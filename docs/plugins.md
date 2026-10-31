# Plugin 与 StatusBar

Plugin 由 `manifest.yaml` 声明能力和协议。当前提供 `codingx.status-bar/v1`：在累计 `tok` 后追加文本和样式。仅 TUI 执行插件命令，plain/JSON 模式不启动插件。

同一个已启用插件还可声明 `codingx.turn-summary/v1`，为 Transcript 中每轮执行摘要追加总额及分项明细。deepseek-cost 0.2.1 同时提供这两种能力，启用配置不变。

## 启用 DeepSeek 费用插件

安装并启用内置插件，一条命令即可，不需要配置模型或 API Key：

```sh
codingx plugin install deepseek-cost --enable
```

使用仓库源码时先 `npm run build`，再运行 `node bin/codingx.js plugin install deepseek-cost --enable`。

安装位置是 `$CODINGX_HOME/plugins/`（默认 `~/.codingx/plugins/`）。内置插件从 codingx 包内定位，与当前工作目录无关。`--enable` 将下面的选择写入全局 `config.toml`，保留原有设置、注释和超时参数；重启 TUI 生效。省略 `--enable` 则只安装文件。

```toml
[status_bar]
plugin = "deepseek-cost"
timeout_ms = 1000
refresh_ms = 1000
```

其中 timeout/refresh 为缺省值，启用命令仅设置 `plugin`。安装本地插件、启用已安装插件：

```sh
codingx plugin install ./my-plugin --enable
codingx plugin enable deepseek-cost
```

本地目录必须包含合法 `manifest.yaml`，安装时不执行插件代码、不下载依赖。当前只支持自包含的普通文件和目录，不支持目录内的符号链接或特殊文件，不提供 Git/npm/URL 下载。重复安装保留已有文件（包括历史价格），可用 `--enable` 重新选择该插件；这不是升级命令。无效 manifest 或全局 TOML 会明确报错，复制采用临时目录后重命名。`--json` 可输出安装结果。

重启 codingx，选择官方 DeepSeek Provider 的模型，即可显示：

```text
ctx 32k/1m · tok 128k · ≈¥0.1842
```

- Provider id 可任意命名，插件按 endpoint 的公开 origin `https://api.deepseek.com` 识别官方服务。第三方代理不套用官方价格。
- 显示当前会话已结束轮次（含中断轮次）的 DeepSeek token 费用估算，与累计 `tok` 在轮次结束时更新。包含压缩请求；切换模型后，历史用量仍按原模型计价。混合其他 Provider 时标注 `DS`，金额只覆盖 DeepSeek。
- 支持 Flash、V4 Pro、官方旧 Flash 别名及 Anthropic `claude*` 映射。费用仅用于粗略参考：部分用量缺失时显示能计价部分的 `≈¥…`，不追加问号或缺失提示；完全没有计价依据时不显示金额，不将未知费用当成零。
- 根据请求开始时间按北京时间估算峰谷价格；跨越计价边界的长请求仍按开始时间估算。周末一律闲时，附带 2026 年假期表；未来年份缺少假期数据时，可能受假期影响的高峰请求不计入估算。
- 仅统计 token，不包含独立 Search/Fetch、充值优惠或余额抵扣，不查询账户、不需要额外 API Key。实际扣费以服务端账单为准。
- 窄屏先隐藏插件片段，保留原状态栏。移除 `[status_bar]` 并重启即可关闭。

Turn Summary 统计该轮自己的费用，显示数量、单价、小计与合计，例如：

```text
✓ 10:00:02 · 2s (L2s/T0s) · ↑8.4k ↓160 C1.4k · 67.9 tok/s · 合计 ≈¥0.018136
  费用构成 · deepseek-flash · 高峰
  输入（未命中） 8,400 tok × ¥2/百万 = ¥0.016800
  缓存命中 1,400 tok × ¥0.04/百万 = ¥0.000056
  输出 160 tok × ¥8/百万 = ¥0.001280
```

这是高峰请求的示例，实际按各请求开始时间计价，完成时间不决定费率。多种模型、时段或价格版本分组显示，最多展开 8 组（其他组仍计入合计并标明省略）。金额保留六位小数，正数不足百万分之一元显示 `<¥0.000001`。非 DeepSeek 轮次不加价格；缺失数据不计入估算，也不显示问号。合计和所有价格明细使用与摘要文字相同的默认前景色和 dim 样式。窄屏将明细换行，不丢掉费用项。复制 transcript 包含明细。

旧版本的重复 install 不覆盖文件，因此升级插件时需更新代码与 manifest，保留已安装的 `pricing.json` 历史快照。重启 TUI 后，现有会话摘要通过逐请求记录重建价格；更旧的无明细历史不显示金额。

## 价格与更新

人民币价格核对于 2026-10-31，来源：[DeepSeek 官方价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)。初始快照只用于北京时间 2026-10-31 起的请求，这不是声明官方调价生效日期；更早记录不追溯套用。

状态栏读取本地 `pricing.json`，刷新不请求网络。需要更新时执行：

```sh
node "${CODINGX_HOME:-$HOME/.codingx}/plugins/deepseek-cost/update-prices.mjs"
```

更新器读取官方页面，校验表格与峰谷规则；网络失败、页面格式变化时保留原文件。价格变化时追加快照，首次观察到变化的时间作为估算边界；旧请求按对应旧快照计价。不要覆盖或删除历史快照。假期表需要按当年官方通知更新，更新器不猜测未来假期。

用量口径见 [DeepSeek Anthropic API 文档](https://api-docs.deepseek.com/zh-cn/guides/anthropic_api/)：最终 `message_delta.usage` 是累计值，不能与初始 usage 相加；`input_tokens` 不含缓存命中，`cache_read_input_tokens` 为命中量，缓存创建目前恒为零。非零缓存创建量对应请求因无法准确计价，不计入估算。

## 自定义 Plugin

放在 `$CODINGX_HOME/plugins/<id>/`，id 允许小写字母、数字、`-`、`_`，最长 64 字符。全局配置显式选择 id；项目配置的 `status_bar` 会被忽略并告警，读取清单不会执行代码。

```yaml
manifest_version: 1
id: custom-statusbar
name: Custom StatusBar
version: 0.1.0
capabilities:
  status_bar:
    protocol: codingx.status-bar/v1
    mode: decorate
    placement:
      after: total_tokens
    execution:
      type: command
      command: node
      args: [./index.mjs]
```

三个版本分别表示清单格式、能力协议和插件发布版本。其他能力可存放在清单中，当前不会执行。未知清单版本、StatusBar 协议或 mode 回退默认状态栏并提示配置错误。

命令直接按 argv 执行，不经过 shell 展开；cwd 为插件目录，`node` 使用 codingx 当前 Node 可执行文件。插件是显式信任、以用户权限运行的本地代码，不提供 OS 沙箱。子进程只继承 PATH/HOME/LANG/LC_ALL/TMPDIR/TZ 白名单，不传 Provider 凭证、对话或工具内容。

## `codingx.status-bar/v1`

进程从 stdin 读取一个 JSON 快照，向 stdout 写一个 JSON 响应并退出。stdout 不得混入日志，stderr 不插入终端或 rollout。完整接口见 `src/plugins/types.ts`。

| 输入字段 | 内容 |
| --- | --- |
| `version` | 1 |
| `sessionId` / `generation` | 会话与 clear 代次 |
| `cwd` / `width` | 项目路径与可用列数 |
| `current` | Provider、模型、公开服务 origin、推理强度 |
| `status` | 状态、耗时、turn/step |
| `context` | 上下文占用与窗口 |
| `totalUsage` | 已结束轮次累计用量 |
| `usageRecords` | 已结束轮次的逐请求用量，恢复时也包含崩溃前保存的请求 |
| `usageIncomplete` | 旧记录或中断历史有归属缺口 |

逐请求记录含 `requestId`、`turnId`、`provider`、`model`、`origin`、`startedAt`、`purpose`（turn/compaction）、`complete`、`cacheBreakdownKnown` 和四个 token 分桶。`inputTokens`、`cacheReadTokens`、`cacheCreationTokens` 相互独立；`outputTokens` 为输出。记录通过 SessionStore 追加 `usage.recorded`，不包含凭证或 endpoint query；resume/fork 重放，clear 清空。

```json
{
  "version": 1,
  "segments": [
    { "text": " · ≈¥0.1842", "fg": "#a5d6a7", "bold": true }
  ]
}
```

空 segments 表示不追加。支持 text、fg、bg、bold、dim、italic、underline，颜色用 `#RRGGBB`。宿主去除 ANSI 控制序列、将换行转为空格、按显示宽度绘制。第一版仅装饰 `total_tokens`，不支持多行、点击或替换整条状态栏。

上限：清单 32 KiB、32 个片段、每段 2048 字符、stdout 32768 字符、stdin 8 MiB。默认超时 1000ms（100–10000），刷新 1000ms（250–60000）。此能力每次最多运行一个子进程，UI 不等待；状态变化丢弃旧结果。失败使用默认状态栏，同次运行只提示一次执行失败。退出取消进程并清理进程组，执行层有最多 5 秒强杀宽限期。

## `codingx.turn-summary/v1`

在 manifest 的 `capabilities` 中追加：

```yaml
turn_summary:
  protocol: codingx.turn-summary/v1
  mode: decorate
  placement:
    after: output_rate
  execution:
    type: command
    command: node
    args: [./index.mjs]
```

沿用相同的命令 JSON 通信、超时与环境限制。stdin 包含 `version`、`sessionId`、`generation`、`cwd`、`turn`（id/outcome/completedAt/durationMs/usage）、仅该轮的 `usageRecords` 和 `usageIncomplete`。没有“当前模型”字段，避免切换模型后错误计价。正常、失败、中断的已结束轮次均可装饰，恢复和 fork 时按 turnId 重新关联。

响应中 `segments` 追加到输出速率后；可选 `details` 最多 64 行，每行 `{ "segments": [...] }`，支持与 StatusBar 相同的文本样式。总输出限制仍为 32768 字符。宿主处理宽字符换行与终端控制字符过滤。

每个摘要执行一次，不随底部刷新重复运行；每个能力各自单进程串行。请求异步进行，超时或非法输出退回原摘要，clear/会话切换/退出丢弃旧结果。待装饰摘要在成功或失败返回前暂不写入不可修改的终端原生滚动历史，避免异步结果造成历史中缺价或重复行。
