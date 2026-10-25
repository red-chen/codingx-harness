# 配置

## 文件位置与优先级

优先级从高到低，后者被前者覆盖：

1. 命令行参数
2. 环境变量
3. 项目配置 `<workspace>/.codingx/config.toml`
4. 全局配置 `~/.codingx/config.toml`
5. 内置默认值

项目配置只允许覆盖**行为类**设置（模型、审批、工具开关、MCP、联网），不允许覆盖凭证——避免从远程仓库克隆来的项目配置窃取本地密钥。凭证只从 `codingx login` 的 `auth.json` 或环境变量读取，不写入 `config.toml`。整个 `[sessiond]` 段与 `session.dir` / `retention_days` 是例外：只允许来自全局配置或环境变量，项目配置不得覆盖。`[tui]` 属于个人终端偏好，同样只从全局配置读取。

## 完整示例

```toml
# ~/.codingx/config.toml

[model]
provider = "anthropic"
name = "claude-opus-4-7"
max_output_tokens = 8192
temperature = 0
# 上下文窗口上限，用于触发压缩；留空则按模型默认值
context_window = 200000

[agent]
max_steps = 64               # 单 turn 最多模型往返次数，避免无进展循环

[provider.anthropic]
# 凭证优先从 `codingx login` 的 auth.json 读取；
# 此处仅用于指向兼容端点
base_url = "https://api.anthropic.com"
api_key_env = "ANTHROPIC_API_KEY"

[approval]
mode = "on-request"          # on-request | never | always-ask
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
enabled = false              # web_fetch 默认关闭
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

[tui]
alternate_screen = "auto"    # auto | always | never（never 为 inline/plain fallback）
theme = "auto"               # auto | dark | light | <syntax theme>
animations = true
notifications = true
status_line = ["model", "cwd", "context"]

[mcp]
# 外部工具服务器
servers = []

# [[mcp.servers]]
# name = "filesystem"
# command = "npx"
# args = ["-y", "@modelcontextprotocol/server-filesystem", "."]
# env = {}
```

`approval.mode` 只控制「何时询问」，不能突破硬拒绝列表与沙箱；工具自身的 `approval` 声明（`none` / `on-write` / `always`）给出默认粒度：

- `on-request`：按工具声明与规则，在需要时询问（默认）
- `never`：从不询问；未显式允许的非只读操作一律拒绝，适合 CI 与 `exec`
- `always-ask`：任何工具调用都询问，包括只读工具

`web_fetch` 仅在 `web.enabled = true` 时注册；请求只允许 https，域名必须命中 `allowed_domains`，重定向目标同样校验，解析到私网 / 回环地址的域名一律拒绝。TUI 的布局、键位与渲染策略见 [tui.md](tui.md)。

## 项目配置

`<workspace>/.codingx/config.toml` 通常只写与团队约定相关的部分：

```toml
[model]
name = "claude-sonnet-4-5"    # 团队统一用更便宜的模型

[approval.allow]
exec = ["pnpm test", "pnpm build"]

[[mcp.servers]]
name = "github"
command = "npx"
args = ["-y", "@modelcontextprotocol/server-github"]
```

该文件应提交到版本库。凭证与个人偏好留在全局配置。

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `CODINGX_MODEL` | 覆盖模型名 |
| `CODINGX_PROVIDER` | 覆盖 Provider |
| `CODINGX_APPROVAL` | 覆盖审批模式 |
| `CODINGX_HOME` | 覆盖 `~/.codingx` 目录 |
| `CODINGX_SESSIOND` | 设为 `0` 关闭 sessiond（退回进程内存储，无跨 CLI） |
| `CODINGX_SESSIOND_SOCKET` | 覆盖 sessiond socket 路径 |
| `CODINGX_LOG` | 设为 `debug` 输出详细日志到 stderr |
| `ANTHROPIC_API_KEY` | API Key（`api_key_env` 指向的变量名） |

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
│   ├── 2026-10-24T15-20-01_a1b2c3d4e5f6.jsonl
│   └── ...
└── tools/               # 自定义工具（需 allow_custom）
```

rollout 文件为 append-only JSONL，每行一个事件，默认由 sessiond 单写者追加（`enabled = false` 的嵌入式模式除外）；`index.json` 是元数据缓存，删除后可从 JSONL 重建。清理策略：`retention_days` 之后由 sessiond 自动删除已结束 / 已中断会话，`codingx sessions prune` 可手动触发，活动会话永不清理。协议、租约与崩溃恢复见 [session-manager.md](session-manager.md)。

## 命令行选项

```bash
codingx [options] [prompt]

  -m, --model <name>        指定模型
  -p, --provider <id>       指定 Provider
  -C, --cd <path>           指定工作目录
      --full-auto           跳过审批询问（沙箱仍生效）
      --yolo                关闭审批与沙箱（危险）
      --plain               纯文本输出，不启用 TUI
      --no-alt-screen       不进入 alternate screen（inline/plain fallback）
      --ascii               使用 ASCII 图标与分隔符
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
