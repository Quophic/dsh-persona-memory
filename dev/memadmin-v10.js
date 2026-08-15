/**
 * dsh-persona-memory · 记忆管理设置页（动态 Cordis 插件存档）
 * ============================================================
 * 版本：v10（memadm-25 / pkg-25，2025 存档于 dev/memadmin-ui 分支）
 *
 * 这是什么：
 *   一个临时动态 Cordis 插件，在 DSH WebUI 设置页（settings.section
 *   slot，id=persona-memory，order=25）注册「记忆管理」区块，提供：
 *     - 常驻指令（STANDING.md）查看/新增/编辑/删除
 *     - 三记忆文件（MEMORY.md / USER.md / failures.md）条目编辑/删除
 *     - FTS5 / 向量索引状态 + 重建按钮
 *     - 向量搜索配置（开关 / 模型 / 下载源 / 缓存目录，写回 profile
 *       cordis.patch.yml 的 persona-memory 段 config）
 *     - 已下载模型扫描 + 点击选用 + 输入模型实时缓存检测
 *
 * 为什么存这份存档：
 *   动态插件只活在当前 DSH 进程里，进程重启后丢失。存档后可从本文件
 *   快速恢复（见下方「如何恢复」），且迭代代码有 git 版本管理。
 *   UI 定稿后再固化进 dsh-persona-memory 本体（bundle 插件，升 0.1.13）。
 *
 * 如何恢复（进程重启丢失后）：
 *   1. cordis_define  kind:new  idPrefix:memadm  name:memadmin
 *      code.host   = hostSource 的内容
 *      code.client = clientSource 的内容
 *   2. cordis_run  pluginId=<返回的 id>  packageId=<返回的 pkg id>  mode:run
 *   3. 等待宿主批准（若为双勾授权则自动生效）
 *
 * 技术要点（动态插件沙箱限制）：
 *   - Host 侧没有 require/process，文件访问用 ctx.get('fs') 服务；
 *     相对路径经 fs.resolve('.') 解析到用户主目录。
 *   - harness 是全局 builtin（不是 ctx 服务），用 harness.handle 注册
 *     Client→Host 的 JSON 方法。
 *   - Client 侧没有浏览器全局 setTimeout，防抖必须用 ctx.timer.timeout
 *     （inject: ['timer']），并返回其 disposer 作为 useEffect 清理。
 *   - UI 用 React.createElement（无 JSX），主题变量用 --dsw-alias-*。
 */

export const hostSource = `return {
  apply(ctx) {
    const fs = ctx.get('fs')
    const tryResolve = async (rel) => { if (!fs) return null; try { const t = await fs.resolve(rel); return t.displayPath || t.targetKey || null } catch { return null } }
    const memDir = async () => (await tryResolve('.pi/agent/pi-hermes-memory')) || (await tryResolve('.dsh/memory'))
    const readRaw = async (dir, name) => {
      const file = dir ? await tryResolve(dir.replace(/\\\\/g, '/') + '/' + name) : null
      if (!file) return null
      try { const t = await fs.resolve(file); const s = await fs.stat(t); if (!s) return null; return await fs.readText(t) } catch { return null }
    }
    const writeRaw = async (dir, name, content) => {
      const file = dir ? await tryResolve(dir.replace(/\\\\/g, '/') + '/' + name) : null
      if (!file) return { ok: false, error: 'file path unavailable' }
      try { const t = await fs.resolve(file); await fs.writeText(t, content); return { ok: true } } catch (e) { return { ok: false, error: String(e?.message || e) } }
    }
    const parseEntries = (raw) => (raw || '').split('\\n§\\n').map((e) => e.trim()).filter(Boolean)
    const encodeEntries = (list) => (list.length ? list.join('\\n§\\n') : '')
    const parseStanding = (raw) => (raw || '').split(/\\r?\\n/).map((l) => l.replace(/^\\s*[-*]\\s+/, '').replace(/\\s+/g, ' ').trim()).filter((l) => l && !l.startsWith('#'))
    const encodeStanding = (list) => (list.length ? list.join('\\n') + '\\n' : '')

    const profilePatchPath = async () => await tryResolve('.dsh/profiles/web/cordis.patch.yml')
    const readProfilePatch = async () => {
      const p = await profilePatchPath()
      if (!p) return null
      try { const t = await fs.resolve(p); return await fs.readText(t) } catch { return null }
    }
    const writeProfilePatch = async (content) => {
      const p = await profilePatchPath()
      if (!p) return { ok: false, error: 'profile patch path unavailable' }
      try { const t = await fs.resolve(p); await fs.writeText(t, content); return { ok: true } } catch (e) { return { ok: false, error: String(e?.message || e) } }
    }
    const parseSectionConfig = (content, id) => {
      const lines = content.split(/\\r?\\n/)
      let inSection = false, inConfig = false
      const cfg = {}
      for (const line of lines) {
        const trimmed = line.trim()
        if (!inSection) { if (/^-\\s*id:\\s*/.test(trimmed) && trimmed.includes(id)) { inSection = true; continue } continue }
        if (inConfig) {
          const m = /^\\s*([A-Za-z][A-Za-z0-9_]*):\\s*(.*)$/.exec(line)
          if (m && line.startsWith('    ')) { const v = m[2].trim(); cfg[m[1]] = v === 'true' ? true : v === 'false' ? false : v.replace(/^['\"]|['\"]$/g, ''); continue }
          if (!line.startsWith('    ') && line.trim()) break
          continue
        }
        if (/^\\s*config:\\s*$/.test(line) && line.startsWith('  ')) { inConfig = true; continue }
        if (!line.startsWith(' ') && line.trim()) break
      }
      return cfg
    }
    const updateSectionConfig = (content, id, cfg) => {
      const lines = content.split(/\\r?\\n/)
      let sectionIdx = -1, configIdx = -1
      for (let i = 0; i < lines.length; i++) {
        const t = lines[i].trim()
        if (sectionIdx < 0 && /^-\\s*id:\\s*/.test(t) && t.includes(id)) { sectionIdx = i; continue }
        if (sectionIdx >= 0 && /^\\s*config:\\s*$/.test(lines[i]) && lines[i].startsWith('  ')) { configIdx = i; break }
        if (sectionIdx >= 0 && i > sectionIdx && lines[i].trim() && !lines[i].startsWith(' ') && !/^-\\s*id:/.test(t)) break
      }
      if (sectionIdx < 0) {
        const block = ['', '- id: ' + id, '  config:']
        for (const k of Object.keys(cfg)) block.push('    ' + k + ': ' + (typeof cfg[k] === 'boolean' ? (cfg[k] ? 'true' : 'false') : cfg[k]))
        return content.replace(/\\s*$/, '') + '\\n' + block.join('\\n') + '\\n'
      }
      if (configIdx < 0) {
        const block = ['  config:']
        for (const k of Object.keys(cfg)) block.push('    ' + k + ': ' + (typeof cfg[k] === 'boolean' ? (cfg[k] ? 'true' : 'false') : cfg[k]))
        lines.splice(sectionIdx + 1, 0, ...block)
        return lines.join('\\n')
      }
      const endIdx = (() => { for (let i = configIdx + 1; i < lines.length; i++) { if (lines[i].trim() && !lines[i].startsWith('    ') && !lines[i].startsWith('  ')) return i; if (lines[i].trim() && lines[i].startsWith('  ') && !lines[i].startsWith('    ')) return i } return lines.length })()
      const existing = new Set()
      for (let i = configIdx + 1; i < endIdx; i++) {
        const m = /^\\s*([A-Za-z][A-Za-z0-9_]*):/.exec(lines[i])
        if (m) { const k = m[1]; existing.add(k); if (k in cfg) lines[i] = '    ' + k + ': ' + (typeof cfg[k] === 'boolean' ? (cfg[k] ? 'true' : 'false') : cfg[k]) }
      }
      const insert = []
      for (const k of Object.keys(cfg)) if (!existing.has(k)) insert.push('    ' + k + ': ' + (typeof cfg[k] === 'boolean' ? (cfg[k] ? 'true' : 'false') : cfg[k]))
      if (insert.length) lines.splice(endIdx, 0, ...insert)
      return lines.join('\\n')
    }

    const loadAll = async () => {
      const dir = await memDir()
      const memRaw = await readRaw(dir, 'MEMORY.md')
      const userRaw = await readRaw(dir, 'USER.md')
      const failRaw = await readRaw(dir, 'failures.md')
      const standingRaw = await readRaw(dir, 'STANDING.md')
      const summarize = (raw, limit) => ({
        exists: raw !== null, entries: raw !== null ? parseEntries(raw).length : 0,
        chars: raw !== null ? raw.length : 0, size: raw !== null ? raw.length : 0,
        usagePct: raw !== null && limit > 0 ? Math.min(100, Math.round((raw.length / limit) * 100)) : 0,
      })
      const statIdx = async (rel) => {
        const p = await tryResolve(rel); if (!p) return { exists: false, size: 0 }
        try { const t = await fs.resolve(p); const s = await fs.stat(t); return { exists: !!s, size: s?.size ?? 0 } } catch { return { exists: false, size: 0 } }
      }
      const scanModels = async (baseTarget, prefix) => {
        let entries = []
        try { entries = await fs.listDir(baseTarget) } catch { return [] }
        const out = []
        for (const e of entries) {
          const name = e.name || (e.targetKey || '').split(/[\\\\/]/).pop() || ''
          if (!name) continue
          let st = null
          try { st = await fs.stat(e.target) } catch {}
          if (!st || st.type !== 'directory') continue
          const rel = prefix ? prefix + '/' + name : name
          let isModel = false
          try {
            const cfgTarget = await fs.resolve('.dsh/models/' + rel + '/config.json')
            const cfgStat = await fs.stat(cfgTarget)
            if (cfgStat) isModel = true
          } catch {}
          if (isModel) { out.push({ name: rel }); continue }
          const children = await scanModels(e.target, rel)
          if (children.length > 0) out.push(...children)
          else out.push({ name: rel, leaf: true })
        }
        return out
      }
      const listModels = async () => {
        const modelsDir = await tryResolve('.dsh/models')
        if (!modelsDir) return { dir: null, models: [] }
        try {
          const t = await fs.resolve(modelsDir)
          const models = await scanModels(t, '')
          return { dir: modelsDir, models }
        } catch { return { dir: modelsDir, models: [] } }
      }
      const piDir = await tryResolve('.pi/agent/pi-hermes-memory')
      const which = dir === piDir ? 'pi-shared' : 'dsh-only'
      const patch = await readProfilePatch()
      const config = patch ? parseSectionConfig(patch, 'persona-memory') : {}
      return {
        dir, which, config,
        stores: { memory: summarize(memRaw, 5000), user: summarize(userRaw, 5000), failure: summarize(failRaw, 10000) },
        standing: { exists: standingRaw !== null, instructions: standingRaw !== null ? parseStanding(standingRaw) : [], chars: standingRaw !== null ? standingRaw.length : 0 },
        indexes: { fts: await statIdx((dir || '.') + '/.memory-index.sqlite'), vector: await statIdx((dir || '.') + '/.memory-vec.sqlite') },
        models: await listModels(),
        entries: {
          memory: memRaw !== null ? parseEntries(memRaw).map((e) => ({ text: e })) : [],
          user: userRaw !== null ? parseEntries(userRaw).map((e) => ({ text: e })) : [],
          failure: failRaw !== null ? parseEntries(failRaw).map((e) => ({ text: e })) : [],
        },
        ts: Date.now(),
      }
    }

    const mutStore = async (which, fn) => {
      const dir = await memDir()
      const name = which === 'user' ? 'USER.md' : which === 'failure' ? 'failures.md' : 'MEMORY.md'
      const raw = await readRaw(dir, name)
      if (raw === null) return { ok: false, error: 'file not found' }
      const list = parseEntries(raw)
      const out = fn(list)
      if (out.error) return { ok: false, error: out.error }
      const res = await writeRaw(dir, name, encodeEntries(out.list))
      return res.ok ? { ok: true, message: which + ' 已更新 (' + out.list.length + ' 条)' } : res
    }
    const mutStanding = async (fn) => {
      const dir = await memDir()
      const raw = await readRaw(dir, 'STANDING.md')
      const list = raw !== null ? parseStanding(raw) : []
      const out = fn(list)
      if (out.error) return { ok: false, error: out.error }
      const res = await writeRaw(dir, 'STANDING.md', encodeStanding(out.list))
      return res.ok ? { ok: true, message: '常驻指令已更新 (' + out.list.length + ' 条)' } : res
    }

    harness.handle('memadmin/status', async () => (await loadAll()))
    harness.handle('memadmin/checkModel', async (args) => {
      const model = String(args.model || '').trim()
      if (!model) return { cached: false }
      try {
        const cfgTarget = await fs.resolve('.dsh/models/' + model + '/config.json')
        const cfgStat = await fs.stat(cfgTarget)
        if (cfgStat) return { cached: true, path: (await tryResolve('.dsh/models/' + model)) }
      } catch {}
      return { cached: false }
    })
    harness.handle('memadmin/configSave', async (args) => {
      const cfg = {}
      for (const k of ['vectorEnabled', 'embeddingProvider', 'embeddingModel', 'embeddingRemoteHost', 'embeddingCacheDir']) {
        if (k in args) cfg[k] = args[k]
      }
      if (!cfg.embeddingModel || !String(cfg.embeddingModel).trim()) return { ok: false, error: '模型名不能为空' }
      if (!cfg.embeddingRemoteHost || !String(cfg.embeddingRemoteHost).trim()) return { ok: false, error: '下载源不能为空' }
      const patch = await readProfilePatch()
      if (patch === null) return { ok: false, error: '无法读取 profile 配置' }
      const next = updateSectionConfig(patch, 'persona-memory', cfg)
      const res = await writeProfilePatch(next)
      if (!res.ok) return res
      return { ok: true, message: '配置已保存，重启 web 后生效' }
    })
    harness.handle('memadmin/update', async (args) => {
      const which = String(args.which || ''); const index = Number(args.index); const text = String(args.text || '').trim()
      if (!['memory', 'user', 'failure'].includes(which)) return { ok: false, error: 'invalid which' }
      if (!text) return { ok: false, error: '内容不能为空' }
      return mutStore(which, (list) => { if (index < 0 || index >= list.length) return { error: 'index out of range' }; list[index] = text; return { list } })
    })
    harness.handle('memadmin/delete', async (args) => {
      const which = String(args.which || ''); const index = Number(args.index)
      if (!['memory', 'user', 'failure'].includes(which)) return { ok: false, error: 'invalid which' }
      return mutStore(which, (list) => { if (index < 0 || index >= list.length) return { error: 'index out of range' }; list.splice(index, 1); return { list } })
    })
    harness.handle('memadmin/standingAdd', async (args) => {
      const text = String(args.text || '').trim()
      if (!text) return { ok: false, error: '指令不能为空' }
      return mutStanding((list) => {
        if (list.some((x) => x.toLowerCase() === text.toLowerCase())) return { error: '该指令已存在' }
        if (list.length >= 20) return { error: '常驻指令上限 20 条' }
        if ([...list, text].join('\\n').length > 2000) return { error: '超过 2000 字符预算' }
        return { list: [...list, text] }
      })
    })
    harness.handle('memadmin/standingUpdate', async (args) => {
      const index = Number(args.index); const text = String(args.text || '').trim()
      if (!text) return { ok: false, error: '指令不能为空' }
      return mutStanding((list) => {
        if (index < 0 || index >= list.length) return { error: 'index out of range' }
        if (list.some((x, i) => i !== index && x.toLowerCase() === text.toLowerCase())) return { error: '该指令已存在' }
        list[index] = text; return { list }
      })
    })
    harness.handle('memadmin/standingRemove', async (args) => {
      const index = Number(args.index)
      return mutStanding((list) => { if (index < 0 || index >= list.length) return { error: 'index out of range' }; list.splice(index, 1); return { list } })
    })
    harness.handle('memadmin/rebuildVector', async () => {
      const dir = await memDir()
      const p = await tryResolve((dir || '.') + '/.memory-vec.sqlite')
      if (p) { try { const t = await fs.resolve(p); await fs.writeText(t, ''); } catch (e) { return { ok: false, error: 'clear failed: ' + String(e?.message || e) } } }
      return { ok: true, message: '向量索引已清空，下次 memory_search 会自动重建' }
    })
  }
}`

export const clientSource = `return {
  inject: ['timer'],
  apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) return
    slots.inject('settings.section', () => slots.register(
      { name: 'settings.section', id: 'persona-memory', order: 25, label: '记忆管理' },
      (props) => {
        const [state, setState] = React.useState(null)
        const [error, setError] = React.useState(null)
        const [busy, setBusy] = React.useState(false)
        const [editing, setEditing] = React.useState(null)
        const [confirmDel, setConfirmDel] = React.useState(null)
        const [standingEdit, setStandingEdit] = React.useState(null)
        const [newStanding, setNewStanding] = React.useState('')
        const [open, setOpen] = React.useState({ standing: true, files: true, indexes: true })
        const [notice, setNotice] = React.useState(null)
        const [cfgForm, setCfgForm] = React.useState(null)
        const [modelStatus, setModelStatus] = React.useState(null)
        const load = React.useCallback(async () => {
          setBusy(true); setError(null)
          try {
            const s = await host.call('memadmin/status', {})
            setState(s)
            if (s && s.config) setCfgForm({
              vectorEnabled: s.config.vectorEnabled !== false,
              embeddingProvider: s.config.embeddingProvider || 'local',
              embeddingModel: s.config.embeddingModel || 'Xenova/bge-small-zh-v1.5',
              embeddingRemoteHost: s.config.embeddingRemoteHost || 'https://huggingface.co',
              embeddingCacheDir: s.config.embeddingCacheDir || '',
            })
          }
          catch (e) { setError(String((e && e.message) || e)) }
          finally { setBusy(false) }
        }, [])
        React.useEffect(() => { load() }, [load])

        // 防抖检查模型缓存：用 ctx.timer.timeout（动态 Client 无 setTimeout 全局）
        const modelName = cfgForm ? cfgForm.embeddingModel : null
        React.useEffect(() => {
          if (!modelName || !modelName.trim()) return
          setModelStatus({ checking: true })
          const dispose = ctx.timer.timeout(async () => {
            try {
              const res = await host.call('memadmin/checkModel', { model: modelName.trim() })
              setModelStatus({ checking: false, cached: !!(res && res.cached), path: res && res.path })
            } catch { setModelStatus({ checking: false, cached: false }) }
          }, 400)
          return dispose
        }, [modelName])

        const mutate = async (action, payload) => {
          setBusy(true); setError(null); setNotice(null)
          try {
            const res = await host.call('memadmin/' + action, payload)
            if (res && res.error) setNotice('操作失败: ' + res.error)
            else setNotice((res && res.message) || '完成')
            setEditing(null); setConfirmDel(null); setStandingEdit(null); setNewStanding('')
            await load()
          } catch (e) { setError(String((e && e.message) || e)) }
          finally { setBusy(false) }
        }
        const saveConfig = async () => {
          if (!cfgForm) return
          setBusy(true); setError(null); setNotice(null)
          try {
            const res = await host.call('memadmin/configSave', cfgForm)
            if (res && res.error) setNotice('保存失败: ' + res.error)
            else setNotice((res && res.message) || '配置已保存')
            await load()
          } catch (e) { setError(String((e && e.message) || e)) }
          finally { setBusy(false) }
        }

        const fmtBytes = (n) => { if (!n && n !== 0) return '-'; if (n < 1024) return n + ' B'; if (n < 1048576) return (n / 1024).toFixed(1) + ' KB'; return (n / 1048576).toFixed(1) + ' MB' }
        const btn = (labelText, onClick, opts) => React.createElement('button', {
          onClick, disabled: busy,
          style: Object.assign({ padding: '5px 12px', borderRadius: 6, fontSize: 13, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', cursor: busy ? 'default' : 'pointer' }, opts || {}),
        }, labelText)
        const input = (value, onChange, placeholder) => React.createElement('input', {
          value, onChange: (e) => onChange(e.target.value), placeholder,
          style: { width: '100%', boxSizing: 'border-box', padding: '6px 10px', borderRadius: 6, fontSize: 13, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)' },
        })
        const meter = (pct) => React.createElement('div', { style: { height: 4, background: 'var(--dsw-alias-border-l1)', borderRadius: 2, overflow: 'hidden', margin: '4px 0 6px' } },
          React.createElement('div', { style: { height: 4, width: pct + '%', background: pct >= 90 ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-success-primary)', borderRadius: 2, transition: 'width 0.3s' } }),
        )

        const card = (key, title, summary, children) => {
          const isOpen = open[key]
          return React.createElement('div', { style: { border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8, marginBottom: 10, overflow: 'hidden', background: 'var(--dsw-alias-bg-layer-1)' } },
            React.createElement('div', {
              onClick: () => setOpen(Object.assign({}, open, { [key]: !isOpen })),
              style: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', cursor: 'pointer', userSelect: 'none' },
            },
              React.createElement('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', transition: 'transform 0.2s', transform: isOpen ? 'rotate(90deg)' : 'none' } }, '▸'),
              React.createElement('span', { style: { fontSize: 14, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, title),
              React.createElement('span', { style: { flex: 1 } }),
              summary ? React.createElement('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, summary) : null,
            ),
            isOpen ? React.createElement('div', { style: { padding: '4px 14px 14px', borderTop: '1px solid var(--dsw-alias-border-l1)' } }, children) : null,
          )
        }

        if (error) return React.createElement('div', { style: { maxWidth: 720 } },
          React.createElement('div', { style: { fontWeight: 600, marginBottom: 8 } }, '记忆管理'),
          React.createElement('div', { style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 13 } }, '读取失败: ' + error),
          React.createElement('button', { onClick: load, style: { marginTop: 8 } }, '重试'))
        if (!state) return React.createElement('div', { style: { maxWidth: 720 } },
          React.createElement('div', { style: { fontWeight: 600, marginBottom: 8 } }, '记忆管理'),
          React.createElement('div', { style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary)' } }, busy ? '读取中...' : '正在加载'))

        const st = state.stores || {}
        const idx = state.indexes || {}
        const m = state.models || {}
        const standing = (state.standing || {}).instructions || []
        const whichName = { memory: 'MEMORY.md', user: 'USER.md', failure: 'failures.md' }

        const entryRows = (which) => {
          const list = (state.entries || {})[which] || []
          if (list.length === 0) return React.createElement('div', { style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary)', padding: '6px 0' } }, '（无条目）')
          return list.map((entry, i) => {
            const isEditing = editing && editing.which === which && editing.index === i
            const isConfirm = confirmDel && confirmDel.which === which && confirmDel.index === i
            if (isEditing) return React.createElement('div', { key: which + i, style: { padding: '8px 0', borderBottom: '1px solid var(--dsw-alias-border-l1)' } },
              input(editing.text, (v) => setEditing({ which, index: i, text: v }), '条目内容'),
              React.createElement('div', { style: { display: 'flex', gap: 8, marginTop: 6 } },
                btn('保存', () => mutate('update', { which, index: i, text: editing.text })),
                btn('取消', () => setEditing(null))),
            )
            if (isConfirm) return React.createElement('div', { key: which + i, style: { padding: '8px 0', borderBottom: '1px solid var(--dsw-alias-border-l1)', fontSize: 13 } },
              React.createElement('div', { style: { color: 'var(--dsw-alias-state-warn-primary)', marginBottom: 6 } }, '确认删除这条? ' + String(entry.text || '').slice(0, 60)),
              React.createElement('div', { style: { display: 'flex', gap: 8 } },
                btn('删除', () => mutate('delete', { which, index: i }), { background: 'var(--dsw-alias-state-error-primary)', borderColor: 'transparent', color: '#fff' }),
                btn('取消', () => setConfirmDel(null))),
            )
            return React.createElement('div', { key: which + i, style: { padding: '6px 0', borderBottom: '1px solid var(--dsw-alias-border-l1)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 } },
              React.createElement('span', { style: { fontSize: 13, lineHeight: 1.5, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' } }, String(entry.text || '')),
              React.createElement('div', { style: { display: 'flex', gap: 6, flexShrink: 0 } },
                btn('编辑', () => setEditing({ which, index: i, text: String(entry.text || '') }), { padding: '3px 8px', fontSize: 12 }),
                btn('删除', () => setConfirmDel({ which, index: i, text: String(entry.text || '') }), { padding: '3px 8px', fontSize: 12 })),
            )
          })
        }

        const standingRows = () => {
          if (standing.length === 0) return React.createElement('div', { style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary)', padding: '6px 0' } }, '（无常驻指令，可添加）')
          return standing.map((text, i) => {
            const isEditing = standingEdit && standingEdit.index === i
            if (isEditing) return React.createElement('div', { key: 'st' + i, style: { padding: '8px 0', borderBottom: '1px solid var(--dsw-alias-border-l1)' } },
              input(standingEdit.text, (v) => setStandingEdit({ index: i, text: v }), '指令内容'),
              React.createElement('div', { style: { display: 'flex', gap: 8, marginTop: 6 } },
                btn('保存', () => mutate('standingUpdate', { index: i, text: standingEdit.text })),
                btn('取消', () => setStandingEdit(null))),
            )
            return React.createElement('div', { key: 'st' + i, style: { padding: '6px 0', borderBottom: '1px solid var(--dsw-alias-border-l1)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 } },
              React.createElement('span', { style: { fontSize: 13, lineHeight: 1.5, flex: 1 } }, (i + 1) + '. ' + String(text || '')),
              React.createElement('div', { style: { display: 'flex', gap: 6, flexShrink: 0 } },
                btn('编辑', () => setStandingEdit({ index: i, text: String(text || '') }), { padding: '3px 8px', fontSize: 12 }),
                btn('删除', () => mutate('standingRemove', { index: i }), { padding: '3px 8px', fontSize: 12 })),
            )
          })
        }

        const filesBody = () => React.createElement('div', null,
          ['memory', 'user', 'failure'].map((w) => {
            const s = st[w]
            return React.createElement('div', { key: w, style: { margin: '10px 0' } },
              React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: 13, fontWeight: 600, marginBottom: 2 } },
                React.createElement('span', null, whichName[w]),
                React.createElement('span', { style: { color: 'var(--dsw-alias-label-secondary)', fontWeight: 400 } }, (s && s.exists ? s.entries + ' 条 / ' + s.chars + ' 字符' : '不存在'))),
              s && s.exists ? meter(s.usagePct) : null,
              React.createElement('div', { style: { marginTop: 6 } }, entryRows(w)),
            )
          }),
        )

        const modelStatusLine = () => {
          if (!cfgForm || !cfgForm.embeddingModel || !cfgForm.embeddingModel.trim()) return null
          if (modelStatus && modelStatus.checking) return React.createElement('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', margin: '6px 0' } }, '检查缓存...')
          if (modelStatus && modelStatus.cached) return React.createElement('div', { style: { fontSize: 12, color: 'var(--dsw-alias-state-success-primary)', margin: '6px 0' } }, '已缓存，可直接使用')
          return React.createElement('div', { style: { fontSize: 12, color: 'var(--dsw-alias-state-warn-primary)', margin: '6px 0' } },
            '未缓存 - 保存并重启后，首次 memory_search 会从 ' + (cfgForm.embeddingRemoteHost || 'https://huggingface.co') + ' 自动下载')
        }

        const indexesBody = () => React.createElement('div', null,
          React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', fontSize: 13, borderBottom: '1px solid var(--dsw-alias-border-l1)' } },
            React.createElement('span', null, 'FTS5 全文索引'),
            React.createElement('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, idx.fts && idx.fts.exists ? fmtBytes(idx.fts.size) : '未生成')),
          React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', fontSize: 13, borderBottom: '1px solid var(--dsw-alias-border-l1)' } },
            React.createElement('span', null, '向量索引 (embedding)'),
            React.createElement('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, idx.vector && idx.vector.exists ? fmtBytes(idx.vector.size) : '未启用')),
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 0 2px' } },
            React.createElement('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, '索引可随时重建，不影响记忆本体'),
            btn('重建向量索引', () => mutate('rebuildVector', {}), { background: 'var(--dsw-alias-bg-layer-2)' }),
          ),

          React.createElement('div', { style: { fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '14px 0 8px' } }, '向量搜索配置'),
          cfgForm ? React.createElement('div', null,
            React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', fontSize: 13 } },
              React.createElement('input', {
                type: 'checkbox', checked: cfgForm.vectorEnabled,
                onChange: (e) => setCfgForm(Object.assign({}, cfgForm, { vectorEnabled: e.target.checked })),
              }),
              React.createElement('span', null, '启用向量搜索'),
            ),
            React.createElement('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginBottom: 4 } }, '当前模型'),
            input(cfgForm.embeddingModel, (v) => setCfgForm(Object.assign({}, cfgForm, { embeddingModel: v })), 'embedding 模型名'),
            modelStatusLine(),
            React.createElement('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', margin: '8px 0 4px' } }, '已下载模型（点击选用）'),
            React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6, margin: '4px 0 10px' } },
              (m.models || []).map((mo) => {
                const active = cfgForm.embeddingModel === mo.name
                return btn(mo.name, () => setCfgForm(Object.assign({}, cfgForm, { embeddingModel: mo.name })), {
                  padding: '3px 10px', fontSize: 12, background: 'var(--dsw-alias-bg-layer-2)',
                  borderColor: active ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l2)',
                  color: active ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-primary)',
                  fontWeight: active ? 600 : 400,
                })
              }),
              m.models && m.models.length === 0 ? React.createElement('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, '缓存中暂无模型') : null,
            ),
            React.createElement('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginBottom: 4 } }, '下载源（镜像地址）'),
            input(cfgForm.embeddingRemoteHost, (v) => setCfgForm(Object.assign({}, cfgForm, { embeddingRemoteHost: v })), 'https://huggingface.co 或 https://hf-mirror.com'),
            React.createElement('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', margin: '10px 0 4px' } }, '模型缓存目录'),
            input(cfgForm.embeddingCacheDir, (v) => setCfgForm(Object.assign({}, cfgForm, { embeddingCacheDir: v })), '默认 $DSH_HOME/models'),
            React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 } },
              btn('保存配置', saveConfig, { background: 'var(--dsw-alias-brand-primary)', borderColor: 'transparent', color: '#fff' }),
              React.createElement('span', { style: { fontSize: 12, color: 'var(--dsw-alias-state-warn-primary)' } }, '保存后需重启 web 生效'),
            ),
          ) : React.createElement('div', { style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary)' } }, '读取配置中...'),

          React.createElement('div', { style: { fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '16px 0 8px' } }, '本地模型缓存'),
          m.models && m.models.length > 0
            ? m.models.map((mo) => React.createElement('div', { key: mo.name, style: { padding: '6px 0', fontSize: 13, borderBottom: '1px solid var(--dsw-alias-border-l1)' } }, mo.name))
            : React.createElement('div', { style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary)' } }, (m.dir ? '目录为空' : '未找到模型目录')),
          m.dir ? React.createElement('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginTop: 6 } }, '目录: ' + m.dir) : null,
        )

        const standingSummary = standing.length + ' 条' + ((state.standing || {}).chars ? ' · ' + (state.standing || {}).chars + ' 字符' : '')
        const memStore = st.memory || {}; const usrStore = st.user || {}; const failStore = st.failure || {}
        const filesSummary = (memStore.exists ? 'MEMORY ' + memStore.usagePct + '%' : '') + ' · ' + (usrStore.exists ? 'USER ' + usrStore.usagePct + '%' : '') + ' · ' + (failStore.exists ? 'FAIL ' + failStore.usagePct + '%' : '')
        const idxSummary = (idx.fts && idx.fts.exists ? 'FTS5 ' + fmtBytes(idx.fts.size) : 'FTS5 未生成') + ' · ' + (idx.vector && idx.vector.exists ? '向量 ' + fmtBytes(idx.vector.size) : '向量未启用')

        return React.createElement('div', { style: { maxWidth: 720 } },
          React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 } },
            React.createElement('div', { style: { fontWeight: 600, fontSize: 15 } }, '记忆管理'),
            React.createElement('div', { style: { display: 'flex', gap: 8 } },
              btn(busy ? '处理中' : '刷新', load)),
          ),
          notice ? React.createElement('div', { style: { fontSize: 13, color: notice.indexOf('失败') >= 0 ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-success-primary)', margin: '0 0 8px' } }, notice) : null,
          React.createElement('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginBottom: 12 } },
            '目录: ' + (state.dir || '(未找到)') + '  [' + (state.which || '') + ']'),

          card('standing', '常驻指令', standingSummary,
            React.createElement('div', null,
              React.createElement('div', { style: { display: 'flex', gap: 8, margin: '10px 0' } },
                React.createElement('div', { style: { flex: 1 } }, input(newStanding, setNewStanding, '新增常驻指令...')),
                btn('添加', () => mutate('standingAdd', { text: newStanding })),
              ),
              standingRows(),
            ),
          ),

          card('files', '记忆文件', filesSummary, filesBody()),

          card('indexes', '检索索引', idxSummary, indexesBody()),
        )
      },
    ))
  }
}`
