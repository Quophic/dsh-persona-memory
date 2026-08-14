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
- **常驻指令**（`lib/standing.js` + `lib/standing-command.js`）：STANDING.md 每行一条、硬预算（20 条/2000 字符）、始终注入（order 50，早于记忆块 55）；只有 `/standing` 用户命令或直接编辑能写（模型无写入口，防注入）。
- **失败记忆**（`lib/failures.js`）：failures.md（hermes 文件名）§ 格式、结构化 `[category] 内容 — Failed: … — Corrected to: …`、最近 7 天/5 条注入（order 52）、纠正检测落 failure 并去重；`which: 'failure'` 字符上限=memory×2。
- **项目级记忆**（`lib/projects.js`）：projects-memory/<项目名>/MEMORY.md（Pi 兼容根：dir 为 hermes 数据目录时解析到 ~/.pi/agent/projects-memory）；git 仓库根为项目身份（worktree 共享）+ 迁移桥；按会话 cwd 自动注入（order 53）；`project` 参数需过 `safeProjectName` 防路径穿越；项目合并用 projectCharLimit。
- **与 Pi 共享记忆**：`MEMORY.md` / `USER.md` 磁盘格式与 pi-hermes-memory 完全兼容（`§` 分隔 + 行尾 `<!-- created=, last= -->` 注释）；`dir` 默认自动指向 `~/.pi/agent/pi-hermes-memory`（存在时），否则 `$DSH_HOME/memory`。
- **结构**：`index.js`（插件契约）/ `lib/`（memory-store、secret-scanner、memory-tool、memory-search-tool、prompt、learning、llm-helper、consolidate、failures、projects、correction、fts、standing、standing-command）/ `test/smoke.mjs`。
- **测试**：`node test\smoke.mjs`（85 项，用真实 hermes 文件副本验证；搜索测试自包含，不依赖真实文件内容——在线插件可能已合并改写）。测试需在 workspace 内建 junction `node_modules\@deepseek-ai` → 宿主 dsh 副本（`files` 白名单不含 node_modules，不影响安装）。
- **安装**：`dsh plugin --profile <名> add file:<本仓库路径>` + 挂载到 profile 的 `cordis.patch.yml`（host 行，全局生效）。**file: 安装是真实副本，改代码后必须重新 `pnpm add` 并重启 web 才生效**。
