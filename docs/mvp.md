# Chat Gauge 0.1 · 初版 MVP 计划

> 初版记录。当前覆盖范围与采集设计见 [多 Agent 指标接入](multi-agent.md)。

## 范围

在 Orca 桌面端状态栏显示 Claude Code Chat 最近一次模型请求的平均吞吐、上下文 token 和窗口占比（若已配置上限）；右侧栏展示同一读数的口径、明细与更新时刻。首版针对 Windows 本机原生 Chat，不支持 Terminal、SSH、WSL、远程 Orca Server 或其他 agent。支持经 Claude Code 启动的网关模型，前提是其日志有用量记录。

## 实施顺序与验收

1. **会话绑定**：用 `workspace.readContext` 获取焦点工作区 ID，再用本机 `orca agent list --worktree=<ID> --json` 获取工作区里的 Chat；从 Orca 会话元数据只读解析 provider ID，只找同名 Claude 主转录文件。单会话自动读，多会话显示全部对话标签、默认选第一个并按工作区记住手动选择；无匹配、格式漂移、重复文件均显示原因，不回落到其他会话。切换工作区或 `/clear` 不沿用旧会话数据。
2. **指标采集**：有界增量读取 JSONL，处理不完整行、重复 assistant 块和文件截断。用最近一次已完成请求的输入（含 cache）+ 输出作为上下文快照；窗口默认未知，设置后才显示占比。平均吞吐使用 `输出 token ÷ (完成时间 − 请求开始时间)`，近似且含首 token 等待；没有可配对的请求时间不显示速度。不计算 TTFT、decode rate 或逐 token 流速。
3. **界面**：使用 Orca Components，自适应卡片 + 单值上下文条，不做时间序列图。状态栏简短显示，点击切换右侧栏；详情随 worker 快照更新。同工作区多 Chat 时不把最近活动误作当前焦点；选定会话后状态栏和面板保持一致。
4. **验收**：在 Orca 1.4.274 运行 manifest 验证、TypeScript 检查、合成输入测试和面板渲染检查；用本机现有 Chat 的 ID 和日志验证数据链路，只输出统计字段。真实窗口需单独授权 `trusted-worker`，未经批准不加载运行。不提交或推送。

## 维护边界

使用 `node:sqlite` 的只读连接与参数绑定查询会话映射，不读 Orca 聊天 journal。只读 Claude 项目目录与识别出的 `.jsonl`；不调用模型 API，不联网，不读取凭据，不输出日志正文、不保存会话历史。Orca 内部 schema 不是公开 API，读取失败时显示不可用。任何安装都需用户审批。
