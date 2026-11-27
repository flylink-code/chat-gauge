# 调研索引

> 一行一个主题。详细记录在同目录 `<主题>.md`。
> 规则见 `agent/rules/50-research.md`：≥3 个独立来源，含官方文档，记录否决理由。

| 主题 | 结论一句话 | 状态 | 日期 | 详情 |
| --- | --- | --- | --- | --- |
| Orca Chat 指标来源 | 宿主支持状态栏与面板；首版用精确匹配的本地 transcript | active | 2026-11-25 | `orca-metrics.md` |
| Antigravity 原生 Chat 吞吐 | Orca turn 边界 + agy 逐调用 output_tokens 可在精确绑定后给整轮平均；绑定不唯一则 null | active | 2026-11-25 | `agy-throughput.md` |
| agy-context 插件参考 | 会话库 `gen_metadata` 有逐调用首字延迟与流式时长，本机核对通过，可做真实 tok/s；RPC 分类遥测需用户决定 | active | 2026-11-27 | `agy-context-plugin.md` |

## 状态说明

取值定义见 `agent/rules/30-docs.md`「状态声明」，这里只讲调研特有的两种：

- `active`：结论仍适用
- `stale`：超过 12 个月未复核，或依赖的版本已变，引用前须复核
- `superseded`：被新调研取代，读 `superseded_by`

## 维护

- 新增主题：在 `agent/rules/50-research.md` 的模板下建文件，回来加一行。
- 引用前：先看状态与日期；`stale` 直接当现状用是常见错误。
