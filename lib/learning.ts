/**
 * Lifecycle hooks — the "auto" half of dsh-persona-memory.
 *
 * 1. Correction detection: on the durable `feedback/record` session event
 *    (the /feedback command), save a `[correction]` failure entry to
 *    failures.md immediately — the model cannot learn from feedback that
 *    arrives after its own message, so this is a host-side hook.
 * 2. Background learning: count `turn/end` events per session and every
 *    `learnIntervalTurns` turns call the session's own LLM route to review
 *    the recent transcript and extract durable facts, saving them via the
 *    store. All writes still pass the content scanner.
 */
import { scanContent } from './secret-scanner.js';
import { callLlm, latestRoute, type LlmRoute } from './llm-helper.js';
import { maybeConsolidate, type ConsolidationConfig } from './consolidate.js';
import { buildFailureText } from './failures.js';
import { extractCorrectionDirective, isCorrection } from './correction.js';
import type { MemoryStore } from './memory-store.js';
import type { Context } from '@deepseek-ai/cordis';
import type { Session } from '@deepseek-ai/dsh-session';

// The `feedback/record` event is contributed by @deepseek-ai/dsh-command-feedback
// through declaration merging on SessionEventMap; mirror the same merge so this
// module's `event.data?.text` access type-checks without a runtime dependency.
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'feedback/record': { text: string };
  }
}

const LEARNING_SYSTEM_PROMPT = `You are a memory curator for a coding agent that persists long-term persona memory across sessions.

Read the recent conversation transcript and extract durable, factual entries worth remembering later: user preferences and identity facts, project conventions and architecture decisions, environment details, tool quirks, and lessons learned. Skip one-off task details, greetings, and anything already covered by the current memory below.

Rules:
- Output ONLY plain lines, one fact per line. No numbering, no bullet markers, no markdown fences, no JSON, no commentary.
- Keep each fact self-contained and concise (under 300 chars), written in the language of the conversation.
- Only output NEW facts that are not already in the current memory.
- If there is nothing worth saving, output the single line: NONE`;

// NOTE: this in-flight guard is intentionally module-scoped — runLearning is a
// top-level function and must share one registry across every session. (The
// original JS declared it inside registerLifecycleHooks, which made runLearning
// throw ReferenceError on its first use and silently disabled background
// learning; fixed here by hoisting it to module scope.)
/** sessions with a learning call in flight */
const inflight = new Set<string>();

export interface LearningConfig extends ConsolidationConfig {
  enableSecretScanning: boolean;
  correctionDetection: boolean;
  correctionPatternDetection: boolean;
  correctionRateLimitTurns: number;
  learnEnabled: boolean;
  learnIntervalTurns: number;
  learnRecentTurns: number;
  learnMaxChars: number;
  learnTimeoutMs: number;
  memoryCharLimit: number;
  autoConsolidate: boolean;
}

export function registerLifecycleHooks(ctx: Context, store: MemoryStore, cfg: LearningConfig): void {
  /** turn counts per session id */
  const turnCounts = new Map<string, number>();
  /** sessions with a pending in-chat correction this turn */
  const pendingCorrections = new Set<string>();
  /** turns since last correction save, per session */
  const turnsSinceCorrection = new Map<string, number>();

  ctx.on('session/event', (session, event) => {
    try {
      // /feedback command event — immediate correction save.
      if (event.type === 'feedback/record' && cfg.correctionDetection) {
        const text = event.data?.text;
        if (typeof text === 'string' && text.trim()) {
          saveCorrection(store, cfg, text).catch((err) =>
            ctx.logger.warn('[dsh-persona-memory] correction save failed: %s', (err as Error | undefined)?.message ?? String(err)),
          );
        }
        return;
      }
      // In-chat correction detection — only on DIRECT human prompts
      // (source.kind === 'user'; synthetic contexts are 'plugin').
      if (event.type === 'user/message' && cfg.correctionDetection && cfg.correctionPatternDetection) {
        const msg = event.data;
        if (msg?.source?.kind === 'user') {
          const text = msg.content
            ?.filter((b) => b.type === 'text')
            .map((b) => b.text)
            .join(' ')
            .trim();
          if (text && isCorrection(text, cfg)) {
            pendingCorrections.add(session.id);
          }
        }
        return;
      }
      if (event.type === 'turn/end') {
        // In-chat correction captured at turn end (rate-limited).
        if (pendingCorrections.has(session.id) && cfg.correctionDetection && cfg.correctionPatternDetection) {
          pendingCorrections.delete(session.id);
          const since = turnsSinceCorrection.get(session.id) ?? cfg.correctionRateLimitTurns;
          if (since >= cfg.correctionRateLimitTurns) {
            turnsSinceCorrection.set(session.id, 0);
            const text = lastDirectUserText(session);
            if (text) {
              saveCorrection(store, cfg, extractCorrectionDirective(text)).catch((err) =>
                ctx.logger.warn('[dsh-persona-memory] correction save failed: %s', (err as Error | undefined)?.message ?? String(err)),
              );
            }
          } else {
            turnsSinceCorrection.set(session.id, since + 1);
          }
        } else {
          turnsSinceCorrection.set(session.id, (turnsSinceCorrection.get(session.id) ?? 0) + 1);
        }
        if (cfg.learnEnabled) {
          const n = (turnCounts.get(session.id) ?? 0) + 1;
          if (n >= cfg.learnIntervalTurns) {
            turnCounts.set(session.id, 0);
            runLearning(ctx, store, cfg, session).catch((err) =>
              ctx.logger.warn('[dsh-persona-memory] background learning failed: %s', (err as Error | undefined)?.message ?? String(err)),
            );
          } else {
            turnCounts.set(session.id, n);
          }
        }
      }
    } catch (err) {
      // containment: a hook bug must never break the session event fan-out
      ctx.logger.warn('[dsh-persona-memory] session/event hook error: %s', (err as Error | undefined)?.message ?? String(err));
    }
  });
}

/**
 * Last direct user text from the session surface (for the correction entry).
 */
function lastDirectUserText(session: Session): string {
  const events = session.events;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event?.type === 'user/message' && event.data?.source?.kind === 'user') {
      return event.data.content
        ?.filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join(' ')
        .trim() ?? '';
    }
  }
  return '';
}

async function saveCorrection(store: MemoryStore, cfg: LearningConfig, text: string): Promise<void> {
  // Corrections are captured as failure memory (category correction) — they
  // surface in the injected recent-failures block so the model learns from
  // them, and stay out of MEMORY.md unless promoted by an explicit add.
  const entry = buildFailureText(text, { category: 'correction' });
  if (cfg.enableSecretScanning && scanContent(entry)) return;
  const result = await store.add('failure', entry, { dedupe: true });
  if (!result.overflow && !result.conflict) return;
  // Over budget or a concurrent external write — the correction simply does
  // not land this time; consolidation of failure memory is rare and the
  // failure block only injects the most recent entries anyway.
  // eslint-disable-next-line no-console
  console.warn('[dsh-persona-memory] correction save skipped (overflow/conflict): %s', entry.slice(0, 80));
}

async function runLearning(ctx: Context, store: MemoryStore, cfg: LearningConfig, session: Session): Promise<void> {
  if (inflight.has(session.id)) return;
  inflight.add(session.id);
  try {
    const route = latestRoute(session);
    if (!route) return;
    const transcript = buildTranscript(session, cfg.learnRecentTurns, cfg.learnMaxChars);
    if (!transcript) return;
    const current = store.readSync('memory', cfg.learnMaxChars).content;
    const reply = await callLlm(ctx, route, LEARNING_SYSTEM_PROMPT, `Recent conversation transcript:\n---begin---\n${transcript}\n---end---\n\nCurrent memory:\n${current || '(empty)'}`, cfg.learnTimeoutMs);
    const facts = parseFacts(reply);
    for (const fact of facts) {
      if (cfg.enableSecretScanning && scanContent(fact)) continue;
      const added = await store.add('memory', fact);
      if (added.overflow) {
        // Store is at capacity and refused the write (hermes semantics).
        // Consolidate once and retry; if still refused, drop this fact
        // rather than silently growing past the limit.
        const limit = cfg.memoryCharLimit;
        if (cfg.autoConsolidate && limit > 0) {
          await maybeConsolidate(ctx, store, route, cfg, 'memory');
          const retried = await store.add('memory', fact);
          if (!retried.overflow && !retried.conflict) continue;
        }
        ctx.logger.warn('[dsh-persona-memory] learning skipped fact at capacity: %s', fact.slice(0, 80));
      }
    }
    if (facts.length > 0) {
      ctx.logger.info('[dsh-persona-memory] learned %d fact(s) from %s', facts.length, session.id);
    }
    // If the learned facts pushed memory over budget, consolidate.
    const stat = await store.stat('memory');
    const limit = cfg.memoryCharLimit;
    if (stat.exists && stat.entryCount > 0 && limit > 0) {
      const raw = await store.listRaw('memory');
      if (raw.join('\n§\n').length > limit) {
        await maybeConsolidate(ctx, store, route, cfg, 'memory');
      }
    }
  } finally {
    inflight.delete(session.id);
  }
}

/**
 * @returns bounded recent user/assistant transcript
 */
function buildTranscript(session: Session, recentTurns: number, maxChars: number): string {
  let messages: ReturnType<Session['deriveMessages']>;
  try {
    messages = session.deriveMessages();
  } catch {
    return '';
  }
  // tail slice: roughly 3 events per turn window
  const limit = Math.max(1, Math.floor(recentTurns * 3));
  const tail = messages.slice(-limit);
  const lines: string[] = [];
  for (const msg of tail) {
    if (msg.role !== 'user' && msg.role !== 'assistant') continue;
    const text = msg.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join(' ')
      .trim();
    if (!text) continue;
    lines.push(`${msg.role === 'user' ? 'USER' : 'ASSISTANT'}: ${text}`);
  }
  let out = lines.join('\n');
  if (out.length > maxChars) out = out.slice(out.length - maxChars);
  return out;
}

/**
 * Parse the curator reply into plain facts (exported for testing).
 */
export function parseFacts(reply: unknown): string[] {
  const facts: string[] = [];
  let inFence = false;
  for (const raw of String(reply ?? '').split(/\r?\n/)) {
    if (/^\s*```/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    let line = raw.replace(/^[-*•\d.)\s]+/, '').trim();
    if (!line) continue;
    if (/^NONE$/i.test(line)) continue;
    if (line.length > 300) line = line.slice(0, 300);
    facts.push(line);
    if (facts.length >= 8) break;
  }
  return facts;
}
