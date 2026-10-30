# codingx-harness

> 终端里的 AI 编码 Agent —— Node.js + TypeScript 实现，交互形态参考 Codex CLI。

`codingx` 是一个跑在终端里的编码 Agent。你用自然语言描述任务，它在当前仓库里读代码、改文件、执行命令、跑测试，循环到任务完成。它不依赖 IDE，一条命令即可在本地、SSH 会话或 CI 中运行。会话状态由本地 rollout 统一管理，多个终端能看到同一份进行中的状态（目标态）。

**平台范围：当前 CLI 仅支持 macOS。开发、测试、验收和分发均以 macOS 为目标；Linux / Windows 属于未来可选扩展，不在当前交付范围，也不阻塞当前里程碑验收。文档中的相关平台设计或代码中的降级分支不代表已提供支持。**

**状态：M1（最小可用循环）已完成；M2 核心功能与验收完成（剩余 mention/session picker/表格 holdback/慢订阅者背压列为 M2.1 增强）；M3.1 策略内核、M3.2 审批交互与 M3.3 macOS Seatbelt 沙箱已落地；Agent Harness 生命周期 hooks MVP 已接入。** 当前 macOS 默认配置下，Shell 的文件写入被限制在 permission profile 根、网络默认拒绝、敏感凭证路径由内核拦截，拒绝会以 `sandbox.denied` / `SANDBOX_DENIED` 回填。Linux Landlock（M3.4）、网络代理/域名白名单（S6）、exec policy 规则（S5）与 auto-review（S7）仍未完成。设计文档描述的是目标态；已落地范围与偏差见 [docs/implementation-plan.md](docs/implementation-plan.md)、[docs/implementation-plan-m2.md](docs/implementation-plan-m2.md) 与 [docs/roadmap.md](docs/roadmap.md)。M3 权限设计见 [docs/permissions.md](docs/permissions.md)，任务拆分见 [docs/implementation-plan-m3.md](docs/implementation-plan-m3.md)。

M1 已经可以完成「读文件 → 改文件 → 跑测试 / 命令」的闭环：

- TypeScript strict + ESM + tsup 构建，`bin/codingx.js` 启动
- Anthropic Messages 流式 Provider（tool use / prompt caching / 错误分类 / 超时与中断）
- 单目标 ProviderRouter（首个内容事件前重试；多目标路由留到 M5）
- Agent 循环（串行工具、maxSteps、abort、usage、完整 rollout）
- 工具：`Read`、`ListDir`、`Edit`（先读后写）、`Shell`（进程组 + 超时回收）
- 受管进程：`ProcessStart`、`ProcessList`、`ProcessRead`、`ProcessStop`；跨 turn 保留服务，有界日志与读取游标，`/clear` / 正常退出回收进程组。网络权限沿用 profile；不跨 CLI 托管。见 [Process 使用与边界](docs/processes.md)。
- 直接管理进程：`/process` 查看列表，`/process logs <id>` 查看日志，`/process stop <id>` 停止；plain / TUI 均支持，无需调用模型，id 可用唯一前缀。
- 纯文本 CLI：`codingx exec`、逐行交互模式、`--json` 事件流、`codingx log` 离线回放
- 进程内 JSONL SessionStore（单写者文件锁、seq、去重、脱敏、未完成尾行恢复）

M2 本轮已落地：

- **编辑 Diff**：`Write`、`Edit`、`ApplyPatch` 成功后显示 `Edited N files (+新增 -删除)`；相邻编辑按文件聚合，显示行号、红绿背景与代码着色，每个文件默认预览 3 行，Ctrl+O 展开详情。变更随 rollout 保存，resume 可回放；大 Diff 明示截断。
- **Tips**：TUI 在 StatusBar 正下方显示一条随机使用提示；`/tips` 可浏览完整提示，选中后填入输入框供编辑、发送，同时更新本次运行显示的提示。编辑 `$CODINGX_HOME/tips.json`（默认 `~/.codingx/tips.json`）可替换提示列表或关闭自动显示，首次启动自动生成。详见 [Tips 配置](docs/config.md#tips)。
- **cwd 隔离**：新会话保存在 `$CODINGX_HOME/sessions/<cwd-name>/`（如 `sessions/-Users-red-workspace-codingx-harness/`；自定义 `session.dir` 同样追加 cwd 子目录）；列表、resume、fork、log、watch、prune 只操作当前 cwd。子目录独立，符号链接按真实路径归并；旧会话按 header 中的 cwd 继续读取，旧全局输入历史保留但不自动导入。
- **会话续接**：`--continue` / `--resume <id>` / `--fork <id>`；从 rollout 重建消息历史，悬空工具调用补合成 `tool_result`，恢复已读文件状态
- **上下文压缩**：三级压缩（截断 → 丢弃 → 模型摘要），写入 `context.compacted`；30 轮大工具输出压测通过
- **工具扩展**：`Glob`、`Grep`（优先 rg，缺失时内置回退）、`Write`、`UpdatePlan`、`ApplyPatch`、`Skill`、`AskUserQuestion`
- **额外工作目录**：`--add-dir <DIR>` 可重复，把主 workspace 之外的目录显式加入文件与 Shell 工具的允许根；当前只有 profile 的 `:workspace_roots` 允许写时才能追加，`:read-only` 会报错。仅对当前调用生效，`--continue`/`--resume` 需再次传入
- **权限策略（M3.1）**：Permission profiles（`:read-only` / `:workspace` / `:workspace-git-hooks` / `:danger-full-access` + 命名 profile）、`approval_policy`（`on-request` / `never`）、`--sandbox` / `--ask-for-approval` / `--permission-profile` 已接入文件工具与 Shell；越界在非交互模式下返回 `APPROVAL_REQUIRED`/`PERMISSION_DENIED`，并写 `permission.decision` 审计事件
- **审批交互（M3.2）**：TUI 底部审批弹层与 plain 交互提示；允许一次 / 本会话 / 命令前缀 / 拒绝并说明原因；授权仅存在内存，`/clear` 清除，resume 不继承；`/permissions` 可列出并切换 profile；写 `approval.requested/decided`、`permission.granted`、`profile.changed`
- **本地 `!` 命令**：交互输入 `!pwd` 直接执行终端命令，不经过模型；输入行显示为 `› ! pwd`，输出完整展示、不做 3 行预览（模型发起的 Shell 仍是 `• Ran …`），命令与结果写入 `local.command` / `local.result` 并可在 resume 时恢复。命令仍走 Shell 的 permission profile、审批弹层与 OS 沙箱，turn 运行中拒绝执行，Esc/Ctrl+C 可中断；plain 交互模式同样支持
- **Agent Harness hooks**：全局配置 `[[hooks]]` 支持 `session_start` / `user_prompt_submit` / `pre_tool_use` / `post_tool_use` / `stop` / `session_end` 六个生命周期事件；hook 通过 stdin 接收 JSON、按配置顺序执行、写入 `hook.finished` 审计，exit 2 可阻止 prompt 或工具调用；项目配置不能定义 hooks
- **Git hooks**：仓库已有的 `pre-commit` 等 hooks 默认可以执行（`git commit` 会运行它们）；`.git/hooks` / `.git/config` 写入默认拒绝，防止静默安装持久化 hook。需要安装/管理 hooks 时使用 `:workspace-git-hooks` profile（或自定义 `:git_hooks` / `:git_config` 作用域），启动时会有安全告警
- **macOS Seatbelt 沙箱（M3.3）**：Shell 通过 `sandbox-exec` 在 `(deny default)` profile 中运行；写入严格限制在 profile 根（workspace、`--add-dir`、TMPDIR、`/tmp` 等），读取限制在系统/工具链/profile 根，`~/.ssh`、`~/.aws`、`~/.gnupg`、`.env*`、私钥等敏感路径与文件名由 Seatbelt 再次拒绝；网络默认 deny，profile 启用时整网放行（域名白名单待 S6）；拒绝写入 `sandbox.denied` 并回填 `SANDBOX_DENIED`；`sandbox-exec` 能力探测失败时 Shell fail closed，`--yolo` 在必须沙箱的平台拒绝启动
- **绕过权限检查**：`--yolo` / `--allow-dangerously-skip-permissions` 映射到 `:danger-full-access` + `never`，关闭文件工具策略、审批与 OS 沙箱并打印醒目告警；`exec policy` 的 `forbidden` 仍是尽力而为的硬拒绝。仅建议在一次性、外部已隔离的容器中使用
- **模型与推理强度**：通过 `--reasoning-effort`、`CODINGX_REASONING_EFFORT` 或 `[model].reasoning_effort` 设置 `low|medium|high|xhigh|max`（`default` 使用服务端默认值）；交互中 `/model --effort high` 即时切换，TUI 模型名旁显示档位。选择写入 `model.changed` 并在 resume/fork 时恢复，显式 CLI/env 可覆盖保存值。Anthropic Messages 通过 `output_config.effort` 传递（需目标模型支持该参数）。详见 [推理强度配置](docs/config.md#推理强度)
- **输入历史**：TUI 按 cwd 各保存最近 200 条输入（`$CODINGX_HOME/input-history/<cwd-name>/`，默认在 `~/.codingx/` 下），同一目录跨会话及重启共享，不同目录独立；单行输入用 ↑/↓ 翻查，↓ 越过最新条目恢复草稿，多行输入保留上下移动光标。Ctrl+R 按内容搜索（忽略大小写），再次 Ctrl+R 查找更早匹配，Enter 放回输入框编辑，Esc/Ctrl+C 取消并恢复原草稿；历史文件中的常见凭证会脱敏，`/clear` 不清除当前 cwd 的输入历史。
- **目录偏好**：`/model` 的模型、Provider、route、effort 与 `/permissions` 的权限 profile 按真实 cwd 保存，新会话和重启自动继承；不同目录隔离。CLI/env 仅临时覆盖，`/clear` 不清除目录偏好；详见 [配置优先级](docs/config.md#按-cwd-记住交互设置)。
- **Terminal 与 TUI 层**：Terminal 内核 + TuiApp/TuiRuntime/TuiSession、独立背景 composer/用户消息、底部 meta（model · cwd · session title）、硬件光标/IME 定位、resume transcript 重建、欢迎卡常驻历史顶部、`/copy` 按区域复制、`/clear` 重置会话（UI 与 JSONL rollout 一并清空）、Ctrl+Y 全量复制、滚轮/触控板原生翻阅历史、PgUp/PgDn 应用内翻页、终端原生拖选 + ⌘C 复制、markdown/code/diff 消息单元、连续读取/搜索/列目录调用聚合为 `Explored` 摘要（Ctrl+O 在历史视图中展开/收起原始结果，Esc 返回；最多 3 条摘要，失败数量始终可见），其他相邻同名同目标工具调用合并为 `×N` 块、turn 完成摘要（时间、总耗时、LLM/工具耗时、输入/输出及缓存 Token，紧凑标签）、状态行上下文用量（默认 1M）、累计 Token 与 turn/step 信息、help/transcript overlay、slash 补全菜单；TTY 默认全屏 TUI，`--plain` 退化
- **Skills 与用户提问**：`~/.agents/skills`、`~/.codingx/skills` 与 `<project>/.codingx/skills` 的 `SKILL.md` 按需加载（系统提示只放目录）；TUI 底部提问面板支持单选/多选/自由文本，答案经 `tool.result` 入 rollout
- **sessiond**：JSON-RPC/NDJSON、Unix socket server、注册表/写租约/heartbeat/崩溃恢复、typed client、remote SessionStore、自动拉起、空闲退出、方法握手（升级后自动替换缺少新方法的旧 daemon）；CLI 默认通过 IPC 写入
- **跨 CLI**：`sessions list/show/watch/prune`、`sessiond start/stop/status/restart`；首次 CLI 运行会自动拉起 detached daemon

尚未实现：TUI mention、session picker（M2.1）、Linux Landlock/Windows 沙箱、网络代理与域名白名单、exec policy 规则、Shell 沙箱提权/临时放宽（S5）、自动审查、表格 holdback、慢订阅者背压、MCP、并行工具、多 Provider 路由、OpenAI Responses。权限 profile、拒绝原因与提权流程见 [docs/permissions.md](docs/permissions.md)；使用前请阅读 [当前实现边界](#当前实现边界)。

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

# Git hooks：默认只执行不写入；安装/修改 hooks 需显式 profile（会告警）
node bin/codingx.js --permission-profile :workspace-git-hooks exec "安装并验证 pre-commit hook"

# 危险：关闭文件工具策略、审批与 OS 沙箱（仅用于一次性、外部已隔离的容器）
node bin/codingx.js --yolo exec "跨目录整理文件"

# 交互式：TTY 默认全屏 TUI；--plain 强制逐行
node bin/codingx.js
# 交互内 slash：/help /session /model /clear /copy /queue /quit
# /model 打开模型与 effort 选择面板；/model --show 查看当前值
# 列出所有配置的模型及 Provider，选择时同步切换对应端点
# /model <model> --effort high 同时切换；/model --effort high 只改强度
# /model <provider>/<model> 明确指定 Provider（同名模型时使用）
# /clear 会清空当前会话的 UI、内存历史与 JSONL rollout
# 启动时设置推理强度（交互模式和 exec 均支持）
node bin/codingx.js --reasoning-effort high
node bin/codingx.js --reasoning-effort medium exec "检查当前改动"
# 交互内 !<command>：直接执行终端命令（如 !pwd），仍经过权限策略、审批与沙箱

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
Read(src/util.ts) → Edit(foo → bar) → Shell(grep 校验) → 最终回答
```

测试同时断言 rollout 可回放、`--json` stdout 无人类文本、会话结束后写 `session.end`、续接/分叉历史、悬空工具调用修复与 30 轮压缩。当前 **59 个测试文件、680 项测试**全部通过；还覆盖真实 Ctrl+C 后 `--continue`、两个 CLI 的写租约互斥、TUI 帧/按键预算、slash 补全、`!` 本地命令（策略/审批/沙箱/排队/恢复）、Agent Harness hooks（六事件、exit 2 阻止、JSON stdin、session 生命周期、审计）、`/clear` 重写 JSONL、`/model` 模型与推理强度切换、`--add-dir` 额外可写目录、`--yolo` 绕过 workspace 限制（含别名与告警）、Permission profile / `--sandbox` / `--ask-for-approval` / 非交互 fail closed / `permission.decision` 审计、TUI/plain 审批与拒绝理由 / 会话与前缀授权 / `/permissions` 切换 / `approval.*` 审计、macOS Seatbelt 的越界写入/凭证读取/网络 deny/Node 工具链/git status/git hooks/`sandbox.denied`、`sessions prune`、旧 daemon 方法握手与自动替换、composer/用户消息背景与底部 meta，以及“CLI → 自动拉起 sessiond → rollout → sessions list/show → status/stop”和 80x24/120x40 TUI PTY 冒烟。真实 Provider 的冒烟需要配置 `API_KEY` 后手工执行；CI 不访问外网。

## 当前实现边界

| 能力 | M1 状态 | 计划 |
| --- | --- | --- |
| 多目标路由 / failover / weighted / round-robin | 每次只使用单目标；`/model` 可手动切换已配置 Provider/model，自动多目标路由仍未实现 | M5 |
| sessiond / 跨 CLI 查询 | daemon、租约、自动拉起、sessions list/show/watch/prune 已实现；慢订阅者背压待补 | M2 |
| 自研 TUI | Terminal/TuiApp/TuiRuntime/TuiSession 已接入 CLI（TTY 默认）；markdown/diff、help/transcript overlay、slash 补全、`/clear`、`/model`、提问面板已完成；mention、session picker 待做；审批 overlay 属 M3 | M2 |
| 上下文压缩 | 三级已实现：截断 / 丢弃 / 模型摘要 | M2 已完成 |
| resume / fork | 已实现；sessiond 启用时通过 IPC/租约，嵌入式存储保留 | M2 |
| 工具 | `Glob`、`Grep`、`Write`、`UpdatePlan`、`ApplyPatch`、`Skill`、`AskUserQuestion` 已实现；`AskUserQuestion` 仅在 TUI 可交互 | M2 |
| 权限体系 / 审批 / Permission profiles | M3.1 + M3.2 已落地：文件工具受 profile + approval policy 约束；TUI/plain 可审批并做会话/前缀授权；非交互 fail closed；权限选择器与长命令全屏查看已实现。设计见 [permissions.md](docs/permissions.md) | M3（[任务拆分](docs/implementation-plan-m3.md)） |
| Agent Harness hooks | 全局 `[[hooks]]` 六个生命周期事件；JSON stdin、matcher、exit 2 阻止 prompt/工具、`hook.finished` 审计；项目配置不能定义 hooks | 已实现（MVP） |
| Git hooks | 仓库 hooks 默认可执行；`.git/hooks` / `.git/config` 写入默认 deny；`:workspace-git-hooks` 或 `:git_hooks` / `:git_config` 作用域显式放开并告警 | 已实现 |
| OS 沙箱 | **macOS Seatbelt 已落地**：Shell 默认 deny、写入限定在 profile 根、网络默认 deny、凭证路径/文件由内核拒绝；`sandbox.denied` 审计；Linux Landlock / Windows 待做，Linux 暂时显式告警并保持无沙箱 | M3.3 已完成；M3.4/M3.5 待做 |
| MCP / WebFetch / 自定义工具 | 配置会被解析但忽略并告警 | M4 |
| OpenAI Responses | 配置会报不支持 | M4 |

安全提醒：文件工具与 Shell 受 permission profile 与 approval policy 约束（默认 `:workspace` + `on-request`）；TUI/plain 交互会弹审批，非交互没有 approver 时 fail closed。macOS 上 Shell 先经过策略再进入 Seatbelt：写入限定在 profile 根，网络默认 deny，`~/.ssh`、`.env*` 等敏感路径/文件由内核拒绝；Git hooks 默认只执行不写入，安装 hooks 需显式 `:workspace-git-hooks` 或 `:git_hooks` / `:git_config`，并会告警；Linux 目前没有 OS 沙箱（S4 待做），不能把命令级启发式当成隔离。`--yolo` / `--allow-dangerously-skip-permissions` 映射到 `:danger-full-access` + `never`，会同时关闭文件工具策略、审批与 OS 沙箱并告警；在必须沙箱的平台（macOS 缺少 `sandbox-exec`、Windows）会拒绝启动。见 [permissions.md](docs/permissions.md)。**不要在不可信仓库中运行；在 Linux 或使用 `--yolo` 时尤其要依赖外部隔离。**

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
| 自研终端 | TUI 自己管理 cell buffer、ANSI 差分、输入解析与主屏幕 scrollback，不依赖 Ink |
| 多终端协同 | 会话由本地 sessiond 统一持有，任一终端可查询、观察同一会话 |
| 可审计 | 每次模型调用与工具执行都写入 append-only 的 JSONL 会话日志 |
| 默认安全 | 写操作与命令执行同时受审批策略和操作系统沙箱约束 |
| 可扩展 | 工具、模型 Provider、MCP Server 均为插件式注册 |
| 单文件分发 | `npx codingx` 即可启动，无本地构建步骤 |

## 非目标

- 不做 IDE 插件与图形界面
- 不做多用户 / 远程服务端形态；sessiond 只监听本机 Unix socket / 命名管道
- 不逐像素复刻 Codex 的 TUI；对齐信息架构、核心状态与键盘手感
- TUI 不含登录、认证、配置文件、设置页、主题选择器或可配置键位；模型与 effort 由 `/model` 面板切换
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
| [docs/hooks.md](docs/hooks.md) | **Agent Harness 生命周期 hooks：事件、配置、JSON 输入/输出、审计与安全边界** |
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
| TUI | 自研 Terminal（TypeScript） | 自己管理 cell buffer、ANSI 差分、输入与主屏幕 scrollback，不依赖 Ink |
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
│   ├── policy/             # Action/profile/approval 判定、命令解析、会话授权
│   ├── hooks/              # Agent Harness 生命周期 hooks：配置、执行、审计
│   ├── sandbox/            # Seatbelt backend、profile 生成、能力探测/降级
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
- **M3 安全**：M3.1 策略、M3.2 审批、M3.3 macOS Seatbelt 已完成；Linux Landlock、网络代理/域名白名单、exec policy、auto-review 等待做（见 [implementation-plan-m3](docs/implementation-plan-m3.md)）
- M4 扩展性、M5 进阶能力、M6 分发：见 [docs/roadmap.md](docs/roadmap.md)

## License

MIT
