# Plugin：StatusBar 与 DeepSeek 费用

本增量扩展 M2 的 StatusBar，不引入插件市场、MCP 宿主或多目标路由。

## 范围与协议

- 用户通过全局 `[status_bar]` 启用一个 Plugin；项目配置不能启动插件。
- 从 `$CODINGX_HOME/plugins/<id>/manifest.yaml` 读取身份与能力。清单版本为 1，首个协议为 `codingx.status-bar/v1`。
- 第一版提供 `decorate` 模式，在稳定字段 `total_tokens` 后追加带样式的文本；宿主保留关键状态、负责宽字符布局及控制字符过滤。
- stdin 为 JSON 状态快照，stdout 为 JSON segments；外部命令不进入渲染同步路径。执行有超时、有界输出、环境白名单、退出清理和旧结果丢弃。
- 插件以当前用户权限执行，与用户全局 hooks 一样属于显式信任的本地代码，不是 OS 沙箱。
- 每次模型请求通过 SessionStore 保存 `usage.recorded`，包括请求 ID、模型、Provider、公开服务地址 origin、开始时间、分项 token 用量及完整性。包含压缩请求；恢复与 fork 重放记录，clear 清空。
- DeepSeek 插件只为官方 origin 与支持的模型套用官方价格。价格采用有版本的本地快照，保留历史版本；未知价格、时段或用量不能按零计算。显示人民币 token 费用估算，不含独立 Search/Fetch 费用。

## 任务与验收

- [x] Turn Summary 增量：manifest 声明 `codingx.turn-summary/v1`，逐轮输入与样式响应、费用总额和分项明细；按 turnId 关联恢复记录、异步失败回退、clear/切换会话丢弃旧结果，窄屏换行。升级已安装的 deepseek-cost 时保留 pricing.json 历史快照。

- [x] CLI 安装增量：`plugin install <内置名称|本地目录> [--enable]`、`plugin enable <id>`；校验清单、不执行脚本、不覆盖已有价格，启用时保留全局 TOML 的其他内容。源码与构建产物均验证从任意 cwd 安装内置插件。

- [x] 清单与配置校验、进程执行和生命周期
- [x] 请求用量记录、恢复及数据完整性
- [x] StatusBar 样式片段与窄屏降级
- [x] DeepSeek 插件、官方价格快照与显式更新命令（不在渲染路径联网）
- [x] 本地假进程/Provider 测试，typecheck、test、build

测试不得访问真实 API 或外网。验收包含切换模型、缓存拆分、跨时段、重复刷新、resume/clear、超时/非法输出、中文窄屏和凭证不传入子进程。

2026-10-31：`npm run typecheck`、`npm run build` 与 `npm test -- --maxWorkers=2` 通过（76 文件、903 测试，其中 22 项插件测试）。打包预检确认附带 manifest、插件与价格文件。默认并发下现有 `scoped-permissions` 的 150ms 进程启动等待断言出现时序失败，单独及限制为 2 workers 的全量测试通过。

安装命令增量：typecheck、build、39 项插件/安装测试通过；构建后的 CLI 在临时 HOME、无 Provider 配置、不同 cwd 下完成安装/启用与重复安装冒烟。此次全量回归为 913 通过、7 失败；失败位于当前工作区的工具注册顺序与读取跟踪测试，未改动这些并行开发中的实现。

Turn Summary 增量：typecheck、build、`npm test -- --maxWorkers=2` 通过（81 文件、961 测试）。新增 9 项协议/逐轮计费/样式换行/异步生命周期测试及 1 项 xterm 原生滚动历史测试；验证合计、数量×单价、小计、跨时段分组、历史模型不受当前模型影响、超时回退及 clear 后旧结果丢弃。

deepseek-cost 0.2.1：按用户要求，部分缺失只展示可计价金额的近似值，不追加问号或缺失提示；完全无法计价时隐藏金额。Turn Summary 合计与明细统一使用摘要文字的默认前景色和 dim 样式。typecheck、build、31 项相关测试通过；已安装插件同步更新并保留价格快照。
