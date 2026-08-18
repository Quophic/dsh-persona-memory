/**
 * Auto-consolidation — when a store exceeds its char limit, call the session's
 * own LLM route to merge/age the entries, and commit ONLY when the result is
 * strictly smaller, fully parseable, and passes the content scanner (hermes's
 * "refreshed < current" safety rule). Failures never corrupt memory: they just
 * leave the store over budget and log a warning.
 *
 * Aging: entries carry `<!-- created=..., last=... -->` metadata; the prompt
 * marks entries older than `consolidateStaleDays` without recent references as
 * removal candidates, and preserves user preferences and corrections first.
 */
import { ENTRY_DELIMITER, decodeEntry, type MemoryStore } from './memory-store.js';
import { callLlm, type LlmRoute } from './llm-helper.js';
import { scanContent } from './secret-scanner.js';
import type { Context } from '@deepseek-ai/cordis';

/** per-store consolidation in flight */
const inflight = new Set<string>();

export interface ConsolidationConfig {
  memoryCharLimit: number;
  userCharLimit: number;
  failureCharLimit?: number;
  projectCharLimit?: number;
  enableSecretScanning: boolean;
  autoConsolidate: boolean;
  consolidateStaleDays: number;
  consolidateTimeoutMs: number;
}

/**
 * Trigger consolidation for one store when it is over its char limit.
 * Fire-and-forget from callers; never throws.
 * @param limitOverride explicit char limit (project stores use projectCharLimit)
 */
export async function maybeConsolidate(
  ctx: Context,
  store: MemoryStore,
  route: LlmRoute,
  cfg: ConsolidationConfig,
  which: 'memory' | 'user' | 'failure',
  limitOverride?: number,
): Promise<{ ran: boolean; reason?: string }> {
  // Key the in-flight guard by the store's own file path + which, so the
  // global store and every project store consolidate independently.
  const key = `${store.fileFor(which)}:${which}`;
  if (!cfg.autoConsolidate || inflight.has(key)) return { ran: false, reason: 'disabled-or-inflight' };
  inflight.add(key);
  try {
    const current = await store.listRaw(which);
    if (current.length === 0) return { ran: false, reason: 'empty' };
    const currentChars = current.join(ENTRY_DELIMITER).length;
    const limit = limitOverride ?? (which === 'user' ? cfg.userCharLimit : which === 'failure' ? (cfg.failureCharLimit ?? cfg.memoryCharLimit * 2) : cfg.memoryCharLimit);
    if (currentChars <= limit) return { ran: false, reason: 'under-limit' };

    const prompt = buildConsolidationPrompt(current, limit, cfg.consolidateStaleDays);
    const reply = await callLlm(ctx, route, CONSOLIDATION_SYSTEM_PROMPT, prompt, cfg.consolidateTimeoutMs);
    const entries = parseConsolidatedOutput(reply);
    const check = validateConsolidation(current, entries, cfg);
    if (!check.ok) return { ran: false, reason: check.reason };

    await store.replaceEntries(which, check.entries);
    ctx.logger.info(
      '[dsh-persona-memory] consolidated %s: %d → %d entries, %d → %d chars',
      which, current.length, check.entries.length, currentChars, check.chars,
    );
    return { ran: true };
  } catch (err) {
    ctx.logger.warn('[dsh-persona-memory] consolidation failed: %s', (err as Error | undefined)?.message ?? String(err));
    return { ran: false, reason: 'error' };
  } finally {
    inflight.delete(key);
  }
}

const CONSOLIDATION_SYSTEM_PROMPT = `You are a memory consolidator for a coding agent's persistent long-term memory.

The memory store is at capacity. Consolidate its current entries:
- Merge related entries into a single, concise entry
- Remove outdated or superseded entries (entries older than the stated stale threshold without recent references are candidates for removal)
- Keep the most important and frequently-referenced facts
- Preserve user preferences and corrections (highest priority)
- Do not invent facts, credentials, or data not present in the source entries

Each entry shows when it was created and last referenced in HTML comments (<!-- created=..., last=... -->). Use this to identify stale entries. Today's date is given in the prompt.

Output ONLY a JSON object, no markdown fences, no commentary:
{"entries": ["<full single-line entry INCLUDING its <!-- created=..., last=... --> comment>", ...]}
- Every entry must be a single line with the metadata comment intact (keep created as-is; set last to today's date for entries you keep or merge).
- Fewer, denser entries are better — be aggressive about merging.
- If nothing is worth keeping, output {"entries": []}.`;

/**
 * @param current raw entry lines
 */
export function buildConsolidationPrompt(current: string[], limit: number, staleDays: number): string {
  const today = new Date().toISOString().split('T')[0];
  return `Character limit: ${limit}\nStale threshold: ${staleDays} days without recent references\nToday's date: ${today}\n\nCurrent entries:\n${current.join('\n')}`;
}

/**
 * Extract the JSON `{"entries": [...]}` array from the model reply
 * (exported for testing).
 */
export function parseConsolidatedOutput(reply: unknown): string[] | null {
  const text = String(reply ?? '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed: { entries?: unknown };
  try {
    parsed = JSON.parse(text.slice(start, end + 1)) as { entries?: unknown };
  } catch {
    return null;
  }
  const entries = parsed?.entries;
  if (!Array.isArray(entries)) return null;
  const cleaned = entries.map((e) => (typeof e === 'string' ? e.trim() : '')).filter(Boolean);
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Safety gate before committing a consolidation (exported for testing).
 */
export function validateConsolidation(
  current: string[],
  next: string[] | null,
  cfg: { enableSecretScanning: boolean },
): { ok: true; entries: string[]; chars: number } | { ok: false; reason: string } {
  if (!next || next.length === 0) return { ok: false, reason: 'no-entries' };
  const currentChars = current.join(ENTRY_DELIMITER).length;
  const newChars = next.join(ENTRY_DELIMITER).length;
  if (newChars >= currentChars) {
    return { ok: false, reason: `not-smaller (${newChars} >= ${currentChars})` };
  }
  for (const entry of next) {
    const decoded = decodeEntry(entry);
    if (!decoded.text) return { ok: false, reason: 'empty-entry' };
    if (cfg.enableSecretScanning) {
      const blocked = scanContent(entry);
      if (blocked) return { ok: false, reason: `blocked: ${blocked}` };
    }
  }
  return { ok: true, entries: next, chars: newChars };
}
