// @ts-check
/**
 * Embedding providers for vector memory search.
 *
 * Two pluggable backends behind one `embed(texts) -> number[][]` contract:
 * - remote: any OpenAI-compatible `/embeddings` API (zero dependencies, uses
 *   the global fetch available in the dsh host runtime). Configure
 *   `embeddingBaseUrl` + `embeddingApiKey` (or `DSH_EMBEDDING_API_KEY` env).
 *   DeepSeek's own `/v1/embeddings` endpoint has had availability issues, so
 *   this accepts any compatible base URL (OpenAI, SiliconFlow, Ollama, ...).
 * - local: transformers.js feature-extraction pipeline (dynamic import; only
 *   usable when the user installed `@xenova/transformers` or
 *   `@huggingface/transformers`). Fully offline once the model is cached.
 *
 * When `vectorEnabled` is off, or the chosen provider is unavailable, the
 * caller falls back to FTS5/substring search — vector search is an
 * enhancement, never a hard dependency.
 */

import os from 'node:os';
import path from 'node:path';

/**
 * @param {{ vectorEnabled?: boolean, embeddingProvider?: string, embeddingBaseUrl?: string, embeddingApiKey?: string, embeddingModel?: string, embeddingCacheDir?: string, embeddingRemoteHost?: string, logger?: { info?: (...args: any[]) => void, warn?: (...args: any[]) => void } }} cfg
 * @returns {{ kind: 'remote' | 'local', embed: (texts: string[]) => Promise<number[][]> } | null}
 */
export function createEmbeddingProvider(cfg) {
  if (!cfg.vectorEnabled) return null;
  if (cfg.embeddingProvider === 'local') return createLocalProvider(cfg);
  return createRemoteProvider(cfg);
}

/**
 * OpenAI-compatible remote embeddings (POST {baseUrl}/embeddings).
 * @param {{ embeddingBaseUrl?: string, embeddingApiKey?: string, embeddingModel?: string }} cfg
 */
function createRemoteProvider(cfg) {
  const baseUrl = (cfg.embeddingBaseUrl ?? '').trim().replace(/\/+$/, '');
  const apiKey = cfg.embeddingApiKey ?? process.env.DSH_EMBEDDING_API_KEY ?? '';
  const model = cfg.embeddingModel ?? 'text-embedding-3-small';
  return {
    kind: 'remote',
    async embed(texts) {
      if (!baseUrl || !apiKey) {
        throw new Error('vector search: remote embedding needs embeddingBaseUrl and embeddingApiKey (or DSH_EMBEDDING_API_KEY env)');
      }
      const res = await fetch(`${baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model, input: texts }),
      });
      if (!res.ok) {
        const detail = (await res.text()).slice(0, 200);
        throw new Error(`vector search: embedding API ${res.status} ${detail}`);
      }
      const data = await res.json();
      if (!Array.isArray(data?.data)) {
        throw new Error('vector search: embedding API returned no data array');
      }
      return data.data
        .slice()
        .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
        .map((d) => d.embedding);
    },
  };
}

/**
 * Local transformers.js feature-extraction pipeline. Resolves lazily so a
 * missing optional package only surfaces when vector search is actually used.
 *
 * The model is AUTO-DOWNLOADED on first use: transformers.js fetches the
 * model + tokenizer from the HuggingFace Hub into `env.cacheDir` (default
 * `$DSH_HOME/models` — under the DSH home, never the Pi-shared memory dir),
 * then runs fully offline afterwards. Download progress is logged through
 * `cfg.logger`; a slow/blocked network surfaces a clear error naming the
 * cache dir and the mirror option (`embeddingRemoteHost`, e.g.
 * `https://hf-mirror.com` for mainland China).
 * @param {{ embeddingModel?: string, embeddingCacheDir?: string, embeddingRemoteHost?: string, logger?: { info?: (...args: any[]) => void, warn?: (...args: any[]) => void } }} cfg
 */
function createLocalProvider(cfg) {
  const model = cfg.embeddingModel ?? 'Xenova/all-MiniLM-L6-v2';
  const cacheDir = cfg.embeddingCacheDir ?? path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'models');
  const remoteHost = cfg.embeddingRemoteHost ?? 'https://huggingface.co';
  const log = cfg.logger ?? { info() {}, warn() {} };

  /** @type {Promise<{ embed: (texts: string[]) => Promise<number[][]> }> | null} */
  let ready = null;

  async function load() {
    let mod;
    try {
      mod = await import('@xenova/transformers');
    } catch {
      try {
        mod = await import('@huggingface/transformers');
      } catch {
        throw new Error(
          'vector search: local provider needs @xenova/transformers or @huggingface/transformers installed. '
          + 'Run: pnpm add @xenova/transformers',
        );
      }
    }
    const pipeline = mod.pipeline ?? mod.default?.pipeline;
    if (typeof pipeline !== 'function') {
      throw new Error('vector search: transformers.js module has no pipeline() export');
    }
    const env = mod.env ?? mod.default?.env;
    if (env) {
      env.cacheDir = cacheDir;
      env.remoteHost = remoteHost;
      env.allowRemoteModels = true;
    }
    log.info?.('[dsh-persona-memory] loading local embedding model ' + model + ' (cache: ' + cacheDir + ', host: ' + remoteHost + ')');
    let lastPct = -1;
    const extractor = await pipeline('feature-extraction', model, {
      quantized: true,
      progress_callback: (progress) => {
        // Throttle: only log on whole 10% boundaries (and file-level events).
        if (progress?.status === 'progress' && typeof progress?.progress === 'number') {
          const pct = Math.round(progress.progress * 100);
          if (pct >= lastPct + 10) {
            lastPct = pct;
            log.info?.('[dsh-persona-memory] model download ' + model + ' ' + pct + '% (' + (progress.file ?? '') + ')');
          }
        } else if (progress?.status === 'done' || progress?.status === 'ready') {
          log.info?.('[dsh-persona-memory] model ' + model + ' ready (' + (progress.file ?? '') + ')');
        }
      },
    });
    log.info?.('[dsh-persona-memory] local embedding model ' + model + ' loaded');
    return {
      async embed(texts) {
        const out = await extractor(texts, { pooling: 'mean', normalize: true });
        const data = out?.data;
        const dims = out?.dims;
        if (!data || !dims || dims.length < 2) {
          throw new Error('vector search: extractor returned unexpected tensor shape');
        }
        const batch = dims[0];
        const dim = dims[1];
        const rows = [];
        for (let i = 0; i < batch; i++) {
          rows.push(Array.from(data.subarray(i * dim, (i + 1) * dim)));
        }
        return rows;
      },
    };
  }

  return {
    kind: 'local',
    async embed(texts) {
      ready ??= load();
      const provider = await ready;
      return provider.embed(texts);
    },
  };
}
