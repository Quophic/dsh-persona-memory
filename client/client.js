/**
 * dsh-persona-memory — browser half ("记忆管理" settings page).
 *
 * This file is the PREBUILT client bundle: it runs in the dsh web GUI,
 * loaded via `window.__ModuleLoader__.load` from the `dsh.client` +
 * `exports["./client"]` declarations in package.json. It must stay
 * dependency-light: only React (required through the ModuleLoader) and
 * plain browser fetch — no Node builtins, no bundler transform.
 *
 * The page talks to the host through the /api/persona-memory/* route family
 * (registered by lib/admin.js on the host `webServer` service).
 *
 * Export contract (matches the shipped ui-* plugins):
 *   - inject: ['slots'] — the settings.section slot is contributed via
 *     `ctx.slots.inject` (dsh-client-ui-slots).
 *   - apply(ctx) — registers the page.
 */
window.__ModuleLoader__.load({
  id: 'dsh-persona-memory',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    var React = require('react');

    // ------------------------------------------------------------- api
    /** One JSON call to the host route family. */
    async function api(path, payload, method) {
      const res = await fetch('/api/persona-memory' + path, payload === undefined && method === undefined
        ? undefined
        : {
            method: method || 'POST',
            headers: { 'content-type': 'application/json' },
            body: payload === undefined ? undefined : JSON.stringify(payload),
          });
      let body = null;
      try {
        body = await res.json();
      } catch {
        /* non-JSON error body */
      }
      if (!res.ok) {
        const message = body && body.error ? body.error : 'HTTP ' + res.status;
        throw new Error(message);
      }
      return body;
    }

    // ----------------------------------------------------------- helpers
    function fmtBytes(n) {
      if (!n && n !== 0) return '-';
      if (n < 1024) return n + ' B';
      if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
      return (n / 1048576).toFixed(1) + ' MB';
    }
    function btn(label, onClick, opts) {
      return React.createElement('button', {
        onClick,
        disabled: opts && opts.disabled,
        style: Object.assign({
          padding: '5px 12px',
          borderRadius: 6,
          fontSize: 13,
          border: '1px solid var(--dsw-alias-border-l2)',
          background: 'var(--dsw-alias-bg-layer-1)',
          color: 'var(--dsw-alias-label-primary)',
          cursor: opts && opts.disabled ? 'default' : 'pointer',
        }, opts && opts.style),
      }, label);
    }
    function input(value, onChange, placeholder) {
      return React.createElement('input', {
        value,
        onChange: (e) => onChange(e.target.value),
        placeholder,
        style: {
          width: '100%',
          boxSizing: 'border-box',
          padding: '6px 10px',
          borderRadius: 6,
          fontSize: 13,
          border: '1px solid var(--dsw-alias-border-l2)',
          background: 'var(--dsw-alias-bg-layer-1)',
          color: 'var(--dsw-alias-label-primary)',
        },
      });
    }
    // 编辑用多行输入框：按内容高度自动展开，完整显示全部文字。
    // 最小 3 行，最大 300px 内滚动；内容变化时重新测量。
    // 必须是独立组件：hooks（useRef/useLayoutEffect）归属组件自身，
    // 写成普通函数会在条件渲染时崩 React error #310。
    function TextArea(props) {
      const ref = React.useRef(null);
      React.useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        el.style.height = 'auto';
        el.style.height = Math.min(el.scrollHeight, 300) + 'px';
      }, [props.value]);
      return React.createElement('textarea', {
        ref,
        value: props.value,
        onChange: (e) => props.onChange(e.target.value),
        placeholder: props.placeholder,
        rows: 3,
        style: {
          width: '100%',
          boxSizing: 'border-box',
          padding: '8px 10px',
          borderRadius: 6,
          fontSize: 13,
          lineHeight: 1.5,
          border: '1px solid var(--dsw-alias-border-l2)',
          background: 'var(--dsw-alias-bg-layer-1)',
          color: 'var(--dsw-alias-label-primary)',
          resize: 'vertical',
          minHeight: 68,
          maxHeight: 300,
          overflowY: 'auto',
          fontFamily: 'inherit',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        },
      });
    }
    function meter(pct) {
      return React.createElement('div', {
        style: { height: 4, background: 'var(--dsw-alias-border-l1)', borderRadius: 2, overflow: 'hidden', margin: '4px 0 6px' },
      },
        React.createElement('div', {
          style: {
            height: 4,
            width: pct + '%',
            background: pct >= 90 ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-success-primary)',
            borderRadius: 2,
            transition: 'width 0.3s',
          },
        }),
      );
    }

    // ------------------------------------------------------------- page
    function MemAdminPage() {
      const [state, setState] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [editing, setEditing] = React.useState(null);
      const [confirmDel, setConfirmDel] = React.useState(null);
      const [standingEdit, setStandingEdit] = React.useState(null);
      const [newStanding, setNewStanding] = React.useState('');
      const [open, setOpen] = React.useState({ standing: true, files: true, indexes: true });
      const [notice, setNotice] = React.useState(null);
      const [cfgForm, setCfgForm] = React.useState(null);
      const [modelStatus, setModelStatus] = React.useState(null);

      const load = React.useCallback(async () => {
        setBusy(true);
        setError(null);
        try {
          const s = await api('/status', undefined, 'GET');
          setState(s);
          if (s && s.config) {
            setCfgForm({
              vectorEnabled: s.config.vectorEnabled !== false,
              embeddingProvider: s.config.embeddingProvider || 'local',
              embeddingModel: s.config.embeddingModel || 'Xenova/bge-small-zh-v1.5',
              embeddingRemoteHost: s.config.embeddingRemoteHost || 'https://huggingface.co',
              embeddingCacheDir: s.config.embeddingCacheDir || '',
            });
          }
        } catch (e) {
          setError(String((e && e.message) || e));
        } finally {
          setBusy(false);
        }
      }, []);
      React.useEffect(() => { load(); }, [load]);

      // Debounced model-cache check while typing (400ms). In the browser
      // half the global setTimeout is available; keep a cleanup disposer so
      // an unmount never resolves into a dead setState.
      const modelName = cfgForm ? cfgForm.embeddingModel : null;
      React.useEffect(() => {
        if (!modelName || !modelName.trim()) return;
        setModelStatus({ checking: true });
        let alive = true;
        const timer = setTimeout(async () => {
          try {
            const res = await api('/checkModel?model=' + encodeURIComponent(modelName.trim()), undefined, 'GET');
            if (alive) setModelStatus({ checking: false, cached: !!(res && res.cached), path: res && res.path });
          } catch {
            if (alive) setModelStatus({ checking: false, cached: false });
          }
        }, 400);
        return () => { alive = false; clearTimeout(timer); };
      }, [modelName]);

      const mutate = async (action, payload) => {
        setBusy(true);
        setError(null);
        setNotice(null);
        try {
          const res = await api('/' + action, payload);
          if (res && res.error) setNotice('操作失败: ' + res.error);
          else setNotice((res && res.message) || '完成');
          setEditing(null);
          setConfirmDel(null);
          setStandingEdit(null);
          setNewStanding('');
          await load();
        } catch (e) {
          setError(String((e && e.message) || e));
        } finally {
          setBusy(false);
        }
      };

      const saveConfig = async () => {
        if (!cfgForm) return;
        setBusy(true);
        setError(null);
        setNotice(null);
        try {
          const res = await api('/configSave', cfgForm);
          if (res && res.error) setNotice('保存失败: ' + res.error);
          else setNotice((res && res.message) || '配置已保存');
          await load();
        } catch (e) {
          setError(String((e && e.message) || e));
        } finally {
          setBusy(false);
        }
      };

      if (error) {
        return React.createElement('div', { style: { maxWidth: 720 } },
          React.createElement('div', { style: { fontWeight: 600, marginBottom: 8 } }, '记忆管理'),
          React.createElement('div', { style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 13 } }, '读取失败: ' + error),
          React.createElement('button', { onClick: load, style: { marginTop: 8 } }, '重试'),
        );
      }
      if (!state) {
        return React.createElement('div', { style: { maxWidth: 720 } },
          React.createElement('div', { style: { fontWeight: 600, marginBottom: 8 } }, '记忆管理'),
          React.createElement('div', { style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary)' } }, busy ? '读取中...' : '正在加载'),
        );
      }

      const st = state.stores || {};
      const idx = state.indexes || {};
      const m = state.models || {};
      const standing = (state.standing || {}).instructions || [];
      const whichName = { memory: 'MEMORY.md', user: 'USER.md', failure: 'failures.md' };

      const card = (key, title, summary, children) => {
        const isOpen = open[key];
        return React.createElement('div', { style: { border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8, marginBottom: 10, overflow: 'hidden', background: 'var(--dsw-alias-bg-layer-1)' } },
          React.createElement('div', {
            onClick: () => setOpen(Object.assign({}, open, { [key]: !isOpen })),
            style: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', cursor: 'pointer', userSelect: 'none' },
          },
            React.createElement('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', transition: 'transform 0.2s', transform: isOpen ? 'rotate(90deg)' : 'none' } }, '\u25B8'),
            React.createElement('span', { style: { fontSize: 14, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } }, title),
            React.createElement('span', { style: { flex: 1 } }),
            summary ? React.createElement('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, summary) : null,
          ),
          isOpen ? React.createElement('div', { style: { padding: '4px 14px 14px', borderTop: '1px solid var(--dsw-alias-border-l1)' } }, children) : null,
        );
      };

      const entryRows = (which) => {
        const list = (state.entries || {})[which] || [];
        if (list.length === 0) {
          return React.createElement('div', { style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary)', padding: '6px 0' } }, '（无条目）');
        }
        return list.map((entry, i) => {
          const isEditing = editing && editing.which === which && editing.index === i;
          const isConfirm = confirmDel && confirmDel.which === which && confirmDel.index === i;
          if (isEditing) {
            return React.createElement('div', { key: which + i, style: { padding: '8px 0', borderBottom: '1px solid var(--dsw-alias-border-l1)' } },
              React.createElement(TextArea, { value: editing.text, onChange: (v) => setEditing({ which, index: i, text: v }), placeholder: '条目内容' }),
              React.createElement('div', { style: { display: 'flex', gap: 8, marginTop: 6 } },
                btn('保存', () => mutate('update', { which, index: i, text: editing.text })),
                btn('取消', () => setEditing(null)),
              ),
            );
          }
          if (isConfirm) {
            return React.createElement('div', { key: which + i, style: { padding: '8px 0', borderBottom: '1px solid var(--dsw-alias-border-l1)', fontSize: 13 } },
              React.createElement('div', { style: { color: 'var(--dsw-alias-state-warn-primary)', marginBottom: 6 } }, '确认删除这条? ' + String(entry.text || '').slice(0, 60)),
              React.createElement('div', { style: { display: 'flex', gap: 8 } },
                btn('删除', () => mutate('delete', { which, index: i }), { style: { background: 'var(--dsw-alias-state-error-primary)', borderColor: 'transparent', color: '#fff' } }),
                btn('取消', () => setConfirmDel(null)),
              ),
            );
          }
          return React.createElement('div', { key: which + i, style: { padding: '6px 0', borderBottom: '1px solid var(--dsw-alias-border-l1)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 } },
            React.createElement('span', {
              style: {
                fontSize: 13,
                lineHeight: 1.5,
                flex: 1,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical',
              },
            }, String(entry.text || '')),
            React.createElement('div', { style: { display: 'flex', gap: 6, flexShrink: 0 } },
              btn('编辑', () => setEditing({ which, index: i, text: String(entry.text || '') }), { style: { padding: '3px 8px', fontSize: 12 } }),
              btn('删除', () => setConfirmDel({ which, index: i, text: String(entry.text || '') }), { style: { padding: '3px 8px', fontSize: 12 } }),
            ),
          );
        });
      };

      const standingRows = () => {
        if (standing.length === 0) {
          return React.createElement('div', { style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary)', padding: '6px 0' } }, '（无常驻指令，可添加）');
        }
        return standing.map((text, i) => {
          const isEditing = standingEdit && standingEdit.index === i;
          if (isEditing) {
            return React.createElement('div', { key: 'st' + i, style: { padding: '8px 0', borderBottom: '1px solid var(--dsw-alias-border-l1)' } },
              React.createElement(TextArea, { value: standingEdit.text, onChange: (v) => setStandingEdit({ index: i, text: v }), placeholder: '指令内容' }),
              React.createElement('div', { style: { display: 'flex', gap: 8, marginTop: 6 } },
                btn('保存', () => mutate('standingUpdate', { index: i, text: standingEdit.text })),
                btn('取消', () => setStandingEdit(null)),
              ),
            );
          }
          return React.createElement('div', { key: 'st' + i, style: { padding: '6px 0', borderBottom: '1px solid var(--dsw-alias-border-l1)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 } },
            React.createElement('span', { style: { fontSize: 13, lineHeight: 1.5, flex: 1 } }, (i + 1) + '. ' + String(text || '')),
            React.createElement('div', { style: { display: 'flex', gap: 6, flexShrink: 0 } },
              btn('编辑', () => setStandingEdit({ index: i, text: String(text || '') }), { style: { padding: '3px 8px', fontSize: 12 } }),
              btn('删除', () => mutate('standingRemove', { index: i }), { style: { padding: '3px 8px', fontSize: 12 } }),
            ),
          );
        });
      };

      const filesBody = () => React.createElement('div', null,
        ['memory', 'user', 'failure'].map((w) => {
          const s = st[w];
          return React.createElement('div', { key: w, style: { margin: '10px 0' } },
            React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: 13, fontWeight: 600, marginBottom: 2 } },
              React.createElement('span', null, whichName[w]),
              React.createElement('span', { style: { color: 'var(--dsw-alias-label-secondary)', fontWeight: 400 } },
                (s && s.exists ? s.entries + ' 条 / ' + s.chars + ' 字符' : '不存在')),
            ),
            s && s.exists ? meter(s.usagePct) : null,
            React.createElement('div', { style: { marginTop: 6 } }, entryRows(w)),
          );
        }),
      );

      const modelStatusLine = () => {
        if (!cfgForm || !cfgForm.embeddingModel || !cfgForm.embeddingModel.trim()) return null;
        if (modelStatus && modelStatus.checking) {
          return React.createElement('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', margin: '6px 0' } }, '检查缓存...');
        }
        if (modelStatus && modelStatus.cached) {
          return React.createElement('div', { style: { fontSize: 12, color: 'var(--dsw-alias-state-success-primary)', margin: '6px 0' } }, '已缓存，可直接使用');
        }
        return React.createElement('div', { style: { fontSize: 12, color: 'var(--dsw-alias-state-warn-primary)', margin: '6px 0' } },
          '未缓存 - 保存并重启后，首次 memory_search 会从 ' + (cfgForm.embeddingRemoteHost || 'https://huggingface.co') + ' 自动下载');
      };

      const indexesBody = () => React.createElement('div', null,
        React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', fontSize: 13, borderBottom: '1px solid var(--dsw-alias-border-l1)' } },
          React.createElement('span', null, 'FTS5 全文索引'),
          React.createElement('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, idx.fts && idx.fts.exists ? fmtBytes(idx.fts.size) : '未生成')),
        React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', fontSize: 13, borderBottom: '1px solid var(--dsw-alias-border-l1)' } },
          React.createElement('span', null, '向量索引 (embedding)'),
          React.createElement('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, idx.vector && idx.vector.exists ? fmtBytes(idx.vector.size) : '未启用')),
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 0 2px' } },
          React.createElement('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, '索引可随时重建，不影响记忆本体'),
          btn('重建向量索引', () => mutate('rebuildVector', {}), { style: { background: 'var(--dsw-alias-bg-layer-2)' } }),
        ),

        React.createElement('div', {
          style: {
            fontSize: 12,
            fontWeight: 600,
            color: 'var(--dsw-alias-label-secondary)',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            margin: '14px 0 8px',
          },
        }, '向量搜索配置'),
        cfgForm ? React.createElement('div', null,
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', fontSize: 13 } },
            React.createElement('input', {
              type: 'checkbox',
              checked: cfgForm.vectorEnabled,
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
              const active = cfgForm.embeddingModel === mo.name;
              return btn(mo.name, () => setCfgForm(Object.assign({}, cfgForm, { embeddingModel: mo.name })), {
                style: {
                  padding: '3px 10px',
                  fontSize: 12,
                  background: 'var(--dsw-alias-bg-layer-2)',
                  borderColor: active ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l2)',
                  color: active ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-primary)',
                  fontWeight: active ? 600 : 400,
                },
              });
            }),
            m.models && m.models.length === 0
              ? React.createElement('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, '缓存中暂无模型')
              : null,
          ),
          React.createElement('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginBottom: 4 } }, '下载源（镜像地址）'),
          input(cfgForm.embeddingRemoteHost, (v) => setCfgForm(Object.assign({}, cfgForm, { embeddingRemoteHost: v })), 'https://huggingface.co 或 https://hf-mirror.com'),
          React.createElement('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', margin: '10px 0 4px' } }, '模型缓存目录'),
          input(cfgForm.embeddingCacheDir, (v) => setCfgForm(Object.assign({}, cfgForm, { embeddingCacheDir: v })), '默认 $DSH_HOME/models'),
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 } },
            btn('保存配置', saveConfig, { style: { background: 'var(--dsw-alias-brand-primary)', borderColor: 'transparent', color: '#fff' } }),
            React.createElement('span', { style: { fontSize: 12, color: 'var(--dsw-alias-state-warn-primary)' } }, '保存后需重启 web 生效'),
          ),
        ) : React.createElement('div', { style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary)' } }, '读取配置中...'),

        React.createElement('div', {
          style: {
            fontSize: 12,
            fontWeight: 600,
            color: 'var(--dsw-alias-label-secondary)',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            margin: '16px 0 8px',
          },
        }, '本地模型缓存'),
        m.models && m.models.length > 0
          ? m.models.map((mo) => React.createElement('div', { key: mo.name, style: { padding: '6px 0', fontSize: 13, borderBottom: '1px solid var(--dsw-alias-border-l1)' } }, mo.name))
          : React.createElement('div', { style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary)' } }, (m.dir ? '目录为空' : '未找到模型目录')),
        m.dir ? React.createElement('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginTop: 6 } }, '目录: ' + m.dir) : null,
      );

      const standingSummary = standing.length + ' 条' + ((state.standing || {}).chars ? ' · ' + (state.standing || {}).chars + ' 字符' : '');
      const memStore = st.memory || {};
      const usrStore = st.user || {};
      const failStore = st.failure || {};
      const filesSummary = (memStore.exists ? 'MEMORY ' + memStore.usagePct + '%' : '') + ' · '
        + (usrStore.exists ? 'USER ' + usrStore.usagePct + '%' : '') + ' · '
        + (failStore.exists ? 'FAIL ' + failStore.usagePct + '%' : '');
      const idxSummary = (idx.fts && idx.fts.exists ? 'FTS5 ' + fmtBytes(idx.fts.size) : 'FTS5 未生成') + ' · '
        + (idx.vector && idx.vector.exists ? '向量 ' + fmtBytes(idx.vector.size) : '向量未启用');

      return React.createElement('div', { style: { maxWidth: 720 } },
        React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 } },
          React.createElement('div', { style: { fontWeight: 600, fontSize: 15 } }, '记忆管理'),
          React.createElement('div', { style: { display: 'flex', gap: 8 } },
            btn(busy ? '处理中' : '刷新', load)),
        ),
        notice ? React.createElement('div', {
          style: {
            fontSize: 13,
            color: notice.indexOf('失败') >= 0 ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-success-primary)',
            margin: '0 0 8px',
          },
        }, notice) : null,
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
      );
    }

    // ------------------------------------------------------------ mount
    /** Services required by this page (settings slot host). */
    var inject = ['slots'];

    /**
     * Register the 记忆管理 page into the Web Settings section.
     * @param ctx - client root context (slots service).
     */
    function apply(ctx) {
      // Direct injection like the shipped ui-* plugins: slots.inject returns
      // the disposer the fiber owns; no extra ctx.effect wrapper needed.
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'persona-memory',
        order: 25,
        label: '记忆管理',
      }, MemAdminPage));
    }

    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
