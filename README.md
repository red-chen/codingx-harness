# codingx-harness

> 终端里的 AI 编码 Agent —— Node.js + TypeScript 实现，交互形态参考 Codex CLI。

`codingx` 是一个跑在终端里的编码 Agent。你用自然语言描述任务，它在当前仓库里读代码、改文件、执行命令、跑测试，循环到任务完成。它不依赖 IDE，一条命令即可在本地、SSH 会话或 CI 中运行。

**状态：设计阶段。** 本仓库目前只包含设计文档，代码尚未落地。

## 设计目标

| 目标 | 说明 |
| --- | --- |
| 终端优先 | 全屏 TUI 与纯文本两种形态，SSH / tmux / CI 均可运行 |
| 可审计 | 每次模型调用与工具执行都写入 append-only 的 JSONL 会话日志 |
| 默认安全 | 写操作与命令执行同时受审批策略和操作系统沙箱约束 |
| 可扩展 | 工具、模型 Provider、MCP Server 均为插件式注册 |
| 单文件分发 | `npx codingx` 即可启动，无本地构建步骤 |

## 非目标

- 不做 IDE 插件与图形界面
- 不做多用户 / 服务端部署形态，定位是本地单用户进程
- 不自研模型，只做 Harness 层

## 核心概念

| 概念 | 含义 |
| --- | --- |
| **Session** | 一次完整会话，对应一个 JSONL rollout 文件，可恢复（resume）与分叉（fork） |
| **Turn** | 一轮「用户输入 → 模型推理 → 工具调用 → 收敛」的完整过程 |
| **Tool Call** | 模型发起的一次结构化工具请求，由工具层执行并回填结果 |
| **Approval** | 对写操作 / 命令执行的放行决策，由审批策略与用户交互共同决定 |
| **Sandbox** | 操作系统级的文件系统与网络隔离层，是审批之外的第二道防线 |
| **Rollout** | 会话事件的持久化记录，同时是审计日志与上下文重建的数据源 |

## 快速开始

```bash
# 交互模式（规划中）
npx codingx

# 单次执行，适合 CI / 脚本
npx codingx exec "修复 npm test 里失败的用例"

# 恢复上一次会话
npx codingx --continue
```

配置模型凭证：

```bash
export ANTHROPIC_API_KEY=sk-ant-...
# 或运行 codingx login，凭证写入 ~/.codingx/auth.json
```

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | 分层架构、模块职责、核心接口、Turn 数据流 |
| [docs/agent-loop.md](docs/agent-loop.md) | Turn 生命周期、上下文管理、压缩与错误恢复 |
| [docs/tools.md](docs/tools.md) | 工具清单、工具接口约定、审批粒度 |
| [docs/security.md](docs/security.md) | 审批策略、沙箱模式、网络与命令白名单 |
| [docs/config.md](docs/config.md) | 配置文件、Provider 配置、AGENTS.md 约定 |
| [docs/roadmap.md](docs/roadmap.md) | 里程碑与交付顺序 |

## 技术选型

| 领域 | 选择 | 理由 |
| --- | --- | --- |
| 运行时 | Node.js ≥ 20（ESM） | 原生 fetch、AbortController、稳定的 async 语义 |
| 语言 | TypeScript strict | 工具入参、事件类型、Provider 接口都靠类型收敛 |
| TUI | Ink（React for CLI） | 声明式渲染，流式增量更新比手写 ANSI 状态机可维护 |
| CLI 解析 | commander | 子命令 + 选项足够，生态成熟 |
| 测试 | Vitest | 与 ESM/TS 零配置，快照测试适合渲染层 |
| 构建 | tsup | 单文件 bundle，启动快，发布产物简单 |
| 校验 | zod | 工具入参 schema 与运行时校验复用同一份定义 |

## 仓库结构

```text
codingx-harness/
├── bin/
│   └── codingx.js          # 可执行入口（薄壳，转发到 dist）
├── src/
│   ├── cli/                # 参数解析、子命令、退出码
│   ├── tui/                # Ink 组件、输入处理、渲染
│   ├── agent/              # 主循环、turn 编排、上下文组装
│   ├── providers/          # 模型适配（Anthropic / OpenAI 兼容）
│   ├── tools/              # 工具实现与注册表
│   ├── policy/             # 审批策略、命令判定
│   ├── sandbox/            # 平台沙箱适配（seatbelt / landlock）
│   ├── exec/               # 子进程启动、超时与进程组回收
│   ├── mcp/                # MCP 客户端与外部工具注册
│   ├── session/            # rollout 读写、resume、fork
│   ├── config/             # 配置加载与合并
│   └── util/               # 日志、token 估算、错误类型
├── tests/
└── docs/
```

## 里程碑

见 [docs/roadmap.md](docs/roadmap.md)。当前处于 **M0（设计对齐）**，接口定义见各设计文档。

## License

MIT
