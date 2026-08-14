# dsh-persona-memory

持久化长期人格记忆插件 for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）。

让 agent 跨会话记住用户、项目与教训：事实写入磁盘永久保存，每次请求注入上下文；后台自动学习、纠正检测、失败记忆、容量合并让记忆"自己长出来且不失控"；磁盘格式与 [pi-hermes-memory](https://github.com/chandra447/pi-hermes-memory) 字节兼容，DSH 与 Pi 可读写同一份记忆文件。

---

## 功能清单

### A. 存储与共享

| 功能 | 说明 |
|---|---|
| 跨会话持久记忆 | `MEMORY.md`（事实/偏好/约定/环境）+ `USER.md`（用户画像），写入即永久保存 |
| 每请求上下文注入 | 每次请求自动把当前记忆注入系统提示词（`memory:profile` 段，按字符预算截断） |
| 与 Pi 共用记忆 | 磁盘格式与 pi-hermes-memory 完全兼容，DSH 与 Pi 读写同一份文件（MEMORY/USER/STANDING/failures/projects） |
| 项目级记忆 | 每个项目独立记忆（git 仓库根为身份，worktree 共享），按会话 cwd 自动注入（`memory:project` 段） |
| 记忆老化 | 条目携带 `created/last` 日期，合并时据此判断陈旧条目 |

### B. 读写与检索工具

| 功能 | 说明 |
|---|---|
| `memory` 工具 | `read` / `add` / `update` / `delete` / `rewrite`；`which` 选 memory/user/failure；`project` 参数操作项目记忆 |
| `memory_search`（FTS5） | 优先走 SQLite FTS5 全文索引（相关度排序，`<dir>/.memory-index.sqlite`，按文件 mtime 自动重建）；SQLite 不可用时回退子串扫描 |
| 用量提示 | 所有 `memory` 操作返回用量百分比；达 90%（`usageNudgeThreshold`）提醒用 `rewrite` 合并 |
| `/standing` 命令 | 用户管理常驻指令（列出 / add / remove / clear） |

### C. 自动学习机制

| 功能 | 说明 |
|---|---|
| 后台学习 | 每 `learnIntervalTurns`（默认 10）轮用会话自身 LLM 路由复习近期对话，自动提取持久事实存入记忆 |
| 纠正检测 | `/feedback` 事件 + 对话内模式检测（强/弱/负向模式 + 指令词，仅直接人工消息，3 轮限频）→ 立即存 `[correction]` 失败条目 |
| 失败记忆 | `failures.md` 结构化记录 `[category] 内容 — Failed: 原因 — Corrected to: 修正`；最近 7 天最多 5 条自动注入上下文（`memory:failures` 段），防止重蹈覆辙 |
| 自动合并 | 记忆超限时用 LLM 合并精简（>30 天无引用可删、偏好/纠正优先保留）；**只有结果严格更小、可解析且过扫描才提交**，失败绝不损坏记忆 |

### D. 安全与约束

| 功能 | 说明 |
|---|---|
| 内容扫描 | 每次写入过安检：提示注入/数据外泄载荷、API key/token/私钥、不可见 Unicode 字符一律拦截（防凭据落盘、防记忆被植入恶意指令） |
| 常驻指令 | STANDING.md 每行一条、硬预算（20 条/2000 字符）、始终注入（`memory:standing` 段，早于其他记忆）；**只有 `/standing` 命令或直接编辑能写**——模型无写入口，防止模型把"常驻指令"偷偷注入 |

### E. 工程与容错

| 功能 | 说明 |
|---|---|
| 原子写 + 串行队列 | 临时文件 + rename，崩溃不留半截文件；每文件写队列防止并发工具调用丢更新 |
| 优雅降级 | FTS5 不可用回退子串搜索；SQLite 动态 import，插件绝不硬依赖 |
| 85 项冒烟测试 | 用真实 hermes 文件副本验证格式兼容、解析、读写、扫描、合并、项目、纠正、FTS 全链路 |

---

## 借鉴来源（明确声明）

本插件大量借鉴 [pi-hermes-memory](https://github.com/chandra447/pi-hermes-memory)（MIT，作者 chandra447，其本身移植自 [hermes-agent](https://github.com/anthropics/hermes-agent)）。按借鉴程度分四档：

### 1. 代码级移植（近逐行，MIT 保留声明）

| 文件 | 来源 | 移植内容 |
|---|---|---|
| `lib/secret-scanner.js` | hermes `content-scanner.ts` | 11 条提示注入/外泄威胁模式 + 19 条凭据模式 + 不可见 Unicode 字符集 |
| `lib/standing.js`（核心） | hermes `standing-instructions.ts` | 容错解析（`#` 注释/`-`/`*` 列表符/去重）、硬预算（20 条/2000 字符）、`<standing-instructions>` 渲染块（超预算在块内声明遗漏）、来源约束（仅用户可写） |
| `lib/correction.js` | hermes `correction-detector.ts` 的模式部分 | 强/弱/负向三组正则 + 23 个指令词 + `extractCorrectionDirective` |

### 2. 格式级兼容（字节兼容，实现重写）

| 文件 | 来源 | 兼容内容 |
|---|---|---|
| `lib/memory-store.js`（磁盘格式） | hermes `MemoryStore` | `\n§\n` 分隔符、`encodeEntry`/`decodeEntry` 正则（含 `project64` 字段）、`YYYY-MM-DD` 日期 |
| `lib/failures.js` | hermes `buildFailureMemoryText` | `[category] 内容 — Failed: … — Corrected to: …` 结构化文本 |
| `lib/projects.js` | hermes `project.ts` / `paths.ts` | 项目根解析（`~/.pi/agent/projects-memory`）、git 仓库根身份（worktree 共享）、迁移桥、cwd 检测 |

### 3. 概念级移植（思路照搬，代码全新）

| 功能 | 来源概念 | 本插件实现 |
|---|---|---|
| 后台学习 | hermes 每 10 轮复习 | DSH `session/event` 钩子 + `ctx.llm.stream` + 自写提示词 |
| 自动合并 | hermes `auto-consolidate.ts` | 超限触发、合并规则、**严格更小才提交**安全护栏 |
| 纠正检测落库 | hermes 自动失败捕获 | `feedback/record` 事件 + 对话内模式 → `[correction]` 失败条目 |
| 记忆老化 | hermes Memory Aging | `created/last` 日期驱动合并决策 |

### 4. DSH 原生（未借鉴 hermes，基于 DSH API 构建）

| 模块 | 基于的 DSH 能力 |
|---|---|
| `memory` / `memory_search` 工具 | `ctx.tools.register` + `defineTool` |
| 记忆注入段落 | `ctx.systemPrompt` 注册表（variable + section） |
| `/standing` 命令 | `ctx.commands` 注册 |
| `lib/llm-helper.js` | 会话 `request/header` 路由解析 + `ctx.llm.stream` |
| `lib/fts.js` | `node:sqlite` FTS5（DSH `dsh-session-query-sqlite` 同款契约） |
| 存储实现（原子写/队列/API） | 全新编写（hermes 的 MemoryStore 耦合 Pi API，无法直接复用） |

> 刻意未移植：hermes 的 SQLite 会话搜索（DSH 原生 `dsh-session-query-sqlite` 已具备）、程序性技能（DSH 原生 skills 已具备）、子进程传输与 SQLite 锁协调器（DSH 插件进程内运行，不需要）。

---

## 工具与命令

| 工具/命令 | 说明 |
|---|---|
| `memory` | `read` / `add` / `update` / `delete` / `rewrite`，`which` 选 `memory` / `user` / `failure`；`project` 参数操作项目记忆；failure 支持 `category` / `failure_reason` / `corrected_to` |
| `memory_search` | `query` + 可选 `which`（`memory`/`user`/`failure`/`all`）+ 可选 `project` |
| `/standing` | 列出常驻指令 |
| `/standing add <文本>` | 钉住一条常驻指令 |
| `/standing remove <n>` | 按 1 起编号移除 |
| `/standing clear` | 清空 |

## 安装到 DSH profile

插件声明了 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`，安装后 dsh **自动激活**为 profile 层（无需手动挂载）：

```bash
# 安装（本地路径开发 / npm 发布版均可）
dsh plugin --profile web add file:E:/GitHub/lian_dsh
# 或：dsh plugin --profile web add dsh-persona-memory

# 重启 dsh web
dsh --profile web
```

如需覆盖配置（如 `dir`），在 profile 的 `cordis.patch.yml` 里按 id 覆盖即可（bundle 行在后层会被 profile 行覆盖）：

```yaml
- id: persona-memory
  config:
    dir: C:/Users/Quophic/.pi/agent/pi-hermes-memory
```

## 配置（均可选）

| 键 | 默认 | 含义 |
|---|---|---|
| `dir` | 见下 | 记忆文件目录；显式设置优先 |
| `memoryCharLimit` | `5000` | MEMORY.md 注入上下文的最大字符数 |
| `userCharLimit` | `8000` | USER.md 注入上下文的最大字符数 |
| `enableSecretScanning` | `true` | 是否启用写入扫描 |
| `inject` | `true` | 是否注册系统提示词注入段落 |
| `sectionOrder` | `55` | 注入段落在系统提示词中的顺序 |
| `searchMaxResults` | `10` | `memory_search` 单次最多返回条数 |
| `usageNudgeThreshold` | `0.9` | 达到该用量比例（如 90%）时在结果中提醒合并 |
| `correctionDetection` | `true` | 收到 `feedback/record` 时自动存 `[correction]` 失败条目 |
| `correctionPatternDetection` | `true` | 对话内纠正模式检测（强/弱/负向模式，仅直接人工消息） |
| `correctionRateLimitTurns` | `3` | 对话内纠正保存的最小间隔（轮） |
| `memoryFtsEnabled` | `true` | 启用 SQLite FTS5 记忆镜像（`memory_search` 全文检索） |
| `learnEnabled` | `true` | 是否启用后台自动学习 |
| `learnIntervalTurns` | `10` | 每 N 轮（turn/end）触发一次复习 |
| `learnRecentTurns` | `2` | 每次复习取最近多少个轮次的对话 |
| `learnMaxChars` | `6000` | 复习用的对话/记忆摘要最大字符数 |
| `learnTimeoutMs` | `120000` | 学习 LLM 调用的超时 |
| `standingEnabled` | `true` | 是否启用常驻指令（STANDING.md + `/standing` 命令） |
| `standingCharLimit` | `2000` | STANDING.md 注入预算（硬上限） |
| `standingMaxEntries` | `20` | STANDING.md 最大条数（硬上限） |
| `autoConsolidate` | `true` | 超限时自动 LLM 合并（严格更小才提交） |
| `consolidateStaleDays` | `30` | 合并时判定"陈旧可删"的天数（无近期引用） |
| `consolidateTimeoutMs` | `120000` | 合并 LLM 调用的超时 |
| `failureInjectionEnabled` | `true` | 是否注入最近失败（learn from mistakes） |
| `failureMaxAgeDays` | `7` | 失败注入窗口（按 created 日期） |
| `failureMaxEntries` | `5` | 失败注入最多条数 |
| `failureCharLimit` | `10000` | failures.md 字符上限（hermes 默认 memory×2） |
| `projectEnabled` | `true` | 是否启用项目级记忆 |
| `projectCharLimit` | `5000` | 单项目记忆字符上限 |

`dir` 默认解析顺序：① 显式 `config.dir` → ② `~/.pi/agent/pi-hermes-memory`（若已存在 `MEMORY.md`，即与 Pi 共用）→ ③ `$DSH_HOME/memory`（默认 `~/.dsh/memory`）。

## 磁盘格式（与 pi-hermes-memory 一致）

```markdown
<条目文本> <!-- created=2026-08-13, last=2026-08-13 -->
§
<另一条目文本> <!-- created=2026-08-13, last=2026-08-13 -->
```

- 条目以 `\n§\n` 分隔，每条是单行文本 + 行尾 `<!-- created=YYYY-MM-DD, last=YYYY-MM-DD -->` 注释。
- 无注释的旧条目照常解析（日期默认为今天）。
- 写入采用原子写（临时文件 + rename），并按文件串行化，避免并发工具调用互相覆盖。
- STANDING.md 例外：每行一条，无分隔符、无元数据（见下节）。

## 常驻指令（STANDING.md）

与 pi-hermes-memory 一致：**每行一条**，无分隔符、无元数据；容忍空行、`#` 注释和行首 `-`/`*` 列表符，手改时仍是普通 Markdown。注入块用 `<standing-instructions>` 围栏，声明"用户亲写的规则、始终生效、高于默认行为"；超预算时在块**内部**声明被省略的条数，绝不静默丢弃。

**来源约束**：只有 `/standing` 命令或用户直接编辑文件能写入——模型无写入口（后台学习、合并、纠正检测都不碰它）。

## 与 Pi 共用的注意点

- DSH 与 Pi 不要**同时**写同一份文件（两边都是原子写，但无跨进程锁）；不同时运行则完全安全。
- 本插件覆盖 `MEMORY.md` / `USER.md` / `STANDING.md` / `failures.md` / `projects-memory/`（项目根与 Pi 一致）。
- 两边扫描标准一致（同一份 content-scanner 移植），hermes 写入的内容 DSH 直接可读，反之亦然。

## 许可与致谢

MIT。磁盘格式、内容扫描器、常驻指令、纠正模式与合并策略移植自 [pi-hermes-memory](https://github.com/chandra447/pi-hermes-memory)（MIT，作者 chandra447），其本身又移植自 [hermes-agent](https://github.com/anthropics/hermes-agent)。具体移植清单见上文「借鉴来源」。
