// @ts-check
/**
 * Admin routes for dsh-persona-memory — the browser-half settings page
 * ("记忆管理") talks to these /api/persona-memory/* routes.
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
 */
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { parseEntries, decodeEntry, ENTRY_DELIMITER } from './memory-store.js';
import { parseInstructions, normalizeInstruction } from './standing.js';

/** Cap on JSON request bodies (admin payloads are small). */
const MAX_JSON_BODY_BYTES = 64 * 1024;

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
 * Build the /api/persona-memory route family.
 * @param {object} deps
 * @param {ReturnType<import('./memory-store.js').createMemoryStore>} deps.store
 * @param {ReturnType<import('./standing.js').createStandingStore>} deps.standing
 * @param {object} deps.cfg resolved plugin config (dir, limits, vector dir…)
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

  // ------------------------------------------------------------- state
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
        const hasConfig = fs.existsSync(path.join(full, 'config.json'));
        if (hasConfig) {
          models.push({ name: rel });
        } else {
          walk(full, rel);
        }
      }
    };
    walk(dir, '');
    return { dir, models };
  }

  /** Current config echoed from the resolved cfg (values the client edits). */
  function currentConfig() {
    return {
      vectorEnabled: cfg.vectorEnabled !== false,
      embeddingProvider: cfg.embeddingProvider || 'local',
      embeddingModel: cfg.embeddingModel || 'Xenova/bge-small-zh-v1.5',
      embeddingRemoteHost: cfg.embeddingRemoteHost || 'https://huggingface.co',
      embeddingCacheDir: cfg.embeddingCacheDir || '',
    };
  }

  /** Full status payload for the admin page. */
  function statusPayload() {
    const stores = summarizeStores();
    const standingInfo = standingSnapshot();
    const dir = cfg.dir;
    return {
      dir,
      which: String(dir).includes('.pi') ? 'pi-shared' : 'dsh-only',
      config: currentConfig(),
      stores,
      standing: standingInfo,
      indexes: {
        fts: statIndex(path.join(cfg.dir, '.memory-index.sqlite')),
        vector: statIndex(vectorIndexFile()),
      },
      models: listModels(),
      entries: listEntries(),
      ts: Date.now(),
    };
  }

  // ------------------------------------------------- profile patch (config)
  /** Parse the persona-memory section config out of a patch YAML text. */
  function parseSectionConfig(content, id) {
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
  function updateSectionConfig(content, id, cfg) {
    const lines = content.split(/\r?\n/);
    let sectionIdx = -1;
    let configIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      if (sectionIdx < 0 && /^-\s*id:\s*/.test(t) && t.includes(id)) { sectionIdx = i; continue; }
      if (sectionIdx >= 0 && /^\s*config:\s*$/.test(lines[i]) && lines[i].startsWith('  ')) { configIdx = i; break; }
      if (sectionIdx >= 0 && i > sectionIdx && lines[i].trim() && !lines[i].startsWith(' ') && !/^-\s*id:/.test(t)) break;
    }
    const line = (k) => `    ${k}: ${typeof cfg[k] === 'boolean' ? (cfg[k] ? 'true' : 'false') : cfg[k]}`;
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

  // ----------------------------------------------------------- mutations
  /**
   * Mutate one store by decoded-entry index (admin page edits whole entries).
   * Uses the store's own raw-entry path (listRaw/replaceEntries) so metadata
   * comments survive and the memory format stays Pi-compatible.
   * @param {'memory'|'user'|'failure'} which
   * @param {(list: {text:string,created:string,lastReferenced:string,project:string|null}[]) => ({next?: {text:string,created:string,lastReferenced:string,project:string|null}[], error?: string, message?: string})} change
   */
  async function mutateStore(which, change) {
    if (!['memory', 'user', 'failure'].includes(which)) return { ok: false, error: 'invalid which' };
    const file = store.fileFor(which);
    const raw = readRaw(file);
    if (raw === null) return { ok: false, error: 'file not found' };
    const current = parseEntries(raw).map(decodeEntry);
    const outcome = change(current);
    if (outcome.error) return { ok: false, error: outcome.error };
    const next = outcome.next.map((e) => encodeEntry(e.text, e.created, e.lastReferenced, e.project));
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
    {
      kind: 'exact',
      path: '/api/persona-memory/status',
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return;
        try {
          writeJson(res, 200, statusPayload());
        } catch (e) {
          writeJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
        }
      },
    },
    {
      kind: 'exact',
      path: '/api/persona-memory/checkModel',
      handler: async (req, res) => {
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
      },
    },
    {
      kind: 'exact',
      path: '/api/persona-memory/configSave',
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return;
        const body = await readJsonBody(req);
        if (body === undefined) { writeJson(res, 400, { error: 'invalid JSON body' }); return; }
        try {
          const cfg = {};
          for (const k of ['vectorEnabled', 'embeddingProvider', 'embeddingModel', 'embeddingRemoteHost', 'embeddingCacheDir']) {
            if (k in body) cfg[k] = body[k];
          }
          if (!cfg.embeddingModel || !String(cfg.embeddingModel).trim()) { writeJson(res, 400, { error: '模型名不能为空' }); return; }
          if (!cfg.embeddingRemoteHost || !String(cfg.embeddingRemoteHost).trim()) { writeJson(res, 400, { error: '下载源不能为空' }); return; }
          if (!fs.existsSync(profilePatch)) { writeJson(res, 500, { error: `profile patch not found: ${profilePatch}` }); return; }
          const content = fs.readFileSync(profilePatch, 'utf8');
          const next = updateSectionConfig(content, 'persona-memory', cfg);
          writeRawAtomic(profilePatch, next);
          log(`admin: config saved to ${profilePatch}`);
          writeJson(res, 200, { ok: true, message: '配置已保存，重启 web 后生效' });
        } catch (e) {
          writeJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
        }
      },
    },
    {
      kind: 'exact',
      path: '/api/persona-memory/update',
      handler: async (req, res) => {
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
      },
    },
    {
      kind: 'exact',
      path: '/api/persona-memory/delete',
      handler: async (req, res) => {
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
      },
    },
    {
      kind: 'exact',
      path: '/api/persona-memory/standingAdd',
      handler: async (req, res) => {
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
      },
    },
    {
      kind: 'exact',
      path: '/api/persona-memory/standingUpdate',
      handler: async (req, res) => {
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
      },
    },
    {
      kind: 'exact',
      path: '/api/persona-memory/standingRemove',
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return;
        const body = await readJsonBody(req);
        if (body === undefined) { writeJson(res, 400, { error: 'invalid JSON body' }); return; }
        const index = Number(body.index);
        const result = await mutateStanding((list) => {
          if (!Number.isInteger(index) || index < 0 || index >= list.length) return { error: 'index out of range' };
          return { next: list.filter((_, i) => i !== index), message: '常驻指令已删除' };
        });
        writeJson(res, result.ok ? 200 : 400, result);
      },
    },
    {
      kind: 'exact',
      path: '/api/persona-memory/rebuildVector',
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return;
        try {
          const file = vectorIndexFile();
          if (fs.existsSync(file)) {
            // Drop the derived index file; it rebuilds from the Markdown on
            // next search (fingerprint sync). Never touches the memory files.
            fs.unlinkSync(file);
          }
          log('admin: vector index cleared');
          writeJson(res, 200, { ok: true, message: '向量索引已清空，下次 memory_search 会自动重建' });
        } catch (e) {
          writeJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
        }
      },
    },
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
