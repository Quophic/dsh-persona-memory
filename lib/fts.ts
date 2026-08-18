/**
 * FTS5 memory mirror — the "Memory Search Sync / Extended Store" counterpart
 * of pi-hermes-memory: memory entries are mirrored into a SQLite FTS5 index
 * so `memory_search` gets token-level full-text relevance instead of a linear
 * substring scan over the markdown files.
 *
 * - Index lives at `<memoryDir>/.memory-index.sqlite` (global stores only;
 *   per-project stores stay substring-searched — they are small and per-repo).
 * - Rebuild is cheap (files are small) and driven by file-mtime staleness, so
 *   any write path (tool, learning, correction, consolidation) is picked up on
 *   the next search without explicit invalidation hooks.
 * - `node:sqlite` is imported dynamically: if it is unavailable or the open
 *   fails, `available()` reports false and callers fall back to the substring
 *   scan. The plugin never hard-depends on SQLite.
 */
import fs from 'node:fs';
import path from 'node:path';
import { decodeEntry, type MemoryKind, type MemoryStore } from './memory-store.js';

const WHICHES: MemoryKind[] = ['memory', 'user', 'failure'];

export interface FtsSearchHit {
  which: string;
  created: string;
  text: string;
}

export interface FtsIndex {
  search(store: MemoryStore, query: string, which: MemoryKind | 'all', limit: number): Promise<FtsSearchHit[] | null>;
  available(): Promise<boolean>;
  close(): void;
}

export interface FtsIndexConfig {
  dir: string;
  enabled: boolean;
}

export function createFtsIndex(config: FtsIndexConfig): FtsIndex {
  const dbPath = path.join(config.dir, '.memory-index.sqlite');
  let db: import('node:sqlite').DatabaseSync | null = null;
  /** file mtimes at last build */
  let builtMtimes: Record<string, number> = {};

  async function open(): Promise<import('node:sqlite').DatabaseSync | null> {
    if (!config.enabled) return null;
    if (db) return db;
    try {
      const { DatabaseSync } = await import('node:sqlite');
      db = new DatabaseSync(dbPath);
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(which UNINDEXED, created UNINDEXED, text);
      `);
      return db;
    } catch (err) {
      db = null;
      return null;
    }
  }

  /** @returns true when the index is fresh */
  async function ensureBuilt(store: MemoryStore): Promise<boolean> {
    const handle = await open();
    if (!handle) return false;
    const mtimes: Record<string, number> = {};
    for (const which of WHICHES) {
      const file = store.fileFor(which);
      try {
        mtimes[file] = fs.statSync(file).mtimeMs;
      } catch {
        mtimes[file] = 0; // absent file
      }
    }
    const stale = Object.keys(mtimes).some((file) => mtimes[file] !== builtMtimes[file]);
    if (!stale && Object.keys(builtMtimes).length > 0) return true;
    try {
      handle.exec('DELETE FROM memory_fts');
      const insert = handle.prepare('INSERT INTO memory_fts (which, created, text) VALUES (?, ?, ?)');
      for (const which of WHICHES) {
        for (const raw of await store.listRaw(which)) {
          const decoded = decodeEntry(raw);
          if (!decoded.text) continue;
          insert.run(which, decoded.created, decoded.text);
        }
      }
      builtMtimes = mtimes;
      return true;
    } catch (err) {
      return false;
    }
  }

  /**
   * Search the FTS mirror. Returns null when the index is unavailable —
   * callers fall back to the substring scan.
   */
  async function search(store: MemoryStore, query: string, which: MemoryKind | 'all', limit: number): Promise<FtsSearchHit[] | null> {
    const fresh = await ensureBuilt(store);
    if (!fresh) return null;
    try {
      // Treat the whole query as one literal phrase (FTS5 syntax is data,
      // never executable — same contract as dsh-session-query-sqlite).
      const phrase = '"' + query.replace(/"/g, '""') + '"';
      const rows = which === 'all'
        ? db!.prepare('SELECT which, created, text FROM memory_fts WHERE memory_fts MATCH ? ORDER BY rank LIMIT ?').all(phrase, limit)
        : db!.prepare('SELECT which, created, text FROM memory_fts WHERE memory_fts MATCH ? AND which = ? ORDER BY rank LIMIT ?').all(phrase, which, limit);
      return (rows as Array<Record<string, unknown>>).map((r) => ({ which: String(r.which), created: String(r.created), text: String(r.text) }));
    } catch (err) {
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
    builtMtimes = {};
  }

  return { search, available, close };
}
