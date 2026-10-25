# TUI 设计

这份文档只定义 TUI：终端内核、布局、消息单元、composer、状态行、overlay 与键盘。

**TUI 不包含认证、登录、配置文件、设置页、主题选择器、模型选择器或可配置键位。** 模型、cwd、session 由 core 通过事件传入；TUI 只负责显示与交互。

## 结论：Node + 自研 Terminal

TUI 继续用 Node/TypeScript，但**不用 Ink**，自己实现 Terminal 层：cell buffer、ANSI 差分渲染、alt screen、raw mode、输入解析、resize 与恢复。

为什么不是 Rust：

- codingx 的 agent、工具、审批、sessiond 都在 Node；TUI 同进程可以共享类型和生命周期，不需要第二套工具链、IPC 和平台二进制分发。
- 自研 Terminal 的工作量主要在 cell buffer、diff、输入状态机和布局，不在语言；Node 处理 80x24 / 120x40 的逐帧 diff 足够。
- `npx codingx` 的单文件分发是现有目标；Rust TUI 会把它拆成 Node + 平台二进制。

Rust 只在一种情况下值得：TUI 成为独立产品，且实测 Node 的输入延迟、帧时间或宽字符处理无法达标。届时把 terminal/renderer 拆成独立 Rust 进程，保留 `UiEvent`/`UiCommand` 协议。

## 参考 Codex 的哪些部分

参考核心结构，不复制认证、配置、app-server 和全部外围功能：

- 全屏 + 底部固定：上方 transcript，下方状态行、composer、底部 meta。
- 两级 transcript：已完成的 `HistoryCell` 是不可变、可按宽度重渲染的源；正在流式的 active cell 可变，只重绘尾部。
- 流式按行提交：完整换行/块边界才从 tail 提升为 stable；表格整块 holdback。
- 统一 selection list：审批、`/resume`、帮助都复用同一套列表状态机。
- 自研 terminal：自己管理 cell buffer、ANSI 输出、光标、resize 与恢复，而不是依赖 TUI 框架。

## Terminal 内核

```text
src/tui/
├── terminal/
│   ├── session.ts      // alt screen / raw mode / 恢复
│   ├── buffer.ts       // Cell / 双缓冲 / 宽字符
│   ├── renderer.ts     // ANSI 差分 / SGR / 光标
│   ├── input.ts        // CSI / SS3 / paste / resize
│   └── width.ts        // grapheme / string-width
├── layout/             // Rect / split / constraints
├── widgets/            // welcome / transcript / composer / status / meta
├── text/               // wrap / truncate / grapheme
├── markdown/           // AST → styled lines
├── diff/               // unified diff → lines
├── state/              // UiEvent / UiCommand / TuiApp
└── app.ts              // 事件循环与帧调度
```

### 生命周期

- 启动：进入 alternate screen、raw mode、隐藏光标、开启 bracketed paste；保存终端状态。
- 退出或异常：恢复光标、关闭 bracketed paste、离开 alternate screen、恢复 raw mode；恢复逻辑必须可重复执行。
- 信号：处理 `SIGWINCH`（resize）、`SIGINT`、`SIGTERM`；`Ctrl+C` 由输入层转为应用事件，不直接杀进程。

### Cell buffer

```ts
interface Cell {
  symbol: string;      // grapheme cluster
  fg: Color;
  bg: Color;
  attrs: number;       // bold / dim / italic / underline / reverse
  width: 0 | 1 | 2;    // 0 = 宽字符的 continuation cell
}
```

- 双缓冲：`front` 是当前屏幕，`back` 是下一帧；渲染只改 `back`，最后统一 diff。
- 宽字符占两格，第二格写 continuation；覆盖/裁剪时成对处理，避免半字符残留。
- grapheme 用 `Intl.Segmenter` 切分，宽度用 `string-width`；CJK、emoji、组合字符按显示宽度落格。
- 每帧写完后交换 buffer；滚动/清屏也走同一套 cell 操作。

### 差分渲染

- 比较 `front` / `back`，按行合并连续变化区间，输出 `MoveTo + SGR + Print`，跳过未变化的 cell。
- 每帧用 synchronized output（`\x1b[?2026h` ... `\x1b[?2026l`）包住，减少 tearing。
- 光标位置独立于 cell 内容：composer 的 cursor 由布局层给出，renderer 在帧末显示硬件光标并设置 CUP；中文输入法候选窗因此锚定在插入点。overlay/transcript 模式隐藏硬件光标。
- 颜色能力分 truecolor / 256 / 16 / `NO_COLOR`；不支持的颜色降级，不输出空 SGR。

### 输入

- 原始 stdin 读取，自己解析 printable、C0、CSI、SS3、bracketed paste、focus 和 resize。
- UTF-8 增量解码，避免多字节字符被拆到两次 read。
- 输出统一 `KeyEvent { code, text, mods }`；`Esc` 单独按键与 escape 序列前缀要用超时区分。
- 不启用鼠标；不依赖 readline 的行编辑，composer 自己维护文本、光标与历史。

### 布局

- `Rect { x, y, width, height }` + `split(area, constraints)`；约束支持 length / percent / min / max。
- 每个 widget 实现 `desiredHeight(width)` 与 `render(area, frame)`；父级先量高，再分配区域。
- 文本换行、截断、宽字符测量集中在 `text/` 与 `wrap/`，组件不各写一套。

## 应用模型

TUI 不直接调用模型或工具；核心通过 `UiEvent` 驱动，TUI 通过 `UiCommand` 回传：

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
  | { type: 'session.info'; sessionId: string; cwd: string; model: string }
  | { type: 'session.status'; status: SessionStatus };

type UiCommand =
  | { type: 'submit'; text: string }
  | { type: 'interrupt' }
  | { type: 'approval'; decision: 'allow' | 'allow-session' | 'deny'; reason?: string }
  | { type: 'resume'; sessionId: string }
  | { type: 'fork'; sessionId: string };
```

`TuiApp` 是一个显式状态机：`mode`（main / transcript / session-picker / approval）、`transcript`、`activeCell`、`composer`、`status`、`overlay`。事件循环同时监听 stdin、core 事件和帧定时器；没有隐藏的全局单例。

TUI 不持久化任何配置；所有颜色、键位、布局都是固定行为。模型与 cwd 只作为事件字段显示。终端渲染前对不可信文本做控制序列剥离，见 [security.md](security.md)。

## 主界面

```text
╭──────────────────────────────────────────────────╮
│ >_ codingx (v0.1.0)                              │
│                                                  │
│ model:     model-name                            │
│ directory: ~/work/codingx                        │
│ session:   550e8400-e29b-41d4-…                  │
╰──────────────────────────────────────────────────╯

› 把 session 状态做成跨终端可查的

• 先看现有的 sessiond 与 rollout 结构。
  …
• Ran pnpm test
  └ 42 passed

• Working (12s • esc to interrupt)

› Ask codingx to do anything
model · cwd · session title
```

- 全屏，不做外框；只有 welcome 卡、选择和审批使用边框/底色。welcome 卡展示 version、model、cwd 与当前 session id，内容左右各 1 列内边距。
- 2 列 gutter：用户 `› `、助手 `• `、工具 `└ ` / `│ `，续行 2 空格。
- 消息间空一行；用户消息使用低对比背景，助手消息透明。
- composer 固定底部，3–8 行，内容上下各留 1 行 padding 并垂直居中，使用独立的 `composerBg` 整块背景。
- transcript 与状态行之间、状态行与 composer 之间各留 1 行空白；终端高度 <8 行时自动折叠这两条间隔。
- composer 下方固定一行 meta：模型、cwd、当前会话标题（取首条用户消息，resume 时从 rollout 恢复）。
- 最底部固定 1 行 meta，不再显示快捷键行；cwd 在 home 目录下显示为 `~/...`，用户消息使用独立的 `userBg` 整块背景。
- 每个 turn 完成后追加一行 TurnSummary：完成时间、耗时、in/out/cache tokens。
- 状态行显示 `turn N · step M`，右侧显示 `ctx used/window · tok total`，默认窗口 1M tokens。
- exec 命令显示工具耗时；turn 摘要显示 `total/llm/tools` 耗时与 Token，LLM 耗时不再重复挂在 assistant 内容末尾。
- 向上滚动按历史内容 clamp；内容不足一屏时保持停在底部，不会出现空白。
- welcome 卡作为 transcript 的第一个历史块保留，不会在首条消息后消失；滚动上限包含它。
- resume 时从 rollout 重建 user/assistant/tool/plan/turn 摘要，历史 transcript 直接可见。
- 支持鼠标滚轮（SGR mouse wheel）与 PgUp/PgDn、Shift+Up/Down。
- `/copy` 默认复制完整 transcript；`/copy status|input|meta|screen` 分别复制 StatusRow/Composer/MetaBar/整屏；`/copy all` 复制全部区域（带分区标题），`/copy last` 复制最后一条 assistant 输出。Ctrl+Y 等同 `/copy all`。
- 鼠标拖选时 TUI 用反色高亮选区，释放后自动复制选中文本；可跨 transcript/status/composer/meta 选择。剪贴板优先 OSC52 并回退 pbcopy/clip/wl-copy/xclip。
- 窄于 60 列收窄卡片；窄于 40 列隐藏 meta，只保留输入与最简状态。

## Widgets

```text
TuiApp
├── TranscriptViewport        // 虚拟化，只渲染可见 cell
│   ├── WelcomeCard
│   ├── UserCell / AssistantCell / TurnSummary
│   ├── ExecCell / DiffCell / PlanCell / NoticeCell
│   └── ActiveCell            // 流式尾部
├── BottomPane
│   ├── StatusRow             // spinner / elapsed / interrupt
│   ├── QueuePreview
│   ├── Composer              // 多行编辑器 + slash 补全，独立背景
│   └── MetaBar               // model · cwd · session title（最底部）
└── OverlayHost
    ├── ApprovalView
    ├── TranscriptOverlay
    ├── SessionPicker
    └── HelpOverlay
```

组件只做测量、绘制和本地交互；turn、审批决策、session 状态由上层状态机决定。

## 消息单元

| 单元 | 渲染 |
| --- | --- |
| Welcome | 圆角边框，标题、model、directory；宽度上限约 60 列 |
| User | `› ` + 低对比背景；保留换行，超宽 URL 强制拆分 |
| Assistant | `• ` + markdown；标题、列表、引用、代码块、表格、链接 |
| Exec | `• Ran <command>`；输出 `│`/`└`，前 5 行，超出 `… +N lines`；stderr 用 error tone |
| Diff | `• Edited N files (+a -b)`；文件分组、行号、gutter、add/del 颜色 |
| Plan | `• Updated Plan`；说明 + `✔`/`□` 步骤 |
| Notice | 单行/多行提示，不抢 composer |

Markdown 用 `marked` 或 `micromark` 解析成 AST，再转 styled spans；代码高亮先用 `lowlight`/`cli-highlight`，表格单独做列宽分配，过窄时退化为 key/value 行。

## 流式渲染

1. 文本 delta 进入缓冲；每 16ms 合并，最多 30fps 触发一次绘制。
2. 只在完整换行、代码块结束或表格边界把内容从 active tail 提升为 stable cell。
3. 表格从表头开始 holdback，直到表结束；避免列宽每来一行就重排。
4. 已完成 cell 按 `(width, revision)` 缓存行数；resize 时清缓存，从源重渲染。
5. 滚动锚点在底部时自动跟随；用户上滚后固定，并显示“有新输出”提示。

## 输入

| 场景 | 键 |
| --- | --- |
| 提交 | `Enter` |
| 换行 | `Shift+Enter` / `Ctrl+J` / `Alt+Enter` |
| 任务中排队 | `Tab` |
| 中断 / 关闭弹层 | `Esc` / `Ctrl+C`（首次） |
| 退出 | `Ctrl+C` 双击 / `Ctrl+D`（空 composer） |
| 历史搜索 | `Ctrl+R` |
| Transcript overlay | `Ctrl+T` |
| 复制最后回复 | `Ctrl+O` |
| 外部编辑器 | `Ctrl+G` |
| 清屏 | `Ctrl+L` |
| 帮助 | `?` |
| 滚动 | `PgUp` / `PgDn` / `Shift+↑/↓` |
| 审批 | `y` / `a` / `esc`，或数字 1–3 |

Composer 空输入时 `↑/↓` 走历史；有内容时走光标；保留 `Ctrl+A/E`、`Ctrl+W`、`Ctrl+K/U`。审批打开时所有按键只进入审批。

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

审批替换 composer，显示规范化命令、cwd、涉及文件/网络与风险摘要；模型输出不能伪造选项。

### Slash

Slash 补全浮在 composer 上方，最多 8 行；命令 + 一句描述，支持过滤、↑/↓、enter、tab、esc、数字 1–9。只做 TUI 自身动作：`/resume`、`/diff`、`/clear`、`/help`、`/quit`。

### Transcript

`Ctrl+T` 打开全屏只读 transcript：`j/k`、`PgUp/PgDn`、`g/G` 滚动，`/` 搜索，`q`/esc 关闭；raw/rich 切换用于复制。

### Session picker

`/resume` 打开列表：ID、更新时间、cwd、branch、最后一条用户消息；输入过滤，enter 恢复，`ctrl+f` fork；显示 writer/observers。数据来自 core/sessiond，TUI 不做认证。

## 颜色与终端

- 语义色：`accent`、`muted`、`success`、`warning`、`error`、`userBg`、`composerBg`、`planBg`、`diffAdd`、`diffDel`、`border`；组件不写死颜色。
- 通过 OSC 11 查询背景色，失败按暗色；支持 truecolor / 256 / 16 / `NO_COLOR`。
- Unicode 为主；宽字符、emoji、CJK 由 `string-width` + `Intl.Segmenter` 处理。
- 不做主题选择器，不读主题配置；颜色只由终端能力与内置语义表决定。

## 性能预算

- 流式 30fps；输入反馈 60fps；p95 帧 < 33ms（80x24，200 个可见单元）。
- 按键到反馈 < 50ms；首屏 < 150ms。
- 50k transcript 单元仍可滚动；只渲染可见区，内存 < 200MB。
- 单条消息流式时只重算 active cell；cell diff 只输出变化区间。

## 测试

- cell buffer / diff 单测：宽字符、续格、SGR、光标、清屏、滚动。
- 输入解析单测：CSI/SS3、bracketed paste、UTF-8 分段、Esc 超时、resize。
- 布局与 widget 快照：直接比较 cell buffer 或 ANSI 帧，不依赖终端。
- PTY 集成：`node-pty` + `@xterm/headless` 覆盖 alt screen、resize、paste、CJK/emoji。
- 性能基准：1k/10k/50k cells、40/80/120/200 列、连续 30 turn。

## 里程碑

- **TUI 1**：terminal 生命周期、cell buffer、diff renderer、输入解析、layout、resize、异常恢复。
- **TUI 2**：welcome、transcript、composer、status/meta、流式 markdown、exec/diff/plan、slash、审批、queue。
- **TUI 3**：transcript overlay、session picker、help、复制、外部编辑器、CJK/emoji 打磨。
- **集成**：接 `UiEvent`/`UiCommand`；`--plain` 保持纯文本；TUI 不引入 auth/config。

**验收**：80x24 与 120x40 核心流程可用；30 轮流式不闪烁；输入延迟达标；resize 不跳；CJK/emoji 不变形。

## 非目标

- 不做登录、认证、配置、设置页、主题/模型选择器、可配置键位。
- 不做 pets、plugins、voice、图片、side conversation、多 Agent 面板。
- 不做原生 scrollback / resize reflow；transcript 由 TUI 自己管理，`Ctrl+T` 查看历史。
- 不逐像素复制 Codex；只对齐信息架构、状态与键盘手感。