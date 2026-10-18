/**
 * Shared LLM helpers for the auto features (background learning, consolidation):
 * resolving the session's own provider/model route and streaming one text reply.
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { Context } from '@deepseek-ai/cordis';
import type { Session } from '@deepseek-ai/dsh-session';

export interface LlmRoute {
  provider: string;
  model: string;
}

/** @returns the session's latest request route */
export function latestRoute(session: Session): LlmRoute | undefined {
  const events = sessionEvents(session);
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event?.type === 'request/header') {
      const config = event.data?.header?.config;
      if (config?.provider && config?.model) {
        return { provider: config.provider, model: config.model };
      }
    }
  }
  return undefined;
}

/**
 * Read the session event log across dsh epochs: 0.1.x exposes the array as
 * `session.events`, 0.2.x as `session.snapshotEvents()`. Returns an empty log
 * for any other shape so callers degrade instead of throwing.
 */
export function sessionEvents(session: Session): Session['events'] {
  const carrier = session as unknown as {
    events?: Session['events'];
    snapshotEvents?: () => Session['events'];
  };
  if (Array.isArray(carrier.events)) return carrier.events;
  if (typeof carrier.snapshotEvents === 'function') {
    const snapshot = carrier.snapshotEvents();
    if (Array.isArray(snapshot)) return snapshot;
  }
  return [] as unknown as Session['events'];
}

/**
 * Stream one auxiliary text completion from the session's own LLM route.
 * @returns assembled text output
 */
export async function callLlm(ctx: Context, route: LlmRoute, system: string, prompt: string, timeoutMs: number): Promise<string> {
  const signal = AbortSignal.timeout(timeoutMs);
  const messages = [createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } })];
  let out = '';
  const stream = ctx.llm.stream({
    provider: route.provider,
    model: route.model,
    system,
    messages,
    signal,
  });
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') out += chunk.text;
  }
  return out;
}
