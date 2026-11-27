---
status: active
updated: 2026-11-27
topic: q1uuuu/agy-context 对 agy 上下文与 tok/s 的参考价值
---

## 问题

第三方插件 [q1uuuu/agy-context](https://github.com/q1uuuu/agy-context)（Apache-2.0，plugin 26.3.2，提交 `ba05ca1`）能否补上本项目对 agy 的上下文分类和 tok/s 缺口？

## 候选与结论

| 来源 | 日期 | 采纳/否决 | 理由 |
| --- | --- | --- | --- |
| `conversations/<id>.db` 的 `gen_metadata` 表（`scripts/context-analyzer.mjs` 的 `analyzeSessionPerformance`） | 2026-11-27 | **采纳（待实现）** | 每次模型调用有真实的首字延迟与流式时长。只读本地文件，与现有 worker 边界一致。已本机验证，见下。 |
| Language Server RPC `StreamAgentStateUpdates` → `contextWindowUsage.tokenGroups` | 2026-11-27 | **暂不采纳，待用户决定** | 能拿到系统提示/工具/对话三类官方分组。但需要扫描进程命令行或 `main.log` 取 `--csrf_token`，再调用无公开文档的本机接口。这属于读取他进程的鉴权凭据，未经用户明确同意不做。 |
| `agy-patch.py` / `context-unlocker.mjs`（改写 agy 二进制以突破 256K） | 2026-11-27 | **否决** | 修改用户的 agy.exe，与「只读」边界冲突，也与监控无关。 |
| 用量大盘与 OpenRouter 单价 | 2026-11-27 | 否决 | 费用估算不在本项目范围。 |

## 本机验证（agy 1.5.x，Node 24 `node:sqlite` 只读；数据库副本，只读数值字段，未读对话正文）

- 表：`trajectory_meta, steps, gen_metadata, executor_metadata, ...`。
- `gen_metadata.data` 为 protobuf：`f1`（外层）→ `f4` 用量（`f3` = output_tokens，`f10` = 正文 token）；外层 `f11` = 首字延迟（Duration），`f12` = 流式时长（Duration）。
- 交叉核对：一个会话 13 行，DB 的 output_tokens 之和 31,250，与 `transcript.jsonl` 的 `PLANNER_RESPONSE` 之和 31,250 完全一致，行数也一致。
- 数值合理：输出 11,539 token（正文 103，其余为思考）、流式 115.7 s → 约 100 tok/s；对比之前 `created_at` 算出的约 3,100 tok/s 的不合理值，这里没有该问题。
- 因此 `agy-throughput.md` 中「会话库是 protobuf，未解码」与「单步计时不可用」的结论被取代。逐调用计时可用，但字段含义来自上游逆向，不是官方文档。

## 与本项目的差异 / 适配点

- 上游把 `body/stream` 当作「正文速度」，`output/(ttft+stream)` 当作总速度。本项目应以 `output_tokens / stream_seconds` 作为解码速率（含思考），首字延迟单独显示；二者不得混称。
- 绑定仍沿用已验证的 `nativeId` → 会话 ID 链；DB 在 `<GEMINI_HOME>/antigravity-cli/conversations/<id>.db`，两个 home 同样要检查，歧义返回 null。
- 实时会话库有 WAL（`-wal`/`-shm`），须只读打开，不得复制写入、不得 checkpoint。
- Node 24 的 `node:sqlite` 在 Orca worker 里是否可用要先确认；上游在 Windows 另有 PowerShell 回退。
- 只用完成的调用；未完成或无时长的行返回 null，不外推。

## 未决

- 未验证 DB 中 protobuf 字段号在 agy 其他版本是否稳定；需版本探测，字段缺失即降级。
- 子 Agent 调用是否写入同一个 `gen_metadata`，未验证。
- 官方分类遥测的获取方式需要用户决定是否接受上面的 RPC 方案，或另寻公开接口。
