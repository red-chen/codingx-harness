# Agent 循环

## Turn 生命周期

```text
idle ──user.input──► assembling ──► streaming ──┬─ end_turn ──► idle
                        ▲                       │
                        │                       ├─ tool_use ──► executing ──┐
                        │                       │                            │
                        │                       └─ aborted ──► idle          │
                        └─────────tool_result 回填◄──────────────────────────┘
```

状态机是显式的，每个状态迁移都通过 sessiond 写入 rollout 事件，方便事后复现。

## 循环伪码

```ts
async function runTurn(input: string, ctx: TurnContext): Promise<TurnResult> {
  ctx.messages.push({ role: 'user', content: input });
  await ctx.session.append({ type: 'turn.start', turnId: ctx.turnId });
  await ctx.session.append({ type: 'user.message', text: input });

  for (let step = 0; step < ctx.limits.maxSteps; step++) {
    const request = await buildRequest(ctx);       // 含压缩决策
    const events = ctx.router.stream(request, ctx.signal);

    const text: string[] = [];
    const calls: ToolCall[] = [];

    for await (const ev of events) {
      if (ev.type === 'text.delta') { text.push(ev.text); ctx.ui.append(ev.text); }
      if (ev.type === 'tool.call') calls.push(ev);
      if (ev.type === 'usage') ctx.usage.add(ev);
    }

    ctx.messages.push(assistantMessage(text.join(''), calls));
    await ctx.session.append({ type: 'assistant.message', text: text.join(''), calls });

    if (calls.length === 0) return { status: 'done' };

    const results = await executeTools(calls, ctx);  // 审批 + 沙箱 + 执行
    ctx.messages.push(toolResultsMessage(results));
  }

  return { status: 'step_limit' };
}
```

`maxSteps` 默认 64（可用 `agent.max_steps` 覆盖），防止模型陷入无进展的循环。达到上限时向用户报告当前状态，而不是静默截断。

## 会话与租约

CLI 打开或 resume 会话时，通过 sessiond 获取写租约；租约随连接存在，一个会话同一时刻只有一个 writer。turn 的状态用 `turn.start` / `turn.status` / `turn.end` / `turn.aborted` 上报，sessiond 据此生成跨 CLI 可见的 `running` / `awaiting_approval` / `idle` 等状态。

审批交互只属于持有写租约的 CLI；其他终端可以用 `sessions watch` 看到 `awaiting_approval`，但不能代为批准。CLI 崩溃或被 SIGKILL 时，daemon 释放租约、追加 `session.interrupted`；resume 时按 `seq` 回放，不自动续跑未完成的 turn。协议与状态机见 [session-manager.md](session-manager.md)。

## 上下文组装

发送给模型的 messages 由四部分组成，按优先级从高到低：

1. **系统提示**：角色、工具使用规范、安全约束、输出格式要求
2. **环境上下文**：cwd、操作系统、git 分支与状态、`AGENTS.md` 内容
3. **历史消息**：按时间顺序的 user / assistant / tool_result
4. **当前输入**

系统提示本身分两段，顺序固定：

- **固定规则**（`buildSystemPromptSections().stable`）：角色、Harness 约定、工作方式、汇报要求与压缩说明。这段逐字节稳定、所有会话共用，改它等于改全局行为，因此有 token 预算 `STABLE_RULES_TOKEN_BUDGET`，超出会让测试失败。
- **会话快照**（`.dynamic`）：权限 profile 与会话范围、环境、技能目录、项目约定。每个会话只取一次，固定在尾部。

这样切分是为了保住 provider 的 prompt cache：稳定前缀在前，可能变化的内容（以及 AgentLoop 追加的压缩摘要 `# Compacted context`）在后。新增规则进固定段；只在部分会话成立的内容（`--add-dir`、`--yolo`、权限 profile）进动态段。

### 环境上下文注入

`AGENTS.md`（或 `CODINGX.md`）在仓库根目录被读取，作为项目级约定注入系统提示。多个层级时按「根目录 → 当前目录」的顺序拼接，越近的越靠后（模型的近因偏好）。

注入是**一次性快照**，会话中途文件变化不会自动重载——避免上下文在 turn 之间无故漂移。需要刷新时由用户显式触发。

### Skills

启动时依次扫描 `~/.agents/skills`、`~/.codingx/skills` 与 `<project>/.codingx/skills`（后者覆盖前者同名技能），把每个 `SKILL.md` 的 `name` / `description` 作为目录注入系统提示的 `# Skills` 段。正文不进入系统提示，模型判断任务匹配后调用 `Skill` 工具按需加载，返回正文、文件路径与 base directory。这样技能数量增长不会线性推高每轮请求的固定 token；目录本身仍是快照，新增技能需要重开会话。详见 [tools.md](tools.md#skills)。

## 上下文压缩

触发条件（满足任一）：

- 估算 token 超过模型上下文窗口的 80%
- 历史消息数超过 200 条

单条 tool_result 超过 `tools.max_output_chars`（默认 30k 字符）时由工具层独立裁剪，不触发整体压缩。

压缩策略，按顺序尝试：

1. **截断工具输出**：保留头尾各 N 行，中间标记 `[... 省略 M 行 ...]`。这一步不改动消息数量，成本最低。
2. **丢弃中间对话**：保留系统提示、最近 K 轮、以及所有「用户原始需求」消息。
3. **摘要**：调用一次模型，把被丢弃的段落压成结构化摘要（已完成事项 / 关键文件 / 未决问题），作为一条 `system` 消息保留。

压缩结果通过 sessiond 写入 rollout 的 `context.compacted` 事件，保留原始消息，只在内存视图中替换——这样 resume 时可以还原完整历史。

摘要会在后续请求中以 `# Compacted context` 追加到系统提示末尾。固定规则里已经提前告诉模型「历史可能被摘要、变短是预期行为」，避免它把压缩误判成上下文丢失而急着收尾；摘要固定在尾部，也不会打散前面的缓存前缀。

## 工具执行

```ts
async function executeTools(calls: ToolCall[], ctx: TurnContext): Promise<ToolResult[]> {
  const ordered = partition(calls, c => ctx.tools.get(c.name).parallelSafe);
  const results: ToolResult[] = [];

  // 并行批次：只读工具
  results.push(...await Promise.all(ordered.parallel.map(c => runOne(c, ctx))));

  // 串行批次：写工具按模型给出的顺序执行
  for (const call of ordered.serial) results.push(await runOne(call, ctx));

  return results;
}
```

`runOne` 内部顺序：查表 → 参数校验（zod）→ `pre_tool_use` hook → 审批 → 沙箱执行 → 结果裁剪 → `post_tool_use` hook → 追加事件到 sessiond。任何一步失败都转换成 `is_error: true` 的 `tool_result` 回填，让模型自己看到错误并纠正，而不是让整个 turn 崩掉。macOS 上 Shell 在策略放行后由 Seatbelt 包装执行；内核拒绝会带上 `sandbox` meta 与 `SANDBOX_DENIED`，AgentLoop 同时追加 `sandbox.denied` 审计事件。`user_prompt_submit` 在模型请求前、`stop` 在 turn 结束时执行；详见 [hooks.md](hooks.md)。

### 用户提问

`AskUserQuestion` 是唯一会在工具执行中途等待用户的工具。`ToolContext.ask` 由交互层注入：

- TUI：`TuiSession.ask()` 打开底部提问面板，等待 `answer` / `cancel-ask`；期间 `TurnState` 仍是 `executing`，TUI 状态行显示 `Awaiting answer`。
- `exec` 与纯文本模式没有 `ctx.ask`，工具立即返回 `is_error`，提示模型改用普通文本提问，避免阻塞 stdin。
- 用户取消返回 `is_error: true`（`meta.dismissed`），turn 继续；turn 被中断时 `ask` 以 `ABORTED` reject，与其他工具的中断路径一致。
- 问题与答案不新增事件类型，仍然通过 `tool.call` / `tool.result` 写入 rollout；resume 与 `log` 回放无需特殊处理。

## 路由、重试与故障转移

Provider 的选择、重试、failover 与熔断统一由 `ProviderRouter` 负责；Agent 不再包 `withRetry`，避免两层重试叠加。

- `max_attempts` 是单次模型请求的总预算，不是每个 Provider 各重试 3 次。
- **只在首个内容事件前 failover**：`text.delta` / `tool.call` 一旦发出，就不再切换 Provider；失败直接中止当前 turn。
- 网络错误、408、429、5xx 可重试；参数错误、鉴权失败、内容策略拒绝不重试。
- 429 的 `Retry-After` 与连续失败达到阈值的 target 进入冷却；全部不健康返回 `NO_HEALTHY_PROVIDER`。
- 默认 `affinity = session`，同一会话尽量不切换 Provider，保住 prompt cache。

完整策略、健康检查与审计字段见 [provider-routing.md](provider-routing.md)。

## 用量与成本

每个 turn 结束通过 sessiond 写一条 `turn.end` 事件，包含输入 / 输出 / 缓存命中 token 数。TUI 状态栏展示本会话累计用量与估算成本；`codingx exec` 在结束时打印到 stderr，不污染 stdout 的机器可读输出。

## 子 Agent（后续）

`Task` 工具可以派发一个独立上下文的子 Agent，用于大范围搜索或独立验证。子 Agent 有自己的 turn 循环与工具集，结果以摘要形式返回父 Agent，避免污染主上下文。子 Agent 使用独立的 session（`parent_id` 指向父会话），同样由 sessiond 管理。该能力放在 M5，先保证主循环正确。
