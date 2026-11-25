---
status: active
updated: 2026-11-25
topic: Antigravity 原生 Chat 的吞吐来源
---

## 问题

Antigravity CLI 有输出 token 指标时，Orca 原生 Chat 插件为何仍无法显示 tok/s？

## 检索词

- `Google Antigravity agy CLI tokens per second throughput output tokens ACP usage_update PromptResponse usage`
- `site:github.com/stablyai/orca Antigravity agy tok/s throughput ACP usage outputTokens promptResult`

## 证据与适用范围

| 来源 | 适用版本与结论 |
| --- | --- |
| [Google Antigravity CLI #1045](https://github.com/google-antigravity/antigravity-cli/issues/1045)、[#1776](https://github.com/google-antigravity/antigravity-cli/issues/1776) | 外部实测：`agy acp` 1.5.x 可产生 `PromptResponse.usage.outputTokens`，是整轮总量而非逐模型调用计量。#1776 在 1.5.14/1.5.15 上报告子 Agent 归属不一致；不能假定根会话计数含全部子 Agent。旧 registry `agy_acp_server` 的能力与 `agy acp` 不同。 |
| [Google 官方 CLI headless 文档](https://antigravity.google/docs/cli/headless) | `stream-json` 在可用时记录 `step_update.usage.output_tokens` 和 `step_update.duration_seconds`。这是无头 CLI 的输出，不是 Orca 已运行原生 Chat 的数据；多轮会话末尾 `result` 的总量和耗时是累计值。 |
| [Orca v1.4.274 ACP timeline](https://github.com/stablyai/orca/blob/v1.4.274/src/main/acp/timeline/acp-timeline-translator.ts)、[context projection](https://github.com/stablyai/orca/blob/v1.4.274/src/main/acp/timeline/acp-context-usage.ts) | `promptResult` 不传递响应 `usage`；窗口更新中的 `outputTokens: 0` 是占位，不是测量。 |
| [Orca #18233](https://github.com/stablyai/orca/issues/18233) | 现有速度提案面向 terminal；不能作为已支持 Antigravity 原生 Chat 的依据。 |

## 本机 agy 1.5.13 数据（2026-11-25，只看字段名与数值，未读对话内容）

- 外部：官方 [`/context`](https://antigravity.google/docs/cli/commands/context/) 只在 TUI 里显示分类明细；官方 [status line 脚本接口](https://antigravity.google/docs/cli/statusline/) 的 `context_window` 只有输入/输出 token 总量、窗口大小和占比。ACP 的 `usage_update` 只有 `used` 与 `size`。三条路径都没有程序可读的分类明细，因此 Orca 里的 agy 没有构成图。
- 实测：`~/.gemini/antigravity-cli/brain/<会话>/.system_generated/logs/chunks/transcript/*.jsonl` 中，每个模型调用（`PLANNER_RESPONSE`）记录 `input_tokens`、`output_tokens`、`cache_read_tokens`、`model` 和秒级 `created_at`；其他步骤没有 token 字段。会话库 `conversations/*.db` 是 protobuf，没有公开字段说明，未解码。
- 推断：`created_at` 不是可用的耗时。一个样本里，输出 12,579 token 的步骤与前一步只隔 4 秒，对应约 3,100 tok/s，不合理，说明该时间既不是生成起点，也不是上一步的结束。用相邻步骤间隔计算速率会得出错误数值。
- 未验证：Orca Chat 的会话 ID 与 agy 会话目录的对应关系；`created_at` 的确切含义。
- 可行的验证：用一次极短的 `agy -p … --output-format stream-json` 调用（会产生一次模型请求），把 `step_update.duration_seconds` 与同一会话 transcript 的 `created_at` 逐步比对。只有证明时间可用、并能通过 Orca 的会话记录精确绑定到会话，才值得做 agy 速率适配。

## 结论与恢复条件

- 本机 PATH 的 Windows `agy --version` 为 1.5.13；没有发起模型请求验证其 ACP 负载，也不假定 Orca 当前会话一定选用 PATH 二进制。
- Orca 1.4.274 已可显示 `usage_update` 的窗口占用。没有可绑定到同轮的输出 token 就不能以 `0 tok/s` 或窗口增量估算速度；`/usage` 是配额，不是吞吐。
- Orca 持久化或公开同轮输出 token 与耗时后，才可验证「整轮平均」；单次模型生成速率仍需匹配单独的模型调用时间。无头 CLI 的计量不能补读正在运行的原生 Chat。

## 实现验证（2026-11-25，Orca 1.4.274 + 本机 agy 1.5.13）

- 会话绑定可精确证明：`agent_session_records.record_json.providerHandleChain` 末项的 `handle.nativeId` 直接对应 `<GEMINI_HOME>/antigravity-cli/brain/<nativeId>`。Orca 的 ACP 托管常量是 `antigravity-acp`（`antigravity-session-origin.js`），因此两个 home 都检查；若同一 `nativeId` 同时出现在两个 home 则视为歧义并拒绝。`record.accountHome.variable` 必须为 `GEMINI_HOME`，`location` 必须是本机、非 WSL。
- 轮次边界可精确证明：Orca journal turn 的 `body.startedAt` 是毫秒值；agy transcript 的 `USER_INPUT.created_at` 是整秒值。本机 79 个可匹配轮次中，唯一命中 `|created_at - startedAt| < 1000 ms` 的差值范围为 7–961 ms；没有相邻候选。匹配不唯一、无命中，或 turn 内出现第二个 `USER_INPUT` 时返回 null，不用最近时间戳猜测。
- 主输出数可完整求和：同一原生会话的 `PLANNER_RESPONSE` 每次模型调用都有 `output_tokens`；按该轮 `USER_INPUT` 到下一个 `USER_INPUT` 之间的区域求和。要求每条 `PLANNER_RESPONSE` 为 `MODEL`/`DONE`、`step_index` 不重复、`truncated_fields` 不含 `output_tokens`；该轮最后一条可见记录必须是 `tool_calls` 为空/缺失的最终 `PLANNER_RESPONSE`，且不得有 `ERROR_MESSAGE`。非主输出的工具行即使残留 `RUNNING` 也不影响计数。本机 18 个会话的 `transcript.jsonl` 与 `transcript_full.jsonl` 的 `PLANNER_RESPONSE` 行数和 `output_tokens` 之和完全一致，说明截断字段只影响 `content`/`tool_calls`，不影响主输出计数。
- 文件完整性：优先读 `logs/transcript.jsonl`；`chunks/transcript/` 存在时，其 chunk 编号必须连续、无符号链接，且字节数之和必须等于所读文件；末字节必须是换行。只读末尾 8 MiB，所选轮次不在窗口内即返回 null。
- 实测：按 Orca 最新已完成且成功的根 turn 选择，2026-11-25 的一次采样中 17 个 Antigravity 会话有 7 个满足以上条件，得到 7.5–76.0 tok/s 的整轮平均；其余因缺少对应 agy transcript、轮内错误或边界歧义返回 null。会话数据仍在更新，数量会变；未发起任何模型调用。
- 单步计时仍不可用：`created_at` 是整秒墙钟，不是生成起止；本机样本中 12,579 token 的步骤距上一步仅 4 秒（约 3,100 tok/s），证明不能拿相邻步骤差算速率。实现只额外暴露 `readAgySteps` 的逐调用计数作为求和证据，不提供单步速率。代码见 `src/agy-metrics.ts`，测试见 `src/agy-metrics.test.ts`。
