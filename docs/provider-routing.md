# Provider 路由

多 Provider 不只是“能配置多个”：还需要在请求级别选择目标、分摊流量、在故障时切换，并且不能破坏流式输出和 prompt cache。

## 概念

| 概念 | 含义 |
| --- | --- |
| Provider | 协议 + 端点 + 凭证，例如 `primary`、`secondary`、`local` |
| Target | `provider + model + weight`，一次请求的具体目标 |
| Route | 一组 targets + 选择策略；会话通过 route 选目标 |
| Router | 实现 `ModelClient` 接口的选路层：选择、重试、故障转移、健康状态 |

Agent 只依赖 `ModelClient` 接口；`ProviderRouter` 实现它，负责把 `stream()` 调用路由到具体 `Provider` 适配器。

运行时 `/model` 切换只更新当前 router 的 `selection.model`，不重新选择 route/provider；`ModelRequest.reasoningEffort` 由 provider 适配器映射到 wire 参数（Anthropic Messages 为 `output_config.effort`）。变更写入 `model.changed`，resume 时恢复。

## 配置

```toml
[model]
route = "default"            # 选择 route；也可用 --route / CODINGX_ROUTE

[provider.primary]
protocol = "anthropic-messages"
endpoint = "https://api.example.com"
api_key_env = "API_KEY"

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

[[routes.default.targets]]
provider = "secondary"
model = "model-name-2"
weight = 30
```

- `weight` 只在 `weighted` 下有含义；`failover` 按 targets 顺序。
- 多个 route 可共存（如 `default`、`cheap`、`failover`），通过 `--route` / `CODINGX_ROUTE` / `[model] route` 选择。
- `[provider.<id>]` 含端点与凭证，只允许全局配置；项目配置可以定义/选择 routes，但只能引用全局 provider id。

## 策略

### `failover`

按 targets 顺序选第一个健康目标；遇到可重试错误时尝试下一个。适合“主 + 备”，不关心流量比例。

### `weighted`

在健康目标之间按 `weight` 做平滑加权轮询。默认 `affinity = session`，即同一会话尽量粘在同一目标，避免每轮都丢失 prompt cache；跨会话分摊流量。

### `round-robin`

健康目标之间轮转；同样受 `affinity` 约束。

### 选择顺序

1. `--route` / `CODINGX_ROUTE` / `[model] route` 选 route
2. 过滤不健康目标
3. 按 route 策略选首选目标
4. `--provider` 把候选限制到指定 provider；`--model` 覆盖目标 model
5. 请求失败时在剩余健康目标中 failover

如果 `--provider` 或 `--model` 把候选收窄到单个目标，就不再跨 Provider failover；这是显式 pin。

## 故障转移窗口

**只在第一个可见内容事件之前允许透明 failover。**

- `text.delta` 或 `tool.call` 一旦发出，就不再切换 Provider：否则用户会看到重复文本，或工具调用被执行两次。
- 失败发生在连接、首包、首个内容事件之前：记录目标失败，切到下一个健康目标，最多 `max_attempts` 次。
- 失败发生在内容之后：中止当前 turn，向用户报错；是否重试由用户或上层新 turn 决定。
- `countTokens` 等无副作用的调用可以正常重试。

这个边界必须由 router 强制执行，不能依赖 Provider 适配器各自实现。

## 健康与熔断

- 连续失败达到 `failure_threshold` 后，目标进入 unhealthy，冷却 `cooldown_seconds`。
- 冷却后进入 half-open：只放一个探测请求；成功恢复，失败继续冷却。
- 429 带 `Retry-After` 时，目标至少冷却到该时间；不计入普通失败阈值。
- 所有目标都不可用时返回 `NO_HEALTHY_PROVIDER`，不在客户端里无限重试。
- 健康状态只在内存中，进程重启后重置；不做跨机器共享。

## 重试归属

Provider 重试和故障转移统一由 `ProviderRouter` 负责：

- Agent 层不再包 `withRetry`，避免“router 重试 × agent 重试”放大请求。
- `max_attempts` 是整个请求的总预算，不是每个 Provider 各试 3 次。
- 网络错误、408、429、5xx 可重试；鉴权失败、参数错误、内容策略拒绝不重试。
- 退避用于同一目标；切换到下一个目标时立即尝试，除非目标被 429/熔断冷却。

## 会话粘性与 prompt cache

- `affinity = session`（默认）：同一会话的首选目标固定，直到该目标不健康或用户 pin 了别的目标。
- `affinity = turn`：每个 turn 重新选，负载更均匀，但跨 turn 的 prompt cache 可能失效。
- `affinity = none`：每次请求重选；只建议在明确不需要 cache 的场景使用。
- failover 到另一个 Provider 后，新目标没有原 Provider 的 cache；这是故障转移的代价，不额外补偿。

## 可观测性

路由决策写入 rollout，便于审计：

- `provider.selected`：route、provider、model、strategy、affinity
- `provider.failover`：失败目标、错误类别、下一个目标、是否已发出内容
- `provider.health`：unhealthy / half-open / recovered

事件只记录目标 id、模型名和错误类别，不记录 API Key、完整响应或 prompt 内容。

## 安全与数据边界

- 自动 failover 会把同一份对话发给另一个 Provider；route 的 targets 必须显式列出，禁止隐式 fallback 到未配置的 Provider。
- `[provider.<id>]` 的端点与凭证只允许全局配置；项目配置不能新增 Provider 或改写 endpoint/api_key_env。
- 每个 target 使用自己的 `api_key_env`，router 不跨 Provider 复用密钥。
- 路由决策进入审计；用户可以通过 route 配置明确数据会流向哪些 Provider。

## 并发与一致性

- 路由状态（健康、权重计数）在进程内串行更新；并发会话最多看到轻微不公平，不会破坏协议。
- 一次请求内只允许一个目标在流式输出；不允许两个 Provider 同时写同一 turn。
- 工具调用一旦开始执行，失败不回滚；router 不重放已完成的 tool.call。

## 测试

- 策略单测：failover 顺序、加权分布、round-robin、健康过滤、全不健康。
- 故障注入：连接失败、首包前 5xx、首个 text 后断开、429 Retry-After、half-open 恢复。
- 粘性：session 固定、turn 重选、pin 后不跨 Provider。
- 并发：多会话同时选路，健康状态更新不互相破坏。
- 审计：selected/failover/health 事件字段完整且不含凭证。

## 参考

- 配置字段与项目配置限制见 [config.md](config.md)。
- 数据边界与凭证隔离见 [security.md](security.md)。

## 非目标

- 不做按 prompt 内容自动选模型（成本/能力路由）；v1 的自动性体现在健康检查、权重与 failover。
- 不做跨 Provider 的 prompt cache 迁移。
- 不做跨机器共享健康状态或分布式限流。
- 不做请求级成本预算或竞价路由。
