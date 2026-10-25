# 配置

## 文件位置与优先级

优先级从高到低，后者被前者覆盖：

1. 命令行参数
2. 环境变量
3. 项目配置 `<workspace>/.codingx/config.toml`
4. 全局配置 `~/.codingx/config.toml`
5. 内置默认值

项目配置只允许覆盖**行为类**设置（模型、工具开关、MCP、联网），且权限相关设置只能收紧（M3 起强制执行）：受信任项目可以追加更窄的 Permission profile / 审批规则，但不能放宽全局权限或网络白名单。项目配置不允许覆盖凭证——避免从远程仓库克隆来的项目配置窃取本地密钥。凭证只从 `codingx login` 的 `auth.json` 或环境变量读取，不写入 `config.toml`。整个 `[sessiond]` 段与 `session.dir` / `retention_days` 是例外：只允许来自全局配置或环境变量，项目配置不得覆盖。`[provider.<id>]` 含端点与凭证，也只允许全局配置；项目配置可以定义/选择 routes，但只能引用全局 provider id。

## 完整示例

```toml
# ~/.codingx/config.toml

[model]
route = "default"            # 选择 route；也可用 --route / CODINGX_ROUTE
max_output_tokens = 8192
temperature = 0
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
network = "none"             # none | loopback | all
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

## Permission profiles（S1 已解析）

> 设计见 [permissions.md](permissions.md)。新模型用 Permission profile（边界）× Approval policy（何时问）× Approvals reviewer（谁答）；S1 已解析并接入文件工具，旧/新配置冲突会报错。OS 沙箱、网络代理、审批 UI 与自动审查尚未实现；项目配置不能覆盖这些权限键。

```toml
# 顶层：批准策略与默认 profile
approval_policy = "on-request"       # on-request | never
approvals_reviewer = "user"          # user | auto_review（后续）
default_permissions = "project-edit" # 或 :read-only / :workspace / :danger-full-access

[permissions.project-edit]
extends = ":workspace"

[permissions.project-edit.filesystem]
":minimal" = "read"
"~/.agents" = "write"

[permissions.project-edit.filesystem.":workspace_roots"]
"." = "write"
"**/*.env" = "deny"

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
| `[approval].allow` / `deny` | S5 的 `[approval.rules]`；之后再兼容 Codex `.rules` |
| `[sandbox].writable_roots` / `network` | 并入命名 profile；与 `default_permissions` 冲突时报错 |

`--add-dir` 只追加可写根；profile 不允许扩展时启动报错，不静默忽略。S1 已解析 `network.enabled` / `domains` 并对已知网络命令做启发式检查；没有代理或 OS 网络隔离，任意程序仍可绕过。

受信任项目记录在全局配置中（路径必须是绝对路径；项目配置不能自证可信）：

```toml
[projects."/Users/me/work/repo"]
trust_level = "trusted"
```

S1 同时解析旧配置与新键：`[approval]` / `[sandbox]` 仍兼容，新键优先；`sandbox.writable_roots` / `readable_roots` 等 OS 沙箱字段仍预留给 S3/S4，不参与当前路径策略。

`approval.mode` 是兼容旧键（S1 仍支持，推荐迁移到 `approval_policy`）；它只控制「何时询问」，不能突破硬拒绝列表与沙箱。工具自身的 `approval` 声明（`none` / `on-write` / `always`）是 M2 的默认粒度，M3 起由结构化 `Action` + profile 判定取代：

- `on-request`：按工具声明与规则，在需要时询问（默认）
- `never`：从不询问；未显式允许的非只读操作一律拒绝，适合 CI 与 `exec`
- `always-ask`：任何工具调用都询问，包括只读工具（M3 弃用，迁移为 `on-request` + 写/执行 prompt 规则）

当前构建只有应用层路径检查：`--yolo` / `--allow-dangerously-skip-permissions` 关闭文件工具与 Shell `cwd` 的 workspace / `--add-dir` 限制并输出告警；审批引擎与 OS 沙箱尚未接入，因此该选项也不会关闭它们。M3 目标语义、预设与提权流程见 [permissions.md](permissions.md)，任务拆分见 [implementation-plan-m3.md](implementation-plan-m3.md)。

`WebFetch` 仅在 `web.enabled = true` 时注册；请求只允许 https，域名必须命中 `allowed_domains`，重定向目标同样校验，解析到私网 / 回环地址的域名一律拒绝。

`provider.<id>.protocol` 默认 `anthropic-messages`，后续支持 `openai-responses`；协议只决定 wire 格式，`endpoint` 与 `api_key_env` 保持通用配置。

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
│   ├── index.json       # 元数据缓存，可重建
│   ├── 2026-10-24T15-20-01_550e8400-e29b-41d4-a716-446655440000.jsonl
│   └── ...
└── tools/               # 自定义工具（需 allow_custom）
```

rollout 文件为 append-only JSONL，每行一个事件，默认由 sessiond 单写者追加（`enabled = false` 的嵌入式模式除外）；`index.json` 是元数据缓存，删除后可从 JSONL 重建。清理策略：`retention_days` 之后由 sessiond 自动删除已结束 / 已中断会话，`codingx sessions prune` 可手动触发，活动会话永不清理。协议、租约与崩溃恢复见 [session-manager.md](session-manager.md)。

## 命令行选项

```bash
codingx [options] [prompt]

      --route <name>        选择 route（默认取 [model] route）
  -m, --model <name>        覆盖目标模型名
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
                            关闭审批与沙箱（危险；当前无 OS 沙箱，文件工具不受限）
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