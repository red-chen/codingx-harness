# AGENTS.md

本文件是本仓库的协作约定；运行 codingx 时会被注入系统提示。

## 构建与测试

- 使用 npm（本仓库未使用 pnpm）。
- 提交前执行：`npm run typecheck && npm test`。
- 产物：`npm run build`，入口 `bin/codingx.js` → `dist/main.js`。
- 端到端测试使用本地假 Anthropic SSE 服务，不需要真实 API Key 或网络。

## 代码约定

- ESM + NodeNext；相对 import 必须带 `.js` 后缀。
- TypeScript strict；新增公共接口先定义类型，错误使用 `src/util/errors.ts` 中的稳定 code。
- 工具入参使用 zod，并通过 registry 生成 JSON Schema；工具业务失败返回 `isError: true`，不要抛异常。
- 会话只能通过 `SessionStore` 追加；不要绕过 rollout 单写者。
- 凭证不进入配置文件、日志、rollout 或子进程环境。
- 工具与 Provider 的测试用本地假实现 / 回环 HTTP 服务驱动，不访问外网。

## 范围

- **当前 CLI 仅需支持 macOS。** 开发、测试与验收均以 macOS 为目标；Linux / Windows 兼容、沙箱与分发不属于当前范围，也不作为当前里程碑完成的前置条件。除非用户明确要求扩展平台，不要主动实现跨平台支持。

- 当前实现边界见 [docs/implementation-plan.md](docs/implementation-plan.md)。
- 不要在本仓库提前实现 TUI、sessiond、审批/沙箱、MCP 或多目标路由；这些属于 M2/M3/M4/M5，需要先更新文档与任务拆分。
- 设计目标态见 `docs/`，实现状态的唯一来源是 README、roadmap 与 implementation-plan。
