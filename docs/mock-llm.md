# Mock LLM Server

本地、确定性的 Anthropic Messages/SSE 服务，用真实 codingx Provider、AgentLoop、工具、权限策略和 SessionStore 验证已实现的能力。无需真实 API Key，不调用外部 LLM，不访问外网。仅监听 `127.0.0.1`，当前验收平台为 macOS。

Mock 负责提供可重复的模型行为；终端渲染、sessiond 租约、OS 沙箱与网络代理等由对应专项测试证明。`npm run verify:mock` 把构建、类型检查、新 Mock 测试与全部现有测试一起执行，覆盖清单见下文；这不包含尚未实现的 MCP、多目标路由、OpenAI Responses 或 auto-review。

## 一分钟启动

在仓库根目录：

```bash
npm run mock:llm -- --port 4010 --init /tmp/codingx-mock-demo
```

`--init` 的目标目录必须尚不存在，父目录必须存在。服务会创建独立的 `home/config.toml`、`workspace/AGENTS.md`、测试 skill 和一张 PNG，不修改日常 codingx 配置。stdout 第一条服务输出为 `mock.ready` JSON（npm 的构建输出在它之前）；stderr 显示可直接复制的运行命令。端口冲突时用 `--port 0`，配置会写入实际端口。

另一个终端，在仓库根目录运行：

```bash
export CODINGX_HOME=/tmp/codingx-mock-demo/home
export MOCK_LLM_API_KEY=mock-local-only

# 真实读写、搜索、计划、diff、Shell 校验和 rollout
node bin/codingx.js -C /tmp/codingx-mock-demo/workspace exec '[mock:files]'

# TUI：依次发送 [mock:text]、[mock:ask]、[mock:approval]、[mock:pty]
node bin/codingx.js -C /tmp/codingx-mock-demo/workspace --tui

# 全仓库验证（本地回环 HTTP 和 macOS 子进程能力必须可用）
npm run verify:mock

# 只跑 Mock Provider / CLI 验证
npm run test:mock

# 两个真实构建入口的子进程冒烟
npm run smoke:mock
```

首次构建以后可直接运行 `node dist/mock-llm.js`，无需每次重新构建。Ctrl+C / SIGTERM 会关闭监听和活动连接。测试导入 `startMockServer()` 时默认选择随机端口，通过 `close()` 清理。

文件类场景会修改当前 workspace 内的 `mock-output/hello.txt`、`mock-conflict.txt` 等测试文件，使用生成的独立 workspace 运行。`files` 会先 Read，支持重复执行；`permission` 必须配合只读 profile。测试仍走 codingx 原有权限与 Seatbelt，没有默认启用 `--yolo`。

## 场景选择与诊断

优先级：**当前用户消息的 `[mock:<id>]` > `mock-<id>` 模型名 > 服务的 `--scenario`**。可以通过 `--model mock-files` 或 TUI `/model` 切换，也可以保留真实模型名（例如验证费用插件），只在消息中指定场景。生成配置使用模型名 `mock`，允许 `--scenario` 生效。

```bash
node dist/mock-llm.js --list
node dist/mock-llm.js --scenario text --chunk-bytes 7 --delay-ms 2 --crlf
curl -sS http://127.0.0.1:4010/health
curl -sS http://127.0.0.1:4010/scenarios
curl -sS http://127.0.0.1:4010/stats
```

`/stats` 只保留最近 100 个已识别场景的请求摘要：场景、step、HTTP 状态、消息/图片/工具数量、effort、是否携带 cache_control。它不记录 headers、API Key、提示词、工具输入/输出或图片内容；总请求数也按已识别场景计。HTTP 200 仅表示响应已发送，不代表 CLI 已执行成功。最终状态以工具断言、退出码和 rollout 为准。

请求必须为 `POST /v1/messages`，携带 `model`、正整数 `max_tokens`、`stream: true`、非空 `messages`。支持普通字符串和 content blocks。请求体上限 32 MiB；不支持非流式响应。API Key 不校验；`mock-local-only` 只是满足 codingx Provider 必填参数的占位符。

## 内置场景

| 场景 | 验证行为 / 预期 |
| --- | --- |
| `text` | 中文、emoji、Markdown/code/table 流式文本；固定 usage/cache counters |
| `files` | UpdatePlan、Read、Write、同批 Read/ListDir/Glob/Grep、Edit、ApplyPatch、Shell 精确校验；最终 `MOCK PASS` |
| `process` | pipe stdin；ProcessStart/List/Write/Read/Stop；动态提取 processId |
| `pty` | PTY 输入、resize、输出读取与停止；仍走沙箱 |
| `ask` | 中文单选、多选、自由文本；交互模式回答或取消，exec 验证错误回填 |
| `skill` | 加载 `--init` 创建的 `mock-check`，检查 `MOCK_SKILL_READY` |
| `errors` | 不存在的文件、错误入参、WebFetch 拒绝、未知工具；检查 `is_error` |
| `permission` | 以 `--sandbox read-only --ask-for-approval never` 运行，Write 必须被拒绝 |
| `approval` | 合法按次追加读取权限请求；交互弹审批，exec 返回 APPROVAL_REQUIRED |
| `shell-errors` | 非零退出、100ms 超时、后续命令恢复成功 |
| `conflict` | Read 后 Shell 从外部改文件，Edit 必须拒绝旧指纹；CLI 测试检查 FILE_CHANGED |
| `image` | 当前 turn 必须含图片；检查传输而非视觉理解 |
| `context` | 每轮约 4 万字符文本，供多轮压缩和滚动测试 |
| `loop` | 不断 ListDir，直到 max_steps 或中断；预期无 PASS |
| `slow` | 首字节前等待 10 秒，供中断/idle timeout 测试 |
| `retry` | 相同请求先返回两次 503，第三次成功；需 max_attempts ≥ 3 |
| `rate-limit` | 一次 429 + Retry-After: 0，重试成功 |
| `auth` | 永久 401；预期失败且不重试 |
| `overflow` | 400 context length 错误；供溢出分类/压缩路径验证 |
| `stream-error` | 输出文本后发 SSE error；不可重新请求重放部分内容 |
| `disconnect` | 输出文本后正常结束 HTTP body，但缺 message_stop；预期协议错误 |
| `malformed-json` | 输出文本后发损坏的 SSE JSON；预期协议错误 |
| `max-tokens` / `refusal` | 完整流分别返回 max_tokens / refusal stop reason |

`ask` / `approval` 接受成功或失败结果以支持用户取消、拒绝和非交互运行。它们的 PASS 只证明结果已回填；是否弹出面板、批准或拒绝需要看 UI / rollout。其他工具默认要求成功，负例显式要求失败。Mock 的所有 token 数是测试夹具，不是实际文本计量或真实账单。

实用命令：

```bash
node bin/codingx.js -C /tmp/codingx-mock-demo/workspace --sandbox read-only --ask-for-approval never exec '[mock:permission]'
node bin/codingx.js -C /tmp/codingx-mock-demo/workspace exec --image image.png --json '[mock:image]'
node bin/codingx.js -C /tmp/codingx-mock-demo/workspace --reasoning-effort high exec '[mock:retry]'
```

## 自定义 JSON 场景

```bash
node dist/mock-llm.js --port 4010 --scenario-file docs/mock-llm-example.json
# 另一个终端（沿用上述 CODINGX_HOME / MOCK_LLM_API_KEY）：
node bin/codingx.js -C /tmp/codingx-mock-demo/workspace exec '[mock:custom-smoke]'
```

文件可为单个场景或数组。启动时严格校验，重复 id（包括覆盖内置 id）、未知字段、非最终的纯文本 step 都报错。完整类型/schema 见 [types.ts](../src/mock-llm/types.ts)。主要字段：

- `id`、`description`、`steps`：每个 step 为一次模型响应；非最后的 step 应发出工具调用来继续 AgentLoop。
- step 的 `text`、`tools: [{name, input, expect}]` 可同时提供；同一个 step 的多个只读工具可触发 codingx 的并行调度。
- `expect` 未指定时默认要求 `is_error=false`；`{}` 接受任意返回；`{isError: true}` 验证失败；`contains` 检查工具结果文本。断言失败返回 409，不伪造 PASS。
- `input` 内的字符串支持 `{{stepIndex.toolIndex.json.path}}`，索引从 0 起。例如 `{{0.0.processId}}` 引用第 0 步第 0 个工具 JSON 输出的 processId。缺少结果或字段会明确失败，不执行模板代码。
- `repeat: true` 循环 steps，适合 maxSteps / 中断测试。
- `httpError: {status, type, message, attempts?}` 在 SSE 前注入 HTTP 故障；不填 attempts 表示永久失败。
- step 的 `fault` 为 `stream-error`、`disconnect` 或 `malformed-json`；`delayMs` 为响应前延迟。
- `usage` 自定义 input/output/cache token 计数，`requireImage` 要求当前 turn 有图片。

脚本进度从**当前 turn 的 assistant tool_use IDs 和 tool_result** 推导，不以服务总请求数计步，因此不同会话不会共享一个脚本游标，resume/fork 可以携带历史继续。只校验刚完成的一批工具，早期结果被上下文压缩后不会误判旧 contains；引用早期 JSON 结果的自定义脚本需要保留该结果，丢失后会明确失败。

HTTP 故障重试计数按完整请求 JSON 的哈希保存（最多 1000 个），成功后删除。**并发、字节完全相同的请求会共享故障计数**，需要独立验证重试时请用不同提示词或独立服务实例。停止服务会清空这些计数和统计。普通工具场景无服务端会话游标。

模型摘要请求通过 codingx 专用 summary system prompt 识别，返回固定四节摘要，不执行所选工具脚本。该夹具用于验证三级压缩的协议、用量与持久化，不能证明真实摘要的语义保真。

## 全能力验证矩阵

`npm run verify:mock` 执行全仓库测试。服务提供模型侧输入，真正的断言由对应测试负责：

| 能力 | Mock / 手工操作 | 自动化证据 |
| --- | --- | --- |
| SSE、UTF-8 分块、CRLF、usage/cache、effort、错误分类/重试 | text、retry、rate-limit、故障场景 | mock-llm、anthropic-provider、router、model-selection |
| 文件/搜索/计划/diff/Shell、先读后写、工具失败回填 | files、errors、shell-errors | mock-llm-cli、tools、tools-m2、tools-apply-patch、file-diff |
| 并行只读、外部修改冲突、检查点、撤销 | files、conflict；TUI `/changes`、`/undo` 预览再确认 | mock-llm-cli、p0-p2-files、agent-loop |
| 受管进程、PTY/stdin、退出清理 | process、pty；`/process` 命令 | mock-llm-cli、tools-process、process-manager、process-shutdown、process-command |
| 用户提问/取消、Skills | ask、skill | mock-llm-cli、tools-ask、skills、tui-ask、tui-session |
| 权限 profile、交互审批、按次提权、exec policy、Seatbelt | permission、approval；TUI `/permissions` | mock-llm-cli、policy、scoped-permissions、exec-policy、sandbox、tui-approval |
| 网络代理/域名拒绝、WebFetch 成功与 SSRF 拦截 | errors 仅驱动拒绝，不触网 | network-proxy、web-fetch（本地 HTTPS fixture / 注入 DNS） |
| 生命周期 hooks | 配置 hooks 后运行任意工具场景；阻止正常工具会触发 Mock 断言失败 | mock-llm-cli、hooks |
| rollout、恢复/fork、cwd 隔离、会话切换、sessiond | 多轮 text/files；`--continue`、`--resume`、`--fork`、`/resume` | session、resume、session-fork、history、sessiond-*、acceptance-m2 |
| 上下文压缩、maxSteps、中断 | context 多轮（调小 context_window）、loop、slow | mock-llm、mock-llm-cli、compression、summarize、agent-loop |
| 文件引用、图片附件、额外目录 | `/attach`、`@`、image；自定义 Write 配合 --add-dir | mock-llm-cli、p0-p2-files、cli-e2e、p0-p2-tui |
| TUI/plain/JSON、Markdown、聚合、diff、历史、快捷键、resize、复制 | text/files/ask/approval；真实终端交互 | mock-llm-cli、tui-*、plain-renderer、input-history、clipboard、local-command |
| 插件费用/状态栏、tips、目录偏好 | text + 已配置插件；真实模型名配合 `[mock:text]` | plugins、turn-summary-plugin、plugin-install、tips、workspace-preferences |
| 构建入口、实际子进程和终端验收 | `node dist/mock-llm.js` / `node bin/codingx.js` | `scripts/smoke-mock-llm.mjs`（包含在 verify:mock）；`node scripts/smoke-p0-p2.mjs` 为可选终端冒烟 |

Mock 的新增测试还检查所有当前注册的工具名都有场景触发；这表示工具入口覆盖，不能代替该工具所有分支的专项测试。WebFetch 默认拒绝、权限拒绝、未知工具等负例以符合预期的错误作为通过条件。

遇到 `listen EPERM`，表示运行测试的外层沙箱不允许本机监听，需要在允许回环网络的本地终端或经批准的测试环境运行；服务自身不会绕过 codingx 的工具权限策略。
