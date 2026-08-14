// @ts-check
/**
 * The `memory_search` tool: keyword search across the persistent persona
 * memory (MEMORY.md, USER.md, failures.md, and per-project stores).
 * Case-insensitive substring matching.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { safeProjectName } from './projects.js';

/**
 * @param {import('./memory-store.js').ReturnType<typeof import('./memory-store.js').createMemoryStore>} store
 * @param {(name: string) => import('./memory-store.js').ReturnType<typeof import('./memory-store.js').createMemoryStore>} getProjectStore
 * @param {{ searchMaxResults: number }} config
 * @param {ReturnType<typeof import('./fts.js').createFtsIndex>} [fts] FTS5 mirror; falls back to substring scan when unavailable
 */
export function registerMemorySearchTool(ctx, store, config, getProjectStore, fts) {
  ctx.tools.register(
    defineTool({
      name: 'memory_search',
      description:
        'Search the persistent long-term persona memory (facts, preferences, conventions, failures, user profile) ' +
        'for entries containing `query`. Uses full-text (FTS5) ranking when available, else substring matching. ' +
        'Pass `project` to search one project\'s scoped memory instead.',
      parameters: {
        query: {
          type: 'string',
          required: true,
          description: 'Keyword or phrase to search for (literal; FTS5 phrase semantics).',
        },
        which: {
          type: 'string',
          enum: ['memory', 'user', 'failure', 'all'],
          description: 'Where to search (ignored when `project` is set). Default: all.',
        },
        project: {
          type: 'string',
          description: 'Project name to search its scoped memory.',
        },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(_args, value) {
          return [{ type: 'text', text: formatResult(value) }];
        },
      },
      async execute(args) {
        const query = (args.query ?? '').trim();
        if (!query) {
          return { query, matchCount: 0, matches: [] };
        }
        const projectName =
          args.project !== undefined && args.project !== null && String(args.project).trim() !== ''
            ? safeProjectName(args.project)
            : undefined;
        if (projectName) {
          const hits = await getProjectStore(projectName).search('memory', query, config.searchMaxResults);
          const matches = hits.map((h) => ({ ...h, which: `project:${projectName}` }));
          return { query, matchCount: matches.length, matches };
        }
        const which = args.which ?? 'all';
        // FTS5 mirror first (relevance-ranked); substring scan as fallback.
        if (fts) {
          const ranked = await fts.search(store, query, which, config.searchMaxResults);
          if (ranked !== null) {
            return { query, matchCount: ranked.length, matches: ranked };
          }
        }
        const matches = await store.search(query, which, config.searchMaxResults);
        return { query, matchCount: matches.length, matches };
      },
    }),
  );
}

/** @param {unknown} value @returns {string} */
function formatResult(value) {
  const v = /** @type {Record<string, any>} */ (value);
  if (!v.matches || v.matches.length === 0) {
    return `No memory entries match "${v.query}".`;
  }
  const lines = v.matches.map((m) => `- [${m.which}/${m.created}] ${m.text}`);
  return `Found ${v.matchCount} matching entr${v.matchCount === 1 ? 'y' : 'ies'} for "${v.query}":\n${lines.join('\n')}`;
}
