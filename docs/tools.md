# 工具系统

## 工具接口

```ts
import type { z } from 'zod';

export interface ToolDef<S extends z.ZodType = z.ZodType> {
  /** 模型可见的名字，snake_case */
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
```

约定：

- `description` 是模型选工具的唯一依据，必须写清楚边界。宁长勿短。
- 入参用 zod 定义，JSON Schema 由 `zod-to-json-schema` 生成，避免两份定义漂移。
- `approval` 只是默认粒度：`none` 无需审批（只读），`on-write` 仅在写时询问，`always` 每次询问；策略层可收紧，见 [security.md](security.md)。
- `execute` 不抛异常处理「业务失败」（文件不存在、命令非零退出），统一走 `isError: true` 回填；只有真正的程序错误才 throw。
- 输出默认裁剪到 30k 字符，超出部分保留头尾并标记省略行数。

## 内置工具清单

### 文件读取

| 工具 | 入参 | 说明 |
| --- | --- | --- |
| `read_file` | `path`, `offset?`, `limit?` | 按行读取，带行号；默认最多 2000 行 |
| `list_dir` | `path`, `depth?` | 树状列出目录，自动忽略 `.gitignore` 与二进制 |
| `glob` | `pattern`, `path?` | 文件名匹配，返回按修改时间排序的路径列表 |
| `grep` | `pattern`, `path?`, `glob?`, `context?` | 内容搜索，优先调用 `rg`，缺失时退化为内置实现 |

### 文件写入

| 工具 | 入参 | 说明 |
| --- | --- | --- |
| `write_file` | `path`, `content` | 整文件写入；写入前检查是否已存在并提示覆盖 |
| `edit_file` | `path`, `old_string`, `new_string`, `replace_all?` | 精确字符串替换；`old_string` 必须唯一匹配，否则报错让模型重试 |
| `apply_patch` | `patch` | unified diff 形式的多文件补丁，用于批量改动 |

`edit_file` 与 `apply_patch` 都要求**先读后写**：工具会检查该文件在本会话中是否被读取过，未读取则拒绝并提示先调用 `read_file`。这条约束显著降低了模型凭想象改文件的情况。

### 执行

| 工具 | 入参 | 说明 |
| --- | --- | --- |
| `shell` | `command`, `cwd?`, `timeout_ms?`, `description?` | 执行命令，返回 stdout / stderr / 退出码 |
| `shell_interactive` | `command` | 长驻进程（dev server 等），返回会话句柄，后续可读取输出（M5） |

`shell` 的默认超时 120s，超时后向整个进程组发 `SIGTERM`，再等 5s 后 `SIGKILL`。命令在沙箱内执行，工作目录限制在 workspace 根。

### 其他

| 工具 | 说明 |
| --- | --- |
| `update_plan` | 维护任务清单，模型用它显式记录多步计划，TUI 实时展示 |
| `web_fetch` | 抓取 URL 并转 markdown；默认关闭，受 `[web]` 域名白名单与网络策略约束（M4） |
| `task` | 派发子 Agent（M5） |
| `mcp__<server>__<tool>` | 从 MCP Server 动态注册的外部工具 |

## 工具输出的裁剪

不同工具的输出形态不同，裁剪策略也不同：

| 工具 | 策略 |
| --- | --- |
| `shell` | 保留最后 200 行 + 首个错误块；截断时标注总行数 |
| `read_file` | 超过 `limit` 时明确告知「文件共 N 行，已返回 A-B 行」 |
| `grep` | 最多 100 条命中，超出提示缩小范围 |
| `list_dir` | 超过 500 个条目时折叠为目录统计 |

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
