---
status: active
updated: 2026-11-25
---

# 计划与进度

## 已发布

- GitHub Release `v0.2.0`：响应式 HTML 侧栏、Claude 彩色上下文树图、缺数据提示和精简状态栏。发布前 28 个测试通过；UI 验证见 `docs/ui-v2.md`。

## 多 Agent 开发版

- `docs/multi-agent.md` 为当前支持矩阵。Windows 本机原生 Chat 的范围以 Orca 1.4.274 的 20 个 ACP 注册项与 3 个独立原生适配器为准。整轮计时与 token 吞吐独立。未支持远程、WSL、终端。
- 新接口已完成合成测试。真实本机既有历史验证了 Antigravity 的当前成功轮次和可匹配的整轮吞吐；没有发起模型请求。其他各家的本机端到端覆盖不等同于格式适配，见矩阵。
- 回归：`npm run typecheck`、`npm test`、`npm run check`、`orca plugin validate . --json`。真实开发插件可用 `orca plugin shot local.chat-gauge --panel chat-gauge --width 320 --json`。

## 下一步

1. 在真实 Codex、OpenCode 1.x/2.x、Copilot、Pi、Gemini 原生会话上核对账号绑定、完成时刻与显示口径。不同步时宁可留空，不扩大匹配范围。
2. 其余 ACP Agent 先验证宿主窗口与轮次事实；只有找到对应会话的真实输出计数与计时才增加专用速率。
