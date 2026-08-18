/**
 * Memory store — durable half of dsh-persona-memory.
 *
 * ON-DISK FORMAT IS SHARED WITH PI's pi-hermes-memory so both agents can
 * read and write the same files (port of hermes's format, MIT):
 *
 *   MEMORY.md  — long-term facts, preferences, conventions (memoryCharLimit)
 *   USER.md    — the user profile: who they are, how they communicate (userCharLimit)
 *
 * File shape (hermes `compact` policy style):
 *   <entry text> <!-- created=YYYY-MM-DD, last=YYYY-MM-DD [ , project64=...] -->
 *   §
 *   <entry text> <!-- created=..., last=... -->
 *
 * - Entries are joined by "\n§\n" (ENTRY_DELIMITER); each entry is a single
 *   line whose metadata lives in a trailing HTML comment (invisible in
 *   markdown, transparent to the delimiter).
 * - Legacy entries without the comment are accepted (dates default to today).
 * - Writes are atomic (temp file + rename) and serialized per file so
 *   parallel tool calls cannot lose each other's updates.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Narrow `unknown` catch values to their errno code (Node errno guard). */
export function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT';
}

/** Same delimiter as pi-hermes-memory (src/constants.ts). */
export const ENTRY_DELIMITER = '\n§\n';

/** Char limits aligned with pi-hermes-memory (src/constants.ts). */
export const DEFAULT_MEMORY_CHAR_LIMIT = 5000;
export const DEFAULT_USER_CHAR_LIMIT = 5000;

export type MemoryKind = 'memory' | 'user' | 'failure';

export interface DecodedEntry {
  text: string;
  created: string;
  lastReferenced: string;
  project: string | null;
}

export interface StoreAddResult {
  which: MemoryKind;
  file: string;
  added: boolean;
  duplicate?: boolean;
  overflow?: boolean;
  limit?: number;
  entryCount: number;
  charCount: number;
}

export interface StoreUpdateResult {
  which: MemoryKind;
  file: string;
  updated: boolean;
  overflow?: boolean;
  limit?: number;
  entryCount: number;
  charCount: number;
}

export interface StoreRemoveResult {
  which: MemoryKind;
  file: string;
  deleted: boolean;
  entryCount: number;
  charCount: number;
}

export interface StoreRewriteResult {
  which: MemoryKind;
  file: string;
  rewritten: boolean;
  overflow?: boolean;
  limit?: number;
  entryCount: number;
  charCount: number;
}

export interface StoreReadResult {
  which: MemoryKind;
  file: string;
  exists: boolean;
  charCount: number;
  entryCount: number;
  content: string;
}

export interface StoreSearchHit {
  which: MemoryKind;
  created: string;
  text: string;
}

export interface MemoryStore {
  add(which: MemoryKind, content: string, opts?: { dedupe?: boolean; project?: string | null }): Promise<StoreAddResult & { conflict?: boolean }>;
  update(which: MemoryKind, match: string, content: string): Promise<StoreUpdateResult & { conflict?: boolean }>;
  remove(which: MemoryKind, match: string): Promise<StoreRemoveResult & { conflict?: boolean }>;
  rewrite(which: MemoryKind, content: string): Promise<StoreRewriteResult>;
  read(which: MemoryKind, limit: number): Promise<StoreReadResult>;
  readSync(which: MemoryKind, limit: number): StoreReadResult;
  readRawSync(which: MemoryKind): string[];
  search(query: string, which: MemoryKind | 'all', maxResults: number): Promise<StoreSearchHit[]>;
  stat(which: MemoryKind): Promise<{ exists: boolean; entryCount: number }>;
  fileFor(which: MemoryKind): string;
  listRaw(which: MemoryKind): Promise<string[]>;
  replaceEntries(which: MemoryKind, entries: string[]): Promise<{ which: string; entryCount: number; charCount: number }>;
}

/** @returns today as YYYY-MM-DD (hermes date format) */
function today(): string {
  return new Date().toISOString().split('T')[0];
}

/**
 * Encode one entry line (hermes MemoryStore.encodeEntry).
 */
function encodeEntry(text: string, created: string, lastReferenced: string, project?: string | null): string {
  const projectMetadata = project?.trim()
    ? `, project64=${Buffer.from(project.trim(), 'utf-8').toString('base64url')}`
    : '';
  return `${text} <!-- created=${created}, last=${lastReferenced}${projectMetadata} -->`;
}

/**
 * Decode one raw entry line (hermes MemoryStore.decodeEntry).
 */
export function decodeEntry(raw: string): DecodedEntry {
  const match = /^(.*?)\s*<!--\s*created=([^,]+),\s*last=([^,>]+)(?:,\s*project64=([A-Za-z0-9_-]+))?\s*-->\s*$/.exec(raw);
  if (match) {
    let project: string | null = null;
    if (match[4]) {
      try {
        project = Buffer.from(match[4], 'base64url').toString('utf-8').trim() || null;
      } catch {
        project = null;
      }
    }
    return { text: match[1].trim(), created: match[2].trim(), lastReferenced: match[3].trim(), project };
  }
  const t = today();
  return { text: raw.trim(), created: t, lastReferenced: t, project: null };
}

/** Split raw file content into raw entry lines (hermes split). */
export function parseEntries(raw: string): string[] {
  return raw.split(ENTRY_DELIMITER).map((e) => e.trim()).filter(Boolean);
}

function normalizeContent(text: string): string {
  // Aligned with pi-hermes-memory: only trim, never collapse embedded
  // newlines (hermes MemoryStore.add trims; line-anchored decodeEntry
  // handles multi-line entries via its legacy fallback on both sides).
  return text.trim();
}

export interface MemoryStoreConfig {
  dir: string;
  limits?: { memory?: number; user?: number; failure?: number };
}

export function createMemoryStore(config: MemoryStoreConfig): MemoryStore {
  const dir = config.dir;
  const limits = config.limits ?? {};

  function charLimitFor(which: MemoryKind): number {
    if (which === 'user') return limits.user ?? DEFAULT_USER_CHAR_LIMIT;
    if (which === 'failure') return limits.failure ?? DEFAULT_MEMORY_CHAR_LIMIT * 2; // hermes: failures get more space
    return limits.memory ?? DEFAULT_MEMORY_CHAR_LIMIT;
  }

  /** per-file write chains */
  const queues = new Map<string, Promise<unknown>>();

  /**
   * Serialize mutations per file; read-modify-write cycles never interleave.
   */
  function withLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
    const prev = queues.get(file) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    queues.set(file, next);
    return next.finally(() => {
      if (queues.get(file) === next) queues.delete(file);
    });
  }

  async function writeAtomic(file: string, content: string): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    await writeFile(tmp, content, 'utf8');
    await rename(tmp, file);
  }

  /**
   * Read a file's raw text, or null when absent. Empty files read as ''.
   */
  async function readRaw(file: string): Promise<string | null> {
    try {
      return await readFile(file, 'utf8');
    } catch (err) {
      if (isEnoent(err)) return null;
      throw err;
    }
  }

  /** stable fingerprint ('' for absent) */
  function fingerprint(raw: string | null): string {
    return createHash('sha256').update(raw ?? '').digest('hex');
  }

  /**
   * Serialize entries exactly like pi-hermes-memory: entries joined by the
   * delimiter, NO trailing newline (byte-compatible with Pi's saveToDisk).
   */
  function serialize(entries: string[]): string {
    return entries.length ? entries.join(ENTRY_DELIMITER) : '';
  }

  /**
   * Re-read a file and compare its fingerprint with a previously captured one.
   * Detects an external (Pi / editor) write that landed between our read and
   * our write — the "phantom success" guard from hermes's ExternalMemoryWriteConflict.
   * @returns true when the file still matches
   */
  async function unchangedSince(file: string, expected: string): Promise<boolean> {
    try {
      return fingerprint(await readRaw(file)) === expected;
    } catch {
      return false;
    }
  }

  function fileFor(which: MemoryKind): string {
    if (which === 'user') return path.join(dir, 'USER.md');
    if (which === 'failure') return path.join(dir, 'failures.md'); // hermes naming
    return path.join(dir, 'MEMORY.md');
  }

  /** @returns parsed raw entry lines */
  async function readEntries(file: string): Promise<string[]> {
    return withLock(file, async () => {
      try {
        return parseEntries(await readFile(file, 'utf8'));
      } catch (err) {
        if (isEnoent(err)) return [];
        throw err;
      }
    });
  }

  /**
   * Atomically read-modify-write one file under a SINGLE lock, so concurrent
   * tool calls can never read the same base and clobber each other. `change`
   * receives the current raw entries and must return `{ next?, value }`:
   * `next` (optional) is the new raw entry list to write, `value` is the
   * caller-facing result. No write happens when `next` is omitted.
   *
   * Before publishing, the file is re-read and fingerprinted: if an external
   * writer (Pi / manual edit) changed it since our read, the mutation is NOT
   * written over it — the change runs once more against the fresh state, and
   * if the file is still moving the result is returned with `conflict: true`
   * so callers can surface the collision instead of clobbering Pi's write.
   */
  async function mutate<T>(
    file: string,
    change: (entries: string[]) => { next?: string[]; value: T },
  ): Promise<T & { conflict?: boolean }> {
    return withLock(file, async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const before = await readRaw(file);
        const beforeFp = fingerprint(before);
        let entries: string[] = [];
        if (before) {
          entries = parseEntries(before);
        }
        const { next, value } = change(entries);
        if (!next) return value as T & { conflict?: boolean };
        if (await unchangedSince(file, beforeFp)) {
          await writeAtomic(file, serialize(next));
          return value as T & { conflict?: boolean };
        }
        // External write landed between read and publish — retry once against
        // the fresh state; if it is still changing, refuse to overwrite.
      }
      // Second attempt also saw external churn: do NOT publish.
      const before = await readRaw(file);
      const entries = before ? parseEntries(before) : [];
      const { next, value } = change(entries);
      if (!next) return value as T & { conflict?: boolean };
      return { ...value, conflict: true };
    });
  }

  /**
   * Synchronous raw entry read (prompt variables are sync; files are small).
   */
  function readRawSync(which: MemoryKind): string[] {
    let raw = '';
    try {
      raw = readFileSync(fileFor(which), 'utf8');
    } catch (err) {
      if (!isEnoent(err)) throw err;
    }
    return parseEntries(raw);
  }

  async function writeEntries(file: string, entries: string[]): Promise<void> {
    return withLock(file, async () => {
      await writeAtomic(file, serialize(entries));
    });
  }

  /**
   * Raw (metadata-kept) entry lines for one store — used by consolidation.
   */
  async function listRaw(which: MemoryKind): Promise<string[]> {
    return readEntries(fileFor(which));
  }

  /**
   * Replace one store with exact raw entry lines (consolidation commit path).
   */
  async function replaceEntries(which: MemoryKind, entries: string[]): Promise<{ which: string; entryCount: number; charCount: number }> {
    await writeEntries(fileFor(which), entries);
    return { which, entryCount: entries.length, charCount: charCount(entries) };
  }

  /** joined char count (hermes charCount) */
  function charCount(entries: string[]): number {
    return entries.length ? entries.join(ENTRY_DELIMITER).length : 0;
  }

  function decoded(entries: string[]): DecodedEntry[] {
    return entries.map(decodeEntry);
  }

  function encoded(list: DecodedEntry[]): string[] {
    return list.map((e) => encodeEntry(e.text, e.created, e.lastReferenced, e.project));
  }

  /**
   * `dedupe` rejects exact-text duplicates (hermes failure behavior: scoped by
   * project); `project` tags the entry with project64 metadata (hermes failure
   * scopes).
   */
  async function add(which: MemoryKind, content: string, opts: { dedupe?: boolean; project?: string | null } = {}): Promise<StoreAddResult & { conflict?: boolean }> {
    const file = fileFor(which);
    const limit = charLimitFor(which);
    return mutate<StoreAddResult>(file, (entries) => {
      const project = opts.project ?? null;
      if (opts.dedupe) {
        const duplicate = decoded(entries).some((e) =>
          e.text === content && (which !== 'failure' || e.project === project));
        if (duplicate) {
          return { value: { which, file, added: false, duplicate: true, entryCount: entries.length, charCount: charCount(entries) } };
        }
      }
      const t = today();
      const next = [...entries, encodeEntry(normalizeContent(content), t, t, project)];
      if (charCount(next) > limit) {
        // hermes semantics: refuse the write when it would exceed the limit
        // (the tool layer may auto-consolidate and retry).
        return { value: { which, file, added: false, overflow: true, limit, entryCount: entries.length, charCount: charCount(entries) } };
      }
      return { next, value: { which, file, added: true, entryCount: next.length, charCount: charCount(next) } };
    });
  }

  /**
   * Replace the first entry whose stripped text contains `match`.
   */
  async function update(which: MemoryKind, match: string, content: string): Promise<StoreUpdateResult & { conflict?: boolean }> {
    const file = fileFor(which);
    const limit = charLimitFor(which);
    return mutate<StoreUpdateResult>(file, (entries) => {
      const list = decoded(entries);
      const index = list.findIndex((e) => e.text.toLowerCase().includes(match.toLowerCase()));
      if (index < 0) {
        return { value: { which, file, updated: false, entryCount: entries.length, charCount: charCount(entries) } };
      }
      const t = today();
      list[index] = { text: normalizeContent(content), created: list[index].created, lastReferenced: t, project: list[index].project };
      const next = encoded(list);
      if (charCount(next) > limit) {
        return { value: { which, file, updated: false, overflow: true, limit, entryCount: entries.length, charCount: charCount(entries) } };
      }
      return { next, value: { which, file, updated: true, entryCount: next.length, charCount: charCount(next) } };
    });
  }

  /**
   * Remove the first entry whose stripped text contains `match`.
   */
  async function remove(which: MemoryKind, match: string): Promise<StoreRemoveResult & { conflict?: boolean }> {
    const file = fileFor(which);
    return mutate<StoreRemoveResult>(file, (entries) => {
      const list = decoded(entries);
      const index = list.findIndex((e) => e.text.toLowerCase().includes(match.toLowerCase()));
      if (index < 0) {
        return { value: { which, file, deleted: false, entryCount: entries.length, charCount: charCount(entries) } };
      }
      list.splice(index, 1);
      const next = encoded(list);
      return { next, value: { which, file, deleted: true, entryCount: next.length, charCount: charCount(next) } };
    });
  }

  /**
   * Replace a whole file with authored content. `content` may be a plain
   * string (stored as one entry) or a hermes-format document (entries joined
   * by "\n§\n") — detected automatically.
   *
   * Detection uses the REAL delimiter "\n§\n" (never the bare "§" glyph): a
   * single stray "§" character in otherwise-plain content must NOT switch the
   * document branch, or all memory collapses into one unformatted entry
   * (observed: MEMORY.md became one 4.7KB entry with no metadata after a
   * rewrite whose content contained one "§").
   */
  async function rewrite(which: MemoryKind, content: string): Promise<StoreRewriteResult> {
    const file = fileFor(which);
    const trimmed = content.trim();
    const entries = trimmed.includes(ENTRY_DELIMITER)
      // "a\n§\nb" — real multi-entry document: at least one separator present.
      // A leading/bare "§" without "\n§\n" stays a single entry.
      ? parseEntries(trimmed)
      : [encodeEntry(normalizeContent(trimmed), today(), today())];
    const limit = charLimitFor(which);
    if (charCount(entries) > limit) {
      return { which, file, rewritten: false, overflow: true, limit, entryCount: entries.length, charCount: charCount(entries) };
    }
    await writeEntries(file, entries);
    return { which, file, rewritten: true, entryCount: entries.length, charCount: charCount(entries) };
  }

  async function read(which: MemoryKind, limit: number): Promise<StoreReadResult> {
    const file = fileFor(which);
    const entries = await readEntries(file);
    const list = decoded(entries);
    const content = list.map((e) => e.text).join('\n\n');
    return {
      which,
      file,
      exists: entries.length > 0,
      charCount: charCount(entries),
      entryCount: entries.length,
      content: truncate(content, limit),
    };
  }

  /**
   * Synchronous read for the per-request prompt variable (small files).
   */
  function readSync(which: MemoryKind, limit: number): StoreReadResult {
    const file = fileFor(which);
    let raw = '';
    try {
      raw = readFileSync(file, 'utf8');
    } catch (err) {
      if (!isEnoent(err)) throw err;
    }
    const list = parseEntries(raw).map(decodeEntry);
    const content = list.map((e) => e.text).join('\n\n');
    return {
      which,
      file,
      exists: list.length > 0,
      charCount: raw.length,
      entryCount: list.length,
      content: truncate(content, limit),
    };
  }

  async function search(query: string, which: MemoryKind | 'all', maxResults: number): Promise<StoreSearchHit[]> {
    const wanted: MemoryKind[] = which === 'all' ? ['memory', 'user', 'failure'] : [which];
    const q = query.toLowerCase();
    const hits: StoreSearchHit[] = [];
    for (const w of wanted) {
      const list = decoded(await readEntries(fileFor(w)));
      for (const entry of list) {
        if (entry.text.toLowerCase().includes(q)) {
          hits.push({ which: w, created: entry.created, text: entry.text });
          if (hits.length >= maxResults) return hits;
        }
      }
    }
    return hits;
  }

  async function stat(which: MemoryKind): Promise<{ exists: boolean; entryCount: number }> {
    const entries = await readEntries(fileFor(which));
    return { exists: entries.length > 0, entryCount: entries.length };
  }

  return { add, update, remove, rewrite, read, readSync, readRawSync, search, stat, fileFor, listRaw, replaceEntries };
}

/**
 * @returns text truncated to ~limit chars with a marker
 */
export function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return text.slice(0, Math.max(0, limit - 40)) + '\n…[truncated — use memory_search for full entries]';
}
