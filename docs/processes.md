# 受管进程（Process）

本次将 M5 的长驻进程管理提前拆出实现，采用 `ProcessManager` 与
`ProcessStart / ProcessList / ProcessRead / ProcessStop`，替代原计划的
`ShellInteractive` 基础能力。PTY 与 stdin 已由 P0–P2 增量实现；自动重启和跨 CLI 托管仍不在本次范围。

## 接入任务

- 执行层：稳定 processId、独立进程组、有界日志、等待、TERM → KILL、并发数量上限。
- 工具层：zod 入参；启动复用 Shell 权限、审批、沙箱与环境白名单；其余操作只访问本会话句柄。
- 生命周期：CLI 内存持有真实状态；跨 turn 存活；clear 和关闭时回收；通过 SessionStore 记录状态事件。
- 验收：本地服务跨调用访问、失败启动、输出截断、退出/终止、后代清理、权限拒绝、会话关闭和恢复边界。

## 状态与归属

`starting → running → stopping → exited`；自然退出也可直接从 running 进入 exited；
无法启动为 failed。非零退出仍为 exited，通过 exitCode/signal 区分。
running 仅表示进程已启动，不表示服务已就绪；调用方通过本地 HTTP 等方式检查就绪。

ProcessManager 属于一个 AgentLoop/CLI 会话，不绑定单次 turn 的 AbortSignal。
停止当前 turn 不会停止已经启动成功的服务。ProcessRead 的取消仅取消等待。
正常退出、`/clear`、`codingx exec` 完成时回收进程组。恢复或 fork 会话不会根据
rollout 中的 PID 重新接管进程；旧 processId 在新的运行实例中无效。
sessiond 仍只负责会话持久化，不执行进程。

原始环境变量不进入进程快照/事件。日志按需读取，不将持续输出自动注入模型上下文。
后台命令应以前台方式运行（例如 `python3 -m http.server 8000 --bind 127.0.0.1`），
不要使用 `&`、nohup 或自行 daemonize；管理器负责后台运行。

## 工具使用

用户可以在 plain 或 TUI 中直接输入配套命令，无需调用模型：

```text
/process                         查看列表（等价于 /process list）
/process logs <processId>        查看最近 8,000 字符日志
/process logs <processId> 1234   从指定游标增量读取
/process stop <processId>        停止进程组
/process help                    查看用法
```

processId 支持唯一前缀；有歧义时要求输入更长的前缀，不接受 OS PID。
`/process read` 是 `logs` 的别名。列表包含状态、PID 和启动命令；日志页末尾给出
下一次读取命令。查询与日志展示不进入模型历史，停止仍通过 ProcessManager 记录生命周期事件。
TUI 支持 `/pro` + Tab 补全，并可在模型执行期间查看或停止已有进程。

| 工具 | 入参 | 返回 |
| --- | --- | --- |
| ProcessStart | command、可选 cwd / description / network（inherit 或 local） | processId、state、pid 等快照 |
| ProcessList | 无 | 当前 CLI 会话中的进程快照 |
| ProcessRead | process_id、可选 cursor / max_chars / wait_ms | process、output、nextCursor、truncated |
| ProcessStop | process_id | 进程组回收后的快照；重复停止安全 |

启动示例：`ProcessStart({"command":"python3 -m http.server 8000 --bind 127.0.0.1"})`。
随后用返回的 processId 读取日志或停止。`ProcessRead` 的 cursor 初始为 0，
之后传上次 nextCursor；游标以 UTF-16 字符计数。wait_ms 最多 30 秒，等待退出或到期。
stdout/stderr 按接收顺序合并；truncated 表示游标之前的日志已被缓冲区淘汰。
非零自然退出或启动失败返回 isError；主动停止通过 stopReason 表示。

默认最多 32 个活动进程，保留最近 100 个记录，每个进程保留末尾 65,536 字符。
达到活动上限需要先停止进程；历史记录满时淘汰已结束的记录。
停止先向进程组发 SIGTERM，1 秒后对仍存活的组升级为 SIGKILL。
shell 主进程自然退出时也回收组内后代，即使后代已重定向 stdout/stderr。

默认配置下，Python HTTP server、Vite、`npm run dev` 等常见服务会自动请求本机网络审批；
用户同意后启动，无需切换 profile。其他服务可用 `network: "local"` 显式申请；
`network: "inherit"` 表示只沿用 profile，不自动申请。
审批仅允许本次执行及其进程组使用本机网络，直到进程退出；不保存为 session / prefix 授权，
不改变文件隔离及后续命令的网络策略。拒绝、无审批入口或 approval_policy = "never" 时不启动。
例如 `python3 -u -m http.server 8000 --bind 127.0.0.1`；`-u` 使启动日志即时可读。
Seatbelt 的 localhost 包含本机网卡地址，并不能阻止通配监听；务必显式绑定 127.0.0.1 / ::1。
ProcessStart 返回 running 后应读取日志并验证服务就绪。
已有进程保留启动时的沙箱权限，切换 profile 不会动态改变它；需要停止后重新启动。

生命周期事件为 `process.state`，包含进程快照，通过 SessionStore 单写者追加。
正常关闭会等待这些事件写完再释放会话。TUI 的正常信号退出复用退出清理；
plain/exec 无 SIGTERM 处理器时安装回收处理器，进程 exit 钩子提供同步强制回收。
CLI 遭 SIGKILL、系统崩溃或子程序自行脱离进程组时无法保证回收；本版不声称提供
跨崩溃监管，也不会在 resume 时仅凭旧 PID 杀进程。


## PTY 与输入

`ProcessStart` 可传 `pty: true`（默认 80×24）、`cols`、`rows`。非 PTY 默认 stdin 关闭，`stdin: true` 保持管道可写；也可传初始字符串。`ProcessWrite` 在 `text`、`eof`、`interrupt`、`cols`+`rows` 中选择一项。文字不自动附加换行，模型可用 `text: "hello\n"`；本地 `/process send` 在文本末尾补一个换行以提交终端输入。

```text
/process send <id> <text>
/process eof <id>
/process interrupt <id>
/process resize <id> 120 40
```

管道 EOF 关闭 stdin；PTY EOF 发送 Ctrl+D，语义由终端应用决定。interrupt 向终端发送 Ctrl+C（管道为 SIGINT），区别于 stop 的 TERM→KILL 回收。PTY 合并 stdout/stderr；控制序列跨块过滤，输出仍脱敏。已识别的凭证输入被拒绝，不提供密码输入通道；输入审计只保留操作和字节数。

原生依赖 `node-pty` 外置，npm 安装脚本针对其 macOS spawn-helper 修复已知执行位遗漏。原生模块/启动失败明确报错，不退回无沙箱 shell。macOS Seatbelt wrapper、按次权限和代理清理路径保持一致。resume 不重建旧进程句柄。
