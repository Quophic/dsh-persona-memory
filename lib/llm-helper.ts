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
  const events = session.events;
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
