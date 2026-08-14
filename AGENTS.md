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
- **结构**：`index.js`（插件契约）/ `cordis.patch.yml`（bundle patch，经 `"dsh": {"bundle": {"patch": ...}}` 声明，安装后 dsh 自动激活为 profile 层）/ `lib/`（memory-store、secret-scanner、memory-tool、memory-search-tool、prompt、learning、llm-helper、consolidate、failures、projects、correction、fts、vector-index、embedding、standing、standing-command）/ `test/smoke.mjs`。
- **测试**：`node test\smoke.mjs`（111 项，用真实 hermes 文件副本验证；搜索测试自包含，不依赖真实文件内容——在线插件可能已合并改写）。测试需在 workspace 内建 junction `node_modules\@deepseek-ai` → 宿主 dsh 副本（`files` 白名单不含 node_modules，不影响安装）。含工具层测试（memory-tool execute 直连项目 store）、并发写测试与向量索引测试（假 embedding provider 验证增量同步/余弦/RRF）。
- **写入并发安全**：`lib/memory-store.js` 的 add/update/remove 走**单锁原子 `mutate`**（一次 withLock 内完成读-改-写，`{ next?, value }` 返回协议），杜绝并发工具调用互相覆盖；写前**文件指纹预检**（sha256，对照 Pi 的 ExternalMemoryWriteConflict）——若外部（Pi/手动编辑）在我们读后改写了文件，不覆盖、重试一次、仍冲突则返回 `conflict: true`。只读（read/search/listRaw）和纯写（rewrite/replaceEntries）走各自锁。
- **与 Pi 字节兼容（对齐 v0.9.4 实测）**：`\n§\n` 分隔、`<!-- created=, last=, project64= -->` 元数据、**无尾随换行**（hermes saveToDisk 不加 `\n`）、`charCount` = `entries.join(delimiter).length`（含分隔符）、USER 上限默认 5000、容量超限**拒绝写入**（overflow: true，tool 层可先合并后重试）、failure 去重按 `(text, project)`、注入包 `<memory-context>` 围栏。扫描器/STANDING/项目路径与 Pi 逐项一致。
- **安装**：`dsh plugin --profile <名> add file:<本仓库路径>`（或 npm 包名）——**bundle 自动激活，无需手动挂载**；覆盖配置在 profile 的 cordis.patch.yml 按 id 覆盖。**file: 安装是真实副本，改代码后必须重新 `pnpm add` 并重启 web 才生效**。
