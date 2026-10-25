# codingx-harness

> 终端里的 AI 编码 Agent —— Node.js + TypeScript 实现，交互形态参考 Codex CLI。

`codingx` 是一个跑在终端里的编码 Agent。你用自然语言描述任务，它在当前仓库里读代码、改文件、执行命令、跑测试，循环到任务完成。它不依赖 IDE，一条命令即可在本地、SSH 会话或 CI 中运行。会话状态由本地 rollout 统一管理，多个终端能看到同一份进行中的状态（目标态）。

**状态：M1（最小可用循环）已完成；M2 核心功能与验收完成（剩余 mention/session picker/表格 holdback/慢订阅者背压列为 M2.1 增强）；M3 权限体系设计完成，M3.1 策略内核 + M3.2 审批交互基础版已落地（文件工具策略、TUI/plain 审批、会话/前缀授权、`/permissions`、审计）；OS 沙箱与网络隔离尚未开始。** 设计文档描述的是目标态；已落地范围与偏差见 [docs/implementation-plan.md](docs/implementation-plan.md)、[docs/implementation-plan-m2.md](docs/implementation-plan-m2.md) 与 [docs/roadmap.md](docs/roadmap.md)。M3 权限设计见 [docs/permissions.md](docs/permissions.md)，任务拆分见 [docs/implementation-plan-m3.md](docs/implementation-plan-m3.md)。

M1 已经可以完成「读文件 → 改文件 → 跑测试 / 命令」的闭环：

- TypeScript strict + ESM + tsup 构建，`bin/codingx.js` 启动
- Anthropic Messages 流式 Provider（tool use / prompt caching / 错误分类 / 超时与中断）
- 单目标 ProviderRouter（首个内容事件前重试；多目标路由留到 M5）
- Agent 循环（串行工具、maxSteps、abort、usage、完整 rollout）
- 工具：`ReadFile`、`ListDir`、`EditFile`（先读后写）、`Shell`（进程组 + 超时回收）
- 纯文本 CLI：`codingx exec`、逐行交互模式、`--json` 事件流、`codingx log` 离线回放
- 进程内 JSONL SessionStore（单写者文件锁、seq、去重、脱敏、未完成尾行恢复）

M2 本轮已落地：

- **会话续接**：`--continue` / `--resume <id>` / `--fork <id>`；从 rollout 重建消息历史，悬空工具调用补合成 `tool_result`，恢复已读文件状态
- **上下文压缩**：三级压缩（截断 → 丢弃 → 模型摘要），写入 `context.compacted`；30 轮大工具输出压测通过
- **工具扩展**：`Glob`、`Grep`（优先 rg，缺失时内置回退）、`WriteFile`、`UpdatePlan`、`ApplyPatch`、`Skill`、`AskUserQuestion`
- **额外工作目录**：`--add-dir <DIR>` 可重复，把主 workspace 之外的目录显式加入文件与 Shell 工具的允许根；当前只有 profile 的 `:workspace_roots` 允许写时才能追加，`:read-only` 会报错。仅对当前调用生效，`--continue`/`--resume` 需再次传入
- **权限策略（M3.1）**：Permission profiles（`:read-only` / `:workspace` / `:danger-full-access` + 命名 profile）、`approval_policy`（`on-request` / `never`）、`--sandbox` / `--ask-for-approval` / `--permission-profile` 已接入文件工具；越界在非交互模式下返回 `APPROVAL_REQUIRED`/`PERMISSION_DENIED`，并写 `permission.decision` 审计事件
- **审批交互（M3.2）**：TUI 底部审批弹层与 plain 交互提示；允许一次 / 本会话 / 命令前缀 / 拒绝并说明原因；授权仅存在内存，`/clear` 清除，resume 不继承；`/permissions` 可列出并切换 profile；写 `approval.requested/decided`、`permission.granted`、`profile.changed`
- **绕过权限检查**：`--yolo` / `--allow-dangerously-skip-permissions` 现在映射到 `:danger-full-access` + `never`，关闭文件工具策略并打印醒目告警。当前没有 OS 沙箱，因此它不能提供隔离；`exec policy` 的 `forbidden` 仍是尽力而为的硬拒绝。仅建议在一次性容器中使用
- **运行时模型切换**：`/model` 查看或切换当前模型与推理强度（`low|medium|high|xhigh|max`，`default` 清除）；变更立即作用于后续请求，写入 `model.changed`，并在 resume 时恢复。Anthropic Messages 通过 `output_config.effort` 传递（需目标模型支持该参数）
- **Terminal 与 TUI 层**：Terminal 内核 + TuiApp/TuiRuntime/TuiSession、独立背景 composer/用户消息、底部 meta（model · cwd · session title）、硬件光标/IME 定位、resume transcript 重建、欢迎卡常驻历史顶部、`/copy` 按区域复制、`/clear` 重置会话（UI 与 JSONL rollout 一并清空）、Ctrl+Y 全量复制、终端原生拖选 + ⌘C 复制、markdown/code/diff 消息单元、相邻同名工具调用合并为 `×N` 块、turn 完成摘要（total/llm/tools 耗时、Token）、状态行上下文用量（默认 1M）、累计 Token 与 turn/step 信息、help/transcript overlay、slash 补全菜单；TTY 默认全屏 TUI，`--plain` 退化
- **Skills 与用户提问**：`~/.agents/skills`、`~/.codingx/skills` 与 `<project>/.codingx/skills` 的 `SKILL.md` 按需加载（系统提示只放目录）；TUI 底部提问面板支持单选/多选/自由文本，答案经 `tool.result` 入 rollout
- **sessiond**：JSON-RPC/NDJSON、Unix socket server、注册表/写租约/heartbeat/崩溃恢复、typed client、remote SessionStore、自动拉起、空闲退出、方法握手（升级后自动替换缺少新方法的旧 daemon）；CLI 默认通过 IPC 写入
- **跨 CLI**：`sessions list/show/watch/prune`、`sessiond start/stop/status/restart`；首次 CLI 运行会自动拉起 detached daemon

尚未实现：TUI mention、session picker（M2.1）、审批选择器 overlay / 长命令全屏视图、OS 沙箱（Seatbelt/Landlock）、网络代理、exec policy 规则、自动审查、表格 holdback、慢订阅者背压、MCP、并行工具、多 Provider 路由、OpenAI Responses。权限 profile、拒绝原因与提权流程见 [docs/permissions.md](docs/permissions.md)；使用前请阅读 [当前实现边界](#当前实现边界)。

## 快速开始

```bash
npm install
npm run build

# 凭证：环境变量，或 ~/.codingx/auth.json（0600）
export API_KEY=...

# 写入 ~/.codingx/config.toml
cat > ~/.codingx/config.toml <<'TOML'
[provider.primary]
protocol = "anthropic-messages"
endpoint = "https://api.anthropic.com"
api_key_env = "API_KEY"

[model]
route = "default"
max_output_tokens = 8192

[agent]
max_steps = 64

[routes.default]
strategy = "failover"
max_attempts = 3

[[routes.default.targets]]
provider = "primary"
model = "your-model-name"   # 由你的 Provider / 网关提供

# sessiond 默认自动拉起；设为 false 可退回嵌入式存储
[sessiond]
enabled = true
autostart = true

[sandbox]
env_passthrough = ["PATH", "HOME", "LANG", "TERM", "TMPDIR"]
TOML

# 单次执行：stdout 只输出最终回答，工具进度与用量在 stderr
node bin/codingx.js exec "把 src/util.ts 里的 foo 重命名为 bar 并跑测试"

# 额外可写目录：可重复；文件与 Shell 工具可访问，相对路径仍从主 workspace 解析
node bin/codingx.js --add-dir ../shared --add-dir /tmp/out exec "把结果写到共享目录"

# 权限策略：文件工具受 profile 约束；非交互越界 fail closed
node bin/codingx.js --sandbox read-only --ask-for-approval never exec "只读检查仓库"
node bin/codingx.js --permission-profile review exec "使用 config.toml 中的命名 profile"

# 危险：关闭文件工具策略（仅用于一次性容器；当前没有 OS 沙箱/审批 UI）
node bin/codingx.js --yolo exec "跨目录整理文件"

# 交互式：TTY 默认全屏 TUI；--plain 强制逐行
node bin/codingx.js
# 交互内 slash：/help /session /model /clear /copy /queue /quit
# /model <model> [effort] 切模型与推理强度；/clear 会清空当前会话的 UI、内存历史与 JSONL rollout

# 机器可读事件流
node bin/codingx.js --json exec "检查并修复 lint 错误"

# 离线回放任意会话（直接读 JSONL，不需要 daemon / 凭证）
node bin/codingx.js log --session <id>

# 会话续接（交互模式；exec 会在结束时关闭会话）
node bin/codingx.js --continue          # 当前目录最近一个 idle/interrupted 会话
node bin/codingx.js --resume <id>       # 指定 id 或唯一前缀
node bin/codingx.js --fork <id>         # 复制历史到新会话后继续

# 跨 CLI 会话查询 / sessiond 管理
node bin/codingx.js sessions list
node bin/codingx.js sessions show <id>
node bin/codingx.js sessions watch <id>
node bin/codingx.js sessions prune --older-than 30 --dry-run  # 省略 --older-than 时用 [session] retention_days
node bin/codingx.js sessiond status
node bin/codingx.js sessiond stop
```

当前没有 `codingx login`；可以直接手写 `~/.codingx/auth.json`（0600）：

```json
{ "providers": { "primary": { "apiKey": "..." } } }
```

并执行 `chmod 600 ~/.codingx/auth.json`。

### 已验证的验收路径

自动化测试使用本地假 Anthropic SSE 服务覆盖完整链路：

```text
ReadFile(src/util.ts) → EditFile(foo → bar) → Shell(grep 校验) → 最终回答
```

测试同时断言 rollout 可回放、`--json` stdout 无人类文本、会话结束后写 `session.end`、续接/分叉历史、悬空工具调用修复与 30 轮压缩。当前 **55 个测试文件、630 项测试**全部通过；还覆盖真实 Ctrl+C 后 `--continue`、两个 CLI 的写租约互斥、TUI 帧/按键预算、slash 补全、`/clear` 重写 JSONL、`/model` 模型与推理强度切换、`--add-dir` 额外可写目录、`--yolo` 绕过 workspace 限制（含别名与告警）、Permission profile / `--sandbox` / `--ask-for-approval` / 非交互 fail closed / `permission.decision` 审计、TUI/plain 审批与拒绝理由 / 会话与前缀授权 / `/permissions` 切换 / `approval.*` 审计、`sessions prune`、旧 daemon 方法握手与自动替换、composer/用户消息背景与底部 meta，以及“CLI → 自动拉起 sessiond → rollout → sessions list/show → status/stop”和 80x24/120x40 TUI PTY 冒烟。真实 Provider 的冒烟需要配置 `API_KEY` 后手工执行；CI 不访问外网。

## 当前实现边界

| 能力 | M1 状态 | 计划 |
| --- | --- | --- |
| 多目标路由 / failover / weighted / round-robin | 只允许单目标；多目标配置会明确报错 | M5 |
| sessiond / 跨 CLI 查询 | daemon、租约、自动拉起、sessions list/show/watch/prune 已实现；慢订阅者背压待补 | M2 |
| 自研 TUI | Terminal/TuiApp/TuiRuntime/TuiSession 已接入 CLI（TTY 默认）；markdown/diff、help/transcript overlay、slash 补全、`/clear`、`/model`、提问面板已完成；mention、session picker 待做；审批 overlay 属 M3 | M2 |
| 上下文压缩 | 三级已实现：截断 / 丢弃 / 模型摘要 | M2 已完成 |
| resume / fork | 已实现；sessiond 启用时通过 IPC/租约，嵌入式存储保留 | M2 |
| 工具 | `Glob`、`Grep`、`WriteFile`、`UpdatePlan`、`ApplyPatch`、`Skill`、`AskUserQuestion` 已实现；`AskUserQuestion` 仅在 TUI 可交互 | M2 |
| 权限体系 / 审批 / Permission profiles / Seatbelt / Landlock | M3.1 + M3.2 基础版已落地：文件工具受 profile + approval policy 约束；TUI/plain 可审批并做会话/前缀授权；非交互 fail closed；Shell 仍是启发式命令策略，无 OS 沙箱；审批选择器 overlay/长命令全屏待补。设计见 [permissions.md](docs/permissions.md) | M3（[任务拆分](docs/implementation-plan-m3.md)） |
| MCP / WebFetch / 自定义工具 | 配置会被解析但忽略并告警 | M4 |
| OpenAI Responses | 配置会报不支持 | M4 |

安全提醒：文件工具现在受 permission profile 与 approval policy 约束（默认 `:workspace` + `on-request`）；TUI/plain 交互会弹审批，非交互没有 approver 时 fail closed。但 OS 沙箱尚未实现，`Shell` 仍能执行当前用户能执行的任何命令；命令级策略只是保守启发式，不能视为隔离。`--yolo` / `--allow-dangerously-skip-permissions` 映射到 `:danger-full-access` + `never`，会放开文件工具策略并告警；它不改变“Shell 本身没有 OS 沙箱”这一事实。见 [permissions.md](docs/permissions.md)。**不要在不可信仓库中运行，更不要在有真实凭证的环境中随手使用 `--yolo`。**

## Skills

技能是放在 `~/.agents/skills/<name>/SKILL.md`、`~/.codingx/skills/<name>/SKILL.md` 或 `<project>/.codingx/skills/<name>/SKILL.md` 的本地指令包，frontmatter 至少包含一行 `description`：

```markdown
---
name: office-docx
description: Create, read, edit and validate Word documents.
---

# Workflow
...
```

系统提示只注入技能目录（名字 + 描述）；匹配任务时模型调用 `Skill` 工具加载完整正文。同名覆盖顺序为 项目 > `~/.codingx/skills` > `~/.agents/skills`。格式与限制见 [docs/tools.md](docs/tools.md#skills)。

## 设计目标

| 目标 | 说明 |
| --- | --- |
| 终端优先 | 全屏 TUI 与纯文本两种形态，SSH / tmux / CI 均可运行 |
| 交互对齐 | 全屏 TUI 按 Codex 的信息架构组织：欢迎卡、消息单元、底部 composer、审批弹层 |
| 自研终端 | TUI 自己管理 cell buffer、ANSI 差分、输入解析与 alt screen，不依赖 Ink |
| 多终端协同 | 会话由本地 sessiond 统一持有，任一终端可查询、观察同一会话 |
| 可审计 | 每次模型调用与工具执行都写入 append-only 的 JSONL 会话日志 |
| 默认安全 | 写操作与命令执行同时受审批策略和操作系统沙箱约束 |
| 可扩展 | 工具、模型 Provider、MCP Server 均为插件式注册 |
| 单文件分发 | `npx codingx` 即可启动，无本地构建步骤 |

## 非目标

- 不做 IDE 插件与图形界面
- 不做多用户 / 远程服务端形态；sessiond 只监听本机 Unix socket / 命名管道
- 不逐像素复刻 Codex 的 TUI；对齐信息架构、核心状态与键盘手感
- TUI 不含登录、认证、配置文件、设置页、主题/模型选择器或可配置键位
- 不自研模型，只做 Harness 层

## 核心概念

| 概念 | 含义 |
| --- | --- |
| **Session** | 一次完整会话，由本地 sessiond 持有并写入一个 JSONL rollout，可恢复（resume）、分叉（fork），也可被其他 CLI 查询/观察 |
| **Sessiond** | 每用户、每个 `CODINGX_HOME` 一个的本地会话管理进程，负责会话注册、写租约、追加与广播 |
| **Turn** | 一轮「用户输入 → 模型推理 → 工具调用 → 收敛」的完整过程 |
| **Tool Call** | 模型发起的一次结构化工具请求，由工具层执行并回填结果 |
| **Approval** | 对写操作 / 命令执行的放行决策，由审批策略与用户交互共同决定 |
| **Sandbox** | 操作系统级的文件系统与网络隔离层，是审批之外的第二道防线 |
| **Rollout** | 会话事件的持久化记录，同时是审计日志与上下文重建的数据源 |

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/implementation-plan.md](docs/implementation-plan.md) | **M1 任务拆分、验收结果与当前实现边界** |
| [docs/implementation-plan-m2.md](docs/implementation-plan-m2.md) | **M2 任务拆分与当前进度（续接/压缩/工具/sessiond/TUI CLI 已完成，TUI 细节与验收进行中）** |
| [docs/roadmap.md](docs/roadmap.md) | 里程碑与交付顺序 |
| [docs/architecture.md](docs/architecture.md) | 分层架构、模块职责、核心接口、Turn 数据流 |
| [docs/tui.md](docs/tui.md) | 自研 Terminal、cell buffer、布局、流式渲染、键位与 overlay |
| [docs/session-manager.md](docs/session-manager.md) | sessiond 进程模型、IPC 协议、写租约、跨 CLI 查询 |
| [docs/provider-routing.md](docs/provider-routing.md) | Provider 路由、failover、负载均衡、熔断与粘性 |
| [docs/agent-loop.md](docs/agent-loop.md) | Turn 生命周期、上下文管理、压缩与错误恢复 |
| [docs/tools.md](docs/tools.md) | 工具清单、工具接口约定、审批粒度 |
| [docs/permissions.md](docs/permissions.md) | **M3 权限体系设计：Permission profiles、approval、提权、沙箱与审计** |
| [docs/implementation-plan-m3.md](docs/implementation-plan-m3.md) | **M3 任务拆分与验收（S1–S8）** |
| [docs/security.md](docs/security.md) | 权限模型、沙箱、网络、提示注入、凭证与审计 |
| [docs/config.md](docs/config.md) | 配置文件、Provider 配置、AGENTS.md 约定 |

## 技术选型

| 领域 | 选择 | 理由 |
| --- | --- | --- |
| 运行时 | Node.js ≥ 20（ESM） | 原生 fetch、AbortController、稳定的 async 语义 |
| 语言 | TypeScript strict | 工具入参、事件类型、Provider 接口都靠类型收敛 |
| Provider 协议 | Anthropic Messages（默认）/ OpenAI Responses（后续） | 统一 ModelEvent，协议差异收敛在 providers/ |
| Provider 路由 | route + target，failover / weighted / round-robin | 会话粘性、熔断与健康检查 |
| TUI | 自研 Terminal（TypeScript） | 自己管理 cell buffer、ANSI 差分、输入与 alt screen，不依赖 Ink |
| CLI 解析 | commander | 子命令 + 选项足够，生态成熟 |
| 会话进程 | sessiond + Unix socket / 命名管道（JSON-RPC 2.0） | 单写者落盘、跨 CLI 查询，不暴露 TCP 端口 |
| 测试 | Vitest | 与 ESM/TS 零配置，快照测试适合渲染层 |
| 构建 | tsup | 单文件 bundle，启动快，发布产物简单 |
| 校验 | zod | 工具入参 schema 与运行时校验复用同一份定义 |

## 仓库结构（已实现）

```text
codingx-harness/
├── AGENTS.md               # 本仓库的构建/测试约定（运行时注入系统提示）
├── bin/
│   └── codingx.js          # 可执行入口，转发到 dist/main.js
├── src/
│   ├── cli/                # 参数解析、exec / interactive / log、bootstrap
│   ├── agent/              # 循环、turn 状态机、上下文/压缩、历史重建
│   ├── providers/          # ModelEvent 契约、SSE、Anthropic Messages、factory
│   ├── routing/            # 单目标 router、pin、首内容前重试
│   ├── skills/             # SKILL.md 扫描、frontmatter、按需加载
│   ├── tools/              # read/list/glob/grep/write/edit/shell/ask/skill
│   ├── exec/               # spawn、进程组、超时、有界输出、env 白名单
│   ├── session/            # rollout 信封、JSONL 单写者、文件锁、replay
│   ├── sessiond/           # JSON-RPC 协议/传输、socket server、registry/租约、daemon
│   ├── config/             # TOML 加载与合并、项目配置限制
│   ├── tui/                # Terminal 内核：宽度/cell buffer/差分渲染/输入/布局
│   ├── ui/                 # 纯文本 renderer；TUI 组装在 M2 后续
│   ├── util/               # 错误、ID、path、token 估算、凭证、脱敏
│   ├── version.ts
│   └── main.ts
├── tests/                  # 单元 + 假 Provider 集成 + CLI E2E（无外网）
└── docs/
```

## 里程碑

- **M0 设计对齐**：已完成
- **M1 最小可用循环**：已完成（见 [implementation-plan](docs/implementation-plan.md)）
- **M2 交互体验**：核心与验收完成（续接/fork、三级压缩、工具、TUI CLI/markdown/diff/overlay/slash/底部背景与 meta、sessiond/跨 CLI/prune、G1-G5 已完成；mention/picker/表格 holdback/背压列为 M2.1）
- M3 安全、M4 扩展性、M5 进阶能力、M6 分发：见 [docs/roadmap.md](docs/roadmap.md)

## License

MIT
