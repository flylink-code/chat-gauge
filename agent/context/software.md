---
status: active
updated: 2026-11-25
---

# 软件摘要卡

## 事实源

- `orca-plugin.json`：宿主版本、插件贡献点与权限。
- `docs/multi-agent.md`：当前采集架构与支持矩阵；`docs/mvp.md` 记录初版方案。
- `README.md`：构建、验证、加载与卸载入口。

## 当前结论

- `src/source.ts` 负责工作区 Chat 枚举、会话映射和精确查找 transcript。
- `src/context.ts` 用只读 SQL 投影选中会话主线程的上下文事实；`src/transcript.ts` 和 `src/tail.ts` 追读 Claude JSONL，`src/format.ts` 统一计量口径。
- 状态栏与 HTML 侧栏读同一份快照。桌面侧栏从隔离框架的 `window.orca.plugin` 获取会话数据；矩形图默认按已占用分类展示，完整报告可切换整窗视图。见 `docs/ui-v2.md`。

## 未决项

- Orca 内部 SQLite schema 与 Claude JSONL 需要跨版本复测；Codex、OpenCode 和 Pi 的本机 Chat 数据尚未验证。

## 最后更新

- 2026-11-25 / Chat Gauge 开发记录。
