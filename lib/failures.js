// @ts-check
/**
 * Failure memory (failures.md) — ported in spirit from pi-hermes-memory.
 *
 * Failures are structured entries in the SAME §-delimited format as MEMORY.md,
 * stored in `failures.md` (hermes filename). The text is built as:
 *   [<category>] <what went wrong> — Failed: <reason> — Corrected to: <fix>
 *
 * Recent failures (created within `failureMaxAgeDays`, at most
 * `failureMaxEntries`) are injected every request so the model learns from
 * past mistakes before repeating them.
 */
import { decodeEntry } from './memory-store.js';

/** hermes MemoryCategory set */
export const FAILURE_CATEGORIES = ['failure', 'correction', 'insight', 'preference', 'convention', 'tool-quirk'];

/**
 * Build a structured failure entry line (hermes buildFailureMemoryText).
 * @param {string} content
 * @param {{ category?: string, failureReason?: string, correctedTo?: string }} opts
 * @returns {string}
 */
export function buildFailureText(content, opts = {}) {
  const category = FAILURE_CATEGORIES.includes(opts.category) ? opts.category : 'failure';
  const parts = [`[${category}] ${content.trim()}`];
  if (opts.failureReason?.trim()) parts.push(`Failed: ${opts.failureReason.trim()}`);
  if (opts.correctedTo?.trim()) parts.push(`Corrected to: ${opts.correctedTo.trim()}`);
  return parts.join(' — ');
}

/**
 * Render recent failures for prompt injection (hermes renderFailureBlock +
 * getFailureEntries): entries created within the age window, newest first,
 * bullets, bounded by max entries.
 * @param {ReturnType<import('./memory-store.js').createMemoryStore>} store
 * @param {{ failureMaxAgeDays: number, failureMaxEntries: number }} cfg
 * @returns {string} empty string when there is nothing recent
 */
export function renderRecentFailures(store, cfg) {
  const raw = store.readRawSync('failure');
  if (raw.length === 0) return '';
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - cfg.failureMaxAgeDays);
  const cutoffStr = cutoff.toISOString().split('T')[0];

  const recent = raw
    .map((line) => decodeEntry(line))
    .filter((e) => e.created >= cutoffStr)
    .sort((a, b) => (a.created < b.created ? 1 : a.created > b.created ? -1 : 0))
    .slice(0, cfg.failureMaxEntries);

  if (recent.length === 0) return '';
  const header = 'RECENT FAILURES & LESSONS (learn from these):';
  const bulletList = recent.map((e) => '• ' + e.text).join('\n');
  return `${header}\n${bulletList}`;
}
