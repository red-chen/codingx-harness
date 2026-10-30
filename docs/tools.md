# 工具系统

当前文件工具名称为 `Read`、`Write`、`Edit`（旧会话中的 `ReadFile` 仍可恢复已读状态）。
`Write`、`Edit` 和 `ApplyPatch` 的成功结果在 `meta.fileDiffs` 中附带有界的文件变更快照，
供 TUI 的 `Edited` 视图和会话回放使用，不回传模型。每个文件包含路径、增删行数、
带原/新行号的变更行以及截断/粗略替换标记；计数聚合的是各次编辑操作，非整个 turn 的净 Git Diff。
TUI 默认每文件预览 3 行，Ctrl+O 展开保留的变更；无快照的旧结果继续显示原工具输出。

## 工具接口

```ts
import type { z } from 'zod';
import type { ApprovalHandler, PolicyRuntime } from '../policy/types.js';

export interface ToolDef<S extends z.ZodType = z.ZodType> {
  /** 模型可见的名字，PascalCase */
  name: string;
  /** 给模型看的说明：做什么、什么时候用、什么时候别用 */
  description: string;
  /** 入参 schema，同时用于生成 JSON Schema 和运行时校验 */
  schema: S;
  /** 只读工具可与其他只读工具并发执行 */
  parallelSafe: boolean;
  /** 审批粒度，见 security.md */
  approval: 'none' | 'on-write' | 'always';
  execute(input: z.infer<S>, ctx: ToolContext): Promise<ToolResult>;
}

export interface ToolResult {
  content: string;
  isError?: boolean;
  /** 结构化元数据，供 TUI 渲染与 rollout 审计，不回传给模型 */
  meta?: Record<string, unknown>;
}

export interface ToolContext {
  /** 主 workspace 根；相对路径始终从这里解析 */
  cwd: string;
  /** --add-dir 追加的可写根（已规范化的绝对路径） */
  additionalDirs?: readonly string[];
  /** --yolo / :danger-full-access 时为 true：跳过文件路径限制 */
  yolo?: boolean;
  /** S1 接入：Permission profile + approval policy */
  policy?: PolicyRuntime;
  /** M3.3 接入：OS 沙箱 backend（macOS Seatbelt） */
  sandbox?: SandboxBackend;
  /** TUI/plain 审批回调；无回调时越界 fail closed */
  approve?: ApprovalHandler;
  signal: AbortSignal;
  readTracker: ReadFileTracker;
  maxOutputChars: number;
  shell: { env: Record<string, string>; timeoutMs: number };
  plan?: PlanController;
  /** 仅当 UI 能在一轮中途收集答案时提供（TUI） */
  ask?: AskHandler;
  /** 本会话加载的技能；没有技能时为 undefined 或空注册表 */
  skills?: SkillToolContext;
}
```

> S1 已给 `ToolContext` 接入 `policy` 与 `approve`；S3 加入 `sandbox`，`Shell` 用它在策略放行后包装 `sandbox-exec`。工具用结构化 `Action` 描述副作用，`approval` 字段只作为 M2 兼容保留。S2 已由 TUI/plain 交互提供 `approve`。设计见 [permissions.md](permissions.md)。

约定：

- `description` 是模型选工具的唯一依据，必须写清楚边界。宁长勿短。除了「做什么」，还要写「什么时候不要用这个工具」和「调用被拒绝或失败后该怎么办」——否则模型容易原样重试同一次调用。
- 入参用 zod 定义，JSON Schema 由 `zod-to-json-schema` 生成，避免两份定义漂移。
- `approval` 只是 M2 的默认粒度：`none` 无需审批（只读），`on-write` 仅在写时询问，`always` 每次询问。M3 起由 `Action` + Permission profile + Approval policy 统一判定，见 [permissions.md](permissions.md)。
- `execute` 不抛异常处理「业务失败」（文件不存在、命令非零退出），统一走 `isError: true` 回填；只有真正的程序错误才 throw。
- 输出默认裁剪到 30k 字符，超出部分保留头尾并标记省略行数。
- 文件路径由 Permission profile 决定：默认 `:workspace` 覆盖 `cwd`、`--add-dir` 与临时目录；命名 profile 可追加根。相对路径从 `cwd` 解析，符号链接按真实路径校验；敏感路径（`~/.ssh`、`.env*` 等）默认 deny。`--yolo` 跳过这一层并同时关闭 OS 沙箱，不影响读后写等完整性检查。macOS 上 `Shell` 还会由 Seatbelt 再执行一次内核级边界检查。
- 工具返回给模型的路径统一相对主 workspace（跨盘时为绝对路径），因此可以原样作为下一次工具调用的 `path` 入参。

## 内置工具清单

### 文件读取

| 工具 | 入参 | 说明 |
| --- | --- | --- |
| `Read` | `path`, `offset?`, `limit?` | 按行读取，带行号；默认最多 2000 行 |
| `ListDir` | `path`, `depth?` | 树状列出目录，自动忽略 `.gitignore` 与二进制 |
| `Glob` | `pattern`, `path?` | 文件名匹配，返回按修改时间排序的路径列表 |
| `Grep` | `pattern`, `path?`, `glob?`, `context?` | 内容搜索，优先调用 `rg`，缺失时退化为内置实现 |

### 文件写入

| 工具 | 入参 | 说明 |
| --- | --- | --- |
| `Write` | `path`, `content` | 整文件写入；写入前检查是否已存在并提示覆盖 |
| `Edit` | `path`, `old_string`, `new_string`, `replace_all?` | 精确字符串替换；`old_string` 必须唯一匹配，否则报错让模型重试 |
| `ApplyPatch` | `patch` | unified diff 形式的多文件补丁，用于批量改动 |

`Edit` 与 `ApplyPatch` 都要求**先读后写**：工具会检查该文件在本会话中是否被读取过，未读取则拒绝并提示先调用 `Read`。这条约束显著降低了模型凭想象改文件的情况。

### 执行

| 工具 | 入参 | 说明 |
| --- | --- | --- |
| `Shell` | `command`, `cwd?`, `timeout_ms?`, `description?` | 执行命令，返回 stdout / stderr / 退出码 |
| `ProcessStart` | `command`, `cwd?`, `description?` | 启动会话内受管进程，返回 processId；复用 Shell 权限/沙箱 |
| `ProcessList` | 无 | 查询当前 CLI 会话进程及最近退出状态 |
| `ProcessRead` | `process_id`, `cursor?`, `max_chars?`, `wait_ms?` | 读取有界合并日志与状态，按 nextCursor 增量读取 |
| `ProcessStop` | `process_id` | TERM → KILL 回收进程组，可重复调用 |

Process 跨 turn 存活，在 `/clear` 和正常退出时清理；不会从历史 PID 恢复监管。
用户可通过 `/process`、`/process logs <id>`、`/process stop <id>` 直接管理，无需模型调用。
running 不等于服务已就绪；HTTP server 需要 profile 允许网络。详见 [受管进程](processes.md)。
PTY / stdin 交互与跨 CLI 托管仍待后续实现。

`Shell` 的默认超时 120s，超时后向整个进程组发 `SIGTERM`，再等 5s 后 `SIGKILL`。工作目录受 Permission profile 约束；策略层会解析命令、拦截已知网络命令/重定向/硬拒绝，macOS 上再交给 Seatbelt（默认 deny、写入限 profile 根、网络默认 deny）。Linux 目前没有 OS 级沙箱，任意程序仍可绕过命令启发式；`--yolo` 在 macOS 上也跳过 Seatbelt。

Git hooks 不受 `Shell` 工具额外拦截：仓库已安装的 hooks 会由 git 自身执行；`.git/hooks` / `.git/config` 写默认拒绝，需要安装 hooks 时使用 `:workspace-git-hooks` 或 `:git_hooks` / `:git_config` 作用域。

交互模式还可以直接输入 `!command`（例如 `!pwd`）。这条路径不经过模型，但复用同一套 Shell 策略、审批与沙箱执行逻辑（`src/tools/shell-exec.ts`），输出只写 `local.command` / `local.result`，不会进入模型消息历史。

S5 起 `Shell` 增加提权字段（仅在沙箱拒绝后由模型重试时使用；S1 尚未实现）：

```ts
interface ShellExtras {
  sandbox_permissions?: 'use_default' | 'with_additional_permissions' | 'require_escalated';
  justification?: string;          // 给用户看的理由，不是授权凭证
  additional_permissions?: {
    file_system?: { read?: string[]; write?: string[] };
    network?: { enabled?: boolean; domains?: string[] };
  };
  prefix_rule?: string[];          // 请求会话级命令前缀批准
}
```

沙箱拒绝 → 结构化 `SANDBOX_DENIED` → 模型带理由重试 → 用户批准 → 本次调用放宽/无沙箱执行。详见 [permissions.md](permissions.md) 的提权章节。

### 其他

| 工具 | 说明 |
| --- | --- |
| `UpdatePlan` | 维护任务清单，模型用它显式记录多步计划，TUI 实时展示 |
| `AskUserQuestion` | 向用户提 1–4 个问题并等待回答；TUI 弹出选择面板，无交互运行时返回 `is_error` |
| `Skill` | 按名字加载本地技能（`SKILL.md`）的完整说明，系统提示只放目录 |
| `WebFetch` | 抓取 URL 并转 markdown；默认关闭，受 `[web]` 域名白名单与网络策略约束（M4） |
| `Task` | 派发子 Agent（M5） |
| `mcp__<server>__<tool>` | 从 MCP Server 动态注册的外部工具 |

## 用户提问（`AskUserQuestion`）

模型在信息不足、且答案会改变下一步动作时，用这个工具向用户提问，而不是猜。入参是 1–4 个问题：

```json
{
  "questions": [
    {
      "id": "approach",
      "header": "方案",
      "question": "这次改动优先速度还是兼容性？",
      "options": [
        { "label": "速度", "description": "只改一个文件，不补测试" },
        { "label": "兼容", "description": "先补测试，再改实现" }
      ],
      "multi_select": false
    }
  ]
}
```

- `options` 可选（2–6 个）；省略时返回自由文本。`multi_select` 省略或为 `false` 时为单选，设为 `true` 时为多选。单选 Enter 确认当前项；多选 Space / 数字键切换勾选，Enter 提交。
- 工具把答案格式化为 `selected: ...` / `custom: ...` 回填，并把结构化答案放进 `meta.answers`。
- 用户按 `Esc` 取消时返回 `is_error: true`（`meta.dismissed`），提示模型改用普通文本继续，不要重复提问；正在输入自由文本时，第一次 `Esc` 只退出输入，再按一次才取消整组问题。
- 非交互运行（`exec`、纯文本 `--plain`）没有 `ctx.ask`，工具返回 `is_error`，避免阻塞 stdin。
- TUI 打开问题时状态行显示 `Awaiting answer`，turn 仍处于 `executing`；取消或中断会关闭面板。问题与答案本身通过常规 `tool.call` / `tool.result` 进入 rollout，可回放。
- 面板只根据工具调用的结构化字段绘制；transcript 里模型生成的文本不能伪造选项或改变顺序。

## Skills

技能是本地指令包，用于把领域流程（例如 Office 文档、发布检查）按需加载，避免把所有说明常驻上下文。

### 目录与优先级

```text
~/.agents/skills/<name>/SKILL.md          # 共享全局（其他 agent 工具也可读）
~/.codingx/skills/<name>/SKILL.md         # codingx 全局，覆盖同名共享技能
<project root>/.codingx/skills/<name>/SKILL.md   # 项目，覆盖同名全局技能
```

- 启动时依次扫描三个目录（缺失不报错），按名字建索引；后面的目录覆盖前面的同名技能并给出 warning，优先级为 项目 > `~/.codingx/skills` > `~/.agents/skills`。
- 系统提示只放 `# Skills` 目录（名字 + 一行描述）；模型判断任务匹配时调用 `Skill`，工具返回完整正文、`SKILL.md` 路径与 base directory。
- 正文中可以用相对路径引用技能目录下的补充文件。

### SKILL.md 格式

```markdown
---
name: office-docx
description: Create, read, edit and validate Word documents.
---

# Workflow

1. Read the existing document.
2. ...
```

- `name` 可省略，默认取目录名；只允许字母、数字、点、下划线、连字符。
- `description` 必填，会进入系统提示；支持单行、引号字符串与 `>` / `|` 块。
- 单文件上限 256 KiB；缺 description、名字非法、frontmatter 未闭合、正文为空都会被跳过并给出 warning。
- 正文超过工具输出上限（默认 30k 字符）时按通用规则保留头尾并标注截断；技能应保持精简。
- 索引在会话启动时加载，会话中途新增/修改技能需要重开会话。技能文件与 `AGENTS.md` 属于同一信任级别：只在可信仓库中使用项目技能。

### 当前限制

文件工具默认限制在 workspace 内；未通过 `--add-dir` 添加该目录时，**全局技能目录中的补充文件无法被 `Read` 读取**。需要引用补充文件时，把技能放在项目的 `.codingx/skills` 下，或用 `--add-dir` 显式加入技能目录。技能正文本身不受此限制（由 `Skill` 工具直接加载）。

## 工具输出的裁剪

不同工具的输出形态不同，裁剪策略也不同：

| 工具 | 策略 |
| --- | --- |
| `Shell` | 保留最后 200 行 + 首个错误块；截断时标注总行数 |
| `Read` | 超过 `limit` 时明确告知「文件共 N 行，已返回 A-B 行」 |
| `Grep` | 最多 100 条命中，超出提示缩小范围 |
| `ListDir` | 超过 500 个条目时折叠为目录统计 |

模型对「被截断了」这件事必须知情，否则会基于不完整信息做判断。

## 工具注册

```ts
const registry = new ToolRegistry();
registry.register(readFile, listDir, glob, grep);
registry.register(writeFile, editFile, applyPatch);
registry.register(shell, shellInteractive);
registry.register(updatePlan);

// MCP 在运行时追加
for (const server of config.mcp.servers) {
  await registry.registerMcp(server);
}

const schemas = registry.toJsonSchemas();  // 传给模型的 tools 数组
```

注册顺序不影响模型行为，但 `toJsonSchemas()` 的输出顺序应稳定（按注册顺序），以最大化 prompt cache 命中率——工具定义在请求前缀里，顺序变化会导致缓存失效。

## 自定义工具

用户可在 `~/.codingx/tools/*.js` 放置自定义工具模块，导出 `ToolDef` 数组，启动时自动加载。这条路径先于 MCP 存在，用于本地快速实验；跨进程、跨语言的需求交给 MCP。

加载自定义工具意味着执行任意代码，因此默认关闭，需在配置中显式开启 `tools.allow_custom = true`。
