# 路线图

**当前平台范围：CLI 仅支持 macOS。所有当前里程碑的开发、测试、验收与分发均以 macOS 为目标。Linux / Windows 支持暂缓，只有明确扩展平台范围后才启动，不作为 M3 或其他当前里程碑的验收条件。**

原则：每个里程碑结束时都应是**可运行、可验证**的，不做「只有骨架」的交付。

## M0 · 设计对齐（已完成）

- [x] 架构、Agent 循环、工具、安全、配置、会话管理、TUI 文档
- [x] 确定默认 Provider 协议：Anthropic Messages；预留 OpenAI Responses；模型名由配置提供
- [x] 确定路由模型：route + target，支持 failover / weighted / round-robin
- [x] 确定沙箱在 macOS / Linux 上的降级行为：Seatbelt / Landlock，内核能力缺失时降级并告警，其他平台禁用 `--full-auto`
- [x] 确定 sessiond 边界：单写者会话存储 + 跨 CLI 查询，不执行模型与工具
- [x] 确定 TUI 选型：Node + 自研 Terminal；Rust 仅作为性能兜底

**完成标志**：文档评审通过，接口定义无重大争议。设计文档已作为 M1 实现基础。

## M1 · 最小可用循环（已完成）

目标：能在一个真实仓库里完成「读文件 → 改文件 → 跑测试」的闭环。

- [x] 项目脚手架：TypeScript strict、ESM、tsup 构建、Vitest、`bin/codingx.js`
- [x] `Provider` 接口 + Anthropic Messages 实现（流式、tool use、prompt caching）
- [x] `ProviderRouter` 单目标实现，为后续多 Provider 路由留接口
- [x] Agent 循环（单 turn、串行工具、无压缩）
- [x] 工具：`Read`、`ListDir`、`Edit`、`Shell`
- [x] 纯文本输出（`--plain`），无 TUI
- [x] `SessionStore` 接口 + 进程内实现，rollout 写入 JSONL（单写者）
- [x] 额外交付：逐行交互模式、`--json` 事件流、`codingx log` 离线回放

**验收**：`codingx exec "把 src/util.ts 里的 foo 重命名为 bar 并跑测试"` 能端到端完成，rollout 可回放。

自动化验收已通过：本地假 Anthropic SSE 服务驱动 Read → Edit → Shell → 最终回答，验证文件修改、退出码、JSON 事件流与 rollout 回放。真实 Provider 需要配置 API Key 后手工冒烟，未纳入 CI。

**M1 实现偏差**（接口已留出，后续里程碑补齐）：

- Sessiond 未实现，M1 使用带文件锁的进程内 JSONL 存储；`sessiond.enabled = true` 会告警并退回嵌入式存储。
- 多目标路由未实现；M1 要求 route 收敛到单个 target，多目标配置会明确报错而不是静默忽略。
- 审批与 OS 沙箱属于 M3；M1 的 `Shell` 以当前用户权限运行，仅做 workspace 路径约束。
- TUI、上下文压缩、resume/fork 属于 M2；M1 提供逐行纯文本与 `codingx log`。
- MCP、WebFetch、自定义工具、OpenAI Responses 属于 M4；相关配置会被忽略并告警。

## M2 · 交互体验（核心与验收完成；mention/session picker/表格 holdback/背压列为 M2.1）

- [x] 输入历史与会话按真实 cwd 隔离存储及查找；子目录独立、符号链接共享，旧 rollout 按 cwd 兼容读取。

目标：日常可用。

- [x] 自研 Terminal：alt screen / raw mode、cell buffer、ANSI 差分、输入解析、resize、异常恢复
- [x] 布局与 widgets：welcome、transcript viewport、composer、status/footer、固定键位（CLI 接入在 E6）
- [ ] 消息单元：user/assistant、exec、diff、plan、notice；流式 markdown/diff 已完成，表格 holdback 与 30fps 节流待补
- [ ] 交互：排队/transcript overlay/slash 补全/`/clear`/`/model`/AskUserQuestion 提问面板/`!` 本地命令已完成；mention、审批、session picker 待补
- [x] 推理强度：CLI / 环境变量 / TOML 默认值、运行时 `/model --effort`、TUI 档位提示及 resume/fork 恢复
- [x] cwd 交互偏好：模型/Provider/route/effort 与权限 profile 按目录保存，CLI/env 临时覆盖，旧会话不覆盖最新目录选择
- [x] `/model` 手动跨 Provider 切换：所有已配置模型候选、按需加载凭证、原子保存选择、恢复 Provider/route；自动多目标路由仍属 M5
- [x] CJK/emoji、宽字符与 80x24 / 120x40 布局（PTY 冒烟通过）
- [x] 上下文压缩：截断 → 丢弃 → 模型摘要（三级已完成）
- [x] 会话 resume / fork（sessiond 启用时通过 IPC/租约）
- [x] sessiond 常驻进程：Unix socket + JSON-RPC、写租约、会话索引、client、自动拉起、空闲退出
- [x] 跨 CLI 查询：`codingx sessions list/show/watch/prune`
- [x] 工具：`Glob`、`Grep`、`Write`、`ApplyPatch`、`UpdatePlan`、`Skill`、`AskUserQuestion`
- [x] CLI 中断与取消（`Ctrl+C` 首次中断；双击退出；`--continue` 续接）
- [x] TUI 中断键位（`Esc` / `Ctrl+C`）

**验收**：连续进行 30 轮以上对话不因上下文超限中断；中途 `Ctrl+C` 后 `--continue` 能接上；两个终端能看到同一会话状态且写租约互斥；80x24 / 120x40 核心流程可用，流式不闪烁，resize 后锚点稳定。当前 30 轮压缩、Ctrl+C 续接、双 CLI 租约、TUI 帧/按键预算均有自动测试；80x24/120x40 + CJK/emoji + resize 有 PTY 冒烟。

## M3 · 安全（M3.0 设计完成，M3.1 策略内核、M3.2 审批交互与 M3.3 macOS Seatbelt 已落地）

目标：可以放心在真实项目上跑。

- [x] 权限模型设计：Permission profile × Approval policy × Approvals reviewer × sandbox backend，已对照 Codex 0.153.x 校准；见 [permissions.md](permissions.md)
- [x] Permission profiles：`:read-only` / `:workspace` / `:workspace-git-hooks` / `:danger-full-access` + 命名 profile、文件系统规则（S1 文件工具 + S3 macOS Seatbelt；域名级网络规则待 S6）
- [x] Approval policy：`on-request` / `never` + 非交互 fail closed（S1）；`approvals_reviewer` 接口保留，自动审查待 S7
- [x] Action 规范化 + 基础硬拒绝/Shell tokenizer（S1）
- [ ] exec policy 规则、提权重试（S5）；会话/前缀授权已由 S2 完成
- [x] TUI/plain 审批弹层、会话/前缀授权、`/permissions` 列表/切换、profile 状态行与断线/写租约语义（选择器 overlay 与长命令支持 v 全屏查看）
- [x] macOS Seatbelt：默认 deny、profile 写根、凭证/密钥路径拒绝、网络默认 deny、`sandbox.denied` 审计与降级保护（S3）
- [x] Agent Harness hooks MVP：全局 `[[hooks]]` 六个生命周期事件、JSON stdin、matcher、exit 2 阻止、`hook.finished` 审计；项目配置不能定义 hooks
- [x] Git hooks：仓库 hooks 默认执行；`.git/hooks` / `.git/config` 写入默认 deny，`:workspace-git-hooks` 或 `:git_hooks` / `:git_config` 显式 opt in 并告警
- [ ] 网络代理与域名白名单（S6）
- 暂缓：Linux Landlock + seccomp（S4）与 Windows 沙箱；不属于当前 macOS 交付范围
- [x] `--yolo` / `--allow-dangerously-skip-permissions` 映射到 `:danger-full-access` + `never` 并告警；macOS 无 `sandbox-exec` 时拒绝启动（S1/S3；Linux S4 待做）
- [ ] sessiond 本地 IPC 加固（0700 / 0600、peer UID、项目配置禁改 socket、事件二次脱敏）
- [ ] TUI 不可信输出脱敏（ANSI / OSC / 控制字符）与审批弹层防伪造
- [x] 环境变量白名单、凭证脱敏（M1 已提前实现）
- [x] 审计视图：`codingx log --session <id>`（M1 已提前实现）
- [x] `permission.decision` / `approval.requested` / `approval.decided` / `permission.granted` / `profile.changed` / `sandbox.denied` 审计

**验收**：macOS 默认配置下，文件工具与 Shell 的越界写入、凭证读取和默认联网都已被拦截且原因对模型可见；交互审批、会话/前缀授权、非交互 fail closed 与 `sandbox.denied` 已有测试。**网络代理/域名白名单、exec policy 与自动审查仍未完成**，因此 M3 整体验收尚未达成，剩余工作见 [implementation-plan-m3.md](implementation-plan-m3.md)。

**设计**：[permissions.md](permissions.md)。**任务拆分**：[implementation-plan-m3.md](implementation-plan-m3.md)。

## M4 · 扩展性

- MCP 客户端（stdio + SSE），动态注册外部工具
- 自定义工具加载（`~/.codingx/tools/`）
- 联网工具 `WebFetch`（默认关闭，`[web]` 域名白名单 + 仅 https）
- 第二个 Provider：OpenAI Responses 协议
- [x] `AGENTS.md` 多层级加载（M1 已提前实现）
- 配置热重载（仅限非会话中）
- TUI 打磨：复制/导出、transcript raw 模式、性能优化、可访问性

## M5 · 进阶能力

- 子 Agent（`Task` 工具，独立上下文）
- [x] 长驻进程基础管理提前落地：`ProcessStart / ProcessList / ProcessRead / ProcessStop`，会话内跨 turn 存活、日志游标、进程组回收（见 [Process](processes.md)）
- 长驻进程增强：PTY / stdin 交互、跨 CLI 托管（原 `ShellInteractive` 的剩余范围）
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
| 应用层 resize reflow | 已接入主屏幕原生 scrollback；已归档历史的重排由终端处理，当前视口由 TUI 重绘 |
| Codex 逐像素复刻（pets / plugins / voice） | 先对齐信息架构与核心交互 |
| TUI 认证 / 配置 / 主题选择器 | TUI 只做终端与交互，这些不属于核心 |
