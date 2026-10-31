# P0–P2 增量实施计划

本计划在现有 M2/M3、受管进程及未提交改动上增量实施；仅支持 macOS，不扩展 MCP、Provider 或自动 failover。

| 阶段 | 任务 | 验收 | 状态 |
| --- | --- | --- | --- |
| 1 | 文件 SHA-256 / 身份校验、写前复查、原子替换 | 外部修改、替换、删除、部分读取、多文件冲突、旧历史 | DONE |
| 1 | SessionStore 有界二进制对象、分块 IPC、检查点、/changes、/undo | fork/prune、存储失败阻止修改、冲突拒绝、审计恢复 | DONE |
| 2 | 连续只读工具并行，默认 4 | 上限、屏障、审批/hooks 顺序、中断、结果顺序 | DONE |
| 2 | HTTPS WebFetch，默认关闭 | HTML 解析、跳转重校验、公网固定 IP、解压限额、取消 | DONE |
| 3 | 结构化文件引用与图片附件 | 权限、范围/总预算、签名、快照、resume/fork | DONE |
| 3 | 空闲会话选择及切换 | 真实 cwd、租约先获取、失败保留、统一恢复 | DONE |
| 4 | node-pty、ProcessWrite 与本地命令 | stdin/EOF/interrupt/resize、沙箱、输出过滤、清理 | DONE |
| 4 | 文档与完整验收 | typecheck、test、build、npm pack、两种终端尺寸 | DONE |

撤销只覆盖专用文件工具，按 turn 聚合；恢复 Agent 修改前的内容，不回退对话。冲突不覆盖、不自动合并。多文件提交不是操作系统级事务。文件引用默认 200 行、总计 30,000 字符；图片 PNG/JPEG/WebP，单张 5 MiB、每消息 4 张。WebFetch 仅 HTTPS GET，最多 5 次跳转、30 秒、解压后 2 MiB，始终拒绝私网。PTY 继续通过 Seatbelt 与网络代理启动，原生依赖不可用时明确失败。


## 实现与兼容

- 文件工具通过 SessionStore 保存检查点对象与审计事件；对象按会话独立保存，fork 复制所引用对象，prune 只删除目标会话对象。原始内容不进入 JSONL。单对象最多 16 MiB、IPC 每块 256 KiB；同一会话未再引用的对象暂保留至该会话删除。
- 文件版本记录兼容已有纯文本历史；旧读取没有指纹时必须重新 Read。对最终完成事件写入失败的修改，可从已持久化的 ready 检查点恢复。
- `/attach` 与 TUI `@` 保存结构化引用，实际内容在发送时读取并检查权限；发送失败保留草稿，`/attach --clear` 可移除待发送附件。图片以原始字节快照保存，resume/fork 校验对象；压缩旧图像时保留文字标记。
- `/resume` 仅切换同一真实 cwd 的 idle/interrupted 会话，先获取目标写租约并验证历史；失败保留当前会话。成功切换时清理旧草稿、附件与受管进程，重建会话上下文和 UI；ended 会话需 fork。
- PTY 原生模块为外部运行依赖；安装脚本修复 macOS node-pty helper 的可执行位。继续通过原有 Seatbelt、按次权限与代理启动。纯管道执行默认行为不变，resume 不重建旧进程。

## 验收记录

自动测试覆盖文件修改/替换/删除/符号链接冲突、多文件预检、旧历史、检查点故障恢复、撤销与用户改动、对象分块/fork/prune、并发顺序/屏障/中断/hooks、HTML/重定向/DNS/解压上限/取消、中文和空格附件、图片签名与快照、会话租约、真实 macOS PTY 与 Seatbelt/代理。

2026-10-31 验收通过：`npm run typecheck`、`npm test`（81 个文件、964 项测试）、`npm run build` 与 `npm pack --dry-run --json`。发布包包含 CLI 入口和 PTY 安装脚本，不包含测试夹具或会话对象。`scripts/smoke-p0-p2.mjs` 使用本地假 Anthropic SSE 和真实 macOS PTY，在 80×24、120×40 验证文件引用、中文发送、resize、会话切换/历史恢复、退出，并验证 exec 图片的原生请求编码；两种尺寸均通过；无需真实 API Key 或外网。

## 剩余限制

撤销不覆盖 Shell/Process 修改，不自动合并冲突，不保证跨文件事务。文件引用不读取剪贴板；图片不自动压缩、转换或在终端渲染。WebFetch 不执行脚本或提供登录态、搜索、私网访问。进程仅在当前 CLI 内托管；未引入其他平台、MCP、第二种 Provider 或自动 failover。
