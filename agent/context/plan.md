---
status: active
updated: 2026-11-25
---

# 计划与进度

## 已发布

- GitHub Release `v0.2.0`：响应式 HTML 侧栏、Claude 彩色上下文树图、缺数据提示和精简状态栏。发布前 28 个测试通过；UI 验证见 `docs/ui-v2.md`。

- GitHub Release `v0.3.3`（提交 `1cb1d65`）：Antigravity 解码速度卡片。社区目录收录结果待到状态页核实。

## 多 Agent 开发版

- `docs/multi-agent.md` 为当前支持矩阵。Windows 本机原生 Chat 的范围以 Orca 1.4.274 的 20 个 ACP 注册项与 3 个独立原生适配器为准。整轮计时与 token 吞吐独立。未支持远程、WSL、终端。
- 新接口已完成合成测试。真实本机既有历史验证了 Antigravity 的当前成功轮次和可匹配的整轮吞吐；没有发起模型请求。其他各家的本机端到端覆盖不等同于格式适配，见矩阵。
- 回归：`npm run typecheck`、`npm test`、`npm run check`、`orca plugin validate . --json`。真实开发插件可用 `orca plugin shot local.chat-gauge --panel chat-gauge --width 320 --json`。

## 0.3.1 候选（PR #2）

- 多对话：面板顶部列出全部 Chat 标签，默认第一个，手动选择按工作区记住；不再自动跟随 Orca 焦点（ADR 0002，归档卡 chat-focus-follow.md）。src/chat-focus.ts 保留未接入。
- 回归：pm run typecheck、pm test（90 项）、ode scripts/check-panel.mjs（含点击标签切换）通过；真实桌面窗口尚未复测，未打 0.3.1 标签。

## 下一步

0. agy 解码速率已实现（未发布，`src/agy-gen.ts`）：只读 `gen_metadata`，每个绑定调用的输出数须与 transcript 一致才显示，否则只留整轮平均。93 项测试通过；5 个本机会话（含正在使用的库）只读解码成功。2026-11-27 真实 Orca 1.4.278 + Antigravity 氢模型（gemini-4-hydrogen-high）发起一次极短请求：整轮 5.38 s、33 token，`gauge.get` 返回 decode 首字 4.65 s、流式 0.16 s、1 次调用；流式不足 1 s 不显示解码速度（样本太短）。面板卡片已用合成数据渲染确认。第二次请求（约 500 词）会话库读出 1 次调用、5,489 输出 token、流式 24.9 s、首字 3.3 s，约 220 tok/s；当时 Orca 活动工作区已切换，插件名单只剩另一个对话，未能经 `gauge.get` 端到端复核这一次。官方分类遥测 RPC 等用户决定后再做。

1. 在真实 Codex、OpenCode 1.x/2.x、Copilot、Pi、Gemini 原生会话上核对账号绑定、完成时刻与显示口径。不同步时宁可留空，不扩大匹配范围。
2. 其余 ACP Agent 先验证宿主窗口与轮次事实；只有找到对应会话的真实输出计数与计时才增加专用速率。
