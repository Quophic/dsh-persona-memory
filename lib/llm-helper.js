// @ts-check
/**
 * Shared LLM helpers for the auto features (background learning, consolidation):
 * resolving the session's own provider/model route and streaming one text reply.
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm';

/**
 * @param {import('@deepseek-ai/dsh-session').Session} session
 * @returns {{ provider: string, model: string } | undefined} the session's latest request route
 */
export function latestRoute(session) {
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
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ provider: string, model: string }} route
 * @param {string} system
 * @param {string} prompt
 * @param {number} timeoutMs
 * @returns {Promise<string>} assembled text output
 */
export async function callLlm(ctx, route, system, prompt, timeoutMs) {
  const signal = AbortSignal.timeout(timeoutMs);
  const messages = [createUserMessage({ content: prompt, source: { kind: 'user' } })];
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
