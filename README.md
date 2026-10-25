# codingx-harness

> 终端里的 AI 编码 Agent —— Node.js + TypeScript 实现，交互形态参考 Codex CLI。

`codingx` 是一个跑在终端里的编码 Agent。你用自然语言描述任务，它在当前仓库里读代码、改文件、执行命令、跑测试，循环到任务完成。它不依赖 IDE，一条命令即可在本地、SSH 会话或 CI 中运行。会话状态由本地 rollout 统一管理，多个终端能看到同一份进行中的状态（目标态）。

**状态：M1（最小可用循环）已完成；M2 核心功能与验收完成（剩余 mention/session picker/审批 overlay/表格 holdback/慢订阅者背压列为 M2.1 增强）。** 设计文档描述的是目标态；已落地范围与偏差见 [docs/implementation-plan.md](docs/implementation-plan.md)、[docs/implementation-plan-m2.md](docs/implementation-plan-m2.md) 与 [docs/roadmap.md](docs/roadmap.md)。

M1 已经可以完成「读文件 → 改文件 → 跑测试 / 命令」的闭环：

- TypeScript strict + ESM + tsup 构建，`bin/codingx.js` 启动
- Anthropic Messages 流式 Provider（tool use / prompt caching / 错误分类 / 超时与中断）
- 单目标 ProviderRouter（首个内容事件前重试；多目标路由留到 M5）
- Agent 循环（串行工具、maxSteps、abort、usage、完整 rollout）
- 工具：`read_file`、`list_dir`、`edit_file`（先读后写）、`shell`（进程组 + 超时回收）
- 纯文本 CLI：`codingx exec`、逐行交互模式、`--json` 事件流、`codingx log` 离线回放
- 进程内 JSONL SessionStore（单写者文件锁、seq、去重、脱敏、未完成尾行恢复）

M2 本轮已落地：

- **会话续接**：`--continue` / `--resume <id>` / `--fork <id>`；从 rollout 重建消息历史，悬空工具调用补合成 `tool_result`，恢复已读文件状态
- **上下文压缩**：三级压缩（截断 → 丢弃 → 模型摘要），写入 `context.compacted`；30 轮大工具输出压测通过
- **工具扩展**：`glob`、`grep`（优先 rg，缺失时内置回退）、`write_file`、`update_plan`、`apply_patch`
- **Terminal 与 TUI 层**：Terminal 内核 + TuiApp/TuiRuntime/TuiSession、独立背景 composer/用户消息、底部 meta（model · cwd · session title）、硬件光标/IME 定位、resume transcript 重建、欢迎卡常驻历史顶部、鼠标滚轮滚动、`/copy` 按区域复制、Ctrl+Y 全量复制、鼠标拖选自动复制、markdown/code/diff 消息单元、turn 完成摘要（total/llm/tools 耗时、Token）、状态行上下文用量（默认 1M）、累计 Token 与 turn/step 信息、help/transcript overlay、slash 补全菜单；TTY 默认全屏 TUI，`--plain` 退化
- **sessiond**：JSON-RPC/NDJSON、Unix socket server、注册表/写租约/heartbeat/崩溃恢复、typed client、remote SessionStore、自动拉起、空闲退出；CLI 默认通过 IPC 写入
- **跨 CLI**：`sessions list/show/watch/prune`、`sessiond start/stop/status/restart`；首次 CLI 运行会自动拉起 detached daemon

尚未实现：TUI mention、session picker/审批 overlay、表格 holdback、慢订阅者背压、审批与沙箱、MCP、并行工具、多 Provider 路由、OpenAI Responses。使用前请阅读 [当前实现边界](#当前实现边界)。

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

# 交互式：TTY 默认全屏 TUI；--plain 强制逐行
node bin/codingx.js

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
node bin/codingx.js sessions prune --older-than 30 --dry-run
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
read_file(src/util.ts) → edit_file(foo → bar) → shell(grep 校验) → 最终回答
```

测试同时断言 rollout 可回放、`--json` stdout 无人类文本、会话结束后写 `session.end`、续接/分叉历史、悬空工具调用修复与 30 轮压缩。当前 **48 个测试文件、499 项测试**全部通过；还覆盖真实 Ctrl+C 后 `--continue`、两个 CLI 的写租约互斥、TUI 帧/按键预算、slash 补全、`sessions prune`、composer/用户消息背景与底部 meta，以及“CLI → 自动拉起 sessiond → rollout → sessions list/show → status/stop”和 80x24/120x40 TUI PTY 冒烟。真实 Provider 的冒烟需要配置 `API_KEY` 后手工执行；CI 不访问外网。

## 当前实现边界

| 能力 | M1 状态 | 计划 |
| --- | --- | --- |
| 多目标路由 / failover / weighted / round-robin | 只允许单目标；多目标配置会明确报错 | M5 |
| sessiond / 跨 CLI 查询 | daemon、租约、自动拉起、sessions list/show/watch/prune 已实现；慢订阅者背压待补 | M2 |
| 自研 TUI | Terminal/TuiApp/TuiRuntime/TuiSession 已接入 CLI（TTY 默认）；markdown/diff、help/transcript overlay、slash 补全已完成；mention、session picker/审批 overlay 待做 | M2 |
| 上下文压缩 | 三级已实现：截断 / 丢弃 / 模型摘要 | M2 已完成 |
| resume / fork | 已实现；sessiond 启用时通过 IPC/租约，嵌入式存储保留 | M2 |
| 工具 | `glob`、`grep`、`write_file`、`update_plan`、`apply_patch` 已实现 | M2 |
| 审批策略 / Seatbelt / Landlock | 未实现；shell 直接以当前用户权限执行 | M3 |
| MCP / web_fetch / 自定义工具 | 配置会被解析但忽略并告警 | M4 |
| OpenAI Responses | 配置会报不支持 | M4 |

安全提醒：当前没有审批与操作系统沙箱，`shell` 能执行当前用户能执行的任何命令。文件工具被限制在 workspace 内，shell 的 `cwd` 也被限制，但命令本身可以自行 `cd`。**不要在不可信仓库中运行。**

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
| [docs/security.md](docs/security.md) | 审批策略、沙箱模式、网络与命令白名单 |
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
│   ├── tools/              # read/list/glob/grep/write/edit/shell
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