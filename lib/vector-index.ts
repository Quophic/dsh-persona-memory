/**
 * Vector memory index — a DSH-side SQLite mirror that stores ONLY embedding
 * data for the shared MEMORY.md / USER.md / failures.md files.
 *
 * Design (aligned with the FTS5 mirror but fingerprint-incremental):
 * - The Markdown files remain the single source of truth, shared byte-for-byte
 *   with pi-hermes-memory. This index is a DERIVED cache living under the DSH
 *   directory (config `vectorIndexDir`, default $DSH_HOME/memory) — Pi never
 *   sees it, and it can be dropped/rebuilt at any time without touching memory.
 * - Each file entry is fingerprinted (sha256 of its raw §-delimited line). On
 *   every search, `sync()` diffs the current file entries against the DB and
 *   only embeds NEW/CHANGED entries (Pi's writes to the shared files are thus
 *   picked up incrementally; deleted entries are removed). Stored embeddings
 *   are never recomputed on read.
 * - Retrieval is pure-JS cosine over a Float32Array BLOB column. The stores are
 *   small (hundreds of entries), so no sqlite-vec native extension is needed —
 *   keeps the plugin dependency-free and peer-safe.
 * - `node:sqlite` is imported dynamically: if unavailable, `available()`
 *   reports false and callers fall back to FTS5/substring search.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { decodeEntry, type MemoryKind, type MemoryStore } from './memory-store.js';
import type { EmbeddingProvider } from './embedding.js';

const WHICHES: MemoryKind[] = ['memory', 'user', 'failure'];
const SCHEMA_VERSION = 1;

export interface VectorSearchHit {
  which: string;
  created: string;
  text: string;
}

export interface VectorIndex {
  search(store: MemoryStore, query: string, which: MemoryKind | 'all', limit: number): Promise<VectorSearchHit[] | null>;
  available(): Promise<boolean>;
  close(): void;
}

export interface VectorIndexConfig {
  dir: string;
  enabled: boolean;
  provider: EmbeddingProvider | null;
}

export function createVectorIndex(config: VectorIndexConfig): VectorIndex {
  const dbPath = path.join(config.dir, '.memory-vec.sqlite');
  let db: import('node:sqlite').DatabaseSync | null = null;
  /** in-flight sync guard */
  let syncing: Promise<boolean> | null = null;

  async function open(): Promise<import('node:sqlite').DatabaseSync | null> {
    if (!config.enabled || !config.provider) return null;
    if (db) return db;
    try {
      const { DatabaseSync } = await import('node:sqlite');
      await fs.promises.mkdir(config.dir, { recursive: true });
      db = new DatabaseSync(dbPath);
      db.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS entries (
          id        INTEGER PRIMARY KEY,
          which     TEXT NOT NULL,
          text_hash TEXT NOT NULL,
          text      TEXT NOT NULL,
          embedding BLOB NOT NULL,
          created   TEXT NOT NULL,
          last      TEXT NOT NULL,
          UNIQUE (which, text_hash)
        );
        CREATE INDEX IF NOT EXISTS idx_entries_which ON entries (which);
        CREATE TABLE IF NOT EXISTS meta (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
      const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as { value?: unknown } | undefined;
      if (row && Number(row.value) !== SCHEMA_VERSION) {
        // Schema changed: drop derived data and rebuild lazily on next search.
        db.exec('DELETE FROM entries;');
        db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
      } else if (!row) {
        db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
      }
      return db;
    } catch (err) {
      db = null;
      return null;
    }
  }

  /** sha256 fingerprint of one raw entry line */
  function hashEntry(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
  }

  /**
   * Diff the shared files against the index and embed only what changed.
   * @returns true when the index is ready
   */
  async function sync(store: MemoryStore): Promise<boolean> {
    const handle = await open();
    if (!handle) return false;
    if (syncing) return syncing;
    syncing = (async () => {
      try {
        for (const which of WHICHES) {
          const raws = await store.listRaw(which);
          const current = new Map(raws.map((raw) => [hashEntry(raw), raw]));
          const rows = handle.prepare('SELECT text_hash FROM entries WHERE which = ?').all(which) as Array<{ text_hash?: unknown }>;
          for (const row of rows) {
            if (!current.has(String(row.text_hash))) {
              handle.prepare('DELETE FROM entries WHERE which = ? AND text_hash = ?').run(which, String(row.text_hash));
            }
          }
          const missing: Array<{ hash: string; raw: string }> = [];
          for (const [hash, raw] of current) {
            const exists = handle.prepare('SELECT 1 FROM entries WHERE which = ? AND text_hash = ?').get(which, hash);
            if (!exists) missing.push({ hash, raw });
          }
          if (missing.length === 0) continue;
          const texts = missing.map((m) => decodeEntry(m.raw).text);
          const vectors = await config.provider!.embed(texts);
          const insert = handle.prepare(
            'INSERT OR REPLACE INTO entries (which, text_hash, text, embedding, created, last) VALUES (?, ?, ?, ?, ?, ?)',
          );
          for (let i = 0; i < missing.length; i++) {
            const dec = decodeEntry(missing[i].raw);
            const buf = Buffer.from(Float32Array.from(vectors[i]).buffer);
            insert.run(which, missing[i].hash, dec.text, buf, dec.created, dec.lastReferenced);
          }
        }
        return true;
      } catch {
        return false;
      } finally {
        syncing = null;
      }
    })();
    return syncing;
  }

  /** cosine similarity */
  function cosine(a: number[], b: number[]): number {
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    const denom = Math.sqrt(na) * Math.sqrt(nb);
    return denom === 0 ? 0 : dot / denom;
  }

  /**
   * Semantic search over the mirrored entries. Returns null when the index or
   * the embedding provider is unavailable — callers fall back to FTS5.
   */
  async function search(store: MemoryStore, query: string, which: MemoryKind | 'all', limit: number): Promise<VectorSearchHit[] | null> {
    const ready = await sync(store);
    if (!ready) return null;
    try {
      const [qvec] = await config.provider!.embed([query]);
      const rows = which === 'all'
        ? db!.prepare('SELECT which, text, created, embedding FROM entries').all()
        : db!.prepare('SELECT which, text, created, embedding FROM entries WHERE which = ?').all(which);
      const scored: Array<{ which: string; created: string; text: string; sim: number }> = [];
      for (const row of rows as Array<Record<string, unknown>>) {
        const blob = row.embedding as Uint8Array;
        const vec = Array.from(new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4));
        const sim = cosine(qvec, vec);
        if (sim > 0) scored.push({ which: String(row.which), created: String(row.created), text: String(row.text), sim });
      }
      scored.sort((a, b) => b.sim - a.sim);
      return scored.slice(0, limit).map(({ which, created, text }) => ({ which, created, text }));
    } catch {
      return null;
    }
  }

  async function available(): Promise<boolean> {
    return (await open()) !== null;
  }

  /** Close the index (releases the SQLite handle / file locks). */
  function close(): void {
    try {
      db?.close();
    } catch {
      // closing a broken handle must not throw
    }
    db = null;
  }

  return { search, available, close };
}
