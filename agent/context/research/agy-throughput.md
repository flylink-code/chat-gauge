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

## 结论与恢复条件

- 本机 PATH 的 Windows `agy --version` 为 1.5.13；没有发起模型请求验证其 ACP 负载，也不假定 Orca 当前会话一定选用 PATH 二进制。
- Orca 1.4.274 已可显示 `usage_update` 的窗口占用。没有可绑定到同轮的输出 token 就不能以 `0 tok/s` 或窗口增量估算速度；`/usage` 是配额，不是吞吐。
- Orca 持久化或公开同轮输出 token 与耗时后，才可验证「整轮平均」；单次模型生成速率仍需匹配单独的模型调用时间。无头 CLI 的计量不能补读正在运行的原生 Chat。
