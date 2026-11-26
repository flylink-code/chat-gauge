---
status: archived
archived: 2026-11-26
commit: 0deaca0
superseded_by: docs/adr/0002-manual-chat-tabs.md
valid_until: 2026-11-26
evidence: 实测
---

# 自动跟随 Orca 当前聚焦的 Chat

## 结论（最终）

- 根因：Orca 1.4.274 点击标签后，插件可读的保存状态（`workspaceSession`）不及时写入；顶层 `activeTabId` 是终端面 ID，原生 Chat 在前台时可为空。
- 处理：不再自动跟随；面板列出全部标签，用户手动选择（ADR 0002）。
- 验证：前台点击两个顶部标签，正文已切到 B，插件仍显示 A，最长观察 11 分 34 秒；侧栏 `Select` 切换同样不更新。

## 证据

- 候选实现：`src/chat-focus.ts`（读取标签组的活动 Chat 并核对名册，单元测试 89 项通过），PR #2。
- `lastFocusedAt` 点击后约 0.55 秒变化，但只在保存刷新时落盘；`recentTabIds` 顺序不跟随。
- 环境：Orca 1.4.274，Windows，本机原生 Chat。

## 不要再做（重要）

- 不要重复：缩短轮询间隔——数据源不更新，300 毫秒也读到同一份旧状态。
- 不要重复：用保存状态里的 `activeTabId` / `lastFocusedAt` 推断“当前对话”并标为“跟随当前对话”。
- 不要：用 CDP、模块注入或窗口截图读取焦点。

## 失效条件

- Orca 提供插件可用的实时焦点接口或事件；或升级后保存状态在点击后即时写入（先用 `.orca/latency` 方法重测）。

## 未解决

- 自动跟随焦点；当前以手动选择代替。

## 原始记录

- 归档前位置：PR #2 分支 `fix/chat-focus-031`
- 相关提交：`9abe77c`
