# TUI 设计

目标是做一套与 Codex CLI 同级、同信息架构的终端界面：欢迎卡、消息流、底部 composer、状态行、审批弹层、diff/plan 单元、会话选择器，以及一套可预期的键盘操作。

不是逐像素复刻 Codex，也不在第一版复制它的全部外围能力（pets、plugins、voice、side conversation、多 Agent 面板等）。

## 先给结论：Node + Ink

**TUI 继续用 Node + Ink，不把 codingx 改成 Rust。**

理由：

- codingx 的 agent loop、工具、审批、sessiond 都在 Node；TUI 同进程可以直接消费类型化事件，不需要再定义一套跨语言 UI 协议、再维护一个 Rust 工具链和一套平台二进制分发。
- Codex 默认使用 alternate screen，也就是全屏应用；它最复杂的“把已完成历史插入终端 scrollback、resize 时重排 scrollback”能力，并不是全屏模式必须的。Ink 自己维护一个虚拟化 viewport 就能得到同样的视觉与交互。
- Codex TUI 的体感主要来自信息层级、留白、前缀、流式节奏、状态机和键盘细节，这些是产品设计问题，不是 Rust 独有能力。
- 参考实现的 `codex-rs/tui` 约 30 万行 Rust（含测试代码），依赖 ratatui/crossterm、自研 terminal、app-server 协议；直接复刻或 fork 的成本远高于用 Ink 重做核心交互。

Ink 的明确短板与对策：

| 短板 | 对策 |
| --- | --- |
| 没有 cell-level buffer / 同步输出 API | 只渲染可视区，30fps 节流，减少整屏重绘；出现可见闪烁再评估 Rust |
| 没有原生的 scrollback 插入与 resize reflow | 默认 alternate screen，自己做 viewport 与 transcript overlay；v1 不承诺原生 scrollback |
| 没有现成的多行 composer | 自研 `TextEditor`：grapheme、宽字符、软换行、历史、粘贴、光标 |
| 没有 ratatui 级别的表格/高亮原语 | markdown/diff/表格用 Node 解析器生成 styled spans，缓存渲染结果 |

**什么时候应该改用 Rust：** 如果“相同”被定义为必须拥有 Codex 的终端原生 scrollback、resize reflow、cell 级增量渲染或同步输出，或 Ink 在 80x24、SSH/tmux 下稳定掉帧/闪烁，那就把 TUI 拆成独立 Rust 进程，不要继续在 Ink 上加补丁。

## Codex TUI 的可借鉴结构

Codex 的几个结构值得直接借用，而不是照抄实现：

- **全屏 + 底部固定**：上方是 transcript，下方是状态行、composer、footer；welcome 卡是第一条历史单元。
- **两级 transcript**：已完成的 `HistoryCell` 是不可变、可按宽度重渲染的源；正在流式的 `active cell` 是可变的，只重绘尾部。
- **流式按行提交**：只在完整换行/块边界把内容从 tail 提升为 stable，避免半行 markdown 反复变形；表格必须整块 holdback。
- **列表选择器统一**：审批、`/model`、`/resume`、`/theme`、快捷键帮助都复用同一套 selection list（编号、方向键、enter、esc）。
- **状态行与 footer 分离**：状态行描述“正在发生什么”，footer 描述“现在能按什么”；两者按宽度逐级折叠。
- **键盘是主交互**：没有鼠标依赖；`Esc` 中断、`Tab` 排队、`Ctrl+T` transcript、`Ctrl+G` 外部编辑器、`Ctrl+O` 复制。

## 主界面

```text
╭──────────────────────────────────────────────────╮
│ >_ codingx (v0.1.0)                              │
│                                                  │
│ model:     claude-opus-4-7   /model to change    │
│ directory: ~/work/codingx                        │
╰──────────────────────────────────────────────────╯

› 把 session 状态做成跨终端可查的

• 先看现有的 sessiond 与 rollout 结构。
  …
• Ran pnpm test
  └ 42 passed

• Working (12s • esc to interrupt)

› Ask codingx to do anything
  ? for shortcuts                     72% context left
```

布局规则：

- 全屏，不做外框；只有 welcome 卡、选择和审批使用边框/底色。
- 左侧统一 2 列 gutter：用户 `› `，助手 `• `，工具输出 `└ ` / `│ `，续行 2 空格。
- 消息之间空一行；用户消息使用随终端背景推导的低对比底色，助手消息保持透明。
- composer 固定在底部，高度 1–8 行；状态行在 composer 之上；footer 在 composer 之下，固定 1 行。
- 窄于 60 列时：welcome 卡收窄、footer 折叠、状态行省略细节；窄于 40 列时只保留输入与最简状态。

## 组件树

```text
<App>
  <TerminalHost>                 // alt screen, raw mode, resize, paste, cursor
    <MainView>
      <TranscriptViewport>       // 虚拟化，只渲染可见 HistoryCell
        <WelcomeCard/>
        <UserCell/> <AssistantCell/> <ExecCell/>
        <DiffCell/> <PlanCell/> <NoticeCell/>
      </TranscriptViewport>
      <BottomPane>
        <StatusRow/>             // spinner / elapsed / interrupt hint
        <QueuePreview/>          // 排队消息、待审批提示
        <Composer/>              // 多行编辑器 + slash/mention popup
        <Footer/>                // hints + context left
      </BottomPane>
    </MainView>
    <OverlayHost>                // 同一时间只显示一个全屏 overlay
      <TranscriptOverlay/> <SessionPicker/>
      <ModelPicker/> <ThemePicker/> <HelpOverlay/>
    </OverlayHost>
  </TerminalHost>
</App>
```

组件只做渲染与本地交互；会话、turn、审批决策都由上层 store/agent 决定。

## 状态与事件

TUI 不直接调用模型或工具，只消费 `UiEvent`、发出 `UiCommand`：

```ts
type UiEvent =
  | { type: 'turn.started'; turnId: string }
  | { type: 'text.delta'; turnId: string; text: string }
  | { type: 'tool.started'; call: ToolCall }
  | { type: 'tool.output'; callId: string; chunk: string }
  | { type: 'tool.finished'; result: ToolResult }
  | { type: 'diff.updated'; files: FileChange[] }
  | { type: 'plan.updated'; steps: PlanStep[] }
  | { type: 'approval.requested'; request: ApprovalRequest }
  | { type: 'usage.updated'; usage: TokenUsage }
  | { type: 'turn.finished'; status: 'done' | 'aborted' | 'error' }
  | { type: 'session.status'; status: SessionStatus; writer?: WriterInfo };

type UiCommand =
  | { type: 'submit'; text: string }
  | { type: 'interrupt' }
  | { type: 'approval'; decision: 'allow' | 'allow-session' | 'deny'; reason?: string }
  | { type: 'resume'; sessionId: string; takeover?: boolean }
  | { type: 'fork'; sessionId: string }
  | { type: 'set-model'; model: string; effort?: string };
```

`TuiStore` 是一个纯 reducer；React 通过 `useSyncExternalStore` 订阅快照。这样 reducer 可以脱离终端做单测，未来如果 TUI 换成 Rust，只需要把 `UiEvent`/`UiCommand` 换成 JSON-RPC 传输。

## 渲染管线

1. 启动时进入 alternate screen、raw mode、隐藏光标、开启 bracketed paste；退出/异常时恢复。
2. `TuiStore` 收到事件后更新 `transcript`、`activeCell`、`composer`、`status`、`overlay`。
3. 文本 delta 先进入缓冲；每 16ms 合并一次，最多 30fps 触发 React 更新。
4. 只在换行/代码块/表格边界把内容从 active tail 提升为 stable cell；表格从表头开始 holdback，避免列宽反复变化。
5. `TranscriptViewport` 只挑选可见 cell（上下各多渲染一屏），按宽度缓存每个 cell 的渲染行数与行内容。
6. 如果滚动锚点在底部，新内容到达时自动跟随；用户上滚后固定锚点，并显示“有新输出”提示。
7. resize 后清空布局缓存，按新宽度重渲染可见 cell；保留“底部/顶部”锚点，避免跳变。

不使用 Ink 的 `<Static>` 作为主 transcript：全屏 viewport 需要自己控制滚动、锚点和 overlay；`<Static>` 只适合 inline fallback。

## 内容单元

| 单元 | 渲染 |
| --- | --- |
| Welcome | 圆角边框，标题 `>_ codingx (vX)`、model、directory、permissions；宽度上限约 60 列 |
| User | `› ` 前缀 + 背景 tint；保留换行，超宽 URL 强制拆分；末尾空行 |
| Assistant | `• ` 前缀 + markdown；标题、列表、引用、代码块、表格、链接 |
| Exec | `• Ran <command>`；输出 `│`/`└`，默认保留前 5 行，超出显示 `… +N lines`；stderr 用 error tone |
| Diff | `• Edited N files (+a -b)`；按文件分组，行号 + gutter，add/del 主题色，按 hunk 语法高亮 |
| Plan | `• Updated Plan`；说明 + `✔`/`□` 步骤，步骤按宽度换行并保持缩进 |
| Notice/Error | 单行/多行提示，warning 用黄色或 dim，error 用红色；不抢占 composer |

Markdown 解析推荐 `marked` 或 `micromark` 的 AST，再映射为 Ink spans；代码高亮先用 `lowlight`/`cli-highlight`，如果质量不够再评估 Shiki（注意 bundle 与冷启动）。表格需要单独做列宽分配，过窄时退化为 key/value 行。

## 输入与键位

| 场景 | 默认键 |
| --- | --- |
| 提交 | `Enter` |
| 换行 | `Shift+Enter` / `Ctrl+J` / `Alt+Enter` |
| 任务中排队 | `Tab` |
| 中断 / 关闭弹层 | `Esc` / `Ctrl+C`（任务运行时首次按下也中断） |
| 退出 | `Ctrl+C` 双击 / `Ctrl+D`（空 composer 时） |
| 历史搜索 | `Ctrl+R` |
| Transcript overlay | `Ctrl+T` |
| 复制最后回复 | `Ctrl+O` |
| 外部编辑器 | `Ctrl+G` |
| 清屏 | `Ctrl+L` |
| 快捷键帮助 | `?` |
| slash / mention | 行首 `/`、任意位置 `@` |
| 滚动 | `PgUp` / `PgDn`，`Shift+↑/↓` 逐行 |
| 审批 | `y` 允许、`a` 本会话允许、`esc` 拒绝，或数字 1–3 |

Composer 在空输入时 `↑/↓` 走历史；有内容时走光标；`Ctrl+A/E`、`Ctrl+W`、`Ctrl+K/U` 等 readline 键位保留。审批弹层打开时，所有按键只进入审批，模型输出不能伪造或抢焦点。

## Overlay

### 审批

```text
  Would you like to run this command?

  $ rm -rf dist && pnpm build
  cwd: ~/work/codingx

› 1. Yes, proceed (y)
  2. Yes, and don't ask again for this command (a)
  3. No, and tell codingx what to do differently (esc)
```

审批替换 composer 区域，保留底部上下文；显示规范化命令、cwd、涉及文件/网络和风险摘要。决策回到 agent 后，结果作为一条历史单元留下。

### Slash / mention

Slash popup 浮在 composer 上方，最多 8 行；每行命令 + 一句描述，支持模糊过滤、↑/↓、enter、tab 补全、esc 关闭、数字 1–9 直选。`@` 只做文件/目录补全，不执行任意脚本。

### Transcript overlay

`Ctrl+T` 打开全屏只读 transcript：`j/k`/`PgUp/PgDn`/`g/G` 滚动，`/` 搜索，`q`/esc 关闭；提供 raw/rich 切换，raw 用于复制。它不改变主 transcript 状态。

### Session picker

`/resume` 或 `--resume` 打开列表：ID、更新时间、cwd、branch、最后一条用户消息；输入过滤，`tab` 切换排序，enter 恢复，`ctrl+f` fork；跨终端会显示 writer/observers，被占用时提示 `--takeover` 或只读观察。会话列表来自 sessiond，见 [session-manager.md](session-manager.md)。

### Model / theme / help

`/model` 显示模型与 reasoning effort；`/theme` 实时预览；`?` 显示当前上下文所有快捷键。三者复用 selection list。

## 主题与终端

- 语义色：`accent`、`muted`、`success`、`warning`、`error`、`userBg`、`planBg`、`diffAdd`、`diffDel`、`border`；不直接在组件里写颜色。
- `theme = auto` 时通过 OSC 11 查询背景色；查询失败或超时按暗色处理；支持 `dark`、`light` 和自定义语法主题。
- 颜色能力分 truecolor / 256 / 16 / `NO_COLOR`；diff 在 16 色下只保留前景色区分。
- Unicode 为主；`--ascii` 时把 `› • └ │ ✔ □ …` 降级为 ASCII。
- 宽字符/emoji/CJK 用 `string-width` 和 `Intl.Segmenter` 计算；tab 固定 4 列；不做未定义宽度的猜测。
- 终端标题：`codingx · <cwd basename> · <activity>`；写入前去除控制字符，退出时恢复。
- 通知：仅在失焦且 turn 结束时发 OSC 9/777 或终端 bell；默认不包含 prompt 内容。

## 配置

```toml
[tui]
alternate_screen = "auto"    # auto | always | never（never 为 inline/plain fallback）
theme = "auto"               # auto | dark | light | <syntax theme>
animations = true
notifications = true
status_line = ["model", "cwd", "context"]
```

TUI 配置属于个人偏好，只从全局配置读取；项目配置不得覆盖。完整配置项见 [config.md](config.md)。命令行提供 `--no-alt-screen` 作为一次性降级。

## 性能预算

- 流式渲染 30fps；动画/输入反馈 60fps；p95 帧时间 < 33ms（80x24，200 个可见单元）。
- 按键到界面反馈 < 50ms；首屏（含 welcome）< 150ms。
- transcript 保存 50k 单元仍可滚动；只渲染可见区，内存目标 < 200MB。
- 单条消息流式时只重算 active cell；已完成 cell 的布局按 `(width, revision)` 缓存。
- 超过预算时先降帧、再降动画，最后才考虑 Rust。

## 测试

- reducer/selector 单测：turn 状态、队列、审批、滚动锚点、宽窄布局。
- `ink-testing-library` 组件快照：welcome、user/assistant、exec、diff、plan、approval、slash、footer。
- PTY 集成测试：`node-pty` + `@xterm/headless` 读取屏幕 buffer，覆盖 alt screen、resize、paste、CJK/emoji、40/80/120/200 列。
- 关键帧走 golden 文件；比较前剥离时间、spinner 帧等非确定内容。
- 性能基准：1k/10k/50k cells、连续 30 turn、不同宽度。

## 里程碑与验收

- **M2（核心）**：welcome、transcript viewport、composer、status/footer、流式 markdown、exec/diff/plan、slash/mention、审批、queue、transcript overlay、session picker、alt screen、主题、默认键位。
- **M4（打磨）**：主题选择器、快捷键重映射、终端标题、通知、复制/导出、raw 模式、ASCII fallback、可访问性。
- **验收**：80x24 与 120x40 下核心流程可用；30 轮对话流式不闪烁；审批/恢复/跨终端状态正确；resize 后锚点不跳；CJK/emoji 不变形；`--plain` 仍可用于 CI。

## 非目标

- 第一版不做原生 scrollback 插入、resize reflow、鼠标、pets、plugins、voice、图片、side conversation、多 Agent 面板。
- 不逐像素对齐 Codex；只对齐信息架构、主要状态与键盘手感。
- 不把业务逻辑放进组件；TUI 只消费 `UiEvent`。

## 如果最终选 Rust

只有满足以下任一条件才值得：必须保留终端原生 scrollback / reflow；Ink 在目标终端上无法稳定 30fps；必须复用 ratatui/crossterm 的 cell 级能力。

届时建议：

- `codingx-core` 继续 Node，提供 `UiEvent` / `UiCommand` 的 NDJSON JSON-RPC（UDS 或 stdio）。
- `codingx-tui` 用 Rust + ratatui/crossterm，只做渲染与输入；不复刻 agent 逻辑。
- 按平台分发 TUI 二进制（npm optional dependency 或独立安装包），`codingx` 负责选择/拉起。
- 参考 Codex 的组件划分与交互，但不要直接 fork 整个 `codex-rs/tui`：它与 app-server 协议、认证、配置深度耦合。
