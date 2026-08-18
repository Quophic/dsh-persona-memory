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
import { decodeEntry, type MemoryStore } from './memory-store.js';

/** hermes MemoryCategory set */
export const FAILURE_CATEGORIES = ['failure', 'correction', 'insight', 'preference', 'convention', 'tool-quirk'];

export interface FailureOptions {
  category?: string;
  failureReason?: string;
  correctedTo?: string;
}

/**
 * Build a structured failure entry line (hermes buildFailureMemoryText).
 */
export function buildFailureText(content: string, opts: FailureOptions = {}): string {
  const category = FAILURE_CATEGORIES.includes(opts.category ?? '') ? opts.category : 'failure';
  const parts = [`[${category}] ${content.trim()}`];
  if (opts.failureReason?.trim()) parts.push(`Failed: ${opts.failureReason.trim()}`);
  if (opts.correctedTo?.trim()) parts.push(`Corrected to: ${opts.correctedTo.trim()}`);
  return parts.join(' — ');
}

/**
 * Render recent failures for prompt injection (hermes renderFailureBlock +
 * getFailureEntries): entries created within the age window, newest first,
 * bullets, bounded by max entries.
 * @returns empty string when there is nothing recent
 */
export function renderRecentFailures(store: MemoryStore, cfg: { failureMaxAgeDays: number; failureMaxEntries: number }): string {
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
