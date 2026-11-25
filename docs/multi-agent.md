# 多 Agent 指标接入

## 当前实现（Windows 本机 Chat）

- Orca 会列出当前工作区的本机原生 Chat，不再限制为 Claude Code。只有一个时自动选中；多个时手动选择。以 Orca Chat ID 绑定，不按日志修改时间猜会话。
- 上下文走一条通用路径：只读 Orca 会话数据库，从当前 epoch、最近一次 clear 之后的可见 turn 投影上下文事实。SQL 仅返回用量字段，不返回 turn 正文。`report` 显示为 Reported，`estimate` 显示为 Estimated，`unknown` 不回填旧读数。
- Claude Code 另有 JSONL 请求采样：给出含首 token 等待的估算平均吞吐。Orca 较新的上下文优先；如果 Claude JSONL 比缓存的 Orca 报告新，则以最新请求估算上下文。同一模型可以沿用上次已知的窗口上限。手动配置会覆盖自动上限。

## 上下文面板的数据口径

- 窗口已知时显示剩余 token。来源与时间独立于最新请求；不根据历史增长速度猜剩余请求数。
- Claude Code 分类以矩形树图显示。面积按 Orca 报告的已占用分类 token 数分配，编号与精确明细对应；剩余、压缩预留和按需加载项另列。分类和不作为已用总量，也不替代上方窗口占用条。最新请求比报告更新时，同模型的旧分类标注「上次报告」及时间。
- 提示词缓存命中率只对有明确 cache-read 字段的完成请求显示：缓存读取 token ÷ 全部输入 token（含缓存读取和写入）。不把缺失字段当 0%，也不把缓存拆分当上下文分类。
- Antigravity 经 ACP `usage_update` 提供 `used` / `size`，当前可展示窗口占用与剩余；该通知不含分类、缓存明细或生成时间。新会话在首次更新落盘前会显示暂无用量。

## 支持矩阵

| Agent | 上下文 | 请求吞吐 |
| --- | --- | --- |
| Claude Code | 本机验证；Orca 上下文或 JSONL 回退 | 本机验证；JSONL 请求耗时估算 |
| Antigravity（agy） | 本机验证；Orca 记录已用 token 和窗口 | 不显示；已验证的记录是窗口快照，不是输出 token 与请求时钟 |
| Codex | Orca 如果写出上下文事实即可读，待本机有样本验证 | 待专用适配与验证 |
| OpenCode / OpenCode 2 | 同上 | 待专用适配与验证，两版本分别验收 |
| Pi | 同上 | 待专用适配与验证 |
| 其他原生 Chat | 同上；无事实则显示无数据 | 暂不支持 |

## 下一批适配顺序

| 优先级 | Agent | 实现入口与 UI 口径 |
| --- | --- | --- |
| 1 | OpenCode / OpenCode 2 | 用 ACP handle 的 `nativeId` 绑定 session。只读对应账号的 SQLite：1.x `message`、2.x `session_message`；只用已完成 assistant 记录的 `tokens.output` 与 `time.created` / `time.completed`，标明「消息平均吞吐」，不称为解码速度。需要独立验证两版和托管账号目录。 |
| 2 | Codex | Orca 已把上下文窗口保存在报告中。未来按 thread ID 匹配 rollout，按 `turn_id` 把去重后的 `last_token_usage.output_tokens` 与 Orca 同一已完成 turn 的耗时配对；只能标「整轮平均」，包含工具时间。 |
| 3 | Pi | 按当前 handle 指定的 JSONL 路径读取当前分支，不把其他分支、失败响应或压缩前的记录混入；输出 token 可取自 `message.usage.output`，无单次请求起点；如做整轮平均，必须有可靠的 Orca turn 边界。 |
| 上游 | Antigravity | 较新 `agy acp` 可在 `session/prompt` 完成时报告整轮 `usage.outputTokens`，但 Orca v1.4.274 的时间线未保留该字段。须有同一轮的输出数和耗时才能显示「整轮平均」，仍非实时解码速率。见 [agy 吞吐调查](../agent/context/research/agy-throughput.md)。 |

可核对的 Orca v1.4.274 实现入口：[Codex context](https://github.com/stablyai/orca/blob/v1.4.274/src/main/codex/structured/journal/codex-context-usage.ts)、[OpenCode SQLite 字段](https://github.com/stablyai/orca/blob/v1.4.274/src/main/opencode-usage/opencode-usage-row-parsing.ts)、[Pi RPC context](https://github.com/stablyai/orca/blob/v1.4.274/src/main/pi/rpc/rpc-context-usage.ts)、[ACP timeline](https://github.com/stablyai/orca/blob/v1.4.274/src/main/acp/timeline/acp-timeline-translator.ts)。

## 新增吞吐适配的验收条件

1. 能通过 Orca 的当前 provider handle 精确定位该会话。不同机器、账号、工作区和子 agent 的记录不能串用。
2. 同一条已完成模型请求有输出 token 数与耗时，或者可从明确的起止事件计算耗时。不要把一整轮（含工具、审批和多个请求）当作一次生成，不把全会话累计 token 当作单次输出。
3. 无时间戳、仅有用量或断点不可靠时，独立降级为只显示上下文。没有逐 token 事件时，不显示实时解码速率。
4. 先用合成样本测试缺字段、重复记录、清理或压缩，再用真实本机 Chat 校验。不得启动模型调用作为默认测试；测试不输出对话、凭据、会话 ID 或工作区路径。

Orca 的 Chat 事实结构来自其 [v1.4.274 类型](https://github.com/stablyai/orca/blob/v1.4.274/src/shared/agent-session/conversation-context/agent-session-context-usage.ts)，数据库不是公开 API。如果 Orca 提供正式的 Chat metrics API，优先迁移。