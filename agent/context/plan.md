---
status: active
updated: 2026-11-25
---

# 计划与进度

## 当前目标

- `docs/multi-agent.md`：通用上下文读取、Claude 分类矩形图和精简状态栏已实现；下一步按支持矩阵对 Codex、OpenCode 1.x/2.x、Pi 做真实 Chat 验收，再接各自吞吐。Antigravity 的吞吐恢复条件见 `agent/context/research/agy-throughput.md`。

## 最近一次验证

| 项目 | 记录 |
| --- | --- |
| 版本与环境 | Chat Gauge 0.1.0 工作区版本，Windows 11，Orca CLI 1.4.274，系统 Node 24.15。 |
| 静态与合成测试 | `npm run typecheck` 通过；`npm test` 15/15；`npm run check` 七个侧栏场景无告警，覆盖矩形面积、按需加载项、分类时效与英、简、繁。插件清单校验通过。 |
| 上下文构成 | 本机 Claude smoke 有分类与缓存读数；本机 agy smoke 有总量但无分类。320 px 实拍 `.orca/context-detail.png` 验证 agy 的上下文总量、上限、剩余量及缺明细提示。 |
| 数据链路 | `node scripts/smoke.mjs '<workspace selector>'` 分别从真实 Claude Code、Antigravity Chat 读到上下文，并从 Claude JSONL 读到带耗时样本。 |
| 界面 | 新版实拍 `.orca/gauge-compact-panel.png`（280 px）及 `.orca/gauge-compact-status.png`，无错误；Antigravity 上下文和无吞吐说明正常。Claude 矩形图通过合成渲染检查；当前工作区无 Claude Chat，Orca 窗口可见时拒绝截图回放，尚未取得新版矩形图的亮色/暗色实拍。 |
| 未验收 | Codex、OpenCode 和 Pi 暂无本机已运行样本；没有启动额外模型请求。 |

## 下一步

1. 依次打开 Codex、OpenCode 1.x/2.x、Pi 的本机原生 Chat，有上下文数据后对照 Orca 的事实与插件显示。
2. 按 `docs/multi-agent.md` 优先验证 OpenCode 的会话绑定和已完成 assistant 记录，再实现消息平均吞吐。
3. Codex/Pi 如能可靠匹配 turn 边界，才加入显式标注的整轮平均；继续测试多会话、重置和数据缺失时清除旧读数。
