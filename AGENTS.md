# AGENTS.md — dsh-persona-memory 开发约定

本文件给任何在此仓库工作的 agent（DSH / 莲 / Pi 等）在动代码前必读。

## ⚠️ 首要规范：宿主包必须 peerDependencies（违反会炸掉全部工具）

- **`@deepseek-ai/*` 宿主包**（`dsh-tools`、`dsh-llm`、`dsh-home-paths` 等）**只允许出现在 `peerDependencies`**，**绝不写进 `dependencies`**。
- **为什么**：`dsh plugin add`（=pnpm）会把 `dependencies` 真装进 `<profile>/node_modules`，与宿主 dsh 安装目录形成**双物理副本**；而 `dsh-tools` 的 `TOOL_RUNTIME_SCHEDULER` 是普通 `Symbol()`（非 `Symbol.for()`，见 `dsh-tools/lib/index.js:2409`），双副本互不认 → 执行循环读不到调度器 → **所有工具调用崩** `Cannot read properties of undefined (reading 'prepare')`（web profile 必现）。
- **为什么 peer 就够了**：兜底目录 `$DSH_HOME/profiles/node_modules`（每次启动自动维护的 junction 集合）保证 peer 声明下解析自动回落宿主副本——不需要 junction、不需要加载期自检，**peer 是唯一必需的声明**。
- **安装后验证**（在 `<profile>` 目录下跑）：

  ```bash
  node --input-type=module -e "
  import { createRequire } from 'node:module';
  const require = createRequire(import.meta.url);
  console.log(require.resolve('@deepseek-ai/dsh-tools'));"   # 期望输出宿主路径（含 @deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-tools）
  ```

- 若安装后 `<profile>/node_modules/@deepseek-ai/` 出现真副本（诱因：`autoInstallPeers: true` 或误写进 dependencies）→ 直接删除副本即可，兜底会接管解析。

## 项目事实

- **用途**：DSH 的持久化长期人格记忆插件——`memory`（read/add/update/delete/rewrite）+ `memory_search` 工具，每请求把记忆注入 system prompt（order 55），带内容扫描（秘密/提示注入拦截）。
- **自动能力**（`lib/learning.js` + `lib/consolidate.js` + `lib/llm-helper.js` + `lib/correction.js`）：后台学习（每 `learnIntervalTurns`=10 轮用会话自身 LLM 路由复习近期对话并 `store.add` 事实）+ 纠正检测（`feedback/record` + **对话内模式检测**——强/弱/负向模式 + 指令词，仅 `source.kind==='user'` 直接人工消息，`correctionRateLimitTurns`=3 限频）→ 存 `[correction]` 失败条目 + 用量提示（`usageNudgeThreshold`=0.9）+ **自动合并**（超限触发 LLM 合并，严格更小/可解析/过扫描才经 `replaceEntries` 提交，失败不损坏记忆）。
- **FTS5 记忆镜像**（`lib/fts.js`）：`<dir>/.memory-index.sqlite`，动态 import node:sqlite（不可用则 `memory_search` 回退子串扫描），按文件 mtime 自动重建，literal-phrase 查询（FTS5 语法当数据处理）。
- **向量记忆镜像**（`lib/vector-index.js` + `lib/embedding.js`）：`vectorIndexDir`（默认 `$DSH_HOME/memory`）下 `.memory-vec.sqlite`，**只存 embedding 数据**（entries 表：which/text_hash/text/embedding BLOB/created/last，UNIQUE(which,text_hash)；meta 表 schema_version）；**指纹增量同步**（sha256 每条原始 § 条目，只 embedding 变化项，Pi 改共享文件自动跟上）；检索纯 JS 余弦（条目少，不装 sqlite-vec）；provider 二选一：`remote`（OpenAI 兼容 `/embeddings`，`embeddingBaseUrl`+`embeddingApiKey` 或 `DSH_EMBEDDING_API_KEY` env；DeepSeek 官方 embeddings 接口状态不明勿依赖）或 `local`（**`@xenova/transformers` 已进 dependencies**，首次使用自动从 HuggingFace 下载模型到 `embeddingCacheDir`（默认 `$DSH_HOME/models`），`embeddingRemoteHost` 可换镜像如 `https://hf-mirror.com`，下载进度经 ctx.logger 记录）；`vectorEnabled` 默认关，开后在 `memory_search` 走 **hybrid（FTS5 + 向量 RRF 融合）**，无向量则 FTS5/子串降级；注入成本与 FTS5 同级（仍 ≤searchMaxResults、只进工具输出）。
- **常驻指令**（`lib/standing.js` + `lib/standing-command.js`）：STANDING.md 每行一条、硬预算（20 条/2000 字符）、始终注入（order 50，早于记忆块 55）；只有 `/standing` 用户命令或直接编辑能写（模型无写入口，防注入）。
- **失败记忆**（`lib/failures.js`）：failures.md（hermes 文件名）§ 格式、结构化 `[category] 内容 — Failed: … — Corrected to: …`、最近 7 天/5 条注入（order 52）、纠正检测落 failure 并去重；`which: 'failure'` 字符上限=memory×2。
- **项目级记忆**（`lib/projects.js`）：projects-memory/<项目名>/MEMORY.md（Pi 兼容根：dir 为 hermes 数据目录时解析到 ~/.pi/agent/projects-memory）；git 仓库根为项目身份（worktree 共享）+ 迁移桥；按会话 cwd 自动注入（order 53）；`project` 参数需过 `safeProjectName` 防路径穿越；项目合并用 projectCharLimit。
- **与 Pi 共享记忆**：`MEMORY.md` / `USER.md` 磁盘格式与 pi-hermes-memory 完全兼容（`§` 分隔 + 行尾 `<!-- created=, last= -->` 注释）；`dir` 默认自动指向 `~/.pi/agent/pi-hermes-memory`（存在时），否则 `$DSH_HOME/memory`。
- **WebUI 记忆管理页**（`lib/admin.js` + `client/client.js`，0.1.16）：Host 用 `webServer` 注册 `/api/persona-memory/*` 路由（status/checkModel/configSave/update/delete/standingAdd/standingUpdate/standingRemove/rebuildVector/projectUpdate/projectDelete/backup/restoreLatest，**loopback-only 防护**，同 dsh-ssh 围栏）；Client 是**预构建 bundle**（`window.__ModuleLoader__.load` 格式，经 `dsh.client` + `exports["./client"]` 声明加载，**非动态插件无 harness.handle**，用同源 fetch 调路由）；页面注册到 `settings.section` slot（id=persona-memory，order=25，label=记忆管理）；卡片=常驻指令/记忆文件/项目记忆/检索索引/本地备份/插件配置；**插件配置卡**按 `CFG_SCHEMA`（40 项，分组：基础/学习/合并/检索/向量/项目/常驻/失败/管理/备份）schema 驱动渲染（bool→checkbox、number→数字框、select→按钮组、string→输入框，embeddingModel 特殊渲染缓存检测），保存写回当前 profile 的 `cordis.patch.yml` 中 persona-memory 段（`adminProfile` 配置项指定 profile 名，默认 web）；**本地备份卡**：备份目录 `$DSH_HOME/memory-backup/latest/`（与 Pi 完全隔离、只保留最新快照，8 文件=MEMORY/USER/failures/STANDING + projects-*.md），手动「立即备份/从最新备份恢复」；**自动保护**（`lib/admin.js` `startAutoProtect`，index.js 启动，ctx.timer.interval 每分钟 tick）：按 `autoBackupMin`（默认 60，0=关）间隔覆盖备份 + Pi 丢失检测（`autoSwitchOnPiLoss`，Pi 曾见 MEMORY.md 后消失 → patch 写 `dir: $DSH_HOME/memory` + restoreFromLatest）；**Client 代码修改后必须重新 `pnpm add` + 重启 web 才生效**（预构建产物按包分发）；client 只依赖 react + 浏览器 fetch，**不 import 任何 @deepseek-ai client 包运行时值**（peerDependencies 已声明 react、dsh-client-runtime、dsh-client-ui-slots、dsh-host-webserver 等）。
- **结构**：`index.js`（插件契约）/ `cordis.patch.yml`（bundle patch，经 `"dsh": {"bundle": {"patch": ...}}` 声明，安装后 dsh 自动激活为 profile 层）/ `lib/`（memory-store、secret-scanner、memory-tool、memory-search-tool、prompt、learning、llm-helper、consolidate、failures、projects、correction、fts、vector-index、embedding、standing、standing-command、admin）/ `client/client.js`（WebUI 管理页 bundle）/ `test/smoke.mjs`。
- **测试**：`node test\smoke.mjs`（111 项，用真实 hermes 文件副本验证；搜索测试自包含，不依赖真实文件内容——在线插件可能已合并改写）。测试需在 workspace 内建 junction `node_modules\@deepseek-ai` → 宿主 dsh 副本（`files` 白名单不含 node_modules，不影响安装）。含工具层测试（memory-tool execute 直连项目 store）、并发写测试与向量索引测试（假 embedding provider 验证增量同步/余弦/RRF）。
- **写入并发安全**：`lib/memory-store.js` 的 add/update/remove 走**单锁原子 `mutate`**（一次 withLock 内完成读-改-写，`{ next?, value }` 返回协议），杜绝并发工具调用互相覆盖；写前**文件指纹预检**（sha256，对照 Pi 的 ExternalMemoryWriteConflict）——若外部（Pi/手动编辑）在我们读后改写了文件，不覆盖、重试一次、仍冲突则返回 `conflict: true`。只读（read/search/listRaw）和纯写（rewrite/replaceEntries）走各自锁。
- **与 Pi 字节兼容（对齐 v0.9.4 实测）**：`\n§\n` 分隔、`<!-- created=, last=, project64= -->` 元数据、**无尾随换行**（hermes saveToDisk 不加 `\n`）、`charCount` = `entries.join(delimiter).length`（含分隔符）、USER 上限默认 5000、容量超限**拒绝写入**（overflow: true，tool 层可先合并后重试）、failure 去重按 `(text, project)`、注入包 `<memory-context>` 围栏。扫描器/STANDING/项目路径与 Pi 逐项一致。
- **安装**：`dsh plugin --profile <名> add file:<本仓库路径>`（或 npm 包名）——**bundle 自动激活，无需手动挂载**；覆盖配置在 profile 的 cordis.patch.yml 按 id 覆盖。**file: 安装是真实副本，改代码后必须重新安装并重启 web 才生效**。

## 迭代与上线 SOP（固定流程，每次照做）

**阶段一：UI/逻辑快速迭代期（免重启）**——用动态 Cordis 插件（`cordis_define` kind:new 一次 + kind:existing 追加迭代），双勾授权后 update 免批准，改完秒生效。参考 `dev/memadmin-v10.js`。定稿后才走阶段二。

**阶段二：固化进 bundle（正式发布，需要重启 web）**

1. **改代码**：`index.js`（插件契约）/ `lib/*.js`（Host，Node 原生 API）/ `client/client.js`（预构建 bundle）。
2. **升版本**：`package.json` version 递增（每次上线必须升，否则 pnpm store 判定"无变化"可能不刷新副本）。
3. **同步文档**：AGENTS.md 功能描述 + README.md 功能表/配置表。
4. **验证**：`node test\smoke.mjs`（111 项，exit=0）+ `node --check` 三个入口文件 + 模块级端到端测试（备份/恢复/patch 写回用临时目录，**测试内严禁删真实数据目录**）。
5. **重装**（⚠️ 必做，pnpm 有 store 缓存）：
   ```bash
   dsh plugin --profile web remove dsh-persona-memory   # 先 remove
   dsh plugin --profile web add file:E:\GitHub\lian_dsh   # 再 add，强制拿新副本
   ```
   验证：`<profile>/node_modules/dsh-persona-memory/package.json` version 与仓库一致、`lib/admin.js` 字节数与仓库一致。
6. **重启 web**：杀 `dsh web` 进程（`Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ? CommandLine -match 'dsh'`）→ 同参数重启 → 刷新 GUI。
7. **验证页面**：设置页「记忆管理」出现六张卡；动态插件随进程消失无需手动 undefine。
8. **git 提交**：`git add -A && git commit`，message 带版本号。

**常见坑**
- pnpm `add file:` 复用 store 缓存 → 装到旧版本/旧字节（现象：version 没变、admin.js 长度不对）→ **先 remove 再 add**，别只 add。
- 改 client.js 后必须重装+重启 web 才生效（预构建产物按包分发）；**bundle 无 harness.handle**，Client↔Host 走 webServer 路由 + fetch。
- 备份目录 `$DSH_HOME/memory-backup/latest/` 是**真实数据**，测试/清理时先确认，删了要立即 `backupAll` 重建。
