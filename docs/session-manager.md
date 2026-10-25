# Session Manager

`sessiond` 是 codingx 的本地会话管理进程：每个用户、每个 `CODINGX_HOME` 一个，常驻在本机，持有会话注册表、rollout 写句柄与写租约。CLI 通过本机 IPC 与它通信，因此不同终端里的 CLI 能看到同一份会话状态。

它解决三个问题：

- **单写者**：同一会话的 rollout 只由 sessiond 追加，避免两个 CLI 同时 resume 造成交错写入。
- **跨 CLI**：`sessions list/show/watch` 查询的是 daemon 的实时状态，而不是各自扫描文件。
- **崩溃可解释**：CLI 断开时，daemon 释放租约并把进行中的 turn 标记为 `interrupted`，而不是留下一个永远 `running` 的幽灵会话。

边界是刻意的：**sessiond 不调用模型、不执行工具、不处理审批**。这些仍发生在 CLI 进程内，daemon 只做会话状态与持久化的权威。

## 进程模型

```text
┌──────────┐        UDS + JSON-RPC         ┌──────────────────┐
│ CLI A    │◄─────────────────────────────►│ codingx-sessiond │
│ (writer) │                               │  注册表 / 租约    │
└──────────┘                               │  append / 广播    │──► sessions/*.jsonl
┌──────────┐                               │  索引 / 清理      │──► sessions/index.json
│ CLI B    │◄─────────────────────────────►│                  │
│ (observe)│                               └──────────────────┘
└──────────┘
```

- CLI A 持有会话的写租约；CLI B 只订阅，不写。两者看到同一份状态。
- daemon 不保留完整对话在内存里：元数据与订阅缓冲在内存，事件从 JSONL 读取。
- 单实例：`run/sessiond.lock` 上的文件锁保证每个 `CODINGX_HOME` 只有一个 daemon；`run/sessiond.json` 公布 `{ pid, socket, protocol, version, startedAt }`。
- CLI 首次需要会话服务时自动拉起 daemon（`codingx sessiond run --daemon`，复用同一个单文件可执行体，不从 PATH 解析）；也可手动 `codingx sessiond start|stop|status|restart`。
- daemon 的 cwd 固定为 `CODINGX_HOME`，不占用任何仓库目录；启动环境只保留 `PATH`、`HOME`、`LANG`、`TMPDIR`、`CODINGX_HOME`、`CODINGX_SESSIOND_SOCKET` 等最小集合。
- 没有连接且没有租约超过 `idle_timeout_seconds` 时自动退出；下次查询会重新拉起并从磁盘重建索引。

## 通信

- 传输：Unix domain socket，默认 `~/.codingx/run/sessiond.sock`；目录 `0700`，socket `0600`。Windows 使用命名管道（`\\.\pipe\codingx-sessiond-<hash>`），不使用 TCP。
- 帧格式：NDJSON，每行一个 JSON-RPC 2.0 消息；单帧上限 8 MiB，单事件上限 1 MiB。
- 握手：客户端先发 `initialize`，带上 `{ protocol: 1, client: { name, version, pid } }`；daemon 返回 `{ protocol, version, pid, startedAt, sessionCount }`。协议不匹配时返回 `PROTOCOL_MISMATCH`，客户端提示 `codingx sessiond restart`，不做静默降级。
- 认证：连接建立时校验对端 UID（Linux `SO_PEERCRED`、macOS `LOCAL_PEERCRED`）；Windows 由命名管道 ACL 限制当前用户；Unix 下连接前 lstat socket，要求属主为当前用户且权限为 `0600`。
- 客户端超时：普通请求 10s；`session.append` 30s；超时按可重试处理，事件带 `eventId` 保证幂等。

### 方法

| 方法 | 说明 |
| --- | --- |
| `daemon.status` | 进程信息、会话数、连接数、实际 socket 路径 |
| `daemon.shutdown` | 优雅退出；有活动租约时拒绝，除非 `force` |
| `session.create` | 创建会话（`requestId` 幂等），写 `session.start` 头，向当前连接授予写租约，返回 id 与文件路径 |
| `session.list` | 按更新时间列出会话摘要，支持 `cwd` / `status` / `limit` / `cursor` |
| `session.get` | 单个会话的元数据、状态、客户端、最近事件序号 |
| `session.attach` | 申请 `write` 或 `observe` 连接；`write` 排他，附着到 `interrupted` 会话时写 `session.resumed` |
| `session.detach` | 主动释放；连接关闭时自动等价执行。进行中的 turn 应先写 `turn.aborted`，否则按断连处理 |
| `session.heartbeat` | 续租；写租约每 5s 一次，TTL 15s |
| `session.append` | 追加一批事件，daemon 分配 `seq`、脱敏、fsync、广播 |
| `session.replay` | 从 `fromSeq` 读历史事件，分页返回 |
| `session.subscribe` | 从 `fromSeq` 订阅实时事件与状态变化 |
| `session.fork` | 在指定 `seq` 复制为新会话（`requestId` 幂等），写新的 `session.start` 头并向当前连接授予写租约；仅非 `running` / `awaiting_approval` 会话可 fork |
| `session.end` | 显式结束会话，写 `session.end`；需要写租约，仅 `idle` / `interrupted` 可结束，结束后拒绝写租约 |
| `session.prune` | 按保留期清理已结束 / 已中断会话，活动会话永不清理 |

通知由 daemon 主动推送：`session.event`（新事件）、`session.status`（状态变化）、`session.lease_revoked`（租约被接管）、`session.lagged`（订阅积压断开）。

幂等：`session.create` / `session.fork` 带客户端 `requestId`，写入 `session.start` 头并随索引重建，重复请求返回同一个会话；若原连接已断，响应不带租约，客户端需 `attach`。`session.append` 用 `eventId` 去重，去重缓存从每个会话尾部事件重建，daemon 重启后仍能吸收重试。

```json
→ {"jsonrpc":"2.0","id":7,"method":"session.list","params":{"limit":20}}
← {"jsonrpc":"2.0","id":7,"result":{"sessions":[{"id":"550e8400-e29b-41d4-a716-446655440000","status":"running","cwd":"/Users/red/work/api","model":"model-name","clients":1,"updatedAt":"2026-10-25T02:41:09Z"}]}}
```

## 会话模型

- 新会话 ID 为 UUID v4，例如 `550e8400-e29b-41d4-a716-446655440000`；命令接受唯一前缀。旧的 12 位 base36 ID 仍可读取。
- 文件名为 `<timestamp>_<id>.jsonl`，时间戳中的 `:` 替换为 `-`；首行是 daemon 写入的 `session.start`。
- `sessions/index.json` 是元数据缓存，启动时按文件头与尾部事件校验，损坏或缺失时从 JSONL 重建；JSONL 永远是事实来源。
- 旧版本没有 `session.start` 头的文件仍可读：daemon 用文件名与首个事件补全内存元数据，不修改旧文件，后续事件继续追加。
- `ended` 会话不可再 resume，只能 `--fork` 出新的会话。

### 状态

| 状态 | 含义 |
| --- | --- |
| `idle` | 没有进行中的 turn，可 resume |
| `running` | 模型请求或工具执行中 |
| `awaiting_approval` | 等待持有写租约的 CLI 完成审批 |
| `interrupted` | turn 进行中写租约丢失（CLI 崩溃 / daemon 重启），需要人工 resume |
| `ended` | 显式结束，只读 |

状态由事件与租约共同推导，不做独立持久化字段；daemon 重启后按最后一条 `turn.*` / `session.*` 事件重算。`clients` 与 `writer` 是独立字段，不参与状态机。`session.resumed` 把 `interrupted` 复位为 `idle`，但保留中断事件用于审计。

### 事件

rollout 每行是一个带信封的事件：

```ts
interface RolloutEvent {
  seq: number;          // daemon 分配，会话内单调递增
  ts: string;           // RFC 3339
  type: string;
  eventId: string;      // 客户端或 daemon 生成，用于重试去重
  [key: string]: unknown;
}
```

关键事件：

| 事件 | 写入方 | 用途 |
| --- | --- | --- |
| `session.start` | daemon | 会话头：cwd、model、provider、createdAt、cliVersion、requestId、forkedFrom |
| `user.message` | CLI | 用户输入，resume 与审计都需要 |
| `turn.start` | CLI | turn 开始，状态切到 `running` |
| `turn.status` | CLI | `streaming` / `executing` / `awaiting_approval` |
| `assistant.message` | CLI | 最终助手消息与 tool calls |
| `tool.call` / `tool.result` | CLI | 工具调用与结果 |
| `context.compacted` | CLI | 压缩记录，保留原始消息 |
| `turn.end` / `turn.aborted` | CLI | turn 收敛或中断 |
| `session.interrupted` | daemon | 写租约丢失且 turn 未收敛 |
| `session.resumed` | daemon | 写租约重新附着，状态复位为 `idle` |
| `session.end` | daemon | 会话显式结束 |

daemon 只校验信封与大小；`session.start` / `session.interrupted` / `session.resumed` / `session.end` 是保留事件，只能由 daemon 写入；未知事件类型原样落盘但不参与状态推导，保证 CLI 升级不与旧 daemon 卡死。

## 写租约与并发

- `session.attach { mode: "write" }` 获取排他写租约；`observe` 可多客户端共享，不写。
- 写租约绑定连接：连接关闭立即释放；daemon 每 5s 收到 heartbeat，15s 未续租则强制回收。
- `session.append` 必须带 `leaseId`；租约被回收或接管后返回 `LEASE_REVOKED`，旧 CLI 必须停止写入并退出当前 turn。
- append 以单事件为原子单位；批内已落盘事件不会因后续失败回滚，客户端按 `seq` 与 `eventId` 重试。
- 接管：`--takeover` 只在 `idle` 时允许；如果存在进行中的 turn，返回 `SESSION_BUSY`，提示用 `sessions show/watch` 观察或等待。
- 接管成功后 daemon 向旧客户端推 `session.lease_revoked`，旧客户端不得再 append；新客户端必须从 `seq` 回放后再继续。
- 慢订阅者积压超过 1000 条事件时被断开并收到 `session.lagged`；客户端从最后已确认的 `seq` 重连，daemon 不做无界缓冲。

## 崩溃与恢复

| 场景 | 行为 |
| --- | --- |
| CLI 正常退出 | 连接关闭，租约释放；无进行中 turn 则保持 `idle` |
| CLI 被 SIGKILL / 网络断 | daemon 释放租约；若有未收敛 turn，追加 `session.interrupted` 并置为 `interrupted` |
| daemon 崩溃 | CLI 的 append 失败，立即中止当前 turn；`exec` 以非零码退出，交互模式提示 daemon 不可用后退出。重启后扫描到未收敛 turn，同样标记 `interrupted` |
| 机器重启 | 同 daemon 崩溃；socket 与 lock 为陈旧文件，下一次启动在持锁状态下清理 |
| 写入中途崩溃 | 只保留最后一个完整换行前的内容；尾部半行在启动时截断 |
| 协议版本不匹配 | CLI 报错并要求 `codingx sessiond restart`；不自动杀有活动租约的 daemon |

`resume` 不自动向模型续跑。CLI 回放事件后，如果最后 turn 有 `tool.call` 没有对应 `tool.result`，先补写一条 `is_error: true` 的合成结果（`synthetic: true`，说明「会话在工具执行 / 审批期间中断」），让消息历史保持结构完整；随后回到 idle，等待用户输入。`fork` 与 `resume` 一样处理悬空 tool.call，复制到新会话后补写合成结果。

CLI 与 daemon 断连时**不允许**退回本地直接写文件：否则会破坏单写者假设。只有在 `sessiond.enabled = false` 的显式嵌入式模式下，CLI 才使用带文件锁的本地存储。

## CLI 体验

```bash
# 终端 A：正常开始一个会话
codingx

# 终端 B：查询、观察终端 A 的会话
codingx sessions list
codingx sessions show 550e8400-e29b-41d4-a716-446655440000
codingx sessions watch 550e8400-e29b-41d4-a716-446655440000

# 接管一个空闲会话；运行中的会话会拒绝
codingx resume 550e8400-e29b-41d4-a716-446655440000 --takeover

# 回放任意历史会话；直接读 JSONL，不依赖 daemon
codingx log --session 550e8400-e29b-41d4-a716-446655440000
```

- `sessions list` 默认显示最近 20 个未结束会话，列：ID、状态、cwd、模型、更新时间、客户端数；`--all` 包含已结束，`--json` 输出机器可读结果。
- `sessions show <id>` 显示元数据、最后 20 条事件、当前 writer/observers；`--json` 同样可用。
- `sessions watch <id>` 只读订阅，不获取写租约；收到的是 turn 级事件（状态、工具调用、最终消息），不包含 token 级流式文本——流式文本只在 writer CLI 的 TUI 中实时渲染。审批仍只能在 writer CLI 里完成。
- `resume` / `--continue` 会获取写租约；失败时给出 `sessions show`、`sessions watch`、`--takeover` 三个下一步提示。
- `codingx exec` 创建会话、结束时写 `session.end`，因此不会留下可 resume 的半成品；需要继续探索时用 `--fork <id>` 从历史会话分叉。
- `codingx sessiond status --json` 返回 pid、socket、协议版本、会话数、连接数、启动时间；`stop` 默认拒绝在有活动租约时退出，`--force` 会断开客户端并把进行中的 turn 标记为 `interrupted`；`restart` 同样遵循这个规则。
- `sessions list --offline` 只读扫描 JSONL；`codingx log` 始终直接读 JSONL，不依赖 daemon。两者都忽略尾部半行，且没有实时状态。

## 配置

```toml
[sessiond]
enabled = true               # false 时退回进程内存储，无跨 CLI 查询
socket = "~/.codingx/run/sessiond.sock"
autostart = true
idle_timeout_seconds = 1800  # 无连接且无租约时退出；0 表示常驻
log = "~/.codingx/logs/sessiond.log"
```

- 整个 `[sessiond]` 段与 `session.dir` / `retention_days` 只允许来自全局配置或环境变量；项目配置不得覆盖，避免克隆来的仓库把 CLI 指向恶意 socket 或改写存储位置。
- 环境变量：`CODINGX_SESSIOND_SOCKET` 覆盖 socket 路径；`CODINGX_SESSIOND=0` 关闭 daemon（等价 `enabled = false`）。
- Unix socket 路径超过平台上限（macOS 约 104 字节）时，daemon 回退到 `$TMPDIR/codingx-<uid>/sessiond.sock`（目录 `0700`），并把实际路径写入 `run/sessiond.json`。
- 嵌入式模式仍对会话文件加 `flock`，保证单个 CLI 进程内不会双写；CLI 不会自动拉起 daemon，`sessions list` 等同 `--offline`，没有跨 CLI 实时状态。

## 安全

- 只监听本机 socket，不监听 TCP；目录 `0700`、socket `0600`、`sessiond.json` / 会话文件 / `index.json` 均为 `0600`。
- 对端 UID 校验 + socket 属主/权限校验；其他用户无法查询或写入会话。
- daemon 启动时清空 `API_KEY` 等凭证变量，不读取 `auth.json`，不加载项目配置，不执行仓库代码。
- CLI 发送前与 daemon 落盘前各做一次脱敏；命中常见 API Key / token 模式时替换为 `[REDACTED:<kind>]` 并标记 `redacted: true`，CLI 收到告警。
- 沙箱默认把 `~/.codingx`、`session.dir` 与 sessiond 实际 socket 目录列为不可读，工具子进程也拿不到 `CODINGX_SESSIOND_SOCKET`，避免模型诱导工具读取历史或直接操作 socket。
- daemon 日志只记录连接、租约、append 的元数据，不记录 prompt、工具输出与文件内容。
- 资源上限：最多 64 个并发连接；单帧 8 MiB、单事件 1 MiB；订阅缓冲 1000 条；超限断开而不是拖垮 daemon。

同 UID 的本地进程仍视为可信：`0600` 与 peer 校验只隔离其他用户，不防御已在本用户权限下执行的恶意代码——这类代码本来就能读 `~/.codingx`。

## 可测试性

- 用临时 `CODINGX_HOME` 启动真实 daemon，配合脚本化客户端覆盖协议、租约、订阅与清理。
- 故障注入：SIGKILL CLI / daemon、半行写入、重复 `eventId`、慢订阅者、租约过期、接管竞争。
- 协议兼容：旧 CLI 连新 daemon、新 CLI 连旧 daemon 都必须得到明确错误，而不是行为漂移。
- 跨 CLI 场景作为集成测试：两个客户端看到同一状态，写租约互斥，观察者不阻塞 writer。

## 非目标

- 不做远程 / 多用户服务，不做跨机器同步；sessiond 只服务本机同一用户。
- 不在 daemon 内执行 agent loop、模型请求或工具；那会把审批、沙箱与凭证边界整体搬进一个常驻进程，超出本设计范围。
- 不做通用消息总线、插件宿主或 GUI 后端。
