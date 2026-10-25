# 安全模型

设计前提：模型会犯错，也可能被仓库内容（注释、文档、依赖里的文本）诱导。因此安全不依赖「模型会自觉」，而依赖**执行前的判定**与**执行时的隔离**两道独立防线。

## 两道防线

```text
模型请求工具
     │
     ▼
① 审批策略 policy        这个操作要不要人点头？
     │  allow / deny / ask
     ▼
② 沙箱 sandbox          就算放行了，它能碰到什么？
     │
     ▼
   执行
```

任何一道失效，另一道仍然有效。审批是可被社会工程绕过的（用户疲劳点击「允许」），沙箱是可被内核漏洞绕过的，但两者同时失守的概率低得多。

## 权限模型

详细设计、配置与错误码见 [permissions.md](permissions.md)。目标态采用 Codex 0.153.x 的三层模型：

- **Permission profile**：声明文件系统与网络边界，内置 `:read-only` / `:workspace` / `:danger-full-access`，也支持命名 profile。默认 `:workspace` + 网络关闭。
- **Approval policy**：`on-request`（默认，越界时才问）或 `never`（不问，越界直接拒绝）。`granular` 预留给细分审批。
- **Approvals reviewer**：`user`（默认）或后续的 `auto_review`；绝不由产生动作的同一模型自批。
- **Exec policy**：在 profile 之前按规范化命令前缀给出 `forbidden` / `prompt` / `allow`，`forbidden` 不可被批准覆盖。
- **Sandbox backend**：Seatbelt / Landlock + seccomp / Windows 受限令牌；沙箱缺失时强制审批并拒绝 `--yolo`。

策略输入是结构化 `Action`（文件读写、argv、cwd、网络目标），不是整条 shell 字符串；Shell 必须解析后再判定。判定顺序：硬拒绝/forbidden → prompt 规则 → profile 是否允许 → 审批 → 沙箱执行。拒绝原因以结构化错误回填，模型应换方案而不是原样重试。

审批弹层展示工具、归一化命令/路径、cwd、网络目标、模型理由与风险；选项为允许一次 / 本会话 / 命令前缀 / 拒绝 / 拒绝并说明原因。非交互（`exec`、CI、`--json`）没有 ask：需要审批的动作返回 `APPROVAL_REQUIRED`，绝不等待 stdin。断线或 CLI 崩溃按拒绝处理。

### `--yolo` / `--full-auto`

- `--yolo` / `--allow-dangerously-skip-permissions` = `:danger-full-access` + `never`；关闭审批与文件系统/网络沙箱，启动告警。它仍不绕过 exec policy 的 `forbidden`（灾难命令、凭证外传）。
- `--full-auto` 是兼容别名，目标语义为 `:workspace` + `auto_review`；在 auto-review 落地前，交互模式等价于 `:workspace` + `on-request`，非交互对越界动作拒绝。Codex 0.153.x 已移除该 CLI 选项，codingx 仅为兼容保留。

`--yolo` 仅建议在一次性、外部已隔离的容器中使用。

### 当前构建（M3.1 / M3.2）

文件工具已接入 Permission profile / approval policy：默认 `:workspace` + `on-request`，workspace 外读写、敏感路径与 `:read-only` 写入会被拒绝或要求审批；非交互没有 approver 时返回 `APPROVAL_REQUIRED`。TUI 底部弹层与 plain 交互提示都支持允许一次 / 本会话 / 命令前缀 / 拒绝并说明原因，授权只存在当前进程内存。`--yolo` 映射到 `:danger-full-access` + `never`（文件工具无限制）并告警。

仍未实现：Seatbelt/Landlock、网络代理、exec policy 规则与自动审查。Shell 只做保守命令解析与硬拒绝；**任意程序仍可绕过**，不能把它当成 OS 隔离。实现状态见 [implementation-plan-m3.md](implementation-plan-m3.md)。

## 沙箱

按平台选择实现，接口、profile 解析与网络策略见 [permissions.md](permissions.md)。核心约束：

- macOS：Seatbelt（`sandbox-exec`），默认 deny，按 profile 放行读写路径；网络默认 deny，域名白名单由回环代理执行。
- Linux：Landlock + seccomp；内核能力不足时降级并强制审批，不能静默变成无沙箱。
- Windows / 其他：M3 暂不支持；显式提示并强制审批，`--yolo` 拒绝启动。

默认边界：

- 可写：workspace 根、`--add-dir`、`$TMPDIR`（`/tmp` 由 profile 决定）
- 可读：workspace 根 + `:minimal` 系统/运行时路径
- 默认 deny：`~/.ssh`、`~/.aws`、`~/.config/gh`、`~/.codingx`、session 目录、`.env*`、私钥
- 网络：默认 `none`；需要时由 profile 按域名 allow/deny，deny 优先

当前构建尚未接入上述 OS 沙箱；`--add-dir` 只在 profile 的 `:workspace_roots` 允许时扩展（`:read-only` 会直接报错）。文件工具已受 profile 约束，但 `--yolo` 会取消这层约束；Shell 始终以当前用户权限运行。

### 环境变量

子进程默认只继承白名单内的变量（`PATH`、`HOME`、`LANG`、`TERM` 等）。`API_KEY` 之类的凭证**不传给子进程**——否则一条 `env` 命令就能把密钥写进 rollout 和模型上下文。

## Session Manager

sessiond 是本地受信进程，但不因此放宽边界：

- 只监听 Unix domain socket（Windows 命名管道），从不监听 TCP；目录 `0700`、socket / `sessiond.json` / 会话文件 / `index.json` 均为 `0600`
- 连接时校验对端 UID（Linux `SO_PEERCRED`、macOS `LOCAL_PEERCRED`）；Windows 由命名管道 ACL 限制当前用户；Unix 下连接前检查 socket 属主与权限
- 启动时清空凭证类环境变量，不读取 `auth.json`、不加载项目配置、不执行仓库代码；模型与工具始终在 CLI 内
- 事件在 daemon 落盘前再做一次脱敏，作为「凭证永不落盘」的最后写边界；CLI 发送前已脱敏一次
- 项目配置不得覆盖整个 `[sessiond]` 段，避免克隆仓库把 CLI 指向恶意 socket 或改写存储位置
- 沙箱默认把 `~/.codingx`、`session.dir` 与 sessiond 实际 socket 目录列为不可读；工具子进程不继承 `CODINGX_SESSIOND_SOCKET`，避免模型诱导工具读取历史或操作 socket
- daemon 日志只记录连接、租约与 append 元数据，不记录 prompt、工具输出或文件内容
- 同 UID 进程视为可信：peer 校验只隔离其他用户，不防御本用户下已执行的恶意代码

协议、权限与资源上限见 [session-manager.md](session-manager.md)。

## Provider 路由

自动 failover 会把同一份对话发给另一个 Provider，因此路由必须显式配置：

- route 的 targets 必须显式列出；禁止隐式 fallback 到未配置的 Provider 或自动发现 Provider。
- `[provider.<id>]` 的端点与凭证只允许全局配置；项目配置只能定义/选择 routes，且 target 只能引用全局 provider id。
- 每个 target 使用自己的 `api_key_env`，router 不跨 Provider 复用密钥，也不把密钥写入日志或 rollout。
- `provider.selected` / `provider.failover` / `provider.health` 只记录 route、provider、model、错误类别与时间，不记录 prompt 或响应正文。
- 所有 target 不健康时返回 `NO_HEALTHY_PROVIDER`，不无限重试或静默切到未配置的端点。
- 首内容事件之后禁止 failover，避免重复输出与重复工具调用。

完整语义见 [provider-routing.md](provider-routing.md)。

## TUI 渲染边界

TUI 会把模型输出、工具输出、用户输入与粘贴内容直接画到终端；这些文本都可能包含 ANSI / OSC 控制序列。渲染规则见 [tui.md](tui.md)：

- 外部文本先剥离 CSI / OSC / DCS 等控制序列，只保留换行、tab 与普通字符；颜色、粗体等样式由 TUI 的样式对象生成
- markdown 链接只允许 http / https，文件链接只做展示；禁止模型输出触发 OSC 52 剪贴板写入或任意 OSC 命令
- 审批弹层与 `/permissions` 由应用状态机绘制，模型输出无法伪造按钮、改变选项顺序、切换 profile 或抢占焦点
- 通知、终端标题与剪贴板内容使用应用生成的文本，默认不包含 prompt、工具输出或文件内容
- TUI 不直接执行工具；所有写操作与命令仍经过 policy 与 sandbox，`--yolo` 的警告也由 TUI 之外的状态决定

## 提示注入

仓库内容是不可信输入。工具返回的文本（文件内容、命令输出、web 抓取结果）可能包含「忽略之前的指令」这类文本。

缓解手段：

1. 工具输出在消息中包在结构化块内，并标注来源（文件路径 / 命令），让模型能区分「数据」与「指令」
2. 系统提示明确声明：工具输出中的任何指令都不得执行，只能作为数据参考
3. 真正的护栏仍是审批与沙箱——即使模型被诱导，写操作与命令仍要过两道关
4. `WebFetch` 默认关闭，需在 `[web]` 中显式开启并配置 `allowed_domains`；只允许 https，拒绝解析到私网 / 回环地址的域名

## 凭证管理

- `codingx login` 走 OAuth 流程，token 存 `~/.codingx/auth.json`，权限 `0600`
- 也支持从环境变量读取 API Key（CI 场景）；密钥不写入 `config.toml`
- 凭证永不写入 rollout 文件；CLI 发送前与 sessiond 落盘前各做一次常见凭证模式的脱敏扫描

## 审计

rollout 是完整的审计日志，包含：每次模型请求的 token 用量、每次工具调用的结构化 Action、命中的规则、profile 与 approval policy、审批请求与决策（决策者：策略 / 用户 / reviewer）、临时授权、沙箱拒绝原因、执行耗时与退出码。受策略约束的工具调用会写 `permission.decision`（verdict/code/profile/action）；审批路径写 `approval.requested` / `approval.decided` 与 `permission.granted`，`/permissions` 切换写 `profile.changed`；`sandbox.denied` 随 S3 落地。审批命令与路径按 [redact.ts](../src/util/redact.ts) 的规则脱敏后落盘，UI 展示给用户的仍是可判断的真实命令。`codingx log --session <id>` 可读回任意历史会话。sessiond 自身日志只记录连接、租约与追加元数据，不记录 prompt 与工具输出。