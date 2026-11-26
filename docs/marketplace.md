---
status: active
updated: 2026-11-25
---

# Orca 官网 Community 上架清单

依据：[发布入口](https://orca.dev/plugins/add/)、[社区目录](https://github.com/stablyai/orca-community-plugins)、[Orca 1.4.274 作者指南](https://github.com/stablyai/orca/blob/v1.4.274/docs/reference/plugin-authoring.md)。独立作者走 Community 自动发现，不会标成 Orca 官方出品。

1. 使用公开、未归档、非 fork 的 GitHub 仓库；根目录保留格式 2 的 `orca-plugin.json`。仓库所有者是发布者；不要借用 Orca 官方命名。若显式填 `publisher`，必须等于仓库所有者；对支持的 Orca 版本该字段已弃用，不要为了展示名随意更改本地插件身份。
2. 由仓库所有者决定许可条款。在发布提交中加入 GitHub 能识别的 LICENSE，或在清单中声明适用的真实许可证。插件须可免费安装使用。展示图可选；如添加，使用合成会话，不要上传真实聊天标题、路径或账号信息。本仓库的图标与中英文展示图由 `scripts/store-assets.mjs` 用合成快照生成（步骤见脚本头部注释），输出在 `assets/`。第三方插件的 `description` 只有一个字符串，Orca 不会翻译，所以中英文写在同一句里。
3. 在干净的发布提交上跑 `npm run typecheck`、`npm test`、`orca plugin check .`、`orca plugin validate .`。清单版本与 `vX.Y.Z` 标签保持一致，推送提交与标签；`orca plugin release-entry .` 可核对提交和内容哈希。不要改指已发布标签。
4. 准备好公开收录后，给 GitHub 仓库加 `orca-plugin` topic。社区索引自动发现合格版本，不需要向 Orca 主仓库提 PR。到 [插件状态页](https://orca.dev/plugins/flylink-code/chat-gauge) 查结果；通常在一小时内处理，不保证即时出现。

**版本**：含多 Agent 与会话跟随的社区发布版本为 `v0.3.0`。之后日常更新从 `v0.3.1` 起递增；详见[发布版本规则](../agent/rules/20-git.md#发布版本)。
