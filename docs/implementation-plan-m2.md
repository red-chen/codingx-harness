# M2 实施计划（交互体验）

依据 [roadmap.md](roadmap.md) 的 M2 范围，在 M1 的可运行循环之上继续拆分。M1 计划与结果见 [implementation-plan.md](implementation-plan.md)。

> 状态：G1-G5 验收全部 DONE。E3 的表格 holdback、E4 的 session picker、E5 的 mention，以及 F4 的慢订阅者背压，列为 M2.1 增强，不影响 M2 验收结论；审批 overlay 移至 M3（见 [implementation-plan-m3.md](implementation-plan-m3.md)）。E4 的 AskUserQuestion 提问面板已完成，Skills 按需加载已接入。

## 目标

M2 结束时：

- 连续 30 轮对话不因上下文超限中断
- 中途中断后 `--continue` 能接上
- 两个终端能看到同一会话状态且写租约互斥
- 80x24 / 120x40 核心流程可用；流式不闪烁，resize 后锚点稳定

## 任务拆分

状态：`TODO` / `DOING` / `DONE`。

### Wave A · 会话续接

| ID | 任务 | 验收 | 状态 |
| --- | --- | --- | --- |
| A1 | rollout → 消息历史重建；悬空 `tool.call` 补合成 `tool_result`；恢复 read tracker | replay 后可继续对话；合成结果 `synthetic: true`；读过的文件仍可编辑 | DONE |
| A2 | 嵌入式存储 `forkSession`：复制到指定 seq，新头写 `forkedFrom` | 分叉不修改源会话；新会话可继续；running 会话拒绝 fork | DONE |
| A3 | CLI `--continue` / `--resume <id>` / `--fork <id>` 与交互模式集成 | 最近空闲会话可续接；指定 id/前缀可恢复；分叉后历史完整 | DONE |
| A4 | 续接/分叉 E2E 与错误路径测试 | 第二进程读回第一轮历史；悬空工具调用被修复 | DONE |

### Wave B · 上下文压缩

| ID | 任务 | 验收 | 状态 |
| --- | --- | --- | --- |
| B1 | 一级压缩：截断过大的 tool_result（保留头尾/省略行数） | 不改消息数；模型可见截断标记 | DONE |
| B2 | 二级压缩：保留首条用户需求 + 最近 K 轮，丢弃中间对话 | token 估算下降；不破坏 tool_use/tool_result 配对 | DONE |
| B3 | 三级压缩：模型生成结构化摘要，作为 system 上下文保留 | 摘要含已完成/关键文件/未决问题；失败可降级 | DONE |
| B4 | 接入 AgentLoop：阈值/消息数触发，写 `context.compacted` | 30 轮压测不超限；原始 rollout 不丢 | DONE |

### Wave C · 工具扩展

| ID | 任务 | 验收 | 状态 |
| --- | --- | --- | --- |
| C1 | `Glob` | 按 mtime 排序；忽略 .gitignore/依赖目录；500 条上限 | DONE |
| C2 | `Grep` | 优先 rg；缺失时内置回退；100 条上限与截断提示 | DONE |
| C3 | `Write` | 新建/覆盖；覆盖前要求本会话读过；二进制/越界拒绝 | DONE |
| C4 | `UpdatePlan` | 模型维护步骤，UiEvent 实时更新 | DONE |
| C5 | `ApplyPatch` | unified diff 多文件补丁；失败不半写 | DONE |
| C6 | `Skill` + SKILL.md 加载 | 全局/项目目录、frontmatter 校验、目录注入系统提示、按需加载正文 | DONE |
| C7 | `AskUserQuestion` | TUI 单选/多选/自由文本；Esc 取消；无交互返回 is_error；答案入 rollout | DONE |

### Wave D · 自研 Terminal 内核

| ID | 任务 | 验收 | 状态 |
| --- | --- | --- | --- |
| D1 | grapheme/宽度/换行/截断 | CJK、emoji、组合字符按显示宽度落格 | DONE |
| D2 | Cell buffer 双缓冲与宽字符续格 | 覆盖/裁剪不残留半字符 | DONE |
| D3 | ANSI 差分渲染、SGR、光标、同步输出 | 变化区间最小化；颜色能力降级 | DONE |
| D4 | 输入解析：C0/CSI/SS3/paste/UTF-8/Resize | 分块输入、Esc 超时、paste 正确 | DONE |
| D5 | Terminal 生命周期：alt screen/raw/恢复/信号 | 异常退出可重复恢复 | DONE |
| D6 | Rect/split/constraints 布局 | 80x24 与 120x40 约束正确 | DONE |

### Wave E · TUI 组装

| ID | 任务 | 验收 | 状态 |
| --- | --- | --- | --- |
| E1 | `UiEvent`/`UiCommand` 契约与 TuiApp 状态机 | mode/transcript/activeCell/composer/status 显式 | DONE |
| E2 | welcome、transcript viewport、composer、status/meta | 固定底部；虚拟化只渲染可见单元 | DONE |
| E3 | 消息单元：user/assistant/exec/diff/plan/notice | 流式 markdown、表格 holdback、diff 着色 | DOING（markdown/code/diff 已完成；表格 holdback 待补） |
| E4 | overlay：审批、transcript、session picker、help、ask | 模型输出不能伪造选项 | DOING（help 静态 overlay、transcript 全屏模式、ask 提问面板已完成；session picker 待做；审批 overlay 移至 M3） |
| E5 | 键位、slash/mention、排队、中断/双击退出 | 键盘与滚动符合 tui.md | DOING（编辑/历史/滚动/中断/队列/双击退出/slash 补全菜单已完成；mention 待做） |
| E6 | 接入 CLI；非 TTY/--plain 退化 | TUI 不读配置/凭证；plain 路径保持 | DONE |

### Wave F · sessiond

| ID | 任务 | 验收 | 状态 |
| --- | --- | --- | --- |
| F1 | NDJSON JSON-RPC 协议、握手、错误码、帧上限 | 协议不匹配明确报错 | DONE |
| F2a | JSON-RPC peer transport（握手/请求/通知/超时/关闭） | 双向请求与通知可用；解析错误可恢复 | DONE |
| F2 | 单实例锁、socket 生命周期、自动拉起、空闲退出 | 每个 CODINGX_HOME 一个 daemon | DONE |
| F3 | 注册表、写租约、heartbeat、接管、崩溃恢复 | writer 互斥；观察者不阻塞 | DONE |
| F4 | append/replay/subscribe/fork/end、seq 与 eventId 幂等 | 半行、重复 eventId、慢订阅者有测试 | DOING（方法/幂等已通；慢订阅者/背压待做） |
| F5 | 客户端 SessionStore 切到 IPC；嵌入式保留 | daemon 不可用不回退隐式双写 | DONE |
| F6 | `sessions list/show/watch/prune`、`sessiond start/stop/status/restart` | 跨 CLI 实时状态；--json 可用 | DONE |

### Wave G · 验收

| ID | 任务 | 验收 | 状态 |
| --- | --- | --- | --- |
| G1 | 30 轮长会话压缩压测 | 不因上下文超限中断 | DONE |
| G2 | 中断后 `--continue` | 历史接上；不自动续跑未完成 turn | DONE |
| G3 | 双终端租约 | 两个 CLI 状态一致；写租约互斥 | DONE |
| G4 | 80x24/120x40、CJK/emoji、resize | 核心流程可用，不闪烁/变形 | DONE（PTY 冒烟 + 帧预算测试） |
| G5 | 性能预算 | 帧 <33ms、按键 <50ms、首屏 <150ms | DONE |

## 推进顺序

```text
Wave A ─┬─ Wave B（压缩独立）─┐
Wave C ─┤                     ├─ Wave E（TUI 组装）─ Wave G
Wave D ─┴─────────────────────┘
Wave F（sessiond）依赖 A 的续接语义，可与 D/E 并行
```

当前推进：**Wave A/B/C、Wave D、Wave E1/E2/E4（ask 面板）、Wave E5（除 mention）、Wave E6、Wave F（除背压）、G2/G3/G4/G5 已完成**；剩余 mention、session picker、表格 holdback、慢订阅者背压；审批 overlay 移至 M3。

## 本轮结果（Round 6）

- 测试：44 个文件、471 项全部通过（typecheck 通过）。
- **TUI slash 补全**：`/help|/session|/queue|/quit` 过滤菜单、↑/↓ 选择、Tab/Enter 补全、Esc 关闭；84x24 帧内渲染。
- **`sessions prune`**：daemon 注册表按 ended + 更新时间 + 无 writer/observer 安全清理；支持 `--older-than`、`--dry-run`、`--json`；CLI E2E 覆盖。
- `sessions list/show/watch`、`sessiond start/stop/status/restart` 均保留通过。
- 仍待：mention、session picker、表格 holdback、慢订阅者背压；审批 overlay 移至 M3。

## 本轮结果（Skills 与 AskUserQuestion）

- 测试：51 个文件、524 项全部通过（typecheck 通过）。
- **Skills**：扫描 `~/.agents/skills`、`~/.codingx/skills` 与 `<project>/.codingx/skills`，解析 `SKILL.md` frontmatter（name/description，支持引号与 `>`/`|` 块），项目 > `~/.codingx/skills` > `~/.agents/skills` 依次覆盖；系统提示只注入目录，`Skill` 工具按需返回正文、路径与 base directory。非法/超大/重复技能给出 warning。
- **AskUserQuestion**：模型可一次提 1–4 个问题（每题 2–6 个选项，支持多选与自由文本）；TUI 底部面板支持 ↑/↓、Space、Enter、Esc、数字直选、Other 输入；状态行显示 `Awaiting answer`；无交互运行返回 `is_error`；答案与取消都走常规 `tool.call` / `tool.result` 回放。
- 新增测试：`tests/skills.test.ts`、`tests/tools-ask.test.ts`、`tests/tui-ask.test.ts`，并在 AgentLoop / TuiSession 用例中覆盖 handler 注入与面板桥接。

## M2 后置优化

- TUI composer 使用独立的 `composerBg` 整块背景；用户消息使用 `userBg` 整块背景，文本单元格继承行背景。
- 底部新增 MetaBar：model · cwd · session title；标题取首条用户消息，resume 时从 rollout 恢复，空会话显示 "New session"。
- 测试：48 个文件、499 项通过；新增 `tests/tui-bottom.test.ts`、`tests/tui-turn-summary.test.ts`、`tests/tui-restore.test.ts`，覆盖背景、MetaBar、turn 摘要、上下文/累计 Token、LLM/工具耗时、turn/step 与 resume transcript 重建。
- IME 候选窗定位：每帧把硬件光标显示并移动到 composer 实际插入点（含 CJK 宽字符、多行、slash 菜单）；overlay/transcript 模式隐藏。
- 完成摘要：`turn.finished` 后在 transcript 追加完成时间、耗时、in/out/cache tokens。
- 上下文用量：StatusRow 显示 `ctx used/window · tok total`，TUI 与 AgentLoop 默认窗口 1,000,000 tokens（配置 `model.context_window` 可覆盖）。
- 耗时：exec 命令显示工具耗时；turn 摘要显示 `total/llm/tools` 与 Token；assistant 末尾不再重复 `llm Xs`。
- 工具调用合并：相邻且工具/目标相同的调用渲染为一个 Exec 块（`• Ran <command> ×N`，耗时求和），各次输出依次预览，完全相同的重复输出只显示一次；分组与滚动高度共用同一套块模型，resume 重建的 transcript 同样生效。新增 `buildExecGroupLines` 与 viewport 分组测试。
- StatusRow 同时显示 `turn N · step M`；滚动 offset clamp 到内容高度，短会话上滚不会清空历史。
- 底部留白：transcript↔status、status↔composer 各 1 行，矮终端自动折叠。
- welcome 卡展示当前 session id，卡片按内容收缩并保留左右 1 列内边距。
- 新会话 ID 使用 UUID v4；旧 12 位 base36 ID 继续可读，rollout 文件名与 resume/log 前缀解析兼容两种格式。
- resume 时从 rollout 重建可见 transcript（user/assistant/tool/plan/turn summary），不再只恢复模型历史。
- welcome 卡作为 transcript 第一个历史块常驻，不再在首条消息后消失；滚动上限包含 welcome 卡，可回滚到最顶部。
- 滚动支持 PgUp/Shift+Up 与 SGR 鼠标滚轮；offset clamp 到内容高度，短会话不会清空。
- `/copy` 支持按区域复制 transcript/status/input/meta/screen/all，`/copy last` 复制最后一条 assistant；Ctrl+Y 复制全部区域；鼠标拖选高亮并在释放时自动复制。OSC52 + 平台剪贴板双通道。

## 本轮结果（`/clear`）

- 测试：52 个文件、564 项全部通过（typecheck 通过）。
- **`/clear`**：TUI 与 `--plain` 交互模式均支持；先经 `SessionHandle.clear()`/sessiond `session.clear` 将 JSONL 原地重写为新的 `session.start` 头（保留 id/cwd/model/createdAt，`seq` 回到 1），再清空 AgentLoop 的消息、plan、已读文件状态与 TuiApp 的 transcript/usage/turn/queue/title。
- `/clear` 在 turn 运行中拒绝执行；只读或已结束的会话拒绝清理；sessiond 清理需要写租约并广播 `session.cleared`，`sessions watch` 会提示历史已重置。
- 嵌入式 rollout 统一以 `ax`（append + exclusive）打开，保证 clear 后的 `truncate(0)` + 重写不会在旧偏移留下空洞；新事件从 `seq: 2` 继续。
- 新增测试：session 清理/只读/已结束、sessiond registry/client 清理与租约校验、AgentLoop `clearHistory`、TuiApp `resetSession`、TuiSession `/clear` 与运行中拒绝、plain 交互清理后 JSONL 仅剩头事件。
- **daemon 方法握手**：`initialize` 返回本构建的 `methods` 列表；`ensureSessiond` 发现长驻 daemon 缺少新方法（旧构建没有 `session.clear` 时 `/clear` 会报 `Unknown method`）会先非强制 shutdown 再拉起新 daemon。有活动租约或 `autostart = false` 时返回可执行的 `codingx sessiond restart` 提示；新增旧 daemon 替换与租约保护测试。

## 本轮结果（`--add-dir`）

- 测试：52 个文件、564 项全部通过（typecheck 通过）。
- **`--add-dir <DIR>`**：全局、可重复；bootstrap 校验目录存在且为目录，解析 `~` 与相对路径（相对 `--cd`/workspace），去重后规范化为绝对路径，写入 `CliApp.additionalDirs` 与系统提示。
- **工具边界**：`resolveWorkspacePath` 接受主 workspace 与所有 additional roots；相对路径仍从主 workspace 解析，绝对路径匹配任一允许根；符号链接按真实路径校验，逃逸到所有根之外仍拒绝。`Read`/`ListDir`/`Glob`/`Grep`/`Write`/`Edit`/`ApplyPatch`/`Shell` 全部生效。
- **CLI**：interactive（TUI 与 plain）和 `exec` 均支持；帮助文本、`--add-dir` 缺失目录错误、系统提示目录列表均有测试；无 OS 级沙箱的边界保持不变。

## 本轮结果（`/model`）

### cwd 交互偏好持久化

- `/model` 的模型、Provider、route、effort 和 `/permissions` 的权限 profile 保存到 `$CODINGX_HOME/workspaces/<sha256(real cwd)>/`；每个设置组独立原子写入，目录 0700、文件 0600。
- 启动读取 cwd 默认，优先级 CLI/env > cwd 偏好 > 会话恢复值 > TOML；显式启动覆盖不写回偏好，`default` 保留清除 effort 的语义，`/clear` 不删除偏好。
- Provider/route/profile 引用失效或文件损坏时告警并回退配置；会话变更已应用但目录保存失败时明确告警，保持当前 UI/Agent/rollout 一致。
- 验收覆盖同目录新会话、不同 cwd 与符号链接、临时覆盖、旧会话恢复、跨 Provider 凭证选择、自定义模型、并行写入不同设置组以及保存失败。

### 模型面板后的队列卡住与 MetaBar 截断修复

- 本地 `/model`、`/permissions` 面板记录打开前的执行状态：空闲时打开，关闭后恢复 idle；turn 中的问题/审批关闭后恢复 working，重复清理不会虚构运行中的 turn。
- 模型选择保存期间的输入暂存队列，成功或失败后消费；覆盖确认、取消、保存失败、权限面板及快速连续输入的回归路径。
- MetaBar 不再把模型限制为行宽的 25%；优先显示完整模型名和 effort，目录/标题使用剩余空间，只有模型与 effort 超过整行时才裁剪；覆盖 40/80/120 列及宽字符。
- 验证：typecheck、61 个文件 / 740 项测试通过；包括选择后的下一条消息实际启动 turn、保存期间的队列恢复及真实运行中问题/审批的状态保持。

### 跨 Provider 手动模型切换修复

范围：`/model` 列出所有已配置的 route target，并随模型选择切换对应 Provider。每次请求仍使用一个明确目标；自动 failover、weighted、round-robin 保持 M5 边界。

任务与验收：

- [x] 统一候选解析，包含 provider/model/route；同名模型在面板显示 Provider，可用 `provider/model` 明确指定。
- [x] 选择时按需加载目标 Provider 凭证并创建客户端；凭证加载或会话保存失败时保持原设置，cwd 偏好保存失败时保留本次变更并告警，凭证不进入 rollout。
- [x] TUI/plain 共用切换链路；`model.changed` 保存 Provider/route，resume/fork 恢复实际请求目标。
- [x] 使用两个本地假 SSE 端点覆盖模型列表、切换、effort、恢复和失败处理；typecheck 与 61 个文件 / 728 项测试通过。

- 测试：52 个文件、564 项全部通过（typecheck 通过）。
- **`/model`**：TUI 无参数时打开模型 → effort 两步选择面板（所有 Provider 的配置候选 + 自定义模型名，取消不修改）；plain 无参数显示当前值及用法。`/model --show` 查看；`/model <model>` 切模型并保留 effort；`/model <model> <effort>` 或 `/model <model> --effort <level>` 同时设置；`/model --effort <level>` 只改 effort；`default`/`off`/`none`/`auto` 清除覆盖。TUI 与 `--plain` 均支持直接命令，运行中的 turn/本地命令期间拒绝修改；TUI 通过 notice 显示模型与 effort，meta 行在模型名旁显示选中的档位。
- **启动推理强度**：`--reasoning-effort` / `CODINGX_REASONING_EFFORT` / `[model].reasoning_effort` 支持 `low|medium|high|xhigh|max|default`；exec/plain/TUI 共用解析与请求链路。选择经 SessionStore 保存，resume/fork 时显式 CLI/env 优先于保存值，保存值优先于配置默认；保存的 default 不会被配置重新开启。
- **启动推理强度验收（2026-10-30）**：typecheck、60 个测试文件 / 717 项测试、build 均通过；本地假 SSE 覆盖各档位请求、default 不发送参数、无效输入拒绝、配置分层、resume 覆盖及 fork 恢复。
- **请求链路**：`ModelRequest.reasoningEffort` 由 `buildModelRequest` 透传；Anthropic Messages 映射为 `output_config.effort`（不发送时使用 provider 默认）。`AgentLoop.setModel` 同步更新 `ProviderRouter.selection`，下一 turn 与压缩摘要立即使用新模型。
- **持久化与 resume**：每次变更写入 `model.changed`（含 model/provider/route，可选 reasoningEffort）；`latestModelSelection` 在 TUI/plain 的 resume 前恢复模型、Provider、route 与 effort；`codingx log` 可读该事件。
- 新增测试：`/model` 解析、TUI/plain 命令与运行中拒绝、provider 请求体、router/AgentLoop 切换、resume 后请求恢复、模型/effort 状态与历史解析。


## 编辑 Diff 与工具命名（2026-10-31）

- [x] 模型可见文件工具命名为 `Read`、`Write`、`Edit`，同步策略分类、系统提示、工具描述与测试；旧 `ReadFile` 会话继续恢复已读状态和探索摘要。
- [x] `Write` / `Edit` / `ApplyPatch` 基于操作前后内容生成结构化 Diff，随 `tool.result.meta` 写入现有 SessionStore，不进入模型工具结果正文。
- [x] 连续成功编辑显示 `Edited N files (+新增 -删除)`，按路径聚合并累计各次操作计数；失败/运行中工具保持独立结果。
- [x] 文件行号、红绿整行背景、代码词法着色、保留缩进的宽字符换行；每文件默认 3 行预览，Ctrl+O 展开所有保留的变更，resume 还原。
- [x] 每文件最多保留 400 条变更行 / 64,000 字符；差异计算设工作量上限，大规模重写回退为替换区间并提示，计数对应该替换表示。无末尾换行变更可见。

## 可配置 Tips（2026-10-31）

- [x] `/tips` 本地选择面板：浏览配置列表、换行预览与翻页、确认后填入输入框并切换本次运行的提示；选择不自动发送、不写入会话或修改全局配置，用户可编辑后提交。
- [x] 输入框为空时 Tab 填入当前 Tip，支持空闲和任务运行中；已有输入时保留命令补全与排队行为。
- [x] TUI 启动读取 `$CODINGX_HOME/tips.json`，缺失时生成默认提示；支持自定义列表、关闭和空列表，格式错误时告警并保留原文件。
- [x] 每次启动选取一条提示，在 StatusBar 正下方以 `  └ Tip: ...` 固定显示；空闲和任务运行中均可见，长提示按宽字符边界截断，小窗口隐藏，保持输入框和菜单可用。
- [x] 覆盖首次生成、重启读取、关闭、损坏回退、终端控制字符过滤，以及任务运行/滚动/清空后的固定位置；默认/恢复历史下提示只显示一次且不进入原生历史，不写 rollout 或模型上下文。

## cwd 隔离（2026-10-30）

- [x] 输入历史和新会话分别写入 `input-history/<cwd-name>/` 与 `sessions/<cwd-name>/`，真实 cwd 的路径分隔符替换为 `-` 作为可读名称；每个 cwd 独立保留 200 条输入。
- [x] 嵌入式 SessionStore 与共享 sessiond 的 CLI 连接均限制当前 cwd，覆盖列表、continue/resume/fork、log、show/watch 与 prune，拒绝其他目录的显式 ID。
- [x] 旧平铺 rollout 按 header.cwd 读取；旧全局输入历史不自动导入。子目录独立，符号链接共享。
- [x] sessiond 握手声明 cwd 隔离能力；旧 daemon 走现有空闲替换流程，持有租约时拒绝自动替换。
- 验收：typecheck、62 个测试文件 / 759 项测试、build 和 CLI 版本冒烟均通过；覆盖 cwd 隔离、旧数据、符号链接、跨目录 ID 拒绝、prune 范围及旧 daemon 替换。

- 可读 cwd 目录：输入历史、会话、目录偏好统一使用 `-Users-red-workspace-codingx-harness` 格式；旧哈希目录兼容读取，归属标记与编号后缀防止重名混用，sessiond 握手检查新布局能力。
- 可读目录验收：typecheck、63 个文件 / 764 项测试、build 与 CLI 版本冒烟通过；新增覆盖可读名称、长 Unicode 路径、并发重名隔离和旧哈希数据兼容。
