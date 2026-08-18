/**
 * The `/standing` user command — the only write path into STANDING.md besides
 * a direct file edit. The model never writes standing instructions (they are
 * always injected and outrank its defaults; provenance must stay with the
 * user). Usage:
 *   /standing                — list current instructions
 *   /standing add <text>     — pin one instruction
 *   /standing remove <n>     — remove by 1-based position
 *   /standing clear          — remove all
 */
import type { StandingStore } from './standing.js';
import type { Context } from '@deepseek-ai/cordis';
// Type-only namespace import: loads dsh-commands' `declare module` augmentation
// so `ctx.commands` resolves on the cordis Context (stripped at runtime).
import type * as _DshCommands from '@deepseek-ai/dsh-commands';

export function registerStandingCommand(ctx: Context, store: StandingStore): void {
  ctx.commands.register({
    name: 'standing',
    description:
      'List or manage always-active standing instructions (STANDING.md). Usage: /standing, /standing add <text>, /standing remove <n>, /standing clear',
    handler: async ({ rawInput }) => {
      const input = rawInput.trim();
      try {
        if (!input) {
          const { instructions } = await store.snapshot();
          if (instructions.length === 0) {
            return { kind: 'success', text: 'No standing instructions. Pin one with /standing add <text>.' };
          }
          const lines = instructions.map((instruction, index) => `${index + 1}. ${instruction}`);
          return { kind: 'success', text: `Standing instructions (${instructions.length}):\n${lines.join('\n')}` };
        }

        if (input.startsWith('add ')) {
          const outcome = await store.add(input.slice(4));
          return outcome.success
            ? { kind: 'success', text: outcome.message }
            : { kind: 'error', text: outcome.error };
        }

        if (input.startsWith('remove ')) {
          const position = Number.parseInt(input.slice(7).trim(), 10);
          const outcome = await store.remove(Number.isNaN(position) ? NaN : position);
          return outcome.success
            ? { kind: 'success', text: outcome.message }
            : { kind: 'error', text: outcome.error };
        }

        if (input === 'clear') {
          const outcome = await store.clear();
          return outcome.success
            ? { kind: 'success', text: outcome.message }
            : { kind: 'error', text: outcome.error };
        }

        return {
          kind: 'error',
          text: 'Usage: /standing, /standing add <text>, /standing remove <n>, /standing clear',
        };
      } catch (err) {
        return { kind: 'error', text: `Standing command failed: ${String(err).slice(0, 200)}` };
      }
    },
  });
}
