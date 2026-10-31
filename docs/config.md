# 配置

StatusBar Plugin 使用全局 `[status_bar]` 选择插件，支持 DeepSeek token 费用显示。安装、manifest 与协议见 [Plugin 文档](plugins.md)。

`codingx plugin install deepseek-cost --enable` 安装内置插件并写入全局选择；本地目录用 `codingx plugin install ./my-plugin --enable`。重复安装不会覆盖已有文件；已安装插件可用 `codingx plugin enable <id>` 切换。

## 文件位置与优先级

优先级从高到低，后者被前者覆盖：

1. 命令行参数
2. 环境变量
3. 当前 cwd 保存的交互偏好（模型/Provider/route/effort、权限 profile）
4. 项目配置 `<workspace>/.codingx/config.toml`
5. 全局配置 `~/.codingx/config.toml`
6. 内置默认值

### 按 cwd 记住交互设置

通过 `/model` 修改的模型、Provider、route 和 effort，以及通过 `/permissions` 选择的权限 profile，会保存在 `$CODINGX_HOME/workspaces/<cwd-name>/`（默认 `~/.codingx/workspaces/`）中。同一目录新建会话、重启 CLI 或运行 exec 都会继承，`/clear` 不删除这些偏好；不同 cwd（包括子目录）各自独立，符号链接按真实路径归并。

模型与权限分别写入 `model.json`、`permissions.json`，文件权限 0600，原子替换；多个 CLI 修改不同设置不会互相覆盖，同一设置最后一次写入生效。只保存选择值，不写凭证、端点、临时可写目录或会话审批授权。启动参数/环境变量只覆盖当次运行，不改目录默认值；`--yolo`、`--add-dir`、approval policy/reviewer 等启动选项不会自动持久化。

恢复/分叉会话时，模型与 effort 的优先级为 CLI/env > cwd 偏好 > 会话记录 > TOML 默认；目录中新选择不会被旧会话覆盖。显式 model/provider/route 选项作为一组覆盖保存的目标，effort 独立覆盖。保存的 `default` 会继续使用服务端默认，不被 TOML 中的 effort 重新开启。

保存目标引用的 Provider/route 或权限 profile 被删除时，告警并退回配置默认；损坏的偏好文件同样告警并忽略。会话变更成功但目录偏好写入失败时，当前会话保持新设置并明确告警，不能保证下次启动继承。需要恢复 TOML 默认时可删除对应 cwd 目录中的偏好文件。

项目配置只允许覆盖**行为类**设置（模型、工具开关、MCP、联网），且权限相关设置只能收紧（M3 起强制执行）：受信任项目可以追加更窄的 Permission profile / 审批规则，但不能放宽全局权限或网络白名单。项目配置不允许覆盖凭证——避免从远程仓库克隆来的项目配置窃取本地密钥。凭证只从 `codingx login` 的 `auth.json` 或环境变量读取，不写入 `config.toml`。整个 `[sessiond]` 段与 `session.dir` / `retention_days` 是例外：只允许来自全局配置或环境变量，项目配置不得覆盖。`[provider.<id>]` 含端点与凭证，也只允许全局配置；项目配置可以定义/选择 routes，但只能引用全局 provider id。

## Tips

TUI 每次启动随机选取一条提示，显示在 StatusBar 正下方（输入框上方），空闲和任务执行中均显示；可用 `/tips` 手动切换，格式为：

```text
  └ Tip: Use /model to choose a model and reasoning effort.
```

首次启动会将默认提示写入 `$CODINGX_HOME/tips.json`；未设置 `CODINGX_HOME` 时为 `~/.codingx/tips.json`。这是全局 UI 配置，各工作目录共享。直接编辑此文件，下次启动生效：

```json
{
  "enabled": true,
  "tips": [
    "Use /model to choose a model and reasoning effort.",
    "Press Ctrl+R to search your input history.",
    "完成改动后，记得运行 npm run typecheck 和 npm test。"
  ]
}
```

- `enabled` 默认为 `true`；设为 `false` 关闭提示。
- `tips` 为字符串数组，替换整份默认列表；省略时使用内置默认提示，空数组或全空白内容不显示提示。
- 输入框为空时按 Tab，将当前显示的完整 Tip 填入输入框，光标置于末尾；空闲和任务执行中均可用，不自动发送或排队。输入框已有内容时保留原有 Tab 行为（命令补全、任务执行中排队），不覆盖草稿。
- `/tips` 打开当前配置列表：↑/↓ 浏览，Home/End 到首尾，Enter 将所选完整提示填入输入框（替换当前草稿，光标在末尾），可继续编辑，再按 Enter 发送；Esc 或 Ctrl+C 取消。面板中的预览自动换行，PgUp/PgDn 翻页阅读长提示。选择同时更新本次运行显示的提示，不修改 `tips.json`，不自动发送；即使 `enabled: false`，手动选择仍可在本次运行显示提示。空列表会提示无可选项。
- 除手动选择外，提示在同一次启动中保持不变，重绘、滚动和 `/clear` 不重新抽取，也不滚入终端历史。提示占一行，过长时以省略号截断；终端小于 12 列、8 行或底部空间不足时隐藏，优先保留输入框和交互菜单。
- 文件不存在时自动生成默认值（文件权限 0600）；读取、格式校验或创建失败会告警并回退内置提示，不覆盖已有文件。
- Tips 的展示和选择不写入会话、不自动发送给模型；只有用户提交输入框内容后才按普通输入处理。不影响 `--plain`、`exec` 或 JSON 输出。默认提示包含已支持的命令、快捷键及基于真实场景的深度 Review 建议；`/theme` 当前尚未实现。

## 完整示例

```toml
# ~/.codingx/config.toml

[model]
route = "default"            # 选择 route；也可用 --route / CODINGX_ROUTE
max_output_tokens = 8192
temperature = 0
# 可选：low | medium | high | xhigh | max | default；省略时使用服务端默认
# reasoning_effort = "high"
# 上下文窗口上限，用于触发压缩；留空默认 1,000,000
# 使用标准 200K 模型时显式改为 200000
context_window = 1000000

[agent]
max_steps = 64               # 单 turn 最多模型往返次数，避免无进展循环

[provider.primary]
# 默认协议；后续可切 openai-responses
protocol = "anthropic-messages"
# 通用的 ENDPOINT 与 API_KEY；凭证优先从 `codingx login` 的 auth.json 读取
endpoint = "https://api.example.com"
api_key_env = "API_KEY"

# OpenAI Responses 在 M4 加入；在此之前可只保留 primary，并删除 secondary target
[provider.secondary]
protocol = "openai-responses"
endpoint = "https://api.example.com"
api_key_env = "SECONDARY_API_KEY"

[routes.default]
strategy = "weighted"        # failover | weighted | round-robin
affinity = "session"         # session | turn | none
max_attempts = 3
failure_threshold = 3
cooldown_seconds = 30

[[routes.default.targets]]
provider = "primary"
model = "model-name"
weight = 70

# M4 后启用
[[routes.default.targets]]
provider = "secondary"
model = "model-name-2"
weight = 30

[approval]
mode = "on-request"          # on-request | never | always-ask（兼容旧键；推荐 approval_policy）
# 会话内批准过的同类操作不再重复询问
remember_in_session = true

[approval.allow]
# 规范化后的动作，不是命令字符串前缀匹配
exec = ["npm test", "npm run lint", "git status", "git diff"]
write = ["src/**", "tests/**"]

[approval.deny]
exec = ["git push --force", "rm -rf /"]
write = [".git/config", "**/*.pem"]

[sandbox]
mode = "workspace-write"     # read-only | workspace-write | danger-full-access
network = "none"             # none | local | all（loopback 为历史别名）
writable_roots = ["$TMPDIR"]
readable_roots = []
env_passthrough = ["PATH", "HOME", "LANG", "TERM"]

[tools]
allow_custom = false
max_output_chars = 30000

[web]
enabled = false              # WebFetch 默认关闭
allowed_domains = []         # 仅 https；为空表示不允许任何域名

[session]
dir = "~/.codingx/sessions"
retention_days = 30

[sessiond]
enabled = true               # false 时退回进程内存储，无跨 CLI 查询
socket = "~/.codingx/run/sessiond.sock"
autostart = true
idle_timeout_seconds = 1800  # 无连接且无租约时退出；0 表示常驻
log = "~/.codingx/logs/sessiond.log"

[mcp]
# 外部工具服务器
servers = []

# [[mcp.servers]]
# name = "filesystem"
# command = "npx"
# args = ["-y", "@modelcontextprotocol/server-filesystem", "."]
# env = {}
```

## 按次权限与受控联网

`Shell` / `ProcessStart` 的模型工具调用可显式申请额外权限，例如：

```json
{
  "command": "npm install --cache /tmp/codingx-npm-cache",
  "sandbox_permissions": "require_escalated",
  "justification": "安装项目依赖，仅访问 npm registry。",
  "additional_permissions": {
    "network": { "domains": ["registry.npmjs.org"] }
  }
}
```

额外文件访问使用 `additional_permissions.filesystem.read` / `write` 路径数组。相对路径以主工作区为基准，审批前规范化符号链接；写权限同时允许读取该目录，read 不授予写入。必须提供理由和非空权限。审批仅支持允许一次/拒绝；不继承 session/prefix 授权，不保存到 profile，结束后不影响下一次调用。ProcessStart 保留启动时权限直至其进程组结束。

模型收到 `SANDBOX_DENIED` 后应先检查是否已有部分副作用，再带最小权限重试；Harness 不自动重放命令。每 turn 最多 3 次申请，之后返回 `ESCALATION_LIMIT`。审批拒绝/取消、`never` 或非交互无审批器时不执行。`require_escalated` **不关闭沙箱**，不能解除敏感路径与明确的域名 deny；未实现无沙箱提权字段或 `with_additional_permissions` 枚举。

也可在全局配置中持续允许项目所需域名：

```toml
default_permissions = "dependencies"

[permissions.dependencies]
extends = ":workspace"

[permissions.dependencies.network]
enabled = true

[permissions.dependencies.network.domains]
"registry.npmjs.org" = "allow"
"github.com" = "allow"
"blocked.example.com" = "deny"
```

- 域名精确匹配；`*.example.com` 只匹配一层子域，`**.example.com` 匹配域本身及任意深度子域；deny 优先。跳转、包下载及 CDN 的每个目标都要允许。域名不包含协议、路径或端口。
- 有域名规则时，Shell、ProcessStart 和本地 `!` 命令通过独立 HTTP/CONNECT 代理执行；代理只监听 `127.0.0.1`。代理变量覆盖子进程中的旧值并清空 NO_PROXY，不改变父环境、不注入凭证。客户端忽略代理变量时会被沙箱拒绝直连。
- DNS 每次解析检查全部地址，再固定数字 IP 建立连接，不二次解析。私网/回环/链路本地/映射 IPv6 默认拒绝；需同时精确允许对应 IP（`localhost` 精确授权可使用 127.0.0.1 / ::1）。仅允许一个公网域名不会允许它重绑定到私网。
- Seatbelt 使用 `localhost:代理端口`，会覆盖本机网卡地址，无法表达严格的 127.0.0.1 地址过滤。正常代理只监听回环；同端口其他本机接口服务属于原生边界。其他端口直连、UDP 和监听不放行。CONNECT 按目标主机/IP 控制，不解密 TLS、不提供 URL 路径或 TLS SNI 过滤。
- Shell 完成、超时或中断时销毁代理及连接；ProcessStart 的代理随进程退出、停止、clear 或 CLI 退出回收。运行中的进程保留启动权限，切换 profile 不会改变它。
- `enabled = true` 且无任何域名规则仍保留原先整网放行语义；默认 profile 仍拒绝网络。受控域名访问要求可用的 macOS 沙箱，否则 fail closed。开发服务器使用下节独立的 `network: "local"` 授权。

## Exec policy 规则

自动加载全局 `$CODINGX_HOME/rules/*.rules`（默认 `~/.codingx/rules/`），按文件名排序。也可从全局配置追加文件，路径相对 CODINGX_HOME：

```toml
[exec_policy]
rule_files = ["team.rules"]
```

```python
# ~/.codingx/rules/default.rules
prefix_rule(
    pattern = ["npm", "test"],
    decision = "allow",
    match = ["npm test -- --run"],
    not_match = ["npm install"],
)
prefix_rule(pattern = ["git", "push"], decision = "prompt")
prefix_rule(pattern = ["git", "push", "--force"], decision = "forbidden")
prefix_rule(pattern = ["git", ["status", "diff"]], decision = "allow")
```

支持 `pattern`、`decision`（默认 allow）、`justification`、`match` / `not_match`，字符串/列表字面量、注释及尾逗号；不执行 Python 或完整 Starlark。示例为命令字符串或 argv 数组，加载时验证；缺失的显式文件、未知语法、失败示例均报配置错误。项目配置不能加载/覆盖规则，项目内 rules 目录不会自动加载。旧 `[approval.rules]`、`[approval].allow/deny` 不是有效规则来源。

规则按 argv token 前缀匹配，`forbidden > prompt > allow`，不是命令文本子串。复合命令的每个片段都要匹配 allow；重定向、赋值、展开或无法安全解析的命令不能从前缀获得 allow。allow 只免除该规则层的询问，不能突破 profile、敏感路径或沙箱。forbidden 在 `--yolo` 下仍检查，但命令启发式不能分析任意解释器脚本，不能取代 OS 隔离。

```bash
codingx execpolicy check --command 'git status && git push'
codingx execpolicy check --rules ./candidate.rules -- git push --force
```

诊断不执行命令、不需要 Provider 凭证，输出规则判定与命中来源；forbidden 退出码 1、配置错误 2，其余 0。`none` 表示没有决定性匹配，不表示沙箱允许。`--command` 与 literal argv 二选一。普通审批可由工具 `prefix_rule` 建议单条简单命令的 token 前缀，经用户批准后仅在会话内有效；不能与按次追加权限一起使用。跨启动复用请编辑全局 `.rules`。

## 本机开发服务器

默认配置无需额外参数：启动 Python HTTP server 等常见服务时，harness 会请求本机网络审批；
用户同意后，为这次执行及其进程组开放本机网络，文件隔离和当前 profile 保持不变。
Shell / ProcessStart 可用 `network: "local"` 显式申请，`network: "inherit"` 禁用自动识别。
审批只支持 allow once，不保存会话或前缀授权；无审批入口、拒绝或 `approval_policy = "never"` 时不执行。

如需持续允许本机网络，可选择可选 profile：

```sh
codingx --permission-profile :workspace-local
```

已有 TUI 会话可执行 `/permissions :workspace-local`，之后启动一个新进程。
自定义 profile 使用：

```toml
[permissions.dev]
extends = ":workspace"

[permissions.dev.network]
mode = "local" # none | local | all
```

`local` 使用 Seatbelt 的本机地址匹配，出站目标限本机；本机网卡地址也包含在内，且通配监听仍可能暴露到局域网。
请显式使用 `--bind 127.0.0.1` 或 `::1`。这不等于严格的回环接口隔离。
`mode` 与 `enabled` 同时配置时必须一致（none 对应 false，local/all 对应 true）；原先只设 enabled 的配置行为保持不变。
旧 `[sandbox] network = "loopback"` 作为历史别名映射为 local，启动提示说明其实际边界；新配置请使用 local。
新增 profile 的配置需重启加载，已有进程不会因为切换 profile 改变沙箱。

## Permission profiles（S1 已解析）

> 设计见 [permissions.md](permissions.md)。新模型用 Permission profile（边界）× Approval policy（何时问）× Approvals reviewer（谁答）；S1/S3 已接入文件工具与 Shell，macOS Seatbelt 已落地，旧/新配置冲突会报错。网络代理与声明式 exec policy 已接入，自动审查尚未实现；项目配置不能覆盖这些权限键。

```toml
# 顶层：批准策略与默认 profile
approval_policy = "on-request"       # on-request | never
approvals_reviewer = "user"          # user | auto_review（后续）
default_permissions = "project-edit" # 或 :read-only / :workspace / :workspace-git-hooks / :danger-full-access

[permissions.project-edit]
extends = ":workspace"

[permissions.project-edit.filesystem]
":minimal" = "read"
"~/.agents" = "write"

[permissions.project-edit.filesystem.":workspace_roots"]
"." = "write"
"**/*.env" = "deny"

# 可选：允许安装 Git hooks（默认只执行、禁止写）
# ":git_hooks" = "write"
# ":git_config" = "write"

[permissions.project-edit.network]
enabled = true               # 示例：默认 false，仅按需为单个 profile 开启

[permissions.project-edit.network.domains]
"registry.npmjs.org" = "allow"
```

迁移映射：

| 旧配置 | 新配置 |
| --- | --- |
| `[sandbox].mode = "read-only"` | `default_permissions = ":read-only"` |
| `[sandbox].mode = "workspace-write"` | `default_permissions = ":workspace"` |
| `[sandbox].mode = "danger-full-access"` | `default_permissions = ":danger-full-access"` |
| `[approval].mode = "on-request"` | `approval_policy = "on-request"` |
| `[approval].mode = "never"` | `approval_policy = "never"` |
| `[approval].mode = "always-ask"` | 弃用：`on-request` + 对所有写/执行规则 `prompt` |
| `[approval].allow` / `deny` | 使用全局 `rules/*.rules` 或 `[exec_policy].rule_files`；旧 allow/deny 不作为执行规则 |
| `[sandbox].writable_roots` / `network` | 并入命名 profile；与 `default_permissions` 冲突时报错 |

`--add-dir` 只追加可写根；profile 不允许扩展时启动报错，不静默忽略。`network.enabled` / `domains` 已解析：macOS Seatbelt 在 `enabled = false` 时由内核拒绝网络，`enabled = true` 且未设 mode 时整网放行；`mode = "local"` 限本机通信；存在 `domains` 时通过每次执行独立的 HTTP/CONNECT 代理校验域名并禁止直接外连；`mode = "local"` 与域名规则同时配置时仍只允许本机目标。

受信任项目记录在全局配置中（路径必须是绝对路径；项目配置不能自证可信）：

```toml
[projects."/Users/me/work/repo"]
trust_level = "trusted"
```

S1 同时解析旧配置与新键：`[approval]` / `[sandbox]` 仍兼容，新键优先；`sandbox.writable_roots` / `readable_roots` 等旧字段仍会映射到权限 profile，不直接控制 Seatbelt；macOS Seatbelt 使用解析后的 profile 根，Linux 的 Landlock 字段留给 S4。

`approval.mode` 是兼容旧键（S1 仍支持，推荐迁移到 `approval_policy`）；它只控制「何时询问」，不能突破硬拒绝列表与沙箱。工具自身的 `approval` 声明（`none` / `on-write` / `always`）是 M2 的默认粒度，M3 起由结构化 `Action` + profile 判定取代：

- `on-request`：按工具声明与规则，在需要时询问（默认）
- `never`：从不询问；未显式允许的非只读操作一律拒绝，适合 CI 与 `exec`
- `always-ask`：任何工具调用都询问，包括只读工具（M3 弃用，迁移为 `on-request` + 写/执行 prompt 规则）

当前构建已接入应用层策略与 macOS Seatbelt：`--yolo` / `--allow-dangerously-skip-permissions` 映射到 `:danger-full-access` + `never`，同时关闭文件工具策略、审批与 OS 沙箱并输出告警；在必须有沙箱的平台（macOS 探测失败、Windows）会拒绝启动。Linux 的 Landlock 尚未接入，Shell 仍以当前用户权限运行。M3 目标语义、预设与提权流程见 [permissions.md](permissions.md)，任务拆分见 [implementation-plan-m3.md](implementation-plan-m3.md)。

`WebFetch` 已注册，默认拒绝执行；仅在 `web.enabled = true` 时允许请求；请求只允许 https，域名必须命中 `allowed_domains`，重定向目标同样校验，解析到私网 / 回环地址的域名一律拒绝。

`provider.<id>.protocol` 默认 `anthropic-messages`，后续支持 `openai-responses`；协议只决定 wire 格式，`endpoint` 与 `api_key_env` 保持通用配置。

## 推理强度

参照 GPT 的 [reasoning effort](https://developers.openai.com/api/docs/guides/reasoning) 分档方式，当前支持 `low`、`medium`、`high`、`xhigh`、`max`。较低档位偏向速度与较少 token，较高档位允许更多推理；具体支持范围与效果由目标模型决定。`default` 表示不发送 effort 参数，使用服务端默认值，不等于关闭推理。

```bash
codingx --reasoning-effort high
codingx --reasoning-effort medium exec "检查当前改动"
CODINGX_REASONING_EFFORT=low codingx exec "解释这个函数"
codingx --continue --reasoning-effort default
```

也可在全局或项目 `config.toml` 中设置：

```toml
[model]
reasoning_effort = "high"
```

新会话优先级为 CLI > 环境变量 > cwd 偏好 > 项目配置 > 全局配置 > 服务端默认。恢复或分叉会话时，CLI/env > cwd 偏好 > 会话保存的选择（包括已清除的 default）> 配置文件。启动时选择的档位只记录到会话，交互中修改才更新 cwd 偏好。非法值在启动时以配置/参数错误拒绝。

TUI 中输入 `/model` 打开两步选择面板：先从所有已配置 route target 中选择模型（或通过 Other 输入模型名），再选择 effort。模型项显示 `模型名 (Provider)`，例如 `glm-5.3 (zhipu)`、`deepseek-flash (deepseek)`；当前值排在首项，同一 Provider/model 去重。完成两步后一起保存，Esc 取消不会修改设置。候选来自启动时加载的本地配置，不代表服务端完整模型列表；修改配置后需重新启动 CLI。

选择模型时一并切换其 Provider 和 route，按需读取该 Provider 的凭证；凭证缺失、不支持协议或会话保存失败时保留原设置。每次请求仍只使用一个明确目标，不启用自动 failover、weighted 或 round-robin。模型、Provider、route 和 effort 经 `model.changed` 保存，同时更新 cwd 偏好；显式 CLI/env 的 model/provider/route 优先于保存的目标。

TUI 与 plain 均支持以下直接命令，下一次请求生效：

```text
/model --show                       查看当前模型和 effort
/model <model>                      切换模型，保留 effort
/model <provider>/<model>           明确选择 Provider 和模型
/model <model> high                 同时设置模型和 effort
/model <model> --effort high         同时设置模型和 effort（显式参数）
/model --effort high                只修改 effort
/model --effort default             清除 effort 覆盖
```

plain 模式下，无参数 `/model` 显示当前值和用法。TUI 底部显示如 `model-name (high)`；default 不额外显示档位。运行中的 turn 或本地命令结束后才能切换。

直接输入模型名时，在已配置目标中查找对应 Provider；同名时优先当前 Provider，否则用 `provider/model` 消歧。未配置的自定义模型名沿用当前 Provider；`/model --effort` 只调整强度，保持已选目标。

当前仅接通 Anthropic Messages，沿用 `output_config.effort`，需要端点和模型支持所选值；不会自动降档。OpenAI Responses 仍属后续 M4 范围。已有 `/model` 命令中的 `off`/`none`/`auto` 保持为 default 的兼容别名，不表示 GPT 的 `none` 推理模式；新启动参数和配置统一使用 `default`。

## Agent Harness hooks

Hooks 是用户配置的生命周期命令，与 Git hooks 无关，只能写在全局 `~/.codingx/config.toml`；项目配置中的 `[[hooks]]` 会被忽略并告警。

```toml
[[hooks]]
event = "session_start"          # session_start | user_prompt_submit | pre_tool_use | post_tool_use | stop | session_end
command = "git status --short"
timeout_ms = 5000

[[hooks]]
event = "pre_tool_use"
matcher = "Shell|Write"      # 仅工具事件；工具名正则
command = "python3 ~/.codingx/hooks/guard.py"
timeout_ms = 10000

[[hooks]]
event = "post_tool_use"
matcher = "Edit|Write|ApplyPatch"
command = "npm run lint --silent"
```

- 多行按配置顺序串行执行；每行默认 10s 超时，范围 100ms–120s。
- Hook 从 stdin 读取 JSON（`hook_event_name`、`session_id`、`cwd`、`turn_id`、`tool_name`、`tool_input`、`tool_result` 等），并收到 `CODINGX_HOOK_EVENT` 等环境变量。
- exit 0：成功；stdout 作为可选 context（`session_start` 注入系统提示、`user_prompt_submit` 注入用户消息、`post_tool_use` 追加到工具结果）。
- exit 2：阻止 `user_prompt_submit` / `pre_tool_use`；其他事件只记录。
- 其他非零或超时：记录 `hook.finished` 失败告警，不阻止 turn。
- Hooks 使用当前用户权限执行，继承白名单环境变量；不要从不可信来源复制 hook。完整语义见 [hooks.md](hooks.md)。

## Provider 路由

`[provider.<id>]` 是按 id 索引的表，可以配置多个 Provider；`[routes.<name>]` 把 targets（provider + model）组织成可选择的策略。`[model] route` 选择默认 route，`--route` / `CODINGX_ROUTE` 可覆盖。

- `failover`：按 targets 顺序切换
- `weighted`：按权重分摊，默认 `affinity = session` 保持 prompt cache
- `round-robin`：轮转
- 所有策略都支持在“首个内容事件之前”的故障转移；内容发出后不重放

`--provider` 在 route 内固定 Provider id，`--model` 覆盖目标 model；把候选收窄到单个目标时不再跨 Provider failover。完整语义见 [provider-routing.md](provider-routing.md)。

M1 只实现 Anthropic Messages；OpenAI Responses 在 M4 加入，届时 secondary target 才可用。`[provider.<id>]` 含端点与凭证，只允许全局配置；项目配置可以定义/选择 routes，但只能引用全局 provider id。

## 项目配置

`<workspace>/.codingx/config.toml` 通常只写与团队约定相关的部分：

```toml
[model]
route = "cheap"

[routes.cheap]
strategy = "failover"

[[routes.cheap.targets]]
provider = "primary"
model = "model-name-small"

[approval.allow]
exec = ["pnpm test", "pnpm build"]

[[mcp.servers]]
name = "github"
command = "npx"
args = ["-y", "@modelcontextprotocol/server-github"]
```

该文件应提交到版本库。provider 定义、凭证与个人偏好留在全局配置；routes 可以提交，但 target 只能引用全局 provider id。

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `CODINGX_ROUTE` | 覆盖 route 名 |
| `CODINGX_MODEL` | 覆盖目标 model |
| `CODINGX_REASONING_EFFORT` | 推理强度：`low|medium|high|xhigh|max|default` |
| `CODINGX_PROVIDER` | 在 route 内固定 Provider id |
| `CODINGX_APPROVAL` | 覆盖审批模式 |
| `CODINGX_HOME` | 覆盖 `~/.codingx` 目录 |
| `CODINGX_SESSIOND` | 设为 `0` 关闭 sessiond（退回进程内存储，无跨 CLI） |
| `CODINGX_SESSIOND_SOCKET` | 覆盖 sessiond socket 路径 |
| `CODINGX_LOG` | 设为 `debug` 输出详细日志到 stderr |
| `API_KEY` | 通用 API Key（`api_key_env` 指向的变量名） |

## AGENTS.md

项目约定用 markdown 表达，不用配置项：

```markdown
# AGENTS.md

## 构建与测试
- 包管理器用 pnpm，不要用 npm
- 提交前跑 `pnpm lint && pnpm test`

## 代码风格
- 使用 ESM，不用 CommonJS
- 所有导出函数写显式返回类型

## 注意事项
- `src/legacy/` 是历史代码，不要重构
```

加载顺序：从 workspace 根到当前工作目录，逐层查找 `AGENTS.md` / `CODINGX.md`，按顺序拼接后注入系统提示。内容计入上下文预算，超过 10k token 时截断并告警。

## 会话目录

```text
~/.codingx/
├── config.toml
├── auth.json            # 0600
├── run/
│   ├── sessiond.sock    # 0600
│   ├── sessiond.json    # pid / socket / protocol
│   └── sessiond.lock
├── logs/
│   └── sessiond.log
├── sessions/
│   └── <cwd-name>/
│       └── 2026-10-24T15-20-01_550e8400-e29b-41d4-a716-446655440000.jsonl
├── input-history/
│   └── <cwd-name>/       # 每个 cwd 最近 200 条输入
├── workspaces/
│   └── <cwd-name>/       # 模型和权限偏好
└── tools/               # 自定义工具（需 allow_custom）
```

cwd-name 将真实绝对 cwd 中的 `/` 替换为 `-`，例如 `/Users/red/workspace/codingx-harness` 对应 `-Users-red-workspace-codingx-harness`；子目录独立，符号链接归并。`session.dir` 指定存储根目录，新 rollout 写入其 `<cwd-name>/` 子目录；共享 sessiond 管理各目录，CLI 的 list/show/watch/prune、continue/resume/fork 和离线 log 仅操作当前 cwd。切换项目时使用 `--cd <目录>`。

目录内的 `cwd.json` 记录归属；不同 cwd 转换后重名时追加 `--2`、`--3` 等后缀，长名称在 220 字节内截断后同样处理重名。输入历史、会话和目录偏好统一采用此命名；旧 SHA-256 目录仍可读取，新记录写入可读目录。

旧版 sessions 根目录中的 rollout 仍按 `session.start.cwd` 归属读取，无需搬移或重写；旧全局 input-history 文件缺少 cwd，保留原文件但不导入项目历史。输入历史每个 cwd 独立裁剪到最近 200 条。

rollout 文件为 append-only JSONL，每行一个事件，默认由 sessiond 单写者追加（`enabled = false` 的嵌入式模式除外）。`codingx sessions prune` 按 `retention_days` 清理当前 cwd 中符合条件的非活动会话；活动或仍有客户端占用的会话不会删除。协议、租约与崩溃恢复见 [session-manager.md](session-manager.md)。

## 命令行选项

```bash
codingx [options] [prompt]

      --route <name>        选择 route（默认取 [model] route）
  -m, --model <name>        覆盖目标模型名
  --reasoning-effort <level> 推理强度：low|medium|high|xhigh|max|default
  -p, --provider <id>       在 route 内固定 Provider id
  -C, --cd <path>           指定工作目录
      --add-dir <DIR>       追加文件与 Shell 工具的可写目录（可重复）
  -s, --sandbox <mode>      read-only | workspace-write | danger-full-access
  -a, --ask-for-approval <policy>
                            on-request | never
  -P, --permission-profile <name>
                            选择命名 Permission profile
      --approve-for-me      越界请求交给自动 reviewer（接口已接受；自动审查未实现）
      --full-auto           :workspace + auto_review 的兼容别名（自动审查未实现）
      --yolo, --allow-dangerously-skip-permissions
                            关闭审批、文件策略与 OS 沙箱（危险；仅用于一次性容器）
      --plain               纯文本输出，不启用 TUI
      --json                事件流以 JSON Lines 输出到 stdout
  -c, --continue            继续最近的会话
      --resume <id>         恢复指定会话
      --takeover            接管空闲会话的写租约（有活动 turn 时拒绝）
      --fork <id>           从指定会话分叉
      --offline             只读扫描本地 JSONL，不连接 sessiond

codingx exec <prompt>     单次执行，非交互
codingx resume <id>       恢复会话
codingx login             凭证登录
codingx config            打开配置文件
codingx sessions list     列出所有终端的会话
codingx sessions show <id>   查看会话状态与最近事件
codingx sessions watch <id>  只读观察实时事件
codingx sessions prune    清理过期会话
codingx sessiond start|stop|status|restart  管理本地会话进程
codingx log --session <id>  回放会话的审计事件
```

`--json` 与 `exec` 组合时，stdout 只输出机器可读事件，人类可读信息走 stderr——保证可以安全地接入管道。`sessions list/show/watch` 与 `sessiond status` 同样支持 `--json`；前者在 daemon 未运行且 `sessiond.enabled = true` 时会先尝试自动拉起。`sessions list --offline` 只读扫描 JSONL，`codingx log` 始终直接读 JSONL，两者都不依赖 daemon 且没有实时状态。`sessiond stop` 默认拒绝在有活动租约时退出，`--force` 会把进行中的 turn 标记为 `interrupted`。


## P0–P2 执行与网页读取

```toml
[agent]
max_parallel_tools = 4 # 1–32，设为 1 恢复串行

[web]
enabled = false
allowed_domains = ["example.com", "*.example.com"]
```

只并行连续的 Read/ListDir/Glob/Grep；写入、Shell、Process、交互与 WebFetch 都是顺序屏障。pre/post_tool_use hooks 启用时串行；需要审批的读取也串行。WebFetch 最多 5 次重定向、总超时 30 秒、解压后 2 MiB，支持 HTML/纯文本/Markdown/JSON。网页作为不可信数据进入工具结果，不携带 cookies 或认证。
