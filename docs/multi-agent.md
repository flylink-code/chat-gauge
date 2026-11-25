# Windows 本机原生 Chat 指标

范围按 Orca v1.4.274 的 [ACP 启动表](https://github.com/stablyai/orca/blob/v1.4.274/src/main/acp/launch/acp-launch-registry.ts) 加 Claude Code、Codex、Pi 三个原生适配器，共 23 个标识。不是终端 Agent 菜单。仅显示本机工作区会话；不启动 Agent、不向模型发送请求。

| Agent | 已接入的吞吐或用量 | 验证范围 |
| --- | --- | --- |
| Claude Code | 已完成请求的输出 / 请求耗时（含首 token 等待）；缓存与上下文构成 | 合成测试、本机 Chat |
| Antigravity（agy） | 可唯一匹配的根轮次：主模型各步输出之和 / Orca 整轮耗时；不含子 Agent，不是解码速度 | 合成测试、本机历史，见 [证据和限制](../agent/context/research/agy-throughput.md) |
| Codex | 已完成 rollout 轮次的输出 / 轮次耗时 | 合成测试 |
| OpenCode、OpenCode 2 | 选中账号和会话 SQLite 的已完成 assistant 消息：输出 / 消息耗时 | 两版及迁移、托管账号均有合成测试 |
| GitHub Copilot | 根会话完成调用的输出与耗时，排除子 Agent；状态提示按消息平均标注 | 合成测试；本机 CLI 记录字段已核对，未验证 Orca 端到端 |
| Pi | 当前分支已完成 assistant 消息**显式提供时长**才出速率；只有时间戳不推算 | 合成测试；不保证标准 Pi 日志含时长 |
| Gemini CLI | 最近完成消息的输出 token；没有匹配的调用时长，不出速率 | 合成测试 |
| Grok、OMP、Kimi、Cursor、Hermes、Kiro、Goose、Auggie、Kilocode、MiMo Code、Droid、Qwen Code、Cline、Devin、CodeBuddy | 共用下述上下文和整轮计时；没有专用 token 速率适配 | 上游注册表、合成公共链路；不是逐个真机验证 |

**通用读数**：`report` 用 provider 上报的窗口，`estimate` 用输入及缓存计数；`unknown` 不沿用旧读数。无事实不显示数字。非 Claude 会话可单独显示 Orca 最近成功根轮次的耗时，条件是当前 epoch、最近一次 clear 之后，且最新一轮已完成并明确成功；含工具/等待，不是生成耗时。不拿窗口增量计算 tok/s，也不把 ACP 快照的占位零当输出计数。

**会话绑定**：同一工作区多会话要明确选择。专用适配器读取所选会话的 provider handle 与账号限定的本机记录；输出和时间不能对应、超出读取上限、存储缺失或格式变化时，该指标留空。模型调用、消息、整轮是不同分母，侧栏和状态栏悬停提示注明口径。消息/整轮速率不参与上下文或缓存命中率计算。

**展示**：Claude 构成图默认仅画已占用分类，报告一致时可切换整个窗口。预留、剩余与按需加载分别列出；旧报告注明时间。缓存命中率只用明确报告的缓存读取数 / 全部输入。Antigravity 的窗口更新不含分类。

来源：[Orca 上下文类型](https://github.com/stablyai/orca/blob/v1.4.274/src/shared/agent-session/conversation-context/agent-session-context-usage.ts)、[ACP 窗口快照](https://github.com/stablyai/orca/blob/v1.4.274/src/main/acp/timeline/acp-context-usage.ts)、[整轮计时](https://github.com/stablyai/orca/blob/v1.4.274/src/shared/agent-session/view/structured-agent-session-turn-timing.ts)。这些本机存储不是稳定的公开 API，更新 Orca 或 Agent 后需复测。