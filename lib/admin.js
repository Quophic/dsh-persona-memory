// @ts-check
/**
 * Admin routes + auto-protect for dsh-persona-memory — the browser-half
 * settings page ("记忆管理") talks to these /api/persona-memory/* routes.
 *
 * Why routes instead of harness.handle: this is the shipped bundle plugin,
 * so the client half is a prebuilt `window.__ModuleLoader__` bundle served
 * at /plugins/<id>/client.js; it cannot use dynamic-plugin RPC. Following
 * the dsh-ssh precedent, the client uses plain same-origin fetch against
 * routes registered on the host `webServer` service.
 *
 * Every route is loopback-only (same fence dsh-ssh uses): these endpoints
 * read and mutate the shared memory files, so a LAN-exposed web deployment
 * must not serve them.
 *
 * Auto-protect (startAutoProtect): a background tick every minute that
 *   1. backs up all memory files into $DSH_HOME/memory-backup/latest/
 *      (single overwritten snapshot; interval = autoBackupMin minutes)
 *   2. watches the Pi shared dir: if MEMORY.md was seen and then vanishes,
 *      switches the profile `dir` config to $DSH_HOME/memory and restores
 *      from the latest backup.
 */
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { parseEntries, decodeEntry, ENTRY_DELIMITER } from './memory-store.js';
import { parseInstructions, normalizeInstruction } from './standing.js';

/** Cap on JSON request bodies (admin payloads are small). */
const MAX_JSON_BODY_BYTES = 64 * 1024;

/** Backup root under the DSH home (never inside the Pi-shared dir). */
export const BACKUP_BASE = path.join(os.homedir(), '.dsh', 'memory-backup');
export const BACKUP_LATEST = path.join(BACKUP_BASE, 'latest');

/** The four memory file basenames + project file prefix. */
const MEMORY_FILES = ['MEMORY.md', 'USER.md', 'failures.md', 'STANDING.md'];
const PROJECT_PREFIX = 'projects-';

/** Loopback literal check plus browser same-origin markers (mirrors dsh-ssh). */
function isLoopbackRequest(request) {
  const address = request.socket.remoteAddress;
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false;
  const host = request.headers.host;
  if (typeof host !== 'string') return false;
  let hostUrl;
  try {
    hostUrl = new URL(`http://${host}`);
  } catch {
    return false;
  }
  if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') return false;
  if (request.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}

/** One JSON response. */
function writeJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' });
  res.end(payload);
}

/** Read a JSON request body (undefined when too large or unparseable). */
async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk;
    size += buffer.length;
    if (size > MAX_JSON_BODY_BYTES) return undefined;
    chunks.push(buffer);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** URL query helper (first value, decoded). */
function queryParam(url, name) {
  const value = url.searchParams.get(name);
  return value === null ? undefined : value;
}

/** today as YYYY-MM-DD (hermes date format). */
function today() {
  return new Date().toISOString().split('T')[0];
}

/** Encode one entry line (hermes MemoryStore.encodeEntry). */
function encodeEntry(text, created, lastReferenced, project) {
  const projectMetadata = project?.trim()
    ? `, project64=${Buffer.from(project.trim(), 'utf-8').toString('base64url')}`
    : '';
  return `${text} <!-- created=${created}, last=${lastReferenced}${projectMetadata} -->`;
}

/** Read raw file text or null when absent. */
function readRaw(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}

/** Write raw file text atomically (temp + rename). */
function writeRawAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * Resolve the active memory dir (mirrors index.js resolveDir):
 * explicit config dir → Pi has MEMORY.md → $DSH_HOME/memory.
 * @param {object} cfg resolved plugin config
 * @returns {string}
 */
export function resolveMemoryDir(cfg) {
  if (cfg.dir && String(cfg.dir).trim()) return String(cfg.dir).trim();
  const piMem = path.join(os.homedir(), '.pi', 'agent', 'pi-hermes-memory', 'MEMORY.md');
  if (fs.existsSync(piMem)) return path.join(os.homedir(), '.pi', 'agent', 'pi-hermes-memory');
  return path.join(os.homedir(), '.dsh', 'memory');
}

/** Resolve the projects memory root (mirrors lib/projects.js resolveProjectsRoot). */
export function resolveProjectsRoot(memoryDir) {
  const piDir = path.join(os.homedir(), '.pi', 'agent', 'pi-hermes-memory');
  if (path.resolve(memoryDir) === path.resolve(piDir)) {
    return path.join(os.homedir(), '.pi', 'agent', 'projects-memory');
  }
  return path.join(memoryDir, 'projects-memory');
}

// ------------------------------------------------------------- schema
/** Config schema surfaced to the admin page (mirrors index.js cfg defaults). */
export const CFG_SCHEMA = [
  { key: 'dir', type: 'string', label: '记忆目录', group: '基础', help: '显式设置优先；默认：Pi 有 MEMORY.md 才共享，否则用 $DSH_HOME/memory' },
  { key: 'memoryCharLimit', type: 'number', label: 'MEMORY 字符上限', group: '基础' },
  { key: 'userCharLimit', type: 'number', label: 'USER 字符上限', group: '基础' },
  { key: 'enableSecretScanning', type: 'bool', label: '写入内容扫描', group: '基础', help: '拦截提示注入/凭据' },
  { key: 'inject', type: 'bool', label: '注入记忆段落', group: '基础', help: '每请求注入 system prompt' },
  { key: 'sectionOrder', type: 'number', label: '记忆段顺序', group: '基础' },
  { key: 'searchMaxResults', type: 'number', label: '搜索最大条数', group: '检索' },
  { key: 'usageNudgeThreshold', type: 'number', label: '用量提醒阈值', group: '基础', help: '0~1，达此比例提醒合并' },
  { key: 'correctionDetection', type: 'bool', label: '纠正检测', group: '学习', help: 'feedback/record 自动存纠正条目' },
  { key: 'correctionPatternDetection', type: 'bool', label: '对话内纠正检测', group: '学习' },
  { key: 'correctionRateLimitTurns', type: 'number', label: '纠正限频（轮）', group: '学习' },
  { key: 'learnEnabled', type: 'bool', label: '后台学习', group: '学习', help: '每 N 轮复习对话提取事实' },
  { key: 'learnIntervalTurns', type: 'number', label: '学习间隔（轮）', group: '学习' },
  { key: 'learnRecentTurns', type: 'number', label: '学习近 N 轮', group: '学习' },
  { key: 'learnMaxChars', type: 'number', label: '学习最大字符', group: '学习' },
  { key: 'learnTimeoutMs', type: 'number', label: '学习超时（ms）', group: '学习' },
  { key: 'autoConsolidate', type: 'bool', label: '自动合并', group: '合并', help: '超限用 LLM 合并精简' },
  { key: 'consolidateStaleDays', type: 'number', label: '合并陈旧天数', group: '合并' },
  { key: 'consolidateTimeoutMs', type: 'number', label: '合并超时（ms）', group: '合并' },
  { key: 'standingEnabled', type: 'bool', label: '常驻指令注入', group: '常驻' },
  { key: 'standingCharLimit', type: 'number', label: '常驻字符预算', group: '常驻' },
  { key: 'standingMaxEntries', type: 'number', label: '常驻最大条数', group: '常驻' },
  { key: 'failureInjectionEnabled', type: 'bool', label: '失败记忆注入', group: '失败' },
  { key: 'failureMaxAgeDays', type: 'number', label: '失败记忆天数', group: '失败' },
  { key: 'failureMaxEntries', type: 'number', label: '失败记忆条数', group: '失败' },
  { key: 'failureCharLimit', type: 'number', label: '失败字符上限', group: '失败' },
  { key: 'projectEnabled', type: 'bool', label: '项目记忆', group: '项目', help: '按会话 cwd 自动注入' },
  { key: 'projectCharLimit', type: 'number', label: '项目字符上限', group: '项目' },
  { key: 'memoryFtsEnabled', type: 'bool', label: 'FTS5 全文索引', group: '检索' },
  { key: 'vectorEnabled', type: 'bool', label: '向量搜索', group: '向量', help: 'FTS5+向量 RRF 混合检索' },
  { key: 'vectorIndexDir', type: 'string', label: '向量索引目录', group: '向量', help: '默认 $DSH_HOME/memory' },
  { key: 'embeddingProvider', type: 'select', options: ['remote', 'local'], label: 'embedding 提供方', group: '向量', help: 'local=transformers.js 本地模型' },
  { key: 'embeddingBaseUrl', type: 'string', label: '远程 API 基址', group: '向量', help: 'OpenAI 兼容 /embeddings' },
  { key: 'embeddingApiKey', type: 'string', label: '远程 API Key', group: '向量', help: '或 DSH_EMBEDDING_API_KEY' },
  { key: 'embeddingModel', type: 'string', label: 'embedding 模型', group: '向量' },
  { key: 'embeddingCacheDir', type: 'string', label: '模型缓存目录', group: '向量', help: '默认 $DSH_HOME/models' },
  { key: 'embeddingRemoteHost', type: 'string', label: '下载源镜像', group: '向量', help: '大陆可用 https://hf-mirror.com' },
  { key: 'adminProfile', type: 'string', label: '配置写回 profile', group: '管理', help: '默认 web' },
  { key: 'autoBackupMin', type: 'number', label: '自动备份间隔（分钟）', group: '备份', help: '0=关闭；默认 60；只保留最新一份' },
  { key: 'autoSwitchOnPiLoss', type: 'bool', label: 'Pi 丢失自动切换', group: '备份', help: 'Pi 记忆消失时自动切到本地并恢复' },
];

/** Config defaults (mirrors index.js). */
export const CFG_DEFAULTS = {
  memoryCharLimit: 5000, userCharLimit: 5000, enableSecretScanning: true, inject: true, sectionOrder: 55,
  searchMaxResults: 10, usageNudgeThreshold: 0.9, correctionDetection: true, correctionPatternDetection: true,
  correctionRateLimitTurns: 3, learnEnabled: true, learnIntervalTurns: 10, learnRecentTurns: 2, learnMaxChars: 6000,
  learnTimeoutMs: 120000, autoConsolidate: true, consolidateStaleDays: 30, consolidateTimeoutMs: 120000,
  standingEnabled: true, standingCharLimit: 2000, standingMaxEntries: 20, failureInjectionEnabled: true,
  failureMaxAgeDays: 7, failureMaxEntries: 5, failureCharLimit: 10000, projectEnabled: true, projectCharLimit: 5000,
  memoryFtsEnabled: true, vectorEnabled: false, embeddingProvider: 'remote', embeddingModel: 'text-embedding-3-small',
  embeddingRemoteHost: 'https://huggingface.co', adminProfile: 'web',
  autoBackupMin: 60, autoSwitchOnPiLoss: true,
};

// ------------------------------------------------- profile patch (config)
/** Parse the persona-memory section config out of a patch YAML text. */
export function parseSectionConfig(content, id) {
  const lines = content.split(/\r?\n/);
  let inSection = false;
  let inConfig = false;
  const cfg = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!inSection) {
      if (/^-\s*id:\s*/.test(trimmed) && trimmed.includes(id)) { inSection = true; continue; }
      continue;
    }
    if (inConfig) {
      const m = /^\s*([A-Za-z][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
      if (m && line.startsWith('    ')) {
        const v = m[2].trim();
        cfg[m[1]] = v === 'true' ? true : v === 'false' ? false : v.replace(/^['"]|['"]$/g, '');
        continue;
      }
      if (!line.startsWith('    ') && line.trim()) break;
      continue;
    }
    if (/^\s*config:\s*$/.test(line) && line.startsWith('  ')) { inConfig = true; continue; }
    if (!line.startsWith(' ') && line.trim()) break;
  }
  return cfg;
}

/** Update (or append) the persona-memory section config in a patch YAML. */
export function updateSectionConfig(content, id, cfg) {
  const lines = content.split(/\r?\n/);
  let sectionIdx = -1;
  let configIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (sectionIdx < 0 && /^-\s*id:\s*/.test(t) && t.includes(id)) { sectionIdx = i; continue; }
    if (sectionIdx >= 0 && /^\s*config:\s*$/.test(lines[i]) && lines[i].startsWith('  ')) { configIdx = i; break; }
    if (sectionIdx >= 0 && i > sectionIdx && lines[i].trim() && !lines[i].startsWith(' ') && !/^-\s*id:/.test(t)) break;
  }
  const line = (k) => {
    const v = cfg[k];
    const val = typeof v === 'boolean' ? (v ? 'true' : 'false')
      : typeof v === 'number' ? String(v)
        : `'${String(v).replace(/'/g, "''")}'`;
    return '    ' + k + ': ' + val;
  };
  if (sectionIdx < 0) {
    const block = ['', `- id: ${id}`, '  config:', ...Object.keys(cfg).map(line)];
    return content.replace(/\s*$/, '') + '\n' + block.join('\n') + '\n';
  }
  if (configIdx < 0) {
    const block = ['  config:', ...Object.keys(cfg).map(line)];
    lines.splice(sectionIdx + 1, 0, ...block);
    return lines.join('\n');
  }
  const endIdx = (() => {
    for (let i = configIdx + 1; i < lines.length; i++) {
      if (lines[i].trim() && !lines[i].startsWith('    ') && !lines[i].startsWith('  ')) return i;
      if (lines[i].trim() && lines[i].startsWith('  ') && !lines[i].startsWith('    ')) return i;
    }
    return lines.length;
  })();
  const existing = new Set();
  for (let i = configIdx + 1; i < endIdx; i++) {
    const m = /^\s*([A-Za-z][A-Za-z0-9_]*):/.exec(lines[i]);
    if (m) {
      const k = m[1];
      existing.add(k);
      if (k in cfg) lines[i] = line(k);
    }
  }
  const insert = [];
  for (const k of Object.keys(cfg)) if (!existing.has(k)) insert.push(line(k));
  if (insert.length) lines.splice(endIdx, 0, ...insert);
  return lines.join('\n');
}

// ------------------------------------------------------------- backup
/** List current backup snapshots (single latest dir). */
export function listBackups() {
  try {
    const names = fs.readdirSync(BACKUP_LATEST, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name);
    return [{ name: 'latest', files: names.length }];
  } catch {
    return [];
  }
}

/** Copy one file if the source exists. @returns {Promise<boolean>} */
async function copyIfExists(src, dst) {
  try {
    const s = fs.statSync(src);
    if (!s.isFile()) return false;
    writeRawAtomic(dst, fs.readFileSync(src, 'utf8'));
    return true;
  } catch {
    return false;
  }
}

/** Backup all memory files + project memories into latest/ (overwrite). */
export async function backupAll(cfg) {
  const dir = resolveMemoryDir(cfg);
  let count = 0;
  for (const name of MEMORY_FILES) {
    if (await copyIfExists(path.join(dir, name), path.join(BACKUP_LATEST, name))) count++;
  }
  try {
    const projRoot = resolveProjectsRoot(dir);
    for (const e of fs.readdirSync(projRoot, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      if (await copyIfExists(path.join(projRoot, e.name, 'MEMORY.md'), path.join(BACKUP_LATEST, PROJECT_PREFIX + e.name + '.md'))) count++;
    }
  } catch {
    // no projects root yet — fine
  }
  return { ok: true, message: `备份完成（${count} 个文件）→ ${BACKUP_LATEST}` };
}

/** Restore from latest backup. @param {object} cfg @param {string} [targetDir] override destination (defaults to resolveMemoryDir(cfg)) @returns {number} */
export async function restoreFromLatest(cfg, targetDir) {
  const dir = targetDir || resolveMemoryDir(cfg);
  let count = 0;
  for (const f of MEMORY_FILES) {
    if (await copyIfExists(path.join(BACKUP_LATEST, f), path.join(dir, f))) count++;
  }
  try {
    const projRoot = resolveProjectsRoot(dir);
    for (const e of fs.readdirSync(BACKUP_LATEST, { withFileTypes: true })) {
      if (!e.isFile() || !e.name.startsWith(PROJECT_PREFIX) || !e.name.endsWith('.md')) continue;
      const pname = e.name.slice(PROJECT_PREFIX.length, -'.md'.length);
      if (!pname || !/^[A-Za-z0-9._-]+$/.test(pname)) continue;
      if (await copyIfExists(path.join(BACKUP_LATEST, e.name), path.join(projRoot, pname, 'MEMORY.md'))) count++;
    }
  } catch {
    // fine
  }
  return count;
}

// ------------------------------------------------------------- build
/**
 * Build the /api/persona-memory route family.
 * @param {object} deps
 * @param {ReturnType<import('./memory-store.js').createMemoryStore>} deps.store
 * @param {ReturnType<import('./standing.js').createStandingStore>} deps.standing
 * @param {object} deps.cfg resolved plugin config
 * @param {ReturnType<import('./vector-index.js').createVectorIndex>} deps.vector
 * @param {string} deps.profilePatch absolute path to the active profile's cordis.patch.yml
 * @param {(s: string) => void} deps.log
 * @returns {import('@deepseek-ai/dsh-host-webserver').WebRoute[]}
 */
export function makeAdminRoutes(deps) {
  const { store, standing, cfg, vector, profilePatch, log } = deps;

  /** Guard helper: fence + method check. */
  const guard = (req, res, method) => {
    if (!isLoopbackRequest(req)) {
      writeJson(res, 403, { error: 'forbidden: loopback-only' });
      return false;
    }
    if (req.method !== method) {
      writeJson(res, 405, { error: `method not allowed: ${req.method}` });
      return false;
    }
    return true;
  };

  /** Store summaries for the status page. */
  function summarizeStores() {
    const out = {};
    for (const which of ['memory', 'user', 'failure']) {
      const file = store.fileFor(which);
      const raw = readRaw(file);
      const limit = which === 'user' ? (cfg.userCharLimit ?? 5000)
        : which === 'failure' ? (cfg.failureCharLimit ?? (cfg.memoryCharLimit ?? 5000) * 2)
          : (cfg.memoryCharLimit ?? 5000);
      out[which] = raw === null
        ? { exists: false, entries: 0, chars: 0, usagePct: 0 }
        : {
            exists: true,
            entries: parseEntries(raw).length,
            chars: raw.length,
            usagePct: Math.min(100, Math.round((raw.length / limit) * 100)),
          };
    }
    return out;
  }

  /** Entry lists for the status page (raw text, decoded). */
  function listEntries() {
    const out = { memory: [], user: [], failure: [] };
    for (const which of Object.keys(out)) {
      const raw = readRaw(store.fileFor(which));
      if (raw === null) continue;
      for (const entry of parseEntries(raw)) {
        const decoded = decodeEntry(entry);
        out[which].push({ text: decoded.text, created: decoded.created, lastReferenced: decoded.lastReferenced, project: decoded.project });
      }
    }
    return out;
  }

  /** Standing instructions (snapshot). */
  function standingSnapshot() {
    const raw = readRaw(standing.file);
    return raw === null ? { exists: false, instructions: [], chars: 0 } : {
      exists: true,
      instructions: parseInstructions(raw),
      chars: raw.length,
    };
  }

  /** Index file sizes. FTS lives beside the memory files; the vector index
   *  lives under vectorIndexDir (never inside the Pi-shared dir). */
  function statIndex(file) {
    try {
      const s = fs.statSync(file);
      return { exists: true, size: s.size };
    } catch {
      return { exists: false, size: 0 };
    }
  }
  const vectorIndexFile = () => path.join(
    (cfg.vectorIndexDir && String(cfg.vectorIndexDir).trim() !== '' ? cfg.vectorIndexDir : path.join(os.homedir(), '.dsh', 'memory')),
    '.memory-vec.sqlite',
  );

  /** Scan the local model cache directory for downloaded embedding models. */
  function listModels() {
    const dir = cfg.embeddingCacheDir && String(cfg.embeddingCacheDir).trim() !== ''
      ? cfg.embeddingCacheDir
      : path.join(os.homedir(), '.dsh', 'models');
    const models = [];
    const walk = (base, prefix) => {
      let entries;
      try {
        entries = fs.readdirSync(base, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        const full = path.join(base, e.name);
        if (fs.existsSync(path.join(full, 'config.json'))) {
          models.push({ name: rel });
        } else {
          walk(full, rel);
        }
      }
    };
    walk(dir, '');
    return { dir, models };
  }

  /** List project memories. */
  function listProjects() {
    const projRoot = resolveProjectsRoot(cfg.dir ?? resolveMemoryDir(cfg));
    const out = [];
    let entries;
    try {
      entries = fs.readdirSync(projRoot, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const file = path.join(projRoot, e.name, 'MEMORY.md');
      const raw = readRaw(file);
      const entryList = raw !== null ? parseEntries(raw).map((x) => decodeEntry(x)) : [];
      out.push({ name: e.name, exists: raw !== null, entries: entryList.length, chars: raw !== null ? raw.length : 0, entryList });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  /** Mutate one project memory file. */
  function mutateProject(project, change) {
    const projRoot = resolveProjectsRoot(cfg.dir ?? resolveMemoryDir(cfg));
    if (!project || !/^[A-Za-z0-9._-]+$/.test(project) || project.includes('..')) {
      return { ok: false, error: 'invalid project name' };
    }
    const file = path.join(projRoot, project, 'MEMORY.md');
    const raw = readRaw(file);
    const list = raw !== null ? parseEntries(raw).map((x) => decodeEntry(x)) : [];
    const outcome = change(list);
    if (outcome.error) return { ok: false, error: outcome.error };
    const next = outcome.next.map((e) => encodeEntry(e.text, e.created, e.lastReferenced));
    writeRawAtomic(file, next.length ? next.join(ENTRY_DELIMITER) : '');
    return { ok: true, message: outcome.message ?? `${project} 已更新（${next.length} 条）` };
  }

  /** Current config echoed from the resolved cfg + defaults. */
  function currentConfig() {
    return Object.assign({}, CFG_DEFAULTS, {
      dir: cfg.dir ?? '',
      vectorEnabled: cfg.vectorEnabled !== false,
      embeddingProvider: cfg.embeddingProvider || 'local',
      embeddingModel: cfg.embeddingModel || 'Xenova/bge-small-zh-v1.5',
      embeddingRemoteHost: cfg.embeddingRemoteHost || 'https://huggingface.co',
      embeddingCacheDir: cfg.embeddingCacheDir || '',
    });
  }

  /** Full status payload for the admin page. */
  function statusPayload() {
    const stores = summarizeStores();
    const standingInfo = standingSnapshot();
    const dir = resolveMemoryDir(cfg);
    return {
      dir,
      which: String(dir).includes('.pi') ? 'pi-shared' : 'dsh-only',
      config: currentConfig(),
      schema: CFG_SCHEMA,
      backupDir: BACKUP_BASE,
      backups: listBackups(),
      stores,
      standing: standingInfo,
      indexes: {
        fts: statIndex(path.join(dir, '.memory-index.sqlite')),
        vector: statIndex(vectorIndexFile()),
      },
      models: listModels(),
      projects: listProjects(),
      entries: listEntries(),
      ts: Date.now(),
    };
  }

  // ----------------------------------------------------------- mutations
  /**
   * Mutate one store by decoded-entry index.
   */
  async function mutateStore(which, change) {
    if (!['memory', 'user', 'failure'].includes(which)) return { ok: false, error: 'invalid which' };
    const file = store.fileFor(which);
    const raw = readRaw(file);
    if (raw === null) return { ok: false, error: 'file not found' };
    const current = parseEntries(raw).map(decodeEntry);
    const outcome = change(current);
    if (outcome.error) return { ok: false, error: outcome.error };
    const next = outcome.next.map((e) => encodeEntry(e.text, e.created, e.lastReferenced));
    const limit = which === 'user' ? (cfg.userCharLimit ?? 5000)
      : which === 'failure' ? (cfg.failureCharLimit ?? (cfg.memoryCharLimit ?? 5000) * 2)
        : (cfg.memoryCharLimit ?? 5000);
    const charCount = next.length ? next.join(ENTRY_DELIMITER).length : 0;
    if (charCount > limit) return { ok: false, error: `容量超限（${charCount} > ${limit}），请先合并或精简` };
    writeRawAtomic(file, next.length ? next.join(ENTRY_DELIMITER) : '');
    return { ok: true, message: outcome.message ?? `${which} 已更新（${next.length} 条）`, entryCount: next.length };
  }

  /** Mutate standing instructions. */
  async function mutateStanding(change) {
    const raw = readRaw(standing.file);
    const current = raw === null ? [] : parseInstructions(raw);
    const outcome = change(current);
    if (outcome.error) return { ok: false, error: outcome.error };
    const chars = outcome.next.join('\n').length;
    if (chars > (cfg.standingCharLimit ?? 2000)) return { ok: false, error: `超过 ${cfg.standingCharLimit ?? 2000} 字符预算` };
    writeRawAtomic(standing.file, outcome.next.length ? outcome.next.join('\n') + '\n' : '');
    return { ok: true, message: outcome.message ?? `常驻指令已更新（${outcome.next.length} 条）` };
  }

  // -------------------------------------------------------------- routes
  return [
    { kind: 'exact', path: '/api/persona-memory/status', handler: async (req, res) => {
      if (!guard(req, res, 'GET')) return;
      try {
        writeJson(res, 200, statusPayload());
      } catch (e) {
        writeJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
      }
    } },
    { kind: 'exact', path: '/api/persona-memory/checkModel', handler: async (req, res) => {
      if (!guard(req, res, 'GET')) return;
      const url = new URL(req.url ?? '/', 'http://localhost');
      const model = queryParam(url, 'model');
      if (!model) { writeJson(res, 200, { cached: false }); return; }
      const base = cfg.embeddingCacheDir && String(cfg.embeddingCacheDir).trim() !== ''
        ? cfg.embeddingCacheDir
        : path.join(os.homedir(), '.dsh', 'models');
      try {
        const cfgFile = path.join(base, ...model.split('/'), 'config.json');
        const cached = fs.existsSync(cfgFile);
        writeJson(res, 200, { cached, path: cached ? path.dirname(cfgFile) : undefined });
      } catch {
        writeJson(res, 200, { cached: false });
      }
    } },
    { kind: 'exact', path: '/api/persona-memory/configSave', handler: async (req, res) => {
      if (!guard(req, res, 'POST')) return;
      const body = await readJsonBody(req);
      if (body === undefined) { writeJson(res, 400, { error: 'invalid JSON body' }); return; }
      try {
        const cfgOut = {};
        for (const f of CFG_SCHEMA) {
          if (!(f.key in body)) continue;
          const raw = body[f.key];
          if (f.type === 'bool') cfgOut[f.key] = !!raw;
          else if (f.type === 'number') cfgOut[f.key] = raw === '' || raw === null || raw === undefined ? undefined : Number(raw);
          else cfgOut[f.key] = raw === null || raw === undefined ? '' : String(raw);
        }
        if (cfgOut.embeddingModel !== undefined && !String(cfgOut.embeddingModel).trim()) {
          writeJson(res, 400, { error: '模型名不能为空' }); return;
        }
        if (!fs.existsSync(profilePatch)) { writeJson(res, 500, { error: `profile patch not found: ${profilePatch}` }); return; }
        const content = fs.readFileSync(profilePatch, 'utf8');
        const next = updateSectionConfig(content, 'persona-memory', cfgOut);
        writeRawAtomic(profilePatch, next);
        log(`admin: config saved to ${profilePatch}`);
        writeJson(res, 200, { ok: true, message: '配置已保存，重启 web 后生效' });
      } catch (e) {
        writeJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
      }
    } },
    { kind: 'exact', path: '/api/persona-memory/update', handler: async (req, res) => {
      if (!guard(req, res, 'POST')) return;
      const body = await readJsonBody(req);
      if (body === undefined) { writeJson(res, 400, { error: 'invalid JSON body' }); return; }
      const which = String(body.which || '');
      const index = Number(body.index);
      const text = String(body.text || '').trim();
      if (!text) { writeJson(res, 400, { error: '内容不能为空' }); return; }
      const result = await mutateStore(which, (list) => {
        if (!Number.isInteger(index) || index < 0 || index >= list.length) return { error: 'index out of range' };
        const updated = list.map((e, i) => i === index ? { ...e, text, lastReferenced: today() } : e);
        return { next: updated, message: `${which} 条目已更新` };
      });
      writeJson(res, result.ok ? 200 : 400, result);
    } },
    { kind: 'exact', path: '/api/persona-memory/delete', handler: async (req, res) => {
      if (!guard(req, res, 'POST')) return;
      const body = await readJsonBody(req);
      if (body === undefined) { writeJson(res, 400, { error: 'invalid JSON body' }); return; }
      const which = String(body.which || '');
      const index = Number(body.index);
      const result = await mutateStore(which, (list) => {
        if (!Number.isInteger(index) || index < 0 || index >= list.length) return { error: 'index out of range' };
        return { next: list.filter((_, i) => i !== index), message: `${which} 条目已删除` };
      });
      writeJson(res, result.ok ? 200 : 400, result);
    } },
    { kind: 'exact', path: '/api/persona-memory/projectUpdate', handler: async (req, res) => {
      if (!guard(req, res, 'POST')) return;
      const body = await readJsonBody(req);
      if (body === undefined) { writeJson(res, 400, { error: 'invalid JSON body' }); return; }
      const project = String(body.project || '');
      const index = Number(body.index);
      const text = String(body.text || '').trim();
      if (!text) { writeJson(res, 400, { error: '内容不能为空' }); return; }
      const result = mutateProject(project, (list) => {
        if (!Number.isInteger(index) || index < 0 || index >= list.length) return { error: 'index out of range' };
        const next = list.map((e, i) => i === index ? { ...e, text, lastReferenced: today() } : e);
        return { next, message: `${project} 条目已更新` };
      });
      writeJson(res, result.ok ? 200 : 400, result);
    } },
    { kind: 'exact', path: '/api/persona-memory/projectDelete', handler: async (req, res) => {
      if (!guard(req, res, 'POST')) return;
      const body = await readJsonBody(req);
      if (body === undefined) { writeJson(res, 400, { error: 'invalid JSON body' }); return; }
      const project = String(body.project || '');
      const index = Number(body.index);
      const result = mutateProject(project, (list) => {
        if (!Number.isInteger(index) || index < 0 || index >= list.length) return { error: 'index out of range' };
        return { next: list.filter((_, i) => i !== index), message: `${project} 条目已删除` };
      });
      writeJson(res, result.ok ? 200 : 400, result);
    } },
    { kind: 'exact', path: '/api/persona-memory/backup', handler: async (req, res) => {
      if (!guard(req, res, 'POST')) return;
      try {
        const result = await backupAll(cfg);
        writeJson(res, 200, result);
      } catch (e) {
        writeJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
      }
    } },
    { kind: 'exact', path: '/api/persona-memory/restoreLatest', handler: async (req, res) => {
      if (!guard(req, res, 'POST')) return;
      try {
        const count = await restoreFromLatest(cfg);
        log(`admin: restored ${count} files from latest backup`);
        writeJson(res, 200, { ok: true, message: `已从最新备份恢复 ${count} 个文件 → ${resolveMemoryDir(cfg)}` });
      } catch (e) {
        writeJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
      }
    } },
    { kind: 'exact', path: '/api/persona-memory/standingAdd', handler: async (req, res) => {
      if (!guard(req, res, 'POST')) return;
      const body = await readJsonBody(req);
      if (body === undefined) { writeJson(res, 400, { error: 'invalid JSON body' }); return; }
      const text = normalizeInstruction(String(body.text || '').trim());
      if (!text) { writeJson(res, 400, { error: '指令不能为空' }); return; }
      const result = await mutateStanding((list) => {
        if (list.some((x) => x.toLowerCase() === text.toLowerCase())) return { error: '该指令已存在' };
        if (list.length >= (cfg.standingMaxEntries ?? 20)) return { error: `常驻指令上限 ${cfg.standingMaxEntries ?? 20} 条` };
        return { next: [...list, text], message: `已添加常驻指令（共 ${list.length + 1} 条）` };
      });
      writeJson(res, result.ok ? 200 : 400, result);
    } },
    { kind: 'exact', path: '/api/persona-memory/standingUpdate', handler: async (req, res) => {
      if (!guard(req, res, 'POST')) return;
      const body = await readJsonBody(req);
      if (body === undefined) { writeJson(res, 400, { error: 'invalid JSON body' }); return; }
      const index = Number(body.index);
      const text = normalizeInstruction(String(body.text || '').trim());
      if (!text) { writeJson(res, 400, { error: '指令不能为空' }); return; }
      const result = await mutateStanding((list) => {
        if (!Number.isInteger(index) || index < 0 || index >= list.length) return { error: 'index out of range' };
        if (list.some((x, i) => i !== index && x.toLowerCase() === text.toLowerCase())) return { error: '该指令已存在' };
        const next = list.slice();
        next[index] = text;
        return { next, message: '常驻指令已更新' };
      });
      writeJson(res, result.ok ? 200 : 400, result);
    } },
    { kind: 'exact', path: '/api/persona-memory/standingRemove', handler: async (req, res) => {
      if (!guard(req, res, 'POST')) return;
      const body = await readJsonBody(req);
      if (body === undefined) { writeJson(res, 400, { error: 'invalid JSON body' }); return; }
      const index = Number(body.index);
      const result = await mutateStanding((list) => {
        if (!Number.isInteger(index) || index < 0 || index >= list.length) return { error: 'index out of range' };
        return { next: list.filter((_, i) => i !== index), message: '常驻指令已删除' };
      });
      writeJson(res, result.ok ? 200 : 400, result);
    } },
    { kind: 'exact', path: '/api/persona-memory/rebuildVector', handler: async (req, res) => {
      if (!guard(req, res, 'POST')) return;
      try {
        const file = vectorIndexFile();
        if (fs.existsSync(file)) {
          fs.unlinkSync(file);
        }
        log('admin: vector index cleared');
        writeJson(res, 200, { ok: true, message: '向量索引已清空，下次 memory_search 会自动重建' });
      } catch (e) {
        writeJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
      }
    } },
  ];
}

/**
 * Resolve the active profile's cordis.patch.yml for config write-back.
 * @param {string} profileName
 * @returns {string}
 */
export function profilePatchPath(profileName) {
  return path.join(os.homedir(), '.dsh', 'profiles', profileName, 'cordis.patch.yml');
}

// ------------------------------------------------------- auto-protect
/**
 * Start the background auto-protect tick: periodic backup (autoBackupMin)
 * + Pi-loss detection (autoSwitchOnPiLoss). Returns a disposer.
 * @param {object} deps
 * @param {object} deps.cfg resolved plugin config
 * @param {string} deps.profilePatch absolute path to profile patch
 * @param {(s: string) => void} deps.log
 * @param {(fn: () => void, delay: number) => () => void} deps.setInterval injected timer (ctx.timer.interval)
 * @returns {() => void} disposer
 */
export function startAutoProtect(deps) {
  const { cfg, profilePatch, log, setInterval } = deps;
  let piSeen = false;
  let switched = false;
  let lastAutoBackupAt = 0;

  const tick = async () => {
    try {
      const patch = readRaw(profilePatch);
      const patchCfg = patch ? parseSectionConfig(patch, 'persona-memory') : {};
      const backupMin = Number(patchCfg.autoBackupMin ?? cfg.autoBackupMin ?? CFG_DEFAULTS.autoBackupMin);
      const switchOnLoss = patchCfg.autoSwitchOnPiLoss !== false && cfg.autoSwitchOnPiLoss !== false;

      const dir = resolveMemoryDir(cfg);
      const isPi = String(dir).includes('.pi');
      const piMem = path.join(os.homedir(), '.pi', 'agent', 'pi-hermes-memory', 'MEMORY.md');
      const piExists = fs.existsSync(piMem);

      if (isPi && piExists) piSeen = true;
      if (switchOnLoss && isPi && piSeen && !piExists && !switched) {
        switched = true;
        const localDir = path.join(os.homedir(), '.dsh', 'memory');
        log('Pi memory lost — switching to local dir + restore from latest backup');
        if (fs.existsSync(profilePatch)) {
          const content = fs.readFileSync(profilePatch, 'utf8');
          const next = updateSectionConfig(content, 'persona-memory', { dir: localDir });
          writeRawAtomic(profilePatch, next);
        }
        await restoreFromLatest(cfg, localDir);
      }

      if (backupMin > 0) {
        const now = Date.now();
        if (now - lastAutoBackupAt >= backupMin * 60 * 1000) {
          lastAutoBackupAt = now;
          await backupAll(cfg);
        }
      }
    } catch (err) {
      log(`auto-protect tick error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  tick();
  return setInterval(() => { tick(); }, 60 * 1000);
}
