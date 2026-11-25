# Chat Gauge for Orca

[English](README.md) · 简体中文

在 Orca 的**状态栏和右侧栏**查看本机 Chat 的**上下文占用**；能取得单次请求计时的 Agent 还会显示 **tok/s**。

```text
93.9k/100k · ≈13.9 tok/s
```

## 本地试用

1. Windows 上使用 Orca 1.4.274 或更高版本，并启用插件系统。在仓库根目录运行 `orca plugin dev load . --json`，查看 Orca 列出的权限；信任本地代码后再批准。
2. 打开本机原生 Chat。工作区只有一个会话时自动选中，有多个时在面板中选择，不猜当前标签页。
3. 从右侧栏选 **Chat Gauge**，或运行 `orca plugin open local.chat-gauge --panel chat-gauge`。点状态栏项可切换右侧栏。**Context Window (tokens)** 默认为 `0`，优先用 Orca 报告的窗口；可填写一个手动覆盖值（会应用于当前监控的会话）。若未读到上限，只显示 token 数。

**界面语言**：在设置 → 插件 → Chat Gauge → **Language / 语言** 选择自动、简体中文、繁體中文或 English。侧栏和状态栏悬停提示自动跟随 Orca 主机的系统区域语言，未支持的语言回退到英文；状态栏本身只显示数字和单位。

| 指标 | 口径 |
| --- | --- |
| 平均吞吐 | 输出 token ÷ 估算请求耗时，含首 token 等待。每次请求完成后才刷新，不是逐 token 实时生成速度。缺少计数或计时时，面板显示「暂无」并可展开原因；状态栏省略速率。 |
| 上下文 | 最新的 Orca 上下文事实，或 Claude 请求用量估算；不含草稿。 |
| 占比 | 以实际读到或手动覆盖的窗口为分母，不按模型名称猜。 |
| Claude 上下文构成 | 默认按已占用分类绘制彩色矩形；悬停或用 Tab 聚焦可查看数值，小块合并但明细保留。报告总量能与窗口核对时，可切换「整个窗口」查看剩余和压缩预留；按需加载项不计入面积。 |

按 Orca 1.4.274 的 23 个原生 Chat 标识接入。上下文与成功轮次耗时依赖宿主记录；Claude 使用请求平均，Antigravity 和 Codex 可显示整轮平均，OpenCode 1/2、Copilot 和 Pi 在消息计时可用时显示消息平均。Gemini 可显示消息输出 token 而不推测速率。各项所需字段和实测范围见[支持矩阵](docs/multi-agent.md)。Terminal、WSL、SSH、远程 Orca 暂不支持。

Worker 调用本机 Orca CLI，用只读 SQL 取选中会话的用量字段，并只读对应 Provider 的本机会话日志或 SQLite 指标，不联网、不调用模型 API、不把对话正文传到面板。Worker 仍以用户账户权限运行。Orca 会话数据库与 JSONL 格式可能随版本变化。

开发、验证及卸载命令见 [英文开发说明](README.md#develop)，工程规划见 [MVP 计划](docs/mvp.md)。
