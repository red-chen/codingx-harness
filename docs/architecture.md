# 架构设计

## 分层

```text
┌──────────────────────────────────────────────────────┐
│  交互层   cli / tui                                  │  参数、渲染、按键、审批弹窗
├──────────────────────────────────────────────────────┤
│  Agent 层  agent loop / turn / context               │  编排：模型 ↔ 工具 ↔ 会话
├──────────────────────────────────────────────────────┤
│  能力层   providers / tools / mcp                    │  模型与工具的适配器
├──────────────────────────────────────────────────────┤
│  执行层   policy / sandbox / exec                    │  审批、隔离、进程管理
├──────────────────────────────────────────────────────┤
│  基础层   session / config / util                    │  持久化、配置、日志
└──────────────────────────────────────────────────────┘
```

**依赖方向自上而下，禁止反向依赖。** 上层通过接口调用下层，下层不感知上层的存在。例如 `agent` 只依赖 `Provider` 与 `Tool` 接口，不 import 具体的 Anthropic SDK 或 Ink 组件——这让 Agent 循环可以在测试里用假 Provider 驱动。

## 模块职责

### `cli/`

- 子命令：`codingx`（交互）、`codingx exec`（单次执行）、`codingx resume` / `--continue`、`codingx login`、`codingx config`、`codingx sessions list|prune`、`codingx log --session <id>`
- 参数与配置文件的合并顺序：命令行 > 环境变量 > 项目配置 > 全局配置 > 默认值
- 退出码约定：`0` 成功，`1` 任务失败，`2` 参数错误，`130` 用户中断

### `tui/`

- Ink 组件树：`<App>` 持有状态，`<Transcript>` 渲染历史，`<Composer>` 接收输入，`<ApprovalPrompt>` 阻塞等待确认
- 流式渲染：模型输出按 token 增量追加，渲染层做节流（约 16ms 合并一次），避免高频重排
- 非 TTY 或 `--plain` 时退化为逐行输出，不做光标控制，便于日志收集

### `agent/`

- `loop.ts`：外层循环，负责「调用模型 → 执行工具 → 回填结果 → 再次调用」直到模型不再请求工具
- `turn.ts`：单轮状态机，维护 turn 的起止、取消信号、用量统计
- `context.ts`：组装发给模型的 messages，处理裁剪与压缩
- `system-prompt.ts`：系统提示词模板，注入环境信息（cwd、平台、git 状态、AGENTS.md）

### `providers/`

```ts
export interface Provider {
  readonly id: string;
  stream(req: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent>;
  countTokens(messages: Message[]): Promise<number>;
}

export type ModelEvent =
  | { type: 'text.delta'; text: string }
  | { type: 'tool.call'; id: string; name: string; input: unknown }
  | { type: 'usage'; inputTokens: number; outputTokens: number; cacheReadTokens?: number }
  | { type: 'stop'; reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' };
```

首个实现是 Anthropic Messages API（原生 tool use + prompt caching），其次是 OpenAI 兼容端点。Provider 只负责协议转换，不做重试——重试在 Agent 层统一处理，保证行为一致。

### `tools/`

工具是纯函数 + 声明式 schema。注册表按名字索引，Agent 层只看到 `ToolDef` 接口，见 [tools.md](tools.md)。

### `policy/` 与 `sandbox/`

两者串联执行，缺一不可：

1. `policy` 判断「这个操作要不要问人」，输出 `allow | deny | ask`
2. `sandbox` 在操作系统层面限制「就算放行了，它能碰到什么」

详见 [security.md](security.md)。

### `exec/`

- 用 `spawn` 启动子进程（`shell` 工具的命令串交给 `bash -lc` 解析），绑定独立进程组，超时后 `SIGTERM` → 5s → `SIGKILL` 整组回收
- stdout / stderr 有界缓冲，超出 `tools.max_output_chars` 时按截断策略处理
- 只注入 sandbox 计算后的环境变量白名单，凭证类变量不进入子进程

### `mcp/`

- MCP 客户端（stdio / SSE），连接配置中的外部 Server，并把工具注册进 `ToolRegistry`
- 单个 Server 连接失败只影响它自己的工具，不阻断启动；会话结束统一关闭

### `session/`

- 每个会话一个文件：`~/.codingx/sessions/<timestamp>_<id>.jsonl`，时间戳中的 `:` 替换为 `-`（如 `2026-10-24T15-20-01_a1b2c3.jsonl`）
- append-only，写入即 flush；进程崩溃后仍可恢复到最后一个完整事件
- `resume` 读取 rollout 重建消息历史；`fork` 复制到新文件并追加分叉点

### `config/`

配置来自四层，后者覆盖前者：全局 `~/.codingx/config.toml` → 项目 `.codingx/config.toml` → 环境变量 → 命令行。详见 [config.md](config.md)。

## 一次 Turn 的数据流

```text
用户输入
   │
   ▼
context.assemble()          # 系统提示 + 历史 + 用户输入 + 工具定义
   │
   ▼
provider.stream()           # SSE 流式返回
   │  ├─ text.delta ──────► tui 增量渲染
   │  └─ tool.call ───────► 收集待执行调用
   ▼
policy.evaluate()           # allow / deny / ask
   │  └─ ask ─────────────► tui 弹出审批，等待用户
   ▼
sandbox.wrap() + exec()     # 在隔离环境执行
   │
   ▼
session.append()            # 写入 tool.call / tool.result
   │
   ▼
回填 tool_result → 再次 provider.stream()（循环）
   │
   ▼
stop: end_turn              # 本轮结束，等待下一次用户输入
```

## 并发与取消

- 一次 turn 只有一个 `AbortController`，用户按 `Esc` / `Ctrl+C` 触发 abort，向下传导到模型流与子进程
- 工具调用默认串行执行；只读工具（`read_file`、`grep`、`glob`）可标记 `parallelSafe`，同批并发，写工具强制串行
- 子进程用 `spawn` 而非 `exec`，绑定 `detached: true` 以便超时时整组 kill

## 错误处理

| 错误类型 | 处理 |
| --- | --- |
| 网络 / 5xx / 429 | 指数退避重试，最多 3 次，尊重 `Retry-After` |
| 上下文超限 | 触发压缩，压缩后重试一次；仍失败则中止并提示 |
| 工具执行失败 | 不抛出，作为 `tool_result` 的 `is_error` 回填给模型自纠 |
| 用户中断 | 写入 `turn.aborted` 事件，保留已完成部分 |
| 未捕获异常 | 写入 rollout 后退出，退出码 1 |

## 可测试性

- Agent 循环对 Provider 和 Tool 都是接口依赖，单元测试用脚本化的假 Provider 即可覆盖完整 turn
- 沙箱与审批层可替换为空实现（`--yolo` 仅用于测试环境），保证 CI 无需交互
- TUI 组件通过 Ink 的 `ink-testing-library` 做快照测试
