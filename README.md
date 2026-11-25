# Chat Gauge for Orca

English · [简体中文](README_zh.md)

See local agents’ **context usage** in Orca’s status bar and right sidebar, with **tokens/sec** when a timed request is available.

```text
93.9k/100k · ≈13.9 tok/s
```

## Try the prototype

1. On Windows, use Orca **1.4.274 or later** with Plugins enabled. From this repository, run `orca plugin dev load . --json` and review the access Orca asks you to approve. Approve only if you trust the local code.
2. Open a local native chat in Orca. Chat Gauge auto-selects a lone chat. With several chats, select one in the panel; it does not guess which tab is focused.
3. Select **Chat Gauge** in Orca’s right sidebar, or run `orca plugin open local.chat-gauge --panel chat-gauge`. The status item toggles the right sidebar. **Context Window (tokens)** defaults to `0` to use Orca’s reported limit, if available. A positive value overrides the window for whichever chat is selected.

**Language:** Settings → Plugins → Chat Gauge → **Language / 语言**. Auto uses the Orca host’s system locale, not the chat content. The sidebar and status tooltip support English, Simplified Chinese, and Traditional Chinese; the status readout shows numbers and units only. Unsupported locales fall back to English.

## What the numbers mean

| Readout | Source and limitations |
| --- | --- |
| Average throughput | Output tokens ÷ approximate request duration, including time to first token. Updates when a completed usage record arrives; not a live decode rate. If a request start cannot be inferred, throughput is unavailable. |
| Context used | The latest Orca context fact, or a Claude transcript estimate. It does not include the current draft. |
| Context percentage | Relative to the reported window or a manual override. A custom endpoint’s window is never guessed from its model name. |
| Claude context breakdown | Treemap areas follow reported occupied category counts; tile numbers match the detailed list. Free, reserved, and deferred categories are listed separately. |

Claude Code context and throughput, and Antigravity context, are verified on local Windows. Codex, OpenCode, and Pi are discoverable; context reads use the same Orca facts when available and still need live validation. See the [support matrix](docs/multi-agent.md). Terminal panes, WSL, SSH, and paired remote hosts are not supported.

## Local access

The trusted worker runs with your account’s access on the Orca host. It calls the local Orca CLI to list chats, queries only the selected chat’s context fields in Orca’s Windows database using a read-only connection, and reads the identified Claude JSONL for request metrics. It sends no data to external services, does not call model APIs, and forwards no transcript body to the UI. Orca’s database and the transcript formats may change. The only Orca capabilities requested are `workspace:read` and `settings:own`.

## Develop

Run from the repository root with Orca and Node 24 on PATH. Orca transpiles the plugin directly; the npm packages are development-only.

```powershell
npm ci
orca plugin types . --json
npm run typecheck
npm test
npm run check
orca plugin validate . --json
```

`npm test` uses synthetic fixtures. `npm run check` renders no-chat, selected, multi-chat, and context-only states with Orca’s stand-in host. To exercise the real data path without loading the trusted worker, run `node scripts/smoke.mjs '<workspace selector>'` against a local workspace with a chat that has usage data. It prints only aggregate counts.

If Orca is minimized, render a synthetic screenshot without installing the plugin:

```powershell
orca plugin shot . --scenario 'high context' --theme dark --width 360 --json
```

Unload the development plugin with `orca plugin dev unload . --json`. See [MVP plan](docs/mvp.md) and [agent handoff](AGENTS.md) for scope and implementation notes.
