# M3 实施计划（权限与沙箱）

**当前平台范围：CLI 仅支持 macOS。S4（Linux）与 S7.5（Windows）为未来可选扩展，暂缓实施，不计入当前 M3 未完成项或验收门槛。下文保留其他平台设计与已有降级行为的记录，不代表当前支持承诺。**

依据 [permissions.md](permissions.md) 的设计，在 M2 的可运行循环上落地 Codex 风格的权限体系。M3 的目标不是「加一个确认框」，而是让默认配置在**策略判定**与**执行隔离**两层同时生效，并且拒绝原因对模型可见。

> 状态：**M3.0 设计完成；M3.1 策略内核、M3.2 审批交互基础版与 M3.3 macOS Seatbelt 已落地**；S1.1–S1.8、S2.2–S2.4、S3.1–S3.5 为 DONE，S2.1 / S2.5 为 DOING，S5.1–S5.4 与 S6.1–S6.4 已完成；S5.5 硬拒绝增强与 S7 仍有待办，S4 / S7.5 暂缓，S8 部分完成。当前构建已有文件工具策略、TUI/plain 审批、会话/前缀授权、`/permissions` 切换、非交互 fail closed、approval/permission/sandbox 审计，以及 macOS Shell 的 Seatbelt 文件系统与网络隔离；S5 按次追加权限/声明式规则与 S6 网络代理已落地；Linux Landlock 和自动审查仍未实现。

## 目标与验收

### 本轮 S5/S6 实施范围（已实现）

- S5：Shell / ProcessStart 增加 `sandbox_permissions`、`justification`、`additional_permissions` 和 `prefix_rule`；只增加本次执行明确申请的读写根/网络域名，保留敏感路径 deny。拒绝经工具结果回填，由模型带理由重试，不自动重放可能已有副作用的命令。每 turn 限制提权申请次数。
- exec policy：加载全局 rules 目录及全局配置指定的 `.rules`；支持声明式 `prefix_rule(pattern, decision, justification, match, not_match)` 子集，不执行 Python/Starlark。`forbidden > prompt > allow`，规则不能放宽 OS 沙箱；提供离线 `execpolicy check`。
- S6：按执行启动回环 HTTP/CONNECT 代理，域名 deny 优先，默认拒绝未列出的目标；DNS 全量检查后连接固定 IP，私网仅允许精确显式授权。Seatbelt 仅允许连接代理端口，拒绝绕过代理的 TCP/UDP/监听；退出/中断/进程结束回收代理。HTTP(S) 代理以外协议不在本轮范围。
- 验证：本地 HTTP/CONNECT 服务、DNS 假实现、macOS Seatbelt、审批拒绝/取消/never、后续调用权限不继承、规则配置和诊断 CLI；不访问外网。

- 默认 profile（`:workspace` + `on-request`）下，模型写 workspace 外文件、读取凭证目录或联网时被拦截，且模型收到可操作的结构化原因。
- 交互模式下，越界动作弹出审批框；允许一次 / 本会话 / 命令前缀 / 拒绝并说明原因都写入 rollout。
- 非交互（`exec`、CI）没有审批 UI 时 fail closed；需要审批的动作返回 `APPROVAL_REQUIRED`，不会被静默执行。
- `--yolo` / `--allow-dangerously-skip-permissions` 关闭审批与沙箱并打印警告；exec policy 的 `forbidden` 仍然生效。
- 沙箱能力缺失的平台会显式降级并 fail closed（或强制审批），`--yolo` 拒绝启动，不能静默变成无沙箱。
- 现有全量测试全部通过；新增策略、审批、Seatbelt 沙箱与 PTY/E2E 测试，CI 不依赖外网（非 macOS 上 Seatbelt 用例按平台 skip）。

## 不变量

1. 策略输入是结构化 `Action`，不是整条命令字符串。
2. 审批不能覆盖硬拒绝 / `forbidden` 规则；沙箱拒绝与用户拒绝都要回填原因。
3. 模型不能自批；只有写租约持有者能批准。
4. 项目配置只能收紧权限。
5. 未实现的能力在 CLI、文档与告警中明确标注，不假装可用。
6. 任何平台降级都必须显式告警，并提升审批等级（不能提升权限）。

## 任务拆分

状态：`TODO` / `DOING` / `DONE` / `DEFERRED`（当前范围外，暂缓）。

### S0 · 设计与任务拆分

| ID | 任务 | 交付物 | 验收 | 状态 |
| --- | --- | --- | --- | --- |
| S0 | 对照 Codex 0.153.x 的 profile / approval / reviewer / escalation 模型，更新安全设计与任务拆分 | `docs/permissions.md`、本文件、security/config/tools/roadmap/TUI 文档 | 文档明确当前实现边界、目标语义、配置与错误码；不再把未实现能力写成已实现 | DONE |

### S1 · 策略内核（无 OS 沙箱先跑通）

| ID | 任务 | 交付物 | 验收 | 状态 |
| --- | --- | --- | --- | --- |
| S1.1 | `Action` 类型与文件工具规范化 | `src/policy/types.ts`、`src/policy/engine.ts` | 文件路径 realpath、读写分类、`--add-dir` 根、symlink 逃逸可测试 | DONE（类型与文件工具规范化在 `src/policy/engine.ts`） |
| S1.2 | Shell 命令解析与多 Action | `src/policy/shell-parse.ts` | 管道/重定向/命令替换/环境赋值可拆解；解析失败进入审批；`rm -rf /` 等硬拒绝命中 | DONE（保守 tokenizer；不可解析结构进入审批） |
| S1.3 | Permission profile 解析与路径匹配 | `src/policy/profile.ts`、config | `:read-only` / `:workspace` / `:danger-full-access` + 自定义 profile；具体覆盖宽泛、deny 优先 | DONE |
| S1.4 | Approval 判定表 | `src/policy/engine.ts` | `on-request` / `never`；profile 内直接放行，越界进入 ask/deny；确定性单测覆盖每种组合 | DONE |
| S1.5 | 配置迁移与冲突校验 | `src/config/` | `sandbox_mode` 与新 `default_permissions` 冲突报错；旧 `[approval]` / `[sandbox]` 有迁移告警 | DONE（含 legacy writable_roots/network 映射） |
| S1.6 | CLI 与预设 | `src/cli/` | `--sandbox`、`--ask-for-approval`、`--permission-profile`、`--approve-for-me`（接口）、`--yolo`；冲突参数报错 | DONE（`--approve-for-me` 仅接口） |
| S1.7 | 工具执行接入策略 + 非交互 fail closed | `ToolRegistry` / `AgentLoop` / `exec` | 越界文件/命令被拒；`exec` 不弹窗；`--json` stdout 纯净 | DONE（S3 已在 macOS 补 OS 隔离；Linux 仍只有启发式） |
| S1.8 | 审计事件与错误码 | `src/session/types.ts`、`src/util/errors.ts` | `approval.requested/decided`、`permission.granted`、`sandbox.denied`、`profile.changed` 可回放；稳定 code | DONE（approval.requested/decided、permission.granted、profile.changed、permission.decision 已写入；S3 已补 `sandbox.denied` 与 `SANDBOX_DENIED`） |

**S1 验收**：本地假 Provider E2E 覆盖「写 workspace（放行）→ 写 workspace 外（`APPROVAL_REQUIRED`）→ `--ask-for-approval never`（`PERMISSION_DENIED`）→ `--sandbox read-only`（拒绝）」，并断言 `permission.decision` 审计事件；策略单测覆盖 `~/.ssh` / `.env` 拒绝。Shell 的硬拒绝/已知网络命令/重定向有单测；S3 已补 macOS Seatbelt，但 Linux 与自动审查仍未完成，当前 macOS 范围的完整 M3 验收仍需 S5.5 加固与 S7（不含 S7.5）。

### S2 · 审批 UX 与会话授权

| ID | 任务 | 交付物 | 验收 | 状态 |
| --- | --- | --- | --- | --- |
| S2.1 | TUI approval overlay | `src/tui/` | 展示工具、归一化命令/路径、cwd、理由、风险、选项；长命令可全屏 | DOING（TUI 弹层已渲染命令/路径/cwd/风险/选项；长命令支持 v 全屏查看、滚动与 Esc 返回） |
| S2.2 | 键位与决策 | TUI state | 允许一次 / 本会话 / 前缀 / 拒绝 / 拒绝并说明 / 取消；模型输出不能伪造 | DONE（允许一次/会话/前缀/拒绝/说明原因/取消；按键由固定状态机处理） |
| S2.3 | 会话授权缓存 | `src/policy/grants.ts` | 仅当前会话内存 + rollout；resume 不自动继承；拒绝原因回填 tool_result | DONE（`src/policy/grants.ts`；仅内存，`/clear` 清除，resume 不继承） |
| S2.4 | 写租约 / 断线语义 | sessiond / TUI | 只有 writer 能批准；断线按拒绝处理并写 `session.interrupted`；观察者只读 | DONE（只有 writer 运行 TuiSession；退出拒绝 pending；`turn.status awaiting_approval` 入 rollout） |
| S2.5 | `/permissions` 与状态行 | TUI | 查看/切换预设与命名 profile；状态行常驻显示 profile + approval policy；Full Access 告警 | DOING（`/permissions` 列表/切换 + meta 行/Full Access 告警；选择器已接入） |
| S2.6 | 非交互路径 | `exec` | 需要审批时返回 `APPROVAL_REQUIRED`；错误含可操作建议；不等待 stdin | DONE（S1 已实现非交互 fail closed） |

### S3 · macOS Seatbelt 沙箱

| ID | 任务 | 交付物 | 验收 | 状态 |
| --- | --- | --- | --- | --- |
| S3.1 | SandboxBackend 接口与能力探测 | `src/sandbox/types.ts`、`src/sandbox/seatbelt.ts` | `available()`、`capabilities`、降级原因可展示 | DONE（`createSandboxBackend()` 探测 `sandbox-exec`；Linux/Windows/其他平台返回显式 none backend） |
| S3.2 | Seatbelt profile 生成 | `src/sandbox/seatbelt.ts` | 默认 deny；只放行 profile 的读写根、系统只读路径、TMPDIR；敏感目录 deny | DONE（`buildSeatbeltProfile()`；系统/工具链只读根 + profile 写根；凭证目录与 `.env*`/私钥文件名用 regex deny） |
| S3.3 | Shell 接入（`:workspace` / `:read-only`） | exec 层 | workspace 内命令可跑；写外部/读 `~/.ssh` 被内核拒绝；拒绝原因结构化为 `SANDBOX_DENIED` | DONE（Shell 构造 `sandbox-exec -p ...` argv；结果写入 `sandbox` meta/内容并在 AgentLoop 记 `sandbox.denied`） |
| S3.4 | 网络默认 deny | Seatbelt | 联网命令失败；错误提示可审批或切换 profile；不泄露凭证 | DONE（默认 `(deny default)` 拒绝网络；profile 启用且无域名规则时整网放行；有域名规则时通过 S6 代理） |
| S3.5 | 降级与告警 | bootstrap | 无 sandbox-exec/能力不足时 fail closed 或强制审批，并拒绝 `--yolo`；启动告警 | DONE（macOS 探测失败时 Shell 返回 `SANDBOX_UNAVAILABLE`，`--yolo` 拒绝启动；Linux 在 S4 前显式告警并保持无沙箱） |

**Git hooks 补充**：仓库已有 hooks 默认执行；`.git/hooks` / `.git/config` 默认 deny-write，避免静默安装持久化 hook。需要安装/修改 hooks 时使用 `:workspace-git-hooks` 或自定义 `:git_hooks` / `:git_config` 作用域，启动时告警；`tests/policy.test.ts` 与 `tests/sandbox.test.ts` 覆盖默认拒绝、显式允许、实际安装与 pre-commit 执行。

**S3 验收（macOS，已通过）**：`tests/sandbox.test.ts` 覆盖 profile 默认 deny、workspace 写入放行、workspace 外写入/符号链接逃逸被内核拒绝、`:read-only` 禁止写入、`~/.ssh/id_rsa` 与 `.env` 读取被拒绝、Node/npm 工具链与 `git status` 可运行、默认网络 deny、网络 profile 放行、Shell 返回 `SANDBOX_DENIED` 且 AgentLoop 写 `sandbox.denied`。Linux 仍走显式 none backend（S4 待做）；Seatbelt 不识别域名，S6 通过本机代理端口限制与代理校验落实域名白名单。S5 已将显式 additional_permissions 的按次批准转换为临时沙箱根/网络域名；普通命令审批仍不改变沙箱。

### S4 · Linux Landlock / seccomp（暂缓，不在当前范围）

| ID | 任务 | 交付物 | 验收 | 状态 |
| --- | --- | --- | --- | --- |
| S4.1 | 内核能力探测 | sandbox | Landlock ABI、seccomp、网络能力可检测 | DEFERRED（未来平台扩展） |
| S4.2 | 文件系统限制 | sandbox | 与 macOS 相同的 profile 语义；不支持时降级 | DEFERRED（未来平台扩展） |
| S4.3 | 网络限制与降级 | sandbox | 默认无网络；无能力时强制审批，不静默放行 | DEFERRED（未来平台扩展） |
| S4.4 | CI 覆盖 | tests | 支持/不支持两条路径都有测试；skip 条件明确 | DEFERRED（未来平台扩展） |

### S5 · 提权重试与 exec policy

| ID | 任务 | 交付物 | 验收 | 状态 |
| --- | --- | --- | --- | --- |
| S5.1 | Shell / ProcessStart 提权字段 | 工具 schema | 显式根/域名按次申请；不关闭沙箱 | DONE |
| S5.2 | 沙箱拒绝 → 重试闭环 | AgentLoop / policy | 带理由与范围申请；批准只放宽本次执行/进程组；每 turn 最多 3 次；端到端审计 | DONE |
| S5.3 | 前缀批准与规则 | policy | 校验建议前缀；会话前缀不授予提权；`forbidden > prompt > allow`；token 边界正确 | DONE |
| S5.4 | 声明式 `.rules` 兼容子集 | `src/policy/rules/` | `prefix_rule` / `match` / `not_match`；离线 check；未知语法 fail closed；不执行 Starlark | DONE |
| S5.5 | 硬拒绝列表 | policy | 灾难命令/凭证外传模式不可被审批覆盖；误报有测试 | DOING（基础硬拒绝列表已接入） |

### S6 · 网络代理与域名白名单

| ID | 任务 | 交付物 | 验收 | 状态 |
| --- | --- | --- | --- | --- |
| S6.1 | 本地代理 | `src/sandbox/network.ts` | 只监听回环；HTTP/CONNECT；随 Shell/进程清理；不注入凭证 | DONE |
| S6.2 | 域名 allow/deny | policy | 精确/单层通配/深层通配；deny 优先；localhost 显式 allow | DONE |
| S6.3 | 命令环境接入 | exec | 覆盖代理变量、清空 NO_PROXY；不污染父环境；Seatbelt 禁止其他端口 TCP/UDP/监听 | DONE |
| S6.4 | DNS / 私网防护 | proxy | 全量 DNS 地址检查后固定 IP；私网需精确 IP 授权；混合地址/重绑定有测试 | DONE |

### S7 · 自动审查、兼容与托管

| ID | 任务 | 交付物 | 验收 | 状态 |
| --- | --- | --- | --- | --- |
| S7.1 | `auto_review` reviewer 接口 | policy | 独立 reviewer 决策；不能由同一模型自批；超时/失败 fail closed | TODO |
| S7.2 | `--approve-for-me` / `--full-auto` | CLI | 命令行为与文档一致；非交互不再假装全自动 | TODO |
| S7.3 | 项目信任 | config | 全局配置 `[projects]` 的 `trust_level`；受信任项目可定义更窄 profile/rules，不可放宽；项目不能自证可信 | TODO |
| S7.4 | Enterprise requirements | config | `allowed_*` 白名单、managed defaults、超限报错 | TODO |
| S7.5 | Windows | sandbox | 受限令牌/提权沙箱；不支持时显式拒绝 | DEFERRED（未来平台扩展） |

### S8 · 验证与收尾

| ID | 任务 | 交付物 | 验收 | 状态 |
| --- | --- | --- | --- | --- |
| S8.1 | 单元测试 | tests | Action、profile 优先级、审批表、规则、错误码 | DONE（Action/profile/审批表/规则/错误码已覆盖） |
| S8.2 | 集成/E2E | tests | 默认拦截、审批一次/会话/前缀、拒绝原因、yolo、add-dir | DONE（`cli-e2e` / `interactive-log` / `tui-session-approval` 覆盖） |
| S8.3 | 沙箱安全测试 | tests | 越界读写、symlink、`~/.ssh`、网络、降级 | DOING（macOS 越界读写、symlink、`.ssh`/`.env`、网络、降级已覆盖；Linux 路径待 S4） |
| S8.4 | TUI PTY | tests | 弹层、键位、resize、断线、状态行 | DONE（`tui-approval`、`tui-session-approval`、PTY 冒烟） |
| S8.5 | 文档与运行手册 | docs/README | 当前边界、迁移、故障排查、安全说明更新 | DONE（README、permissions、security、config、tools、roadmap 已更新到 S3） |

## 依赖顺序

```text
S0（设计）── S1（策略内核）──┬─ S2（审批 UX）
                              ├─ S3（macOS 沙箱）
                              ├─ S4（Linux 沙箱）
                              └─ S5（提权/规则）
S3/S4 ── S6（网络代理）
S2/S5 ── S7（自动审查/托管）
全部 ── S8（验证/收尾）
```

S1 不依赖 OS 沙箱，可先把策略、配置、非交互 fail-closed 与审计跑通；S3/S4 完成后，应用层路径检查退化为 defense-in-depth，而不是唯一防线。

## 风险与回滚

| 风险 | 缓解 |
| --- | --- |
| 策略层误拦正常开发 | 默认 profile 覆盖 workspace + TMPDIR；`--add-dir`；审批可一次性放宽；测试覆盖常见命令 |
| Shell 解析误判 | 解析失败进审批而非放行；保守优先；后续用成熟 bash parser，不自己写半套 |
| 沙箱平台差异 | 能力探测 + 显式降级 + 强制审批；CI 覆盖支持/不支持两条路径 |
| 审批疲劳 | 默认沙箱内不打扰；会话/前缀授权；明确展示风险，不提供「全部允许」 |
| 自动审查被同一模型绕过 | reviewer 必须是独立模型/进程；同一模型只产生动作，不参与批准 |
| 文档与实现漂移 | 每个阶段更新 README 当前边界与 permissions.md 状态；未实现能力必须标注 |

## 完成标志

- [x] 默认配置下，workspace 外写入、凭证读取与联网被拦截，模型可见原因（macOS Seatbelt；Linux 待 S4）。
- [x] 交互审批的六种决策与断线语义有自动测试。
- [x] 非交互模式不需要审批的动作正常执行，需要审批的动作 fail closed。
- [x] `--yolo` 在支持的平台可用并告警；macOS 探测失败与 Windows 拒绝启动。
- [x] `npm run typecheck && npm test` 通过（本轮验证 76 个文件 / 901 项）；新增安全测试不访问外网。
- [x] README / security / config / tools / TUI 文档与实现一致。

当前 macOS 范围的 M3 仍未完成：S2 审批 UX 收尾、S5.5 硬拒绝增强、S7（auto-review/企业策略，不含 Windows）及相应验证收尾仍需完成。S4（Linux）与 S7.5（Windows）暂缓，不阻塞当前验收。

## 本机网络增量修复

### 按次审批增量（已实现）

- Shell / ProcessStart 可请求 `network: "local"`；Python HTTP server、常见 dev server 和回环 HTTP 客户端自动识别该需求。
- 默认 network deny 下先弹按次审批，批准后只为当前执行/进程组生成本机网络沙箱；保留文件规则，不修改 profile 或保存网络授权。
- 复用 plain / TUI 审批；此类请求不复用 session/prefix 授权，never、无审批器、拒绝或取消均不启动。
- 验证批准后的 Python HTTP 服务、拒绝/取消、后续命令仍 deny、权限审计和网络授权不扩大文件访问；该 local 授权本身不开放外网；外网域名及额外目录使用上文 S5 的按次申请。

本机开发服务支持已从 S6 域名代理中单独拆出：

- 网络策略增加 `none / local / all`，兼容原 enabled 字段。旧 `[sandbox] network = "loopback"` 迁移为 local，修复此前实际整网放行的问题；新配置应使用 local。
- 新增 `:workspace-local`，保留 workspace 文件隔离，用户通过 `/permissions` 或启动参数显式选择；默认 profile 继续拒绝网络。
- Seatbelt 使用 localhost 匹配本机通信。实测它包含本机网卡地址，也允许通配监听，因此不声称提供严格回环隔离；服务必须显式绑定 127.0.0.1 / ::1 以避免局域网暴露。
- Shell / ProcessStart 复用策略；进程保留启动时的沙箱快照，ProcessRead 在网络拒绝时提供按次申请指引。从 full access 切回隔离 profile 时清除工具上下文中的 yolo 标志。
- 验收：本机 IPv4/IPv6 HTTP、Python HTTP server、主机地址和通配监听边界、内核连接拒绝、文件隔离、配置迁移与失败诊断。不依赖外网服务。
