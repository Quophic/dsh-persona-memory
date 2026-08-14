import { createEmbeddingProvider } from './lib/embedding.js';
import { createVectorIndex } from './lib/vector-index.js';
import { createMemoryStore } from './lib/memory-store.js';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vec-live-'));
const store = createMemoryStore({ dir, limits: { memory: 100000 } });
await store.add('memory', 'godot physics enemy pathfinding 索敌节流');
await store.add('memory', 'coffee brewing temperature 咖啡温度');
await store.add('memory', 'dsh plugin peer dependencies rule');

const cfg = {
  vectorEnabled: true,
  embeddingProvider: 'local',
  embeddingCacheDir: path.join(os.homedir(), '.dsh', 'models'),
};
const provider = createEmbeddingProvider({ ...cfg, logger: { info: (...a) => console.log('[log]', ...a), warn: (...a) => console.log('[warn]', ...a) } });
console.log('provider kind:', provider.kind);

const idx = createVectorIndex({ dir, enabled: true, provider });
console.log('--- searching (first run downloads model if needed) ---');
const t0 = Date.now();
const hits = await idx.search(store, '怎么让敌人找目标 索敌', 'all', 3);
console.log('elapsed ms:', Date.now() - t0);
console.log('hits:', JSON.stringify(hits, null, 2));
idx.close();
