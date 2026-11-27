# Chat Gauge for Orca

English · [简体中文](README_zh.md)

See local agents’ **context usage** in Orca’s status bar and right sidebar, with **tokens/sec** when a timed request is available.

```text
93.9k/100k · ≈13.9 tok/s
```

## Try the prototype

1. On Windows, use Orca **1.4.274 or later** with Plugins enabled. From this repository, run `orca plugin dev load . --json` and review the access Orca asks you to approve. Approve only if you trust the local code.
2. Open a local native chat in Orca. Chat Gauge auto-selects a lone chat. With several chats, the panel shows one tab per chat in the workspace; the first chat is selected by default and the status bar shows the selected chat. Your choice is remembered per workspace. It does not follow Orca's focused tab yet, because Orca 1.4.274 gives plugins no live focus signal; it never guesses from agent activity.
3. Select **Chat Gauge** in Orca’s right sidebar, or run `orca plugin open local.chat-gauge --panel chat-gauge`. The status item toggles the right sidebar. **Context Window (tokens)** defaults to `0` to use Orca’s reported limit, if available. A positive value overrides the window for whichever chat is selected.

**Language:** Settings → Plugins → Chat Gauge → **Language / 语言**. Auto uses the Orca host’s system locale, not the chat content. The sidebar and status tooltip support English, Simplified Chinese, and Traditional Chinese; the status readout shows numbers and units only. Unsupported locales fall back to English.

## What the numbers mean

| Readout | Source and limitations |
| --- | --- |
| Average throughput | Output tokens ÷ approximate request duration, including time to first token. Updates when a completed usage record arrives; not a live decode rate. If a request start cannot be inferred, throughput is unavailable. |
| Decode speed (Antigravity) | Output tokens ÷ summed model streaming time of the last completed turn, read from agy's own conversation database. Excludes first-token wait and tool time; shown only when every call matches the transcript and streaming lasted at least 1 s. |
| Context used | The latest Orca context fact, or a Claude transcript estimate. It does not include the current draft. |
| Context percentage | Relative to the reported window or a manual override. A custom endpoint’s window is never guessed from its model name. |
| Claude context breakdown | Treemap areas follow reported occupied category counts; tile numbers match the detailed list. Free, reserved, and deferred categories are listed separately. |

Coverage follows Orca 1.4.274’s 23 native Chat agents. When available, the panel shows the window and successful root-turn time. Claude uses request timing; Antigravity and Codex can show a whole-turn average, and OpenCode 1/2, Copilot and Pi can show a timed message. Gemini can show output counts without inventing a rate. See the [support matrix](docs/multi-agent.md) for field requirements and live vs. fixture verification. Terminal panes, WSL, SSH, and paired remote hosts are not supported.

## Local access

The trusted worker runs with your account’s access on the Orca host. It calls the local Orca CLI to list chats, queries only the selected chat’s context fields in Orca’s Windows database using a read-only connection, and reads session-bound provider transcripts or SQLite usage metadata for optional message/turn metrics. It sends no data to external services, does not call model APIs, and forwards no transcript body to the UI. Orca’s database and the transcript formats may change. The only Orca capabilities requested are `workspace:read` and `settings:own`.

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

`npm test` uses synthetic fixtures. `npm run check` checks the plugin with Orca; it does not exercise HTML frame interactions. On Windows, run `node scripts/check-panel.mjs` to exercise the real sidebar with synthetic snapshots in a local browser. For the worker data path, `node scripts/smoke.mjs '<workspace selector>'` reads a local workspace that has chat usage and prints aggregate counts only.

Capture the loaded HTML sidebar (desktop Orca, isolated plugin frames enabled):

```powershell
orca plugin shot local.chat-gauge --panel chat-gauge --width 320 --json
```

Unload the development plugin with `orca plugin dev unload . --json`. See [MVP plan](docs/mvp.md) and [agent handoff](AGENTS.md) for scope and implementation notes.
