# 路线图

原则：每个里程碑结束时都应是**可运行、可验证**的，不做「只有骨架」的交付。

## M0 · 设计对齐（当前）

- [x] 架构、Agent 循环、工具、安全、配置文档
- [x] 确定首个 Provider 与默认模型：Anthropic Messages API，默认 `claude-opus-4-7`
- [x] 确定沙箱在 macOS / Linux 上的降级行为：Seatbelt / Landlock，内核能力缺失时降级并告警，其他平台禁用 `--full-auto`

**完成标志**：文档评审通过，接口定义无重大争议。当前文档已对齐，等待评审确认。

## M1 · 最小可用循环

目标：能在一个真实仓库里完成「读文件 → 改文件 → 跑测试」的闭环。

- 项目脚手架：TypeScript strict、ESM、tsup 构建、Vitest、`bin/codingx.js`
- `Provider` 接口 + Anthropic 实现（流式、tool use）
- Agent 循环（单 turn、串行工具、无压缩）
- 工具：`read_file`、`list_dir`、`edit_file`、`shell`
- 纯文本输出（`--plain`），无 TUI
- rollout 写入 JSONL

**验收**：`codingx exec "把 src/util.ts 里的 foo 重命名为 bar 并跑测试"` 能端到端完成，rollout 可回放。

## M2 · 交互体验

目标：日常可用。

- Ink TUI：Transcript / Composer / 状态栏 / 审批框
- 流式增量渲染与节流
- 上下文压缩（截断 → 丢弃 → 摘要 三级）
- 会话 resume / fork
- 工具：`glob`、`grep`、`write_file`、`apply_patch`、`update_plan`
- 中断与取消（`Esc` / `Ctrl+C` 传导到子进程）

**验收**：连续进行 30 轮以上对话不因上下文超限中断；中途 `Ctrl+C` 后 `--continue` 能接上。

## M3 · 安全

目标：可以放心在真实项目上跑。

- 审批策略引擎（规范化动作 + 规则匹配 + 会话记忆）
- macOS Seatbelt 沙箱；Linux Landlock 沙箱
- 环境变量白名单、凭证脱敏
- `--full-auto` / `--yolo` 与降级告警
- 审计视图：`codingx log --session <id>`

**验收**：默认配置下，模型尝试写 workspace 外文件或访问网络时被拦截，且拦截原因对模型可见。

## M4 · 扩展性

- MCP 客户端（stdio + SSE），动态注册外部工具
- 自定义工具加载（`~/.codingx/tools/`）
- 联网工具 `web_fetch`（默认关闭，`[web]` 域名白名单 + 仅 https）
- 第二个 Provider（OpenAI 兼容端点）
- `AGENTS.md` 多层级加载
- 配置热重载（仅限非会话中）

## M5 · 进阶能力

- 子 Agent（`task` 工具，独立上下文）
- `shell_interactive` 长驻进程管理
- 并行只读工具执行
- prompt cache 命中率优化（稳定前缀、工具定义顺序）
- 用量与成本统计

## M6 · 分发

- npm 发布，`npx codingx` 可用
- 单文件 bundle 与启动耗时优化（目标 < 300ms 冷启动）
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
