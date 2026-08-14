// @ts-check
/**
 * The `memory` tool: read / add / update / delete / rewrite the persistent
 * persona memory (MEMORY.md and USER.md). On-disk format is shared with
 * pi-hermes-memory (entries separated by `§`, metadata in HTML comments).
 */
import { HarnessError } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { maybeConsolidate } from './consolidate.js';
import { buildFailureText } from './failures.js';
import { latestRoute } from './llm-helper.js';
import { safeProjectName } from './projects.js';
import { scanContent } from './secret-scanner.js';

/** @param {'memory' | 'user' | 'failure'} which @param {{ memoryCharLimit: number, userCharLimit: number, failureCharLimit?: number, projectCharLimit?: number }} config */
function limitFor(which, config) {
  if (which === 'user') return config.userCharLimit;
  if (which === 'failure') return config.failureCharLimit ?? config.memoryCharLimit * 2; // hermes: failures get more space
  return config.memoryCharLimit;
}

/**
 * @param {import('./memory-store.js').ReturnType<typeof import('./memory-store.js').createMemoryStore>} store
 * @param {(name: string) => import('./memory-store.js').ReturnType<typeof import('./memory-store.js').createMemoryStore>} getProjectStore
 * @param {{ memoryCharLimit: number, userCharLimit: number, failureCharLimit?: number, projectCharLimit?: number, enableSecretScanning: boolean, usageNudgeThreshold: number, autoConsolidate: boolean, consolidateStaleDays: number, consolidateTimeoutMs: number }} config
 */
export function registerMemoryTool(ctx, store, config, getProjectStore) {
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
        const projectName = args.project !== undefined && args.project !== null && String(args.project).trim() !== ''
          ? safeProjectName(args.project)
          : undefined;
        const targetStore = projectName ? getProjectStore(projectName) : store;
        const which = projectName ? 'memory' : (args.which ?? 'memory');
        if (which !== 'memory' && which !== 'user' && which !== 'failure') {
          throw new HarnessError(`Unknown memory store "${which}"`, 'MEMORY_INVALID_WHICH');
        }
        const limit = projectName ? (config.projectCharLimit ?? 5000) : limitFor(which, config);
        const label = projectName ? `project:${projectName}` : which;

        let result;
        switch (args.action) {
          case 'read':
            result = await targetStore.read(which, limit);
            break;
          case 'add': {
            const content = requireText(args.content, 'add');
            const entry =
              which === 'failure'
                ? buildFailureText(content, { category: args.category, failureReason: args.failure_reason, correctedTo: args.corrected_to })
                : content;
            rejectBlocked(entry, config);
            result = await targetStore.add(which, entry, { dedupe: which === 'failure' });
            if (result.duplicate) {
              throw new HarnessError('That failure is already recorded — update it instead of adding a duplicate.', 'MEMORY_DUPLICATE_ENTRY');
            }
            break;
          }
          case 'update': {
            const content = requireText(args.content, 'update');
            rejectBlocked(content, config);
            result = await store.update(which, requireText(args.match, 'update', 'match'), content);
            break;
          }
          case 'delete':
            result = await targetStore.remove(which, requireText(args.match, 'delete', 'match'));
            break;
          case 'rewrite': {
            const content = requireText(args.content, 'rewrite');
            rejectBlocked(content, config);
            result = await targetStore.rewrite(which, content);
            break;
          }
          default:
            throw new HarnessError(`Unknown action "${args.action}"`, 'MEMORY_INVALID_ACTION');
        }
        const used = withUsage(result, label, limit, config.usageNudgeThreshold);

        // Over budget after a mutation? Fire an LLM consolidation in the
        // background (hermes behavior: auto-consolidate instead of rejecting).
        if (config.autoConsolidate && (args.action === 'add' || args.action === 'update' || args.action === 'rewrite') && used.charCount > limit) {
          const route = exec?.agent?.session ? latestRoute(exec.agent.session) : undefined;
          if (route) {
            used.consolidating = true;
            maybeConsolidate(ctx, targetStore, route, config, which, projectName ? (config.projectCharLimit ?? 5000) : undefined).catch((err) =>
              ctx.logger.warn('[dsh-persona-memory] consolidation trigger failed: %s', err?.message ?? String(err)),
            );
          }
        }
        return used;
      },
    }),
  );
}

/** @param {unknown} value @param {string} action @param {string} [field] @returns {string} */
function requireText(value, action, field = 'content') {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new HarnessError(`memory action "${action}" requires a non-empty \`${field}\``, 'MEMORY_MISSING_ARGUMENT');
  }
  return value.trim();
}

/** @param {string} content @param {{ enableSecretScanning: boolean }} config */
function rejectBlocked(content, config) {
  if (!config.enableSecretScanning) return;
  const blocked = scanContent(content);
  if (blocked) {
    throw new HarnessError(`Memory write rejected: ${blocked}`, 'MEMORY_CONTENT_BLOCKED');
  }
}

/**
 * Attach usage reporting to every result (exported for testing).
 * @param {Record<string, any>} result
 * @param {'memory' | 'user'} which
 * @param {number} limit
 * @param {number} nudgeThreshold
 */
export function withUsage(result, which, limit, nudgeThreshold) {
  const charCount = result.charCount ?? 0;
  const pct = limit > 0 ? Math.min(100, Math.round((charCount / limit) * 100)) : 0;
  return {
    ...result,
    which: result.which ?? which,
    limit,
    usagePct: pct,
    nudge: pct >= nudgeThreshold * 100,
  };
}

/** @param {unknown} value @returns {string} */
function formatResult(value) {
  const v = /** @type {Record<string, any>} */ (value);
  if (v.content !== undefined && v.added === undefined && v.updated === undefined && v.deleted === undefined && v.rewritten === undefined) {
    const usage = usageLine(v);
    return usage ? `${v.content}\n\n${usage}` : v.content;
  }
  const file = v.which?.startsWith?.('project:')
    ? `project/${v.which.slice(8)}/MEMORY.md`
    : `memory/${v.which === 'user' ? 'USER.md' : v.which === 'failure' ? 'failures.md' : 'MEMORY.md'}`;
  let text;
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

/** @param {Record<string, any>} v @returns {string} */
function usageLine(v) {
  if (typeof v.usagePct !== 'number' || typeof v.limit !== 'number') return '';
  let line = `Usage: ${v.usagePct}% (${v.charCount} chars / limit ${v.limit})`;
  if (v.consolidating) {
    line += ' — over budget, background consolidation triggered.';
  } else if (v.nudge) {
    line += ` — memory is nearly full; consider \`memory rewrite\` (action=rewrite) to consolidate older entries.`;
  }
  return line;
}
