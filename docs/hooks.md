# Agent Harness Hooks

> 状态：**已实现 MVP**。Hooks 是用户配置的本地生命周期命令，不是 Git hooks。它们由全局配置驱动，在当前 workspace 执行，并写入 rollout 审计。

## 1. 事件

| 事件 | 触发时机 | 可否阻止 | stdout 用途 |
| --- | --- | --- | --- |
| `session_start` | 会话创建/恢复后、首个 turn 前 | 否 | 作为 `session_start` 上下文追加到系统提示 |
| `user_prompt_submit` | 用户 prompt 写入 rollout 后、请求模型前 | 是（exit 2） | 作为 hook context 追加到本次用户消息 |
| `pre_tool_use` | 工具调用已写入 rollout、实际执行前 | 是（exit 2） | 仅审计；阻止原因回填给模型 |
| `post_tool_use` | 工具执行完成、写入 `tool.result` 前 | 否 | 追加到工具结果，模型可见 |
| `stop` | turn 以 done / error / aborted 结束 | 否 | 仅审计/告警 |
| `session_end` | 会话关闭前 | 否 | 仅审计 |

`pre_tool_use` / `post_tool_use` 支持按工具名匹配：

```toml
[[hooks]]
event = "pre_tool_use"
matcher = "Shell|WriteFile"
command = "python3 ~/.codingx/hooks/guard.py"
timeout_ms = 5000
```

matcher 是正则，只匹配工具名；写在非工具事件上会在启动时报配置错误。

## 2. 配置

Hooks 只能写在**全局配置** `~/.codingx/config.toml`。项目配置中的 `[[hooks]]` 会被忽略并告警，避免克隆仓库直接执行命令。

```toml
[[hooks]]
event = "session_start"
command = "git status --short"
timeout_ms = 5000

[[hooks]]
event = "pre_tool_use"
matcher = "Shell"
command = "python3 ~/.codingx/hooks/check-shell.py"
timeout_ms = 10000

[[hooks]]
event = "post_tool_use"
matcher = "EditFile|WriteFile|ApplyPatch"
command = "npm run lint --silent"

[[hooks]]
event = "stop"
command = "echo turn finished"
```

字段：

- `event`：上表六个事件之一，必填。
- `command`：经 `bash -lc` 执行的命令，必填。
- `timeout_ms`：单条 hook 超时，默认 10000，范围 100–120000。
- `matcher`：可选，只用于 `pre_tool_use` / `post_tool_use`。

Hooks 按配置顺序串行执行。Hook context 属于当前调用：`session_start` 会在每次启动/恢复时重新执行；旧的 `user_prompt_submit` context 不会从 rollout 恢复。

## 3. 输入

每条 hook 收到 JSON stdin：

```json
{
  "hook_event_name": "pre_tool_use",
  "session_id": "…",
  "cwd": "/path/to/workspace",
  "timestamp": "2026-…Z",
  "turn_id": "turn_…",
  "call_id": "toolu_…",
  "tool_name": "Shell",
  "tool_input": { "command": "npm test" }
}
```

`post_tool_use` 额外包含：

```json
"tool_result": { "content": "…", "isError": false }
```

`user_prompt_submit` 包含 `prompt`；`stop` 包含 `stop_status`（`done` / `error` / `aborted`）。

环境变量：

- `CODINGX_HOOK=1`
- `CODINGX_HOOK_EVENT`
- `CODINGX_SESSION_ID`
- `CODINGX_CWD`
- `CODINGX_TURN_ID`（可用时）
- `CODINGX_TOOL_NAME`（工具事件）

Hook 进程使用 `[sandbox].env_passthrough` 过滤后的环境，不继承 API Key 等凭证。

## 4. 退出码与结果

| 退出码/状态 | 行为 |
| --- | --- |
| `0` / `ok` | 成功；stdout 作为 context（取决于事件） |
| `2` / `blocked` | 阻止 `user_prompt_submit` / `pre_tool_use`；其他事件只记录 |
| 其他非零 / `failed` | 记录失败并告警；不阻止 turn |
| 超时 / `timeout` | 终止 hook；记录告警；不阻止 turn |
| turn 中止 / `aborted` | hook 随 turn 中止；记录事件 |

被阻止时：

- prompt：返回 `HOOK_BLOCKED`，不调用模型；
- 工具：返回 `is_error: true` 的合成 `tool_result`，模型可见阻止原因。

Hook 失败不会让整个 turn 崩溃；它只是额外防线，不能替代 permission policy 与 OS sandbox。

## 5. 审计与 UI

每条 hook 执行写 rollout：

```ts
{
  type: 'hook.finished',
  event,
  command,
  matcher?,
  status: 'ok' | 'blocked' | 'failed' | 'timeout' | 'aborted',
  exitCode,
  durationMs,
  blocked,
  turnId?,
  callId?,
  toolName?,
  stdout?,
  stderr?,
  reason?
}
```

stdout/stderr 有长度上限；审批/工具命令的敏感信息由通用 rollout 脱敏处理。TUI 与 plain renderer 对非 `ok` 结果显示告警；`session_start` / `session_end` 的失败在启动/退出时打印 warning。

## 6. 安全边界

- Hooks 是**全局配置中的本地代码**，默认信任配置作者；不要从不可信来源复制 hook。
- 项目配置不能定义 hooks；这是与 Git hooks 的关键差异。
- Hooks 不受 Shell tool 的 permission profile / Seatbelt 约束，因为它们属于本地控制面；可以使用当前用户权限。需要隔离时把 hook 自身包装进沙箱。
- Hook 不能修改模型看到的工具参数、审批选项或 profile；它只能阻止/添加上下文。
- Hook 失败、超时和输出都不能绕过 policy、审批或 sandbox。
- 目前没有 per-hook 环境变量、异步/并行执行、项目 hooks 或 hook 审批；需要时再扩展。

## 7. 实现

- `src/hooks/types.ts`：事件、配置、输入/输出类型。
- `src/hooks/runner.ts`：顺序执行、超时、stdin、匹配、审计。
- `src/config/load.ts`：全局 `[[hooks]]` 解析；项目配置剥离。
- `src/agent/loop.ts`：prompt / pre-tool / post-tool / stop 接入。
- `src/cli/commands/*`：session_start / session_end 接入。
- 测试：`tests/hooks.test.ts`、`tests/config.test.ts`、`tests/cli-e2e.test.ts`。
