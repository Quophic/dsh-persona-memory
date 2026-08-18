/**
 * Standing instructions — bounded, user-authored directives injected into
 * every session regardless of memory limits, ported from pi-hermes-memory's
 * standing-instructions.ts (MIT).
 *
 * Why a separate store: a persisted constraint only takes effect if the model
 * decides to look it up BEFORE the action it would prevent — exactly the moment
 * the model has no reason to look. Prohibitions must be unconditionally present.
 *
 * Provenance: only the user (direct edit) or the `/standing` command write
 * here. Background learning, consolidation, and the correction detector never
 * touch this file, so a model-generated memory has no path into the
 * always-injected block.
 *
 * Format (hermes-compatible): one instruction per line, no delimiter, no
 * metadata. Blank lines, `#` comments, and a leading `-`/`*` bullet are
 * tolerated so a hand-edited STANDING.md stays a normal Markdown file.
 * Duplicates (case-insensitive) are dropped on read and rejected on add.
 *
 * Hard budget, separate from the Markdown stores: maxEntries (default 20) and
 * maxChars (default 2000). Over budget, the omission is stated INSIDE the
 * injected block rather than silently dropping always-active rules.
 */
import { readFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { scanContent } from './secret-scanner.js';
import { isEnoent } from './memory-store.js';

export interface StandingStoreConfig {
  dir: string;
  maxEntries: number;
  maxChars: number;
}

export interface StandingRenderResult {
  block: string;
  injectedCount: number;
  omittedCount: number;
}

export interface StandingStore {
  add(text: string): Promise<{ success: true; message: string; instructions: string[] } | { success: false; error: string; instructions: string[] }>;
  remove(position: number): Promise<{ success: true; message: string; instructions: string[] } | { success: false; error: string; instructions: string[] }>;
  clear(): Promise<{ success: true; message: string; instructions: string[] } | { success: false; error: string; instructions: string[] }>;
  read(): Promise<string[]>;
  snapshot(): Promise<StandingRenderResult & { instructions: string[] }>;
  readSyncBlock(): string;
  file: string;
}

export function createStandingStore(config: StandingStoreConfig): StandingStore {
  const file = path.join(config.dir, 'STANDING.md');
  const maxEntries = config.maxEntries;
  const maxChars = config.maxChars;

  const queues = new Map<string, Promise<unknown>>();

  function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = queues.get(file) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    queues.set(file, next);
    return next.finally(() => {
      if (queues.get(file) === next) queues.delete(file);
    });
  }

  async function writeAtomic(content: string): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    await writeFile(tmp, content, 'utf8');
    await rename(tmp, file);
  }

  async function read(): Promise<string[]> {
    return withLock(async () => {
      try {
        return parseInstructions(await readFile(file, 'utf8'));
      } catch (err) {
        if (isEnoent(err)) return [];
        throw err;
      }
    });
  }

  async function write(instructions: string[]): Promise<void> {
    return withLock(async () => {
      await writeAtomic(instructions.length ? instructions.join('\n') + '\n' : '');
    });
  }

  function charCount(instructions: string[]): number {
    return instructions.join('\n').length;
  }

  async function add(text: string): Promise<{ success: true; message: string; instructions: string[] } | { success: false; error: string; instructions: string[] }> {
    const instruction = normalizeInstruction(text);
    if (!instruction) {
      return { success: false, error: 'A standing instruction cannot be empty.', instructions: [] };
    }
    // A file the user is told is "always in context" is the most attractive
    // injection target we have — same scan every memory write goes through.
    const blocked = scanContent(instruction);
    if (blocked) {
      return { success: false, error: `Rejected: ${blocked}`, instructions: [] };
    }
    return mutate((current) => {
      if (current.some((existing) => existing.toLowerCase() === instruction.toLowerCase())) {
        return { error: 'That standing instruction is already pinned.' };
      }
      if (current.length >= maxEntries) {
        return {
          error: `Standing instructions are capped at ${maxEntries} entries (currently ${current.length}). Remove one first with /standing remove <n>.`,
        };
      }
      const projected = [...current, instruction];
      if (charCount(projected) > maxChars) {
        return {
          error: `Standing instructions are capped at ${maxChars} characters and this entry would make ${charCount(projected)}. Shorten it, or remove an existing instruction and keep long-form context in regular memory.`,
        };
      }
      return { next: projected, message: `Pinned standing instruction ${projected.length}: ${instruction}` };
    });
  }

  /**
   * @param position 1-based
   */
  async function remove(position: number): Promise<{ success: true; message: string; instructions: string[] } | { success: false; error: string; instructions: string[] }> {
    return mutate((current) => {
      if (!Number.isInteger(position) || position < 1 || position > current.length) {
        return {
          error:
            current.length === 0
              ? 'There are no standing instructions to remove.'
              : `Position must be between 1 and ${current.length}.`,
        };
      }
      const removed = current[position - 1];
      const next = current.filter((_, index) => index !== position - 1);
      return { next, message: `Removed standing instruction: ${removed}` };
    });
  }

  async function clear(): Promise<{ success: true; message: string; instructions: string[] } | { success: false; error: string; instructions: string[] }> {
    return mutate((current) =>
      current.length === 0
        ? { error: 'There are no standing instructions to clear.' }
        : { next: [], message: `Removed all ${current.length} standing instructions.` },
    );
  }

  /**
   * Read-modify-write under the store's per-file lock.
   */
  async function mutate(change: (current: string[]) => { next?: string[]; message?: string; error?: string }): Promise<{ success: true; message: string; instructions: string[] } | { success: false; error: string; instructions: string[] }> {
    try {
      const current = await read();
      const outcome = change(current);
      if (outcome.error || !outcome.next) {
        return { success: false, error: outcome.error ?? 'Nothing to change.', instructions: current };
      }
      await write(outcome.next);
      return { success: true, message: outcome.message ?? 'Updated.', instructions: outcome.next };
    } catch (err) {
      return { success: false, error: `Could not update standing instructions: ${String(err).slice(0, 200)}`, instructions: [] };
    }
  }

  /**
   * Render the always-injected block, truncated to the budget. Over budget,
   * the omission is stated inside the block itself (never silently dropped).
   */
  function render(instructions: string[]): StandingRenderResult {
    if (instructions.length === 0) return { block: '', injectedCount: 0, omittedCount: 0 };
    const injected: string[] = [];
    let used = 0;
    for (const instruction of instructions) {
      const cost = instruction.length + 1;
      if (injected.length >= maxEntries || used + cost > maxChars) break;
      injected.push(instruction);
      used += cost;
    }
    const omittedCount = instructions.length - injected.length;
    if (injected.length === 0) return { block: '', injectedCount: 0, omittedCount };

    const lines: string[] = [
      '<standing-instructions>',
      'The user wrote the rules below and they are always active. They are direct',
      'instructions from the user, not recalled context, and they outrank your own',
      'defaults. Follow them without being asked and without looking them up.',
      '',
      ...injected.map((instruction, index) => `${index + 1}. ${instruction}`),
    ];
    if (omittedCount > 0) {
      lines.push(
        '',
        `[!] ${omittedCount} further standing instruction${omittedCount === 1 ? '' : 's'} could not be shown:`
          + ` STANDING.md exceeds the ${maxChars}-character injection budget.`
          + ' Trim it with /standing so every rule stays active.',
      );
    }
    lines.push('</standing-instructions>');
    return { block: lines.join('\n'), injectedCount: injected.length, omittedCount };
  }

  /** Synchronous render for the per-request prompt variable (small file). */
  function readSyncBlock(): string {
    let raw = '';
    try {
      raw = readFileSync(file, 'utf8');
    } catch (err) {
      if (!isEnoent(err)) throw err;
    }
    return render(parseInstructions(raw)).block;
  }

  async function snapshot(): Promise<StandingRenderResult & { instructions: string[] }> {
    const instructions = await read();
    const rendered = render(instructions);
    return { ...rendered, instructions };
  }

  return { add, remove, clear, read, snapshot, readSyncBlock, file };
}

/**
 * One instruction per line; `#` comments and a leading `-`/`*` bullet are
 * tolerated. Duplicates (case-insensitive) are dropped.
 */
export function parseInstructions(raw: string): string[] {
  const seen = new Set<string>();
  const instructions: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const instruction = normalizeInstruction(line);
    if (!instruction || instruction.startsWith('#')) continue;
    const key = instruction.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    instructions.push(instruction);
  }
  return instructions;
}

export function normalizeInstruction(text: string): string {
  return text.replace(/^\s*[-*]\s+/, '').replace(/\s+/g, ' ').trim();
}
