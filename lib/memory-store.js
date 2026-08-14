// @ts-check
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

/** Same delimiter as pi-hermes-memory (src/constants.ts). */
export const ENTRY_DELIMITER = '\n§\n';

/** Char limits aligned with pi-hermes-memory (src/constants.ts). */
export const DEFAULT_MEMORY_CHAR_LIMIT = 5000;
export const DEFAULT_USER_CHAR_LIMIT = 5000;

/** @returns {string} today as YYYY-MM-DD (hermes date format) */
function today() {
  return new Date().toISOString().split('T')[0];
}

/**
 * Encode one entry line (hermes MemoryStore.encodeEntry).
 * @param {string} text
 * @param {string} created
 * @param {string} lastReferenced
 * @param {string | null} [project]
 */
function encodeEntry(text, created, lastReferenced, project) {
  const projectMetadata = project?.trim()
    ? `, project64=${Buffer.from(project.trim(), 'utf-8').toString('base64url')}`
    : '';
  return `${text} <!-- created=${created}, last=${lastReferenced}${projectMetadata} -->`;
}

/**
 * Decode one raw entry line (hermes MemoryStore.decodeEntry).
 * @param {string} raw
 * @returns {{ text: string, created: string, lastReferenced: string, project: string | null }}
 */
export function decodeEntry(raw) {
  const match = /^(.*?)\s*<!--\s*created=([^,]+),\s*last=([^,>]+)(?:,\s*project64=([A-Za-z0-9_-]+))?\s*-->\s*$/.exec(raw);
  if (match) {
    let project = null;
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

/** @param {string} raw @returns {string[]} raw entry lines */
/** @param {string} raw @returns {string[]} raw entry lines (hermes split) */
export function parseEntries(raw) {
  return raw.split(ENTRY_DELIMITER).map((e) => e.trim()).filter(Boolean);
}

/** @param {string} text */
function normalizeContent(text) {
  // Aligned with pi-hermes-memory: only trim, never collapse embedded
  // newlines (hermes MemoryStore.add trims; line-anchored decodeEntry
  // handles multi-line entries via its legacy fallback on both sides).
  return text.trim();
}

/**
 * @param {{ dir: string, limits?: { memory?: number, user?: number, failure?: number } }} config
 */
export function createMemoryStore(config) {
  const dir = config.dir;
  const limits = config.limits ?? {};

  /** @param {'memory' | 'user' | 'failure'} which */
  function charLimitFor(which) {
    if (which === 'user') return limits.user ?? DEFAULT_USER_CHAR_LIMIT;
    if (which === 'failure') return limits.failure ?? DEFAULT_MEMORY_CHAR_LIMIT * 2; // hermes: failures get more space
    return limits.memory ?? DEFAULT_MEMORY_CHAR_LIMIT;
  }

  /** @type {Map<string, Promise<unknown>>} per-file write chains */
  const queues = new Map();

  /**
   * Serialize mutations per file; read-modify-write cycles never interleave.
   * @template T
   * @param {string} file
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  function withLock(file, fn) {
    const prev = queues.get(file) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    queues.set(file, next);
    return next.finally(() => {
      if (queues.get(file) === next) queues.delete(file);
    });
  }

  /** @param {string} file @param {string} content */
  async function writeAtomic(file, content) {
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    await writeFile(tmp, content, 'utf8');
    await rename(tmp, file);
  }

  /**
   * Read a file's raw text, or null when absent. Empty files read as ''.
   * @param {string} file
   * @returns {Promise<string | null>}
   */
  async function readRaw(file) {
    try {
      return await readFile(file, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') return null;
      throw err;
    }
  }

  /** @param {string | null} raw @returns {string} stable fingerprint ('' for absent) */
  function fingerprint(raw) {
    return createHash('sha256').update(raw ?? '').digest('hex');
  }

  /**
   * Serialize entries exactly like pi-hermes-memory: entries joined by the
   * delimiter, NO trailing newline (byte-compatible with Pi's saveToDisk).
   * @param {string[]} entries
   */
  function serialize(entries) {
    return entries.length ? entries.join(ENTRY_DELIMITER) : '';
  }

  /**
   * Re-read a file and compare its fingerprint with a previously captured one.
   * Detects an external (Pi / editor) write that landed between our read and
   * our write — the "phantom success" guard from hermes's ExternalMemoryWriteConflict.
   * @param {string} file
   * @param {string} expected
   * @returns {Promise<boolean>} true when the file still matches
   */
  async function unchangedSince(file, expected) {
    try {
      return fingerprint(await readRaw(file)) === expected;
    } catch {
      return false;
    }
  }

  /** @param {'memory' | 'user' | 'failure'} which */
  function fileFor(which) {
    if (which === 'user') return path.join(dir, 'USER.md');
    if (which === 'failure') return path.join(dir, 'failures.md'); // hermes naming
    return path.join(dir, 'MEMORY.md');
  }

  /** @param {string} file @returns {Promise<string[]>} parsed raw entry lines */
  async function readEntries(file) {
    return withLock(file, async () => {
      try {
        return parseEntries(await readFile(file, 'utf8'));
      } catch (err) {
        if (err && err.code === 'ENOENT') return [];
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
   * @template T
   * @param {string} file
   * @param {(entries: string[]) => ({ next?: string[], value: T })} change
   * @returns {Promise<T & { conflict?: boolean }>}
   */
  async function mutate(file, change) {
    return withLock(file, async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const before = await readRaw(file);
        const beforeFp = fingerprint(before);
        let entries = [];
        if (before) {
          entries = parseEntries(before);
        }
        const { next, value } = change(entries);
        if (!next) return value;
        if (await unchangedSince(file, beforeFp)) {
          await writeAtomic(file, serialize(next));
          return value;
        }
        // External write landed between read and publish — retry once against
        // the fresh state; if it is still changing, refuse to overwrite.
      }
      // Second attempt also saw external churn: do NOT publish.
      const before = await readRaw(file);
      const entries = before ? parseEntries(before) : [];
      const { next, value } = change(entries);
      if (!next) return value;
      return { ...value, conflict: true };
    });
  }

  /**
   * Synchronous raw entry read (prompt variables are sync; files are small).
   * @param {'memory' | 'user' | 'failure'} which
   * @returns {string[]}
   */
  function readRawSync(which) {
    let raw = '';
    try {
      raw = readFileSync(fileFor(which), 'utf8');
    } catch (err) {
      if (!err || err.code !== 'ENOENT') throw err;
    }
    return parseEntries(raw);
  }

  /** @param {string} file @param {string[]} entries */
  async function writeEntries(file, entries) {
    return withLock(file, async () => {
      await writeAtomic(file, serialize(entries));
    });
  }

  /**
   * Raw (metadata-kept) entry lines for one store — used by consolidation.
   * @param {'memory' | 'user'} which
   * @returns {Promise<string[]>}
   */
  async function listRaw(which) {
    return readEntries(fileFor(which));
  }

  /**
   * Replace one store with exact raw entry lines (consolidation commit path).
   * @param {'memory' | 'user'} which
   * @param {string[]} entries
   */
  async function replaceEntries(which, entries) {
    await writeEntries(fileFor(which), entries);
    return { which, entryCount: entries.length, charCount: charCount(entries) };
  }

  /** @param {string[]} entries @returns {number} joined char count (hermes charCount) */
  function charCount(entries) {
    return entries.length ? entries.join(ENTRY_DELIMITER).length : 0;
  }

  /** @param {string[]} entries @returns {{ text: string, created: string, lastReferenced: string, project: string | null }[]} */
  function decoded(entries) {
    return entries.map(decodeEntry);
  }

  /** @param {{ text: string, created: string, lastReferenced: string, project: string | null }[]} list @returns {string[]} */
  function encoded(list) {
    return list.map((e) => encodeEntry(e.text, e.created, e.lastReferenced, e.project));
  }

  /**
   * @param {'memory' | 'user' | 'failure'} which
   * @param {string} content
   * @param {{ dedupe?: boolean, project?: string | null }} [opts] dedupe rejects
   *   exact-text duplicates (hermes failure behavior: scoped by project);
   *   `project` tags the entry with project64 metadata (hermes failure scopes).
   */
  async function add(which, content, opts = {}) {
    const file = fileFor(which);
    const limit = charLimitFor(which);
    return mutate(file, (entries) => {
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
   * @param {'memory' | 'user'} which
   * @param {string} match
   * @param {string} content
   */
  async function update(which, match, content) {
    const file = fileFor(which);
    const limit = charLimitFor(which);
    return mutate(file, (entries) => {
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
   * @param {'memory' | 'user'} which
   * @param {string} match
   */
  async function remove(which, match) {
    const file = fileFor(which);
    return mutate(file, (entries) => {
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
   * @param {'memory' | 'user'} which
   * @param {string} content
   */
  async function rewrite(which, content) {
    const file = fileFor(which);
    const trimmed = content.trim();
    const entries = trimmed.includes(ENTRY_DELIMITER.trim())
      ? parseEntries(trimmed)
      : [encodeEntry(normalizeContent(trimmed), today(), today())];
    const limit = charLimitFor(which);
    if (charCount(entries) > limit) {
      return { which, file, rewritten: false, overflow: true, limit, entryCount: entries.length, charCount: charCount(entries) };
    }
    await writeEntries(file, entries);
    return { which, file, rewritten: true, entryCount: entries.length, charCount: charCount(entries) };
  }

  /**
   * @param {'memory' | 'user'} which
   * @param {number} limit
   * @returns {Promise<{ which: string, file: string, exists: boolean, charCount: number, entryCount: number, content: string }>}
   */
  async function read(which, limit) {
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
   * @param {'memory' | 'user'} which
   * @param {number} limit
   * @returns {{ which: string, file: string, exists: boolean, charCount: number, entryCount: number, content: string }}
   */
  function readSync(which, limit) {
    const file = fileFor(which);
    let raw = '';
    try {
      raw = readFileSync(file, 'utf8');
    } catch (err) {
      if (!err || err.code !== 'ENOENT') throw err;
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

  /**
   * @param {string} query
   * @param {'memory' | 'user' | 'failure' | 'all'} which
   * @param {number} maxResults
   * @returns {Promise<{ which: string, created: string, text: string }[]>}
   */
  async function search(query, which, maxResults) {
    const wanted = which === 'all' ? ['memory', 'user', 'failure'] : [which];
    const q = query.toLowerCase();
    const hits = [];
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

  /** @param {'memory' | 'user'} which @returns {Promise<{ exists: boolean, entryCount: number }>} */
  async function stat(which) {
    const entries = await readEntries(fileFor(which));
    return { exists: entries.length > 0, entryCount: entries.length };
  }

  return { add, update, remove, rewrite, read, readSync, readRawSync, search, stat, fileFor, listRaw, replaceEntries };
}

/**
 * @param {string} text
 * @param {number} limit
 * @returns {string} text truncated to ~limit chars with a marker
 */
export function truncate(text, limit) {
  if (text.length <= limit) return text;
  return text.slice(0, Math.max(0, limit - 40)) + '\n…[truncated — use memory_search for full entries]';
}
