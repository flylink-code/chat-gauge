# Chat Gauge · Agent 主路由

## 接手工程

在本仓库根目录执行命令。工程进度以 `agent/context/plan.md` 为准，面向用户的说明在 `README_zh.md`。

| 接手时需要知道什么 | 本工程入口 |
| --- | --- |
| 环境与启动 | Windows · Orca 1.4.274+ · Node 24（开发工具）；见 `README.md#develop`。 |
| 验证 | `npm run typecheck`、`npm test`、`npm run check`；真实数据用 `scripts/smoke.mjs`，真实窗口需用户审批。 |
| 边界 | Worker 只读会话及 JSONL，不向面板传正文；上下文窗口未知时不猜，吞吐不冒充 decode rate。 |

## 按任务取资料

- 续接工作 → `agent/context/plan.md`，先核对最近一次验证的版本和结果。
- 确认需求或协议 → `agent/context/requirements.md`、`agent/context/software.md` 中的现行原件。
- 遇到似曾解决的问题 → `agent/context/archive/ARCHIVE_INDEX.md`，核对状态与失效条件。
- 定位陌生代码 → 用工程现有导航或 `doc/CODE_MAP_INDEX.md`。
- 选择阶段手册、查规则、硬件事实或历史决策 → `agent/index.md`，按触发条件选读。
