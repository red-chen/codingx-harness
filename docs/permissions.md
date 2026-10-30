# 权限体系（M3 设计）

> 状态：**M3.0 设计完成；M3.1 策略内核、M3.2 审批交互与 M3.3 macOS Seatbelt 已落地**。文件工具与 Shell 都已接入 Permission profile / approval policy；TUI 与 plain 交互都可审批，支持允许一次 / 本会话 / 命令前缀 / 拒绝并说明原因，会话授权只存在内存并写入审计。macOS 上 Shell 在 Seatbelt 中运行：文件写入限制在 profile 根、网络默认 deny、凭证路径/文件名由内核拒绝；Linux Landlock、网络代理/域名白名单、自动审查与可配置 exec policy 仍未完成，Linux Shell 仍是显式降级状态。当前实现边界见 [README](../README.md)，实施拆分见 [implementation-plan-m3.md](implementation-plan-m3.md)。

设计对照的是 **Codex CLI 0.153.x** 的权限模型（Permission profiles + Approval policy + Approvals reviewer + sandbox backend）。Codex 已移除旧的 `--full-auto`，批准策略在 CLI 上收敛为 `on-request` / `never`，并新增 `--approve-for-me` 与命名 Permission profiles；codingx 不照抄旧文档，而是采用当前模型，同时保留用户要求的 `--yolo` / `--allow-dangerously-skip-permissions` 别名。

## 0. 当前实现（M3.1 / M3.2 / M3.3）

| 能力 | 当前状态 |
| --- | --- |
| Permission profiles | 内置 `:read-only` / `:workspace` / `:workspace-git-hooks` / `:danger-full-access` + 命名 profile、extends、文件系统/网络解析 |
| 文件工具策略 | Read/Write/Edit/Patch 经过 profile 路径检查；敏感路径 deny；越界 fail closed |
| Approval policy | `on-request` / `never`；`always-ask` 旧值兼容为逐工具询问；非交互无 approver 时返回 `APPROVAL_REQUIRED` |
| 审批交互 | TUI 底部弹层 + plain 交互提示；允许一次 / 本会话 / 命令前缀 / 拒绝并说明原因 / Esc 取消 |
| 会话授权 | 仅内存的 exact action 与 exec prefix 缓存；`/clear` 清除，resume 不继承；写入 `permission.granted` |
| CLI | `--sandbox`、`--ask-for-approval`、`--permission-profile`、`/permissions`、`--yolo`；`--approve-for-me` / `--full-auto` 已接受但自动审查未实现 |
| Shell 策略 | 保守 tokenizer、硬拒绝、网络命令启发式、cd/重定向/绝对路径检查；macOS 上再进入 Seatbelt，Linux 目前无 OS 隔离 |
| 本地 `!` 命令 | 不经过模型；复用 Shell 的 Action、审批与沙箱，输出写 `local.command` / `local.result` |
| Git hooks | 仓库已有 hooks 默认可以执行；`.git/hooks` / `.git/config` 写入默认拒绝。`:git_hooks` / `:git_config` 作用域或 `:workspace-git-hooks` profile 可显式放开，并产生启动告警 |
| OS 沙箱（macOS） | `sandbox-exec` + 生成 profile：默认 deny，写入限定 profile 根，网络默认 deny，凭证目录与 `.env*`/私钥文件名由内核拒绝；Shell 结果带 `sandbox` meta 与 `SANDBOX_DENIED` |
| 沙箱降级 | macOS 探测失败时 Shell 返回 `SANDBOX_UNAVAILABLE`，`--yolo` 拒绝启动；Linux 在 S4 前显式告警并保持无沙箱 |
| 审计 | `approval.requested/decided`、`permission.granted`、`permission.decision`、`profile.changed`、`sandbox.denied` |
| 未实现 | 自动审查、Linux Landlock、Windows 沙箱、网络代理/域名白名单、exec policy 规则、审批全屏视图 |


## 1. 目标与不变量

1. **Fail closed**：没有审批 UI、超时、断线或解析失败时，一律拒绝或降级到更窄权限，绝不静默放行。
2. **两类独立防线**：审批策略回答「要不要人点头」，沙箱回答「点头了它能碰到什么」。任意一道失效时另一道仍然有效。
3. **默认最小权限**：默认只允许读写 workspace 与临时目录，网络默认关闭；越界操作显式批准。
4. **审批是例外，不是常规路径**：能留在沙箱内完成的动作不应打扰用户；只有越过 profile 边界的动作才请求批准。
5. **可解释**：审批框展示规范化后的动作、路径/命令、cwd、网络目标、风险与理由；模型给出的是不可信说明，不参与判定。
6. **可审计**：每次判定、批准、拒绝、沙箱拒绝与授权都写入 rollout，包含决策者与规则来源。
7. **模型不能自批**：批准只能来自用户（或显式配置的独立 reviewer）；模型输出不能伪造弹层、选项或快捷键。
8. **不把未实现能力说成已实现**：macOS 已有 Seatbelt；Linux/Windows 尚无 OS 隔离，`--yolo` 会关闭现有策略与沙箱。文档与告警必须按平台说明当前边界。

## 2. 总体模型

```text
工具调用
  │
  ▼
① 规范化 Action（文件 / 命令 / 网络 / MCP）
  │
  ├─ 硬拒绝与 exec policy（forbidden > prompt > allow）
  ▼
② Permission profile（文件系统 / 网络边界）
  │   在边界内 ──────────────► ④ 沙箱执行
  │
  └─ 越过边界
       ▼
     ③ Approval policy + reviewer
       │ deny ─────────────────► 结构化拒绝回填给模型
       │ allow（一次性/会话/前缀）
       └────────────────────────► ④ 放宽后的沙箱执行，或一次性无沙箱执行
```

三层职责：

| 层 | 回答的问题 | 存储位置 |
| --- | --- | --- |
| Permission profile | 默认允许读/写哪些路径、能否联网 | 用户全局配置；受信任项目可追加更窄规则 |
| Approval policy + reviewer | 越界时是否询问、由谁决定 | 配置 + CLI + TUI 预设 |
| Sandbox backend | 如何在内核/系统层强制 profile | 平台实现（Seatbelt / Landlock + seccomp） |

### 2.1 Action 是策略的唯一输入

策略层不接收自然语言，也不对整条 shell 字符串做正则匹配。工具在执行前把入参规范化为结构化的 `Action`：

```ts
type Action =
  | { kind: 'file.read'; path: string }
  | { kind: 'file.write'; path: string; create: boolean }
  | { kind: 'file.delete'; path: string }
  | {
      kind: 'exec';
      program: string;          // 解析后的可执行文件，绝对路径优先
      argv: string[];           // 已展开的 argv，不含 shell 元字符
      cwd: string;
      reads: string[];
      writes: string[];
      network: boolean;
    }
  | { kind: 'network'; host: string; port?: number; protocol: 'https' | 'http' | 'tcp' }
  | { kind: 'mcp'; server: string; tool: string; readOnly: boolean };
```

规范化规则：

- 文件路径先 `realpath`（不存在的目标解析最近的已存在父目录），再按 profile 匹配；symlink 逃逸按真实目标判断。
- Shell 必须用 bash 语法解析器拆出命令、管道、重定向、命令替换与环境赋值，不能只用 `split(' ')` 或前缀正则。解析失败或出现无法安全解释的结构时，按「需要审批」处理，不能当成只读命令。
- 一条命令产生多个 Action 时，取**最严格**的判定结果；管道中的每一段都要判定。
- `cd`、`export` 等会改变后续命令语义的结构要在同一份 Action 中体现，不能把前后段拆开单独放行。
- 模型给出的 `justification` 只用于展示，不参与 allow/deny；它可能与实际命令不符。
- 文件工具由进程内策略直接检查；Shell 既做执行前策略检查，也由 OS 沙箱兜底。两道都做，不能只依赖其中一道。

## 3. Permission profiles

Permission profile 是一组命名、可复用的文件系统与网络权限。名字与 Codex 对齐，内置四个：

| 名称 | 语义 | 对应 TUI 预设 |
| --- | --- | --- |
| `:read-only` | 只读 workspace 与必要系统路径；命令在只读沙箱内执行，写与联网要审批 | Read Only |
| `:workspace` | 可读写 workspace 与临时目录、可执行命令；workspace 外写入与联网要审批 | Default / Agent |
| `:workspace-git-hooks` | 在 `:workspace` 基础上显式允许写 `.git/hooks` 与 `.git/config`，用于安装/管理 Git hooks；启动时告警 | Custom |
| `:danger-full-access` | 无文件系统沙箱、无网络限制；仍受 exec policy 硬拒绝约束 | Full Access |

自定义 profile：

```toml
# 顶层：使用哪个 profile，以及批准策略（两者正交）
approval_policy = "on-request"
approvals_reviewer = "user"
default_permissions = "project-edit"

[permissions.project-edit]
# 可继承内置 profile；未写 extends 时按最小权限解释
extends = ":workspace"

[permissions.project-edit.filesystem]
# 特殊作用域
":minimal" = "read"          # 运行常见命令所需的系统/运行时路径
"~/.agents" = "write"        # 技能目录

[permissions.project-edit.filesystem.":workspace_roots"]
"." = "write"
"**/*.env" = "deny"          # 敏感文件永远拒绝，除非用户显式覆盖

# Git hooks 默认只允许执行、禁止写入；需要安装 hooks 时显式 opt in：
# ":git_hooks" = "write"
# ":git_config" = "write"      # husky 等需要写 core.hooksPath 时再加

[permissions.project-edit.network]
enabled = true               # 示例：仅此 profile 需要联网；默认是 false

# 仅当 enabled = true 时生效；deny 优先于 allow
[permissions.project-edit.network.domains]
"registry.npmjs.org" = "allow"
"*.internal.example.com" = "deny"
```

### 3.1 文件系统规则

- 作用域支持：`:minimal`、`:root`、`:workspace_roots`、`:tmpdir`、`:slash_tmp`、`:git_hooks`、`:git_config`、绝对路径、`~/...`、glob（如 `**/*.pem`）。当前实现只接受 **deny** glob；read/write glob 会在启动时报配置错误，避免静默忽略。`:git_hooks` / `:git_config` 只接受 `write` / `deny`（`write` 隐含 read）。
- 访问级别：`read` / `write` / `deny`。`write` 隐含 `read`。
- 解析顺序：**更具体的路径覆盖更宽的路径；同级冲突时 deny 优先；显式 deny 永远优先于 allow**。
- 默认拒绝读取：`~/.ssh`、`~/.aws`、`~/.config/gh`、`~/.codingx`、session 目录、`.env*`、私钥与常见凭证文件；除非用户在全局配置中显式放开。
- 默认可写：主 workspace 根、`--add-dir` 显式追加的目录、`$TMPDIR`；`/tmp` 是否可写由 profile 显式决定。
- Git hooks 的执行默认可用（`git commit` 会运行仓库已有 hooks）；`.git/hooks` 与 `.git/config` 默认 deny-write，防止模型或仓库内容静默安装持久化 hook。需要写 hooks 时使用 `:git_hooks` / `:git_config` 作用域（仅 `write` / `deny`），或直接选择 `:workspace-git-hooks` profile；普通 `.git` 对象与索引仍允许写，否则 `git commit` 无法工作。
- `--add-dir` 只追加可写根，不改变网络与审批策略；如果当前 profile 不允许追加根（例如 `:read-only` 或自定义 profile 关闭了 workspace 扩展），`--add-dir` 必须报配置错误，而不是静默忽略。

### 3.2 网络规则

- 默认 `enabled = false`，即无网络。
- 启用后按域名 allow/deny：`api.example.com` 精确匹配，`*.example.com` 匹配子域，`**.example.com` 匹配自身与子域；deny 优先。
- `localhost` / `127.0.0.1` / `::1` 默认也受限；需要本地开发服务器时显式 allow。
- 网络限制由沙箱层的本地代理执行，而不是只检查命令字符串。HTTP(S) 之外的协议、DNS 重绑定、Unix socket 需要单独能力位。
- 域名规则不写端口；代理本身不把凭证注入请求。

### 3.3 项目信任与配置层级

- 项目配置只能**收紧**权限，不能放宽全局 profile、审批策略或网络白名单；这是 codingx 与 Codex 的一个有意差异（Codex 允许受信任项目定义更宽的 profile，codingx 先采用更保守的规则）。
- 项目可以在受信任后定义**更窄**的 profile 与 exec 规则；信任状态存**全局配置**的 `[projects."<abs-path>"] trust_level = "trusted"`（与 Codex 对齐），不存仓库；项目配置不能自证可信。
- 全局配置、环境变量、CLI 的优先级高于项目配置；显式 CLI 冲突（例如 `--yolo` 与 `--sandbox read-only`）直接报错，不做「后写覆盖」。
- 企业/托管场景后续支持 requirements 式白名单：`allowed_approval_policies`、`allowed_sandbox_modes`、`allowed_permission_profiles`、`default_permissions`。

### 3.4 其他工具

- `Read` / `ListDir` / `Glob` / `Grep`：只读 Action，仍受 profile 读路径限制；不能因为「只读」就绕过 `deny` 规则。
- `Write` / `Edit` / `ApplyPatch`：写 Action，按路径与 profile 判定；读后写约束继续生效，不受权限系统影响。
- `AskUserQuestion` / `UpdatePlan`：不改变文件系统或网络，不需要审批；它们也不能被当作提权通道。
- `Skill`：读取技能文件本身受 profile 限制；技能正文是本地指令，不是权限提升，不能修改 policy。
- MCP / 自定义工具：必须声明 `Action`；`readOnlyHint` 只是提示，不可全信。副作用未知时默认 ask（`on-request`）或 deny（`never`）；服务器进程的启动也受文件与网络策略约束（M4）。
- `WebFetch` / 未来的联网工具不经过 Shell 沙箱，必须在工具层校验同一份网络策略，并同时满足 `[web].allowed_domains`；不能因为「不是 Shell」就绕过 profile。

## 4. Approval policy

`approval_policy` 与 profile 正交：

| 值 | 语义 |
| --- | --- |
| `on-request`（默认） | profile 内直接执行；越过 profile 或命中 prompt 规则时询问。模型可以主动请求提权。 |
| `never` | 永不询问；越过 profile 的动作直接拒绝并把结构化原因回填给模型。适合 CI / 无人值守。 |
| `granular`（预留） | 按 `sandbox_approval` / `rules` / `skill_approval` / `request_permissions` / `mcp_elicitations` 细分何时询问；M3 不先暴露。 |

`approvals_reviewer`：`user`（默认）或 `auto_review`（后续，由独立 reviewer 决定，绝不由产生动作的同一模型自批）。Codex 还支持 `guardian_subagent`；codingx 先实现 `user`，为自动审查留接口。

判定矩阵（未命中 exec policy 的 `forbidden` / `prompt` 时）：

| Permission profile | Approval policy | profile 内动作 | 越过 profile / 命中 prompt |
| --- | --- | --- | --- |
| `:read-only` | `on-request` | 允许（只读沙箱） | 询问 |
| `:read-only` | `never` | 允许（只读沙箱） | 拒绝 |
| `:workspace` | `on-request` | 允许 | 询问 |
| `:workspace` | `never` | 允许 | 拒绝 |
| `:danger-full-access` | `on-request` | 允许（无文件系统沙箱） | 仅 exec policy prompt 会询问 |
| `:danger-full-access` | `never` | 允许（等价于 `--yolo`） | `forbidden` 仍拒绝 |

`on-request` 在策略层先判定是否越界，越界就直接发起审批；沙箱运行时拒绝后的提权重试仍然保留（见第 5 节），两条路径都走同一个 reviewer。

### 4.1 判定顺序

1. 硬拒绝 / exec policy 的 `forbidden`（不可被批准覆盖）。
2. 命中的 `prompt` 规则（命令前缀、路径、网络）。
3. profile 是否允许该 Action：
   - 允许且不需要 prompt → 直接沙箱执行。
   - 允许但命中 prompt 规则 → 进入审批。
4. 越过 profile：
   - `on-request` → 进入审批；
   - `never` → 拒绝。
5. 审批结果：一次 / 会话 / 命令前缀；拒绝或超时 → 拒绝。
6. 执行后记录结果与沙箱退出码。

### 4.2 Exec policy

对齐 Codex 的概念，但 M3 分两步：

- **S1（已完成基础版）**：内置硬拒绝 + 已知网络命令/重定向/cd 启发式；**尚未解析** `[approval.rules]`，所以还没有可配置的 allow/prompt 规则。
- **S5**：结构化 `[approval.rules]`（allow / prompt / forbidden + 规范化前缀），满足常见「允许 `npm test` / 拒绝 `git push --force`」场景。
- **M3.4**：兼容 Codex 的 `prefix_rule` 规则文件（`.codingx/rules/*.rules`），支持 `match` / `not_match` 自测与 `codingx execpolicy check`。Starlark 解析器作为独立依赖引入，不自己实现半套。

规则也必须基于 Action：`["git","push"]` 是前缀 token，不是整条命令字符串的子串；`sudo` 不应匹配 `sudoku`。多个规则命中时 `forbidden > prompt > allow`，与 Codex 一致。

M3.1 的结构化规则形如：

```toml
[approval.rules]
allow = [["npm", "test"], ["npm", "run", "lint"], ["git", "status"]]
prompt = [["git", "push"], ["rm"]]
forbidden = [["sudo"], ["rm", "-rf", "/"]]
```

硬拒绝不能只匹配字面量：`rm -fr /`、`rm --recursive --force /`、命令替换与管道都要在 Action 归一化后判定；解析失败按 ask 处理（`never` 下 deny），不能当作 allow。

### 4.3 审批请求与决策

```ts
interface ApprovalRequest {
  id: string;
  turnId: string;
  callId: string;
  tool: string;
  action: Action;
  options: Array<'allow-once' | 'allow-session' | 'allow-prefix'>;
  /** 仅展示：模型的解释不是授权依据 */
  rationale?: string;
  /** 由策略层计算，不让 UI 猜 */
  risk: 'low' | 'medium' | 'high';
  /** 可选：本次批准会授予的临时根/网络/前缀 */
  proposedGrant?: PermissionGrant;
}

type ApprovalDecision =
  | { kind: 'allow'; scope: 'once' | 'session' | 'prefix' }
  | { kind: 'deny'; reason?: string };
```

交互选项对齐 Codex TUI 的语义：允许一次、本会话允许、按前缀允许（仅命令）、拒绝、拒绝并说明原因、取消整轮。拒绝原因作为 `tool_result` 回填，模型应换方案而不是原样重试。

## 5. 提权（escalation）

这是 Codex 权限模型里最关键、也最容易被简化掉的部分：

1. Shell 先按当前 profile 在沙箱内执行。
2. 沙箱拒绝（Seatbelt/Landlock 的 EPERM、网络代理拒绝、只读文件系统）时，返回结构化 `sandbox_denied`，而不是只给一句 "permission denied"。
3. 模型看到原因后，可以带 `sandbox_permissions` 重试：
   - `use_default`：仍按 profile 执行（默认）。
   - `with_additional_permissions`：请求临时追加文件根/网络目标，附 `additional_permissions`。
   - `require_escalated`：请求一次性无沙箱执行，必须附 `justification`；可选 `prefix_rule` 请求会话级前缀批准。
4. 策略层把请求转成审批；批准后只对本次调用（或明确的前缀/会话范围）生效。
5. 被拒绝时回填原因，并限制每个 turn 的提权尝试次数，防止「拒绝→重试→再拒绝」死循环。

Shell 工具新增字段（M3.1 起）：

```ts
interface ShellExtras {
  sandbox_permissions?: 'use_default' | 'with_additional_permissions' | 'require_escalated';
  justification?: string;
  additional_permissions?: {
    file_system?: { read?: string[]; write?: string[] };
    network?: { enabled?: boolean; domains?: string[] };
  };
  prefix_rule?: string[];
}
```

`justification` 是给用户看的说明，不是权限凭证；UI 必须同时展示实际命令。当前 profile 为 `:danger-full-access` 时，没有沙箱可绕过，直接按 exec policy 与审批策略处理。

文件工具没有「在沙箱里失败再重试」这一层（它们在 CLI 进程内执行）。路径越界时直接进入审批：批准一次 → 本次调用带临时根执行；批准会话 → 该根在本会话内有效；拒绝 → 回填 `PERMISSION_DENIED`。

当前 S3 尚未接入 Shell 的 `sandbox_permissions` 提权重试：批准一个越界 Shell 命令只会解除策略层，Seatbelt 仍按 profile 拒绝，直到 S5 把批准转换成临时沙箱根/网络授权。模型会看到 `SANDBOX_DENIED`，不要原样重试。

## 6. 沙箱

接口统一，平台实现可替换：

```ts
interface SandboxBackend {
  readonly kind: 'seatbelt' | 'landlock' | 'windows' | 'none';
  readonly capabilities: {
    fileSystem: 'enforced' | 'none';
    network: 'deny' | 'allow' | 'proxy' | 'none';
    unixSockets: boolean;
  };
  readonly status: SandboxStatus;
  available(): Promise<boolean>;
  /** 生成已包装的 shell argv；不可用时抛 SANDBOX_UNAVAILABLE。 */
  wrapShell(command: string, policy: SandboxPolicy): { file: string; args: string[] };
}

interface SandboxPolicy {
  cwd: string;
  home: string;
  tmpdir: string;
  readRoots: readonly string[];
  writeRoots: readonly string[];
  denyRoots: readonly string[];
  denyGlobs: ReadonlyArray<{ base: string | null; pattern: string }>;
  additionalDirs: readonly string[];
  sessionDir?: string;
  network: NetworkPolicy;
  yolo: boolean;
  gitHooksWritable: boolean;
  gitConfigWritable: boolean;
}
```

| 平台 | 文件系统 | 网络 | 备注 |
| --- | --- | --- | --- |
| macOS | **已实现**：`sandbox-exec` + Seatbelt profile，默认 `(deny default)`；读取限系统/工具链/profile 根，写入限 profile 写根 | 默认 deny；profile 启用时整网放行（域名白名单待 S6 代理） | `sandbox-exec` 已标记弃用但仍可用；需要长期方案时评估 Seatbelt 替代 |
| Linux | Landlock（文件系统） + seccomp；内核不支持时降级 | Landlock 网络能力有限，域名过滤走代理/网络命名空间 | 不支持时**强制审批**并拒绝 `--yolo`，不能静默降级成无沙箱 |
| Windows | 受限令牌 / 提权沙箱（后续） | 代理 | M3 暂不支持，显式提示并强制审批 |
| 其他 | 无沙箱 | 无 | 只允许 `:read-only` 或强制审批；`--yolo` 拒绝启动 |

环境与凭证：

- 子进程只继承白名单 env（`PATH`、`HOME`、`LANG`、`TERM`、`TMPDIR` 等）；`API_KEY` 永不进入沙箱进程。
- 沙箱进程设置 `CODINGX_SANDBOX=seatbelt|landlock|none`，供诊断；不设置可伪造的授权标志。
- 默认拒绝读取 `~/.codingx`、session 目录、sessiond socket 目录。
- 网络代理只监听回环；不把 API Key 注入请求；拒绝私网/回环目标，除非 profile 显式允许。
- 工具子进程不继承 `CODINGX_SESSIOND_SOCKET`、`CODINGX_HOME` 等控制面变量（按现有做法）。

当前构建：文件工具由 profile 检查；macOS Shell 在命令启发式之后还会进入 Seatbelt，因此即使策略误判，越界写入、凭证读取与默认网络访问仍会被内核拒绝。Linux 尚未接入 Landlock，Shell 仍以当前用户权限运行；`--yolo` 在所有平台都关闭现有策略与沙箱。Seatbelt 无法按域名过滤，启用网络时是整网放行，直到 S6 本地代理落地。

## 7. 预设、CLI 与配置优先级

TUI / CLI 预设与 Codex 对齐：

| 预设 | Permission profile | Approval policy | 说明 |
| --- | --- | --- | --- |
| Read Only | `:read-only` | `on-request` | 读 workspace；写与联网要批准 |
| Default / Agent | `:workspace` | `on-request` | 读写 workspace；越界与联网要批准 |
| Git Hooks | `:workspace-git-hooks` | `on-request` | 在 Default 基础上允许写 `.git/hooks` 与 `.git/config`；启动告警 |
| Full Access | `:danger-full-access` | `never` | 无沙箱、无批准；启动告警 |
| Approve for me | `:workspace` | `on-request` + `auto_review` | 越界请求交给独立 reviewer（后续） |
| Custom | `default_permissions` | 配置 | 选择 config.toml 中的命名 profile |

CLI（目标态）：

```bash
codingx -s, --sandbox <read-only|workspace-write|danger-full-access>
codingx -a, --ask-for-approval <on-request|never>
codingx -P, --permission-profile <name>
codingx     --approve-for-me
codingx     --yolo | --allow-dangerously-skip-permissions
codingx     --add-dir <DIR>
codingx     --full-auto        # 兼容别名；见下
codingx -P :workspace-git-hooks exec "安装仓库 hooks"
```

- `-s/--sandbox` 的旧三值映射到内置 profile；新配置首选 `--permission-profile`。
- `--yolo` / `--allow-dangerously-skip-permissions` = `:danger-full-access` + `never`，启动时打印醒目警告；不绕过硬拒绝/exec policy 的 `forbidden`。
- `--full-auto`：Codex 当前 CLI 已移除该选项；codingx 保留为兼容别名，语义为 `:workspace` + `auto_review`。在 auto-review 落地前，交互模式等价于 `:workspace` + `on-request`，非交互模式对越界动作拒绝，不假装「全自动」。
- `--approve-for-me` 使用独立 reviewer；不能由产生动作的同一模型自批。
- `--add-dir` 只加可写根；profile 不允许扩展时直接报错。

优先级：

```text
CLI 显式参数 > 环境变量 > 受信任项目配置（只能收紧） > 用户全局配置 > 内置默认
```

`sandbox_mode` / `sandbox_workspace_write` 等旧键与 `default_permissions` / `[permissions.*]` **不能同时设置**，启动时报配置错误并给出迁移提示；这与 Codex 的冲突校验一致。

## 8. Session、TUI 与审计

事件（rollout + TUI）：

```ts
type PermissionEvent =
  | { type: 'approval.requested'; request: ApprovalRequest }
  | { type: 'approval.decided'; requestId: string; decision: ApprovalDecision; decidedBy: 'user' | 'reviewer'; reason?: string }
  | { type: 'permission.granted'; grant: PermissionGrant; scope: 'once' | 'session' | 'prefix' }
  | { type: 'sandbox.denied'; callId: string; kind: string; reason: string; retryable: boolean }
  | { type: 'profile.changed'; from: string; to: string; source: 'cli' | 'config' | 'tui' };
```

- 只有持有写租约的 CLI 能批准；`sessions show/watch` 只能看到 `awaiting_approval`。
- CLI 崩溃/断线：释放租约，追加 `session.interrupted`；待决审批按拒绝处理；resume 不自动续跑未完成 turn。
- 会话级批准只存在于当前会话内存 + rollout 审计事件，不跨 resume 持久化；需要持久规则时显式写项目/全局规则。
- `--json` / `exec` 无交互：需要审批的动作返回 `APPROVAL_REQUIRED`（或由 auto-review 决定），stdout 保持 JSONL 纯净。
- TUI 弹层由应用状态机绘制，展示完整命令与归一化路径；长命令支持全屏查看；模型输出不能改变选项、焦点或快捷键。
- rollout 中的审批事件与命令需要脱敏后再落盘；UI 展示给用户的是真实命令（否则无法判断），两者是不同视图。
- 审计包含：工具名、Action、匹配规则、profile、approval policy、reviewer、决策、耗时、沙箱退出码；`sandbox.denied` 已在 macOS Seatbelt 路径写入。不记录 prompt 正文与文件内容。
- 用户直接输入的 `!command` 不经过模型，但与 `Shell` 共用同一个 Action、审批与沙箱：策略判定写 `permission.decision`（`source: 'local-command'`），沙箱拒绝写 `sandbox.denied`，命令与输出写 `local.command` / `local.result`，均不进入模型消息历史。

## 9. 错误码

以下 code 已加入 `src/util/errors.ts`（`SANDBOX_DENIED` 随 S3 加入）：

| code | 含义 |
| --- | --- |
| `PERMISSION_DENIED` | 用户/策略拒绝 |
| `APPROVAL_REQUIRED` | 需要审批但当前上下文无法询问（非交互、断线） |
| `POLICY_FORBIDDEN` | 命中硬拒绝/forbidden 规则 |
| `SANDBOX_DENIED` | 沙箱在运行时拒绝；可提示模型带 justification 重试 |
| `SANDBOX_UNAVAILABLE` | 平台无沙箱能力，按策略拒绝或降级 |
| `HOOK_BLOCKED` | Agent Harness hook 阻止了 prompt 或工具调用 |
| `PERMISSION_PROFILE_UNKNOWN` | profile 未定义 |
| `PERMISSION_CONFIG_CONFLICT` | 新旧权限配置冲突 |
| `ESCALATION_LIMIT` | 单个 turn 的提权尝试超限 |

工具业务失败仍走 `isError: true`；这些错误码写在 `meta.code`，不把异常抛穿 AgentLoop。

## 10. 与 Codex 的差异

- **项目配置更保守**：codex 允许受信任项目定义更宽 profile；codingx 先只允许收紧。
- **`always-ask` 仅作兼容**：旧值被映射为逐工具询问（包括只读工具），不产生持久规则；新配置应使用 `on-request` / `never` + profile。
- **自动审查后置**：Codex 的 Guardian/guardian_subagent 依赖独立模型；codingx 先把 `user` reviewer 做扎实，`auto_review` 只留接口。
- **Starlark exec policy 后置**：M3.1 用结构化规则满足核心场景，M3.4 再兼容 `.rules`。
- **`on-request` 的触发点**：codingx 在策略层对已知越界动作直接发起审批，而不是先让沙箱失败再让模型重试；沙箱拒绝后的提权路径仍保留。这样文件工具也有统一的审批入口，减少一次失败往返。
- **Windows 沙箱后置**：先显式声明不支持并强制审批，不静默降级。

## 11. 非目标

- 不把审批做成「一键全部允许」：不允许模型发起、UI 不提供全局放行快捷键。
- 不依赖模型自我审查作为唯一防线。
- 不在本阶段实现远程/多机权限同步。
- 不为了实现权限系统而提前改动 TUI/sessiond 之外的大规模架构。

## 12. 实施拆分

见 [implementation-plan-m3.md](implementation-plan-m3.md)。顺序建议：

```text
M3.1 策略内核 + 配置/CLI + 非交互 fail-closed
   ↓
M3.2 TUI 审批弹层 + 会话授权 + /permissions
   ↓
M3.3 macOS Seatbelt（文件系统 + 网络 deny）— 已完成
   ↓
M3.4 Linux Landlock/seccomp（含降级策略）
   ↓
M3.5 提权重试 + exec policy 前缀规则
   ↓
M3.6 网络代理 + 域名白名单
   ↓
M3.7 auto-review / enterprise requirements / Windows
```
