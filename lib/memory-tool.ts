/**
 * The `memory` tool: read / add / update / delete / rewrite the persistent
 * persona memory (MEMORY.md and USER.md). On-disk format is shared with
 * pi-hermes-memory (entries separated by `§`, metadata in HTML comments).
 */
import { HarnessError } from '@deepseek-ai/dsh-llm';
import { defineTool, type JsonValue, type ToolRunContext } from '@deepseek-ai/dsh-tools';
import { maybeConsolidate, type ConsolidationConfig } from './consolidate.js';
import { buildFailureText } from './failures.js';
import { latestRoute, type LlmRoute } from './llm-helper.js';
import { safeProjectName } from './projects.js';
import { scanContent } from './secret-scanner.js';
import type { MemoryKind, MemoryStore } from './memory-store.js';
import type { Context } from '@deepseek-ai/cordis';

export interface MemoryToolConfig extends ConsolidationConfig {
  memoryCharLimit: number;
  userCharLimit: number;
  usageNudgeThreshold: number;
}

function limitFor(which: MemoryKind, config: { memoryCharLimit: number; userCharLimit: number; failureCharLimit?: number }): number {
  if (which === 'user') return config.userCharLimit;
  if (which === 'failure') return config.failureCharLimit ?? config.memoryCharLimit * 2; // hermes: failures get more space
  return config.memoryCharLimit;
}

export type ProjectStoreProvider = (name: string) => MemoryStore;

export function registerMemoryTool(
  ctx: Context,
  store: MemoryStore,
  config: MemoryToolConfig,
  getProjectStore: ProjectStoreProvider,
): void {
  ctx.tools.register(
    defineTool({
      name: 'memory',
      description:
        'Manage the persistent long-term persona memory that survives across sessions. ' +
        'Stores: `memory` (global facts, preferences, conventions, environment details), `user` ' +
        '(who the user is, their preferences and communication style), `failure` ' +
        '(failures and lessons — recent ones are injected every request so mistakes are not repeated), ' +
        'and per-project memory via the `project` parameter (project-specific conventions and decisions). ' +
        'Actions: read (show current memory), add (append one entry), update (replace an entry ' +
        'whose text contains `match`), delete (remove an entry whose text contains `match`), ' +
        'rewrite (replace the whole file — use for consolidation). Entries are free-form single-line ' +
        'blocks; keep each one self-contained and dated in spirit. Never store credentials — writes are scanned.',
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: ['read', 'add', 'update', 'delete', 'rewrite'],
          description: 'What to do with the memory.',
        },
        which: {
          type: 'string',
          enum: ['memory', 'user', 'failure'],
          description: 'Which store to touch (ignored when `project` is set — projects are memory-only). Default: memory.',
        },
        project: {
          type: 'string',
          description: 'Project name for project-scoped memory (e.g. the repo basename). When set, operates on that project\'s MEMORY.md.',
        },
        category: {
          type: 'string',
          enum: ['failure', 'correction', 'insight', 'preference', 'convention', 'tool-quirk'],
          description: 'Failure category tag, only meaningful for which=failure add.',
        },
        failure_reason: {
          type: 'string',
          description: 'Why it went wrong, only for which=failure add.',
        },
        corrected_to: {
          type: 'string',
          description: 'What was corrected / what to do instead, only for which=failure add.',
        },
        content: {
          type: 'string',
          description: 'Entry text (for add/update) or full document content (for rewrite).',
        },
        match: {
          type: 'string',
          description: 'Substring locating the entry to update or delete (case-insensitive, first match wins).',
        },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(_args, value) {
          return [{ type: 'text', text: formatResult(value) }];
        },
      },
      async execute(args, exec) {
        const projectName = (args.project !== undefined && args.project !== null && String(args.project).trim() !== ''
          ? safeProjectName(args.project)
          : undefined) ?? undefined;
        const targetStore = projectName ? getProjectStore(projectName) : store;
        const which = projectName ? 'memory' : (args.which ?? 'memory');
        if (which !== 'memory' && which !== 'user' && which !== 'failure') {
          throw new HarnessError(`Unknown memory store "${which}"`, 'MEMORY_INVALID_WHICH');
        }
        const limit = projectName ? (config.projectCharLimit ?? 5000) : limitFor(which, config);
        const label = projectName ? `project:${projectName}` : which;

        let result: Record<string, unknown>;
        switch (args.action) {
          case 'read':
            result = (await targetStore.read(which, limit)) as unknown as Record<string, unknown>;
            break;
          case 'add': {
            const content = requireText(args.content, 'add');
            const entry =
              which === 'failure'
                ? buildFailureText(content, { category: args.category, failureReason: args.failure_reason, correctedTo: args.corrected_to })
                : content;
            rejectBlocked(entry, config);
            result = (await targetStore.add(which, entry, { dedupe: which === 'failure' })) as unknown as Record<string, unknown>;
            if (result.duplicate) {
              throw new HarnessError('That failure is already recorded — update it instead of adding a duplicate.', 'MEMORY_DUPLICATE_ENTRY');
            }
            if (result.overflow) {
              result = await retryAfterConsolidation(args.action, entry, config, ctx, targetStore, routeFor(exec), which, projectName, limit);
            }
            break;
          }
          case 'update': {
            const content = requireText(args.content, 'update');
            const match = requireText(args.match, 'update', 'match');
            rejectBlocked(content, config);
            result = (await targetStore.update(which, match, content)) as unknown as Record<string, unknown>;
            if (result.overflow) {
              result = await retryAfterConsolidation(args.action, { content, match }, config, ctx, targetStore, routeFor(exec), which, projectName, limit);
            }
            break;
          }
          case 'delete':
            result = (await targetStore.remove(which, requireText(args.match, 'delete', 'match'))) as unknown as Record<string, unknown>;
            break;
          case 'rewrite': {
            const content = requireText(args.content, 'rewrite');
            rejectBlocked(content, config);
            result = (await targetStore.rewrite(which, content)) as unknown as Record<string, unknown>;
            if (result.overflow) {
              result = await retryAfterConsolidation(args.action, content, config, ctx, targetStore, routeFor(exec), which, projectName, limit);
            }
            break;
          }
          default:
            throw new HarnessError(`Unknown action "${String(args.action)}"`, 'MEMORY_INVALID_ACTION');
        }
        if (result.conflict) {
          throw new HarnessError(
            'Memory file changed externally during this update (e.g. Pi or a manual edit landed first) — nothing was overwritten. Re-run the action against the fresh content.',
            'MEMORY_WRITE_CONFLICT',
          );
        }
        const used = withUsage(result, label, limit, config.usageNudgeThreshold);

        // Over budget after a mutation? Fire an LLM consolidation in the
        // background (hermes behavior: auto-consolidate instead of rejecting).
        if (config.autoConsolidate && (args.action === 'add' || args.action === 'update' || args.action === 'rewrite') && (used.charCount as number) > limit && !used.consolidating) {
          const route = routeFor(exec);
          if (route) {
            used.consolidating = true;
            maybeConsolidate(ctx, targetStore, route, config, which, projectName ? (config.projectCharLimit ?? 5000) : undefined).catch((err) =>
              ctx.logger.warn('[dsh-persona-memory] consolidation trigger failed: %s', (err as Error | undefined)?.message ?? String(err)),
            );
          }
        }
        return used as unknown as Record<string, JsonValue>;
      },
    }),
  );
}

function requireText(value: unknown, action: string, field = 'content'): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new HarnessError(`memory action "${action}" requires a non-empty \`${field}\``, 'MEMORY_MISSING_ARGUMENT');
  }
  return value.trim();
}

function routeFor(exec: ToolRunContext): LlmRoute | undefined {
  return exec.agent?.session ? latestRoute(exec.agent.session) : undefined;
}

type RetryPayload = string | { content: string; match: string };

/**
 * A store mutation was refused because it would exceed the char limit
 * (hermes semantics: refuse, don't silently grow past capacity). When
 * auto-consolidate is enabled and the session has an LLM route, consolidate
 * the target FIRST (awaited — unlike the background nudge below) and retry the
 * mutation once against the freed space. If it is still over budget, surface
 * the capacity error so the model can merge/trim instead of looping forever.
 */
async function retryAfterConsolidation(
  action: 'add' | 'update' | 'rewrite',
  payload: RetryPayload,
  config: ConsolidationConfig,
  ctx: Context,
  targetStore: MemoryStore,
  route: LlmRoute | undefined,
  which: MemoryKind,
  projectName: string | undefined,
  limit: number,
): Promise<Record<string, unknown>> {
  if (!config.autoConsolidate || !route) {
    throw new HarnessError(
      `Memory is at capacity (limit ${limit} chars). Consolidate first with a rewrite, or remove old entries, then retry.`,
      'MEMORY_FULL',
    );
  }
  await maybeConsolidate(ctx, targetStore, route, config, which, projectName ? limit : undefined);
  let retried: Record<string, unknown>;
  if (action === 'add') {
    retried = (await targetStore.add(which, payload as string, { dedupe: which === 'failure' })) as unknown as Record<string, unknown>;
  } else if (action === 'update') {
    const { content, match } = payload as { content: string; match: string };
    retried = (await targetStore.update(which, match, content)) as unknown as Record<string, unknown>;
  } else {
    retried = (await targetStore.rewrite(which, payload as string)) as unknown as Record<string, unknown>;
  }
  if (retried.overflow || retried.conflict) {
    throw new HarnessError(
      `Memory is still at capacity after consolidation (limit ${limit} chars). Merge or remove entries explicitly, then retry.`,
      'MEMORY_FULL',
    );
  }
  return { ...retried, consolidating: true };
}

function rejectBlocked(content: string, config: { enableSecretScanning: boolean }): void {
  if (!config.enableSecretScanning) return;
  const blocked = scanContent(content);
  if (blocked) {
    throw new HarnessError(`Memory write rejected: ${blocked}`, 'MEMORY_CONTENT_BLOCKED');
  }
}

/**
 * Attach usage reporting to every result (exported for testing).
 */
export function withUsage(result: Record<string, unknown>, which: string, limit: number, nudgeThreshold: number): Record<string, unknown> {
  const charCount = (result.charCount as number | undefined) ?? 0;
  const pct = limit > 0 ? Math.min(100, Math.round((charCount / limit) * 100)) : 0;
  return {
    ...result,
    // The caller-passed label (e.g. `project:repo`) wins over the store's
    // generic which, so project operations render their real path.
    which: which ?? result.which,
    limit,
    usagePct: pct,
    nudge: pct >= nudgeThreshold * 100,
  };
}

function formatResult(value: unknown): string {
  const v = value as Record<string, unknown>;
  if (v.content !== undefined && v.added === undefined && v.updated === undefined && v.deleted === undefined && v.rewritten === undefined) {
    const usage = usageLine(v);
    return usage ? `${v.content}\n\n${usage}` : String(v.content);
  }
  const whichStr = String(v.which ?? '');
  const file = whichStr.startsWith?.('project:')
    ? `project/${whichStr.slice(8)}/MEMORY.md`
    : `memory/${whichStr === 'user' ? 'USER.md' : whichStr === 'failure' ? 'failures.md' : 'MEMORY.md'}`;
  let text: string;
  if (v.added) text = `Saved to ${file}. Now ${v.entryCount} entries (${v.charCount} chars).`;
  else if (v.updated !== undefined) {
    text = v.updated
      ? `Updated ${file}. ${v.entryCount} entries, ${v.charCount} chars.`
      : `No entry in ${file} matched — nothing changed. Run read first to see exact text.`;
  } else if (v.deleted !== undefined) {
    text = v.deleted
      ? `Deleted from ${file}. ${v.entryCount} entries remain.`
      : `No entry in ${file} matched — nothing deleted.`;
  } else if (v.rewritten) {
    text = `Rewrote ${file}: ${v.entryCount} entries, ${v.charCount} chars.`;
  } else {
    return JSON.stringify(v);
  }
  const usage = usageLine(v);
  if (usage) text += `\n${usage}`;
  return text;
}

function usageLine(v: Record<string, unknown>): string {
  if (typeof v.usagePct !== 'number' || typeof v.limit !== 'number') return '';
  let line = `Usage: ${v.usagePct}% (${v.charCount} chars / limit ${v.limit})`;
  if (v.consolidating) {
    line += ' — over budget, background consolidation triggered.';
  } else if (v.nudge) {
    line += ` — memory is nearly full; consider \`memory rewrite\` (action=rewrite) to consolidate older entries.`;
  }
  return line;
}
