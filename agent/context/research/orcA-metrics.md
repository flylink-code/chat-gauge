---
status: active
updated: 2026-11-25
---

# Orca Chat 指标来源与扩展点

- [官方 Plugin Host API](https://github.com/stablyai/orca/blob/main/docs/reference/plugin-host-api.md) 与本机 1.4.274 CLI typings：有状态栏和面板消息接口；没有公开 Chat metrics 流。正式能力以本机匹配版本为准。
- [官方 Chat UI 文档](https://orca.dev/docs/agents/native-chat)：部分结构化 Claude Chat 已支持原生上下文圆环。这不是套餐用量，也不是插件的公共数据源。
- [Context Meter](https://github.com/Ellebam/orca-context-meter) 和 [Pitwall](https://github.com/sonthh/orca-pitwall)：有从本机 transcript 读取上下文的先例。其覆盖范围和会话匹配策略不视作本项目事实。
- [Orca throughput PR](https://github.com/stablyai/orca/pull/18235)：定时边界及多段 assistant 写入是速度读数的已知约束；该提案不是本机公开宿主 API。

本机 1.4.274 只读验证：provider UUID 可从本地 session 记录绑定到 transcript；实测有 `api-request` 和带最终 usage 的 assistant 行。样本不是 provider 端精确延迟事件，重复 assistant 块、重试及批量落盘会影响耗时估算。

不采用会话 mtime 推断，不用终端文本切割估计 token。Orca journal 只读上下文结构化字段，不读取消息正文。Antigravity 的吞吐证据见 `agy-throughput.md`。需要重新核验的条件：Orca 数据库 schema、Claude transcript 格式或公开指标 API 变化。
