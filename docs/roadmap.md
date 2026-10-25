# 路线图

原则：每个里程碑结束时都应是**可运行、可验证**的，不做「只有骨架」的交付。

## M0 · 设计对齐（当前）

- [x] 架构、Agent 循环、工具、安全、配置、会话管理、TUI 文档
- [x] 确定默认 Provider 协议：Anthropic Messages；预留 OpenAI Responses；模型名由配置提供
- [x] 确定路由模型：route + target，支持 failover / weighted / round-robin
- [x] 确定沙箱在 macOS / Linux 上的降级行为：Seatbelt / Landlock，内核能力缺失时降级并告警，其他平台禁用 `--full-auto`
- [x] 确定 sessiond 边界：单写者会话存储 + 跨 CLI 查询，不执行模型与工具
- [x] 确定 TUI 选型：Node + 自研 Terminal；Rust 仅作为性能兜底

**完成标志**：文档评审通过，接口定义无重大争议。当前文档已对齐，等待评审确认。

## M1 · 最小可用循环

目标：能在一个真实仓库里完成「读文件 → 改文件 → 跑测试」的闭环。

- 项目脚手架：TypeScript strict、ESM、tsup 构建、Vitest、`bin/codingx.js`
- `Provider` 接口 + Anthropic Messages 实现（流式、tool use、prompt caching）
- `ProviderRouter` 单目标实现，为后续多 Provider 路由留接口
- Agent 循环（单 turn、串行工具、无压缩）
- 工具：`read_file`、`list_dir`、`edit_file`、`shell`
- 纯文本输出（`--plain`），无 TUI
- `SessionStore` 接口 + 进程内实现，rollout 写入 JSONL（单写者）

**验收**：`codingx exec "把 src/util.ts 里的 foo 重命名为 bar 并跑测试"` 能端到端完成，rollout 可回放。

## M2 · 交互体验

目标：日常可用。

- 自研 Terminal：alt screen / raw mode、cell buffer、ANSI 差分、输入解析、resize、异常恢复
- 布局与 widgets：welcome、transcript viewport、composer、status/footer、固定键位
- 消息单元：user/assistant、exec、diff、plan、notice；流式 markdown、表格 holdback 与 30fps 节流
- 交互：slash/mention、审批、排队、transcript overlay、session picker；无认证/配置
- CJK/emoji、宽字符与 80x24 / 120x40 布局
- 上下文压缩（截断 → 丢弃 → 摘要 三级）
- 会话 resume / fork
- sessiond 常驻进程：Unix socket + JSON-RPC、写租约、会话索引
- 跨 CLI 查询：`codingx sessions list/show/watch`
- 工具：`glob`、`grep`、`write_file`、`apply_patch`、`update_plan`
- 中断与取消（`Esc` / `Ctrl+C` 首次中断；`Ctrl+C` 双击退出）

**验收**：连续进行 30 轮以上对话不因上下文超限中断；中途 `Ctrl+C` 后 `--continue` 能接上；两个终端能看到同一会话状态且写租约互斥；80x24 / 120x40 核心流程可用，流式不闪烁，resize 后锚点稳定。

## M3 · 安全

目标：可以放心在真实项目上跑。

- 审批策略引擎（规范化动作 + 规则匹配 + 会话记忆）
- sessiond 本地 IPC 加固（0700 / 0600、peer UID、项目配置禁改 socket、事件二次脱敏）
- TUI 不可信输出脱敏（ANSI / OSC / 控制字符）与审批弹层防伪造
- macOS Seatbelt 沙箱；Linux Landlock 沙箱
- 环境变量白名单、凭证脱敏
- `--full-auto` / `--yolo` 与降级告警
- 审计视图：`codingx log --session <id>`

**验收**：默认配置下，模型尝试写 workspace 外文件或访问网络时被拦截，且拦截原因对模型可见。

## M4 · 扩展性

- MCP 客户端（stdio + SSE），动态注册外部工具
- 自定义工具加载（`~/.codingx/tools/`）
- 联网工具 `web_fetch`（默认关闭，`[web]` 域名白名单 + 仅 https）
- 第二个 Provider：OpenAI Responses 协议
- `AGENTS.md` 多层级加载
- 配置热重载（仅限非会话中）
- TUI 打磨：复制/导出、transcript raw 模式、性能优化、可访问性

## M5 · 进阶能力

- 子 Agent（`task` 工具，独立上下文）
- `shell_interactive` 长驻进程管理
- 并行只读工具执行
- prompt cache 命中率优化（稳定前缀、工具定义顺序）
- 用量与成本统计
- Provider 路由：failover / weighted / round-robin、熔断、健康检查、会话粘性

## M6 · 分发

- npm 发布，`npx codingx` 可用
- 单文件 bundle 与启动耗时优化（目标 < 300ms 冷启动）
- sessiond 随单文件 bundle 分发与自动拉起
- 安装脚本、Homebrew formula
- CI 集成示例（GitHub Actions）

## 明确的暂缓项

以下能力不在近期范围，避免过早复杂化：

| 能力 | 暂缓原因 |
| --- | --- |
| 多 Agent 协作编排 | 主循环稳定性优先 |
| GUI / Web 界面 | 与终端优先定位冲突 |
| 自研模型路由与调度 | Harness 层不承担 |
| 插件市场 | 先有 MCP 与本地工具 |
| 跨会话长期记忆 | 先把单会话上下文做扎实 |
| 远程会话同步 / 多机共享 | sessiond 只服务本机单用户 |
| 原生 scrollback / resize reflow | 自研 Terminal 的 alt screen 已覆盖核心；需要时按 [tui.md](tui.md) 切 Rust |
| Codex 逐像素复刻（pets / plugins / voice） | 先对齐信息架构与核心交互 |
| TUI 认证 / 配置 / 主题选择器 | TUI 只做终端与交互，这些不属于核心 |
