// @ts-check
/**
 * The `memory_search` tool: search across the persistent persona memory
 * (MEMORY.md, USER.md, failures.md, and per-project stores).
 *
 * Retrieval pipeline (most capable first):
 * 1. HYBRID — FTS5 exact/full-text ranking fused with semantic vector ranking
 *    (Reciprocal Rank Fusion). Enabled when the vector index is available.
 * 2. FTS5 full-text only (existing behavior when vector is disabled).
 * 3. Substring scan fallback (when SQLite/FTS5 is unavailable).
 *
 * All paths are bounded by `searchMaxResults` and return the same shape, so
 * injection cost is identical regardless of engine.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { safeProjectName } from './projects.js';

/**
 * Fuse two ranked hit lists by Reciprocal Rank Fusion. Both lists share the
 * { which, created, text } shape; entries present in both are boosted by the
 * sum of their reciprocal ranks, so exact FTS5 matches and semantic near-
 * matches complement each other instead of competing.
 * @param {{ which: string, created: string, text: string }[]} ftsHits
 * @param {{ which: string, created: string, text: string }[]} vecHits
 * @param {number} limit
 * @param {number} [k] RRF constant (default 60, standard choice)
 */
export function fuseRanks(ftsHits, vecHits, limit, k = 60) {
  /** @type {Map<string, { which: string, created: string, text: string, score: number }>} */
  const fused = new Map();
  const bump = (hits) => {
    hits.forEach((h, index) => {
      const key = `${h.which}\u0000${h.text}`;
      const existing = fused.get(key);
      const add = 1 / (k + index + 1);
      if (existing) {
        existing.score += add;
      } else {
        fused.set(key, { which: h.which, created: h.created, text: h.text, score: add });
      }
    });
  };
  bump(ftsHits);
  bump(vecHits);
  return [...fused.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ which, created, text }) => ({ which, created, text }));
}

/**
 * @param {ReturnType<typeof import('./memory-store.js').createMemoryStore>} store
 * @param {(name: string) => ReturnType<typeof import('./memory-store.js').createMemoryStore>} getProjectStore
 * @param {{ searchMaxResults: number }} config
 * @param {ReturnType<typeof import('./fts.js').createFtsIndex>} [fts] FTS5 mirror; falls back to substring scan when unavailable
 * @param {ReturnType<typeof import('./vector-index.js').createVectorIndex>} [vector] semantic mirror; hybrid-fused with FTS5 when available
 */
export function registerMemorySearchTool(ctx, store, config, getProjectStore, fts, vector) {
  ctx.tools.register(
    defineTool({
      name: 'memory_search',
      description:
        'Search the persistent long-term persona memory (facts, preferences, conventions, failures, user profile) ' +
        'for entries related to `query`. Uses hybrid retrieval (full-text FTS5 + semantic vector ranking when enabled), ' +
        'else full-text ranking, else substring matching. ' +
        'Pass `project` to search one project\'s scoped memory instead.',
      parameters: {
        query: {
          type: 'string',
          required: true,
          description: 'Keyword or phrase to search for. Works for exact terms AND semantic matches (near-synonyms, related concepts).',
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
        // Fetch both engines with a little headroom so fusion can re-rank.
        const limit = config.searchMaxResults;
        const ftsPromise = fts ? fts.search(store, query, which, limit * 3) : Promise.resolve(null);
        const vecPromise = vector ? vector.search(store, query, which, limit * 3) : Promise.resolve(null);
        const [ftsRanked, vecRanked] = await Promise.all([ftsPromise, vecPromise]);

        // 1. Hybrid: vector semantics + FTS5 exact, fused by RRF.
        if (vecRanked && vecRanked.length > 0) {
          const matches = fuseRanks(ftsRanked ?? [], vecRanked, limit);
          if (matches.length > 0) {
            return { query, matchCount: matches.length, matches, engine: 'hybrid' };
          }
        }
        // 2. FTS5 only (or vector had nothing while FTS5 did).
        if (ftsRanked && ftsRanked.length > 0) {
          return { query, matchCount: ftsRanked.length, matches: ftsRanked.slice(0, limit), engine: 'fts' };
        }
        // 3. Substring fallback.
        const matches = await store.search(query, which, limit);
        return { query, matchCount: matches.length, matches, engine: 'substring' };
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
  const engine = v.engine ? ` [${v.engine}]` : '';
  const lines = v.matches.map((m) => `- [${m.which}/${m.created}] ${m.text}`);
  return `Found ${v.matchCount} matching entr${v.matchCount === 1 ? 'y' : 'ies'} for "${v.query}"${engine}:\n${lines.join('\n')}`;
}
