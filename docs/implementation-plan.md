# M1 实施计划（最小可用循环）

当前 P0–P2 增量工作见 [八项能力实施拆分](implementation-plan-p0-p2.md)。下文保留 M1 历史验收状态。

后续增量：受管进程 `Process` 已按 [任务拆分与边界](processes.md) 提前实现。
支持会话内跨 turn 的启动、列表、日志读取与停止；复用现有权限/沙箱，退出时回收进程组。

依据 [roadmap.md](roadmap.md) 的 M1 范围，将实现拆分为可独立验证的小任务。每完成一个任务，更新下方状态并跑对应测试。M0 文档描述的是**目标态**；本计划只覆盖 M1 已落地的子集，未实现的能力在「M1 的临时约束」中列出，避免骨架式交付。

## 范围

M1 结束时可以在真实仓库中完成 **读文件 → 改文件 → 跑命令/测试** 的闭环：

```bash
npm run build
export API_KEY=...
node bin/codingx.js exec "把 src/util.ts 里的 foo 重命名为 bar 并跑测试"
npm test
```

## 任务与验收

状态：`TODO` / `DOING` / `DONE`。每个任务都以「可运行 + 有测试」为完成标准。T01–T16 全部完成。

| ID | 任务 | 交付物 | 验收 | 状态 |
| --- | --- | --- | --- | --- |
| T01 | 项目脚手架 | `package.json`、`tsconfig.json`、`tsup.config.ts`、`vitest.config.ts`、`bin/codingx.js` | `npm run build`、`npm run typecheck`、`npm test` 均可执行 | DONE |
| T02 | 核心契约 | `src/providers/types.ts`、`src/util/errors.ts`、`src/util/tokens.ts`、`src/util/ids.ts` | 类型可被 Provider/Agent/Tool 共用；错误有稳定 code；ID 符合 12 位 base36 | DONE |
| T03 | 配置加载 | `src/config/`：schema、默认值、TOML 四层合并、项目配置限制 | 全局/项目/环境变量覆盖顺序正确；项目配置无法定义 provider / sessiond / session.dir | DONE |
| T04 | 凭证与脱敏 | `src/util/auth.ts`、`src/util/redact.ts` | 从 env 或 `auth.json` 读 key；rollout 落盘前命中常见密钥模式被替换 | DONE |
| T05 | SessionStore | `src/session/`：事件信封、JSONL 单写者、文件锁、seq、replay、状态推导、`session.end` | create/append/replay/end 可往返；seq 单调；双写被锁拒绝；半行被忽略 | DONE |
| T06 | 子进程执行层 | `src/exec/`：spawn + 进程组、超时 SIGTERM→SIGKILL、有界输出、env 白名单 | 正常/非零/超时/中断均返回结构化结果；凭证变量不进入子进程 | DONE |
| T07 | 工具注册表 + 文件工具 | `src/tools/`：`Read`、`ListDir`、`Edit`、zod→JSON Schema | 行号/offset/limit、目录树、唯一替换、先读后写、越界路径拒绝 | DONE |
| T08 | Shell 工具 | `Shell` 工具接入 exec 层 | stdout/stderr/退出码/超时回填；输出裁剪且提示截断 | DONE |
| T09 | Anthropic Provider | `src/providers/anthropic/`：SSE 解析、tool_use 流、usage、prompt caching、HTTP 错误分类 | 假 SSE 服务覆盖文本、工具调用、错误映射、分块/CRLF；请求含 system/tools cache_control | DONE |
| T10 | ProviderRouter | `src/routing/`：单目标解析、pin、首个内容事件前重试 | `--provider` / `--model` 收窄目标；429/5xx 在首内容前重试；首内容后不重试 | DONE |
| T11 | 上下文组装 | `src/agent/system-prompt.ts`、`src/agent/context.ts` | 注入 cwd/平台/git/AGENTS.md 快照；工具定义顺序稳定以保住 prompt cache | DONE |
| T12 | Agent 循环 | `src/agent/loop.ts`、`turn.ts`、`events.ts` | 单 turn 串行工具；tool 错误以 is_error 回填；turn.start/end、assistant、tool.call/result 全部落 rollout；maxSteps / abort 生效 | DONE |
| T13 | 纯文本输出 + CLI exec | `src/ui/plain.ts`、`src/cli/`、`src/main.ts` | `codingx exec` 端到端；stdout 只出最终文本；`--json` 输出 JSONL；退出码 0/1/2/130 | DONE |
| T14 | 交互模式与回放 | 交互式逐行 REPL、`codingx log --session` | 多轮对话复用历史；`log` 可离线回放 JSONL | DONE |
| T15 | 测试补齐 | 单元 + 假 Provider 集成 + 临时工作区 E2E | 覆盖配置、SSE、路由、工具、会话、循环、CLI；CI 无网络依赖 | DONE |
| T16 | 文档与验收 | README / roadmap / 本计划状态 | 构建、typecheck、全部测试通过；E2E 演示读改跑闭环 | DONE |

## 依赖顺序

```text
T01 ─ T02 ─┬─ T03 ─ T04 ─┐
           ├─ T05 ────────┤
           ├─ T06 ─ T08 ──┤
           └─ T07 ────────┤
T02 ─ T09 ─ T10 ─ T11 ─ T12 ─ T13 ─ T14
                                      └─ T15 ─ T16
```

T03/T05/T06/T07 之间互不依赖，可并行实现；T09 依赖 T02 的消息与工具 schema 契约。

## M1 的临时约束（M2/M3/M5 解决）

- **单目标路由**：`ProviderRouter` 目前解析出多个候选时要求 `--provider` / `--model` 收敛为一个；multi-target 的 failover / weighted / round-robin 在 M5 实现。配置示例中的 secondary target 在 M1 会得到明确错误而不是静默忽略。
- **嵌入式会话存储**：M2 的 sessiond 尚未实现；M1 固定使用带文件锁的进程内存储。`sessiond.enabled = true` 会提示「M1 未实现，退回嵌入式存储」，不伪装成跨 CLI。
- **无审批 / 无沙箱**：策略引擎与 Seatbelt/Landlock 属于 M3。M1 的 Shell 继承配置的 env 白名单，但**不提供 OS 级隔离**；不要在不可信仓库里使用。文件工具默认限制在 workspace 内（可用 `--add-dir` 显式追加可写目录），作为过渡护栏；`--yolo` / `--allow-dangerously-skip-permissions` 会关闭这层应用层限制并告警，但不会关闭尚未实现的审批与沙箱。
- **无压缩**：上下文压缩属于 M2；M1 超长上下文由 Provider 错误暴露，不静默截断历史。
- **无 TUI**：M2 自研 Terminal；M1 使用逐行纯文本。`--plain` 是默认形态。
- **resume / fork**：M2；M1 通过 `log` 回放验证 rollout 可重建。

## 验证清单

- [x] `npm run typecheck`
- [x] `npm test`（15 个测试文件 / 149 个测试）
- [x] `npm run build`（`dist/main.js` ≈ 126 KB；依赖外置）
- [x] `node bin/codingx.js --help` / `--version`
- [x] 假 Provider E2E：Read → Edit → Shell 校验 → 最终文本
- [x] 构建产物 E2E：直接运行 `bin/codingx.js`，验证文件修改、退出码、rollout、session.end 与锁释放
- [x] rollout 含 `session.start` / `turn.start` / `tool.call` / `tool.result` / `turn.end`，`log` 可读回
- [ ] 真实 Provider 手工冒烟（需要 `API_KEY`，不进 CI）

## 实施结果（2026-10-25）

- 任务 T01–T16 全部完成；M1 可运行、可验证。
- 测试：15 个文件、149 项全部通过；使用本地假 Anthropic HTTP/SSE 服务，无外网依赖。
- 构建：`npm run build` 通过，`bin/codingx.js` 冒烟通过。
- 验收路径：`Read(src/util.ts) → Edit(foo→bar) → Shell(grep) → 最终回答`；rollout 追加 `session.start` … `session.end`，锁在退出后释放。
- 交付面：`codingx exec`、逐行交互、`--json`、`codingx log`、单目标 Anthropic Provider、4 个内置工具、嵌入式 JSONL SessionStore。
- 下一里程碑：M2（自研 TUI、sessiond、上下文压缩、resume/fork、更多工具）。
