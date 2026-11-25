---
status: accepted
updated: 2026-11-25
---

# 0001 · 按 provider 会话 ID 绑定转录

## 上下文

Orca 的 Chat ID 和 Claude Code 的 transcript ID 不同。一个工作区可以同时有多个 Claude Chat，按修改时间选文件会串会话；`/clear` 后 Orca Chat ID 也可能不变。

## 决策

从公开的工作区上下文与 CLI 获取当前工作区的 Chat，从 Orca 本地 metadata 库只读查询对应记录，解析活跃 provider handle 的 UUID。只读取与 UUID 一致的主转录。窗口或会话无法识别时显示不可用。

## 后果

能隔离同工作区多个会话，支持转录 ID 变更；代价是要维护 Windows 本地数据库的 schema 适配，并需要 `trusted-worker`。不读 journal 内容，不读取凭据，不回落到最近修改文件。未来若 Orca 提供正式的 Chat metrics API，替换 `src/source.ts` 和采集实现而不改变面板协议。
