// Copilot CLI / Gemini CLI native-chat metric sources for Orca v1.4.274 ACP chats.
//
// Orca binds an ACP chat to the CLI's own conversation id:
//   - Copilot: `handle.nativeId` is the session id under `<COPILOT_HOME>/session-state/`
//     (src/main/copilot/copilot-acp-launch-spec.ts).
//   - Gemini: `handle.nativeId` is the session id written under
//     `<GEMINI_CLI_HOME>/.gemini/tmp/` (src/main/gemini/gemini-acp-launch-spec.ts).
// Only numeric usage fields from that exact conversation are read; message text,
// titles, tool payloads and paths never leave this module.
//
// Copilot writes one `session.usage_record` per model call. Its `duration` is the
// model-call wall clock in milliseconds, `outputTokens` is the response's output
// token count, and the record carries a completion timestamp. That is an exact
// message-level time/token pairing, so `readAcpRate` returns it. Subagent calls
// carry `parentToolCallId` (plus an outer `agentId`) and are rejected. Older
// Copilot stores back the same facts in `session-store.db`; that store is only a
// fallback when the event file has no usable record.
//
// Gemini stores per-response `tokens` but only the response's own timestamp: no
// model-call start, duration, TTFT or latency. Deriving a rate from adjacent
// message timestamps would invent throughput, so `readAcpRate` returns null for
// Gemini. Its exact last-response token counts are exposed as `AcpTokenUsage`
// through `readAcpUsage` instead.

import { open, readdir, readFile, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { ProviderRate } from './provider-rate'
import { isRecord, tokenCount } from './transcript'

type AcpAgent = 'copilot' | 'gemini'

/** A Gemini response's exact token counts. There is deliberately no duration field. */
export type AcpTokenUsage = {
  provider: 'gemini'
  scope: 'message'
  model: string | null
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number | null
  reasoningTokens: number | null
  toolTokens: number | null
  totalTokens: number | null
  completedAt: number
}

type Target = { agent: AcpAgent; sessionId: string; account: string }

const MAX_HANDLE_LENGTH = 512
const MAX_CHAIN_LENGTH = 256
const MAX_ACCOUNT_PATH_LENGTH = 4096
// A WSL UNC link can boot or stall a distro from an ordinary file read.
const WSL_UNC = /^[\\/]{2}(?:wsl\$|wsl\.localhost)[\\/]/i
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
// Gemini session ids become file names. Reject separators and parent segments.
const SAFE_SESSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/

const MAX_TAIL_BYTES = 4 * 1024 * 1024
const MAX_GEMINI_TAIL_BYTES = 2 * 1024 * 1024
const MAX_LINE_BYTES = 1024 * 1024
const HEAD_BYTES = 64 * 1024
const MAX_GEMINI_JSON_BYTES = 8 * 1024 * 1024
const MAX_GEMINI_SCAN_DIRS = 512
const MAX_GEMINI_SCAN_FILES = 2048

const positiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0

function isHandleField(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_HANDLE_LENGTH &&
    value === value.trim() && !value.includes('\u0000')
}

function accountPath(value: unknown, variable: string): string | null {
  if (!isRecord(value) || value.variable !== variable || typeof value.path !== 'string') return null
  const path = value.path
  return path.length > 0 && path.length <= MAX_ACCOUNT_PATH_LENGTH &&
    !path.includes('\u0000') && isAbsolute(path) && !WSL_UNC.test(path) ? path : null
}

/** `launchedAccount` is the latest runtime account; absent means the founding `accountHome`. */
function launchedAccount(record: Record<string, unknown>, variable: string): string | null | undefined {
  const value = record.launchedAccount
  if (value === undefined) return undefined
  if (!isRecord(value) || !positiveInteger(value.fence)) return null
  return accountPath(value.accountHome, variable)
}

function decodeRecord(record: unknown): Target | null {
  if (!isRecord(record) || record.schemaVersion !== 2) return null
  const agent = record.provider
  if (agent !== 'copilot' && agent !== 'gemini') return null
  const location = record.location
  // Local native chats only: a WSL or remote record names a store this worker cannot read.
  if (!isRecord(location) || location.executionHostId !== 'local' ||
      (location.wslDistro !== null && location.wslDistro !== undefined)) return null
  const chain = record.providerHandleChain
  if (!Array.isArray(chain) || chain.length === 0 || chain.length > MAX_CHAIN_LENGTH) return null
  const link = chain.at(-1)
  if (!isRecord(link) || !isRecord(link.handle)) return null
  const handle = link.handle
  // Both agents are ACP. A typed `provider` handle belongs to Claude or Codex.
  if ('provider' in handle || handle.transport !== 'acp' || handle.agent !== agent) return null
  if (!isHandleField(handle.nativeId)) return null
  const sessionId = handle.nativeId
  if (agent === 'copilot' ? !UUID.test(sessionId) : !SAFE_SESSION.test(sessionId) || sessionId.includes('..')) {
    return null
  }
  const variable = agent === 'copilot' ? 'COPILOT_HOME' : 'GEMINI_CLI_HOME'
  const launched = launchedAccount(record, variable)
  if (launched === null) return null
  const account = launched ?? accountPath(record.accountHome, variable)
  return account ? { agent, sessionId, account } : null
}

function timestamp(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const ms = Date.parse(value)
  return Number.isSafeInteger(ms) && ms > 0 ? ms : null
}

function isoMilliseconds(value: unknown): number | null {
  return typeof value === 'string' && ISO_TIME.test(value) ? timestamp(value) : null
}

/**
 * Read a bounded tail without loading the whole (often tens-of-MB) event file.
 * The first line may be partial; drop it unless the byte before the window was a
 * newline, in which case the first line is complete.
 */
async function readTailText(path: string, maxBytes: number): Promise<string | null> {
  const file = await open(path, 'r')
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size <= 0) return null
    const windowStart = Math.max(0, info.size - maxBytes)
    const from = windowStart > 0 ? windowStart - 1 : 0
    const buffer = Buffer.allocUnsafe(info.size - from)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, from)
    if (bytesRead <= 0) return null
    let text = buffer.toString('utf8', 0, bytesRead)
    if (windowStart > 0) {
      if (buffer[0] === 0x0a) {
        text = text.slice(1)
      } else {
        const newline = text.indexOf('\n')
        if (newline === -1) return null
        text = text.slice(newline + 1)
      }
    }
    return text
  } finally {
    await file.close()
  }
}

function copilotRate(value: unknown): ProviderRate | null {
  if (!isRecord(value) || value.type !== 'session.usage_record' || value.agentId !== undefined) return null
  const data = value.data
  if (!isRecord(data) || !isRecord(data.usage)) return null
  const usage = data.usage
  // A subagent's call is not the root conversation's output.
  if (usage.parentToolCallId !== undefined) return null
  // Compaction and other synthetic calls are not user-visible replies.
  if (usage.initiator !== 'user' && usage.initiator !== 'agent') return null
  if (usage.finishReason !== 'stop' && usage.finishReason !== 'tool_calls') return null
  const callId = typeof usage.apiCallId === 'string' && usage.apiCallId.length > 0
    ? usage.apiCallId
    : typeof usage.providerCallId === 'string' && usage.providerCallId.length > 0
      ? usage.providerCallId
      : null
  if (!callId) return null
  const outputTokens = positiveInteger(usage.outputTokens) ? usage.outputTokens : null
  const durationMs = positiveInteger(usage.duration) ? usage.duration : null
  const completedAt = timestamp(value.timestamp)
  if (outputTokens === null || durationMs === null || completedAt === null) return null
  return { scope: 'message', outputTokens, durationMs, completedAt }
}

async function readCopilotEvents(target: Target): Promise<ProviderRate | null> {
  const text = await readTailText(
    join(target.account, 'session-state', target.sessionId, 'events.jsonl'),
    MAX_TAIL_BYTES
  )
  if (!text) return null
  let latest: ProviderRate | null = null
  for (const line of text.split('\n')) {
    if (line.length === 0 || line.length > MAX_LINE_BYTES || !line.includes('session.usage_record')) continue
    let row: unknown
    try { row = JSON.parse(line) } catch { continue }
    const rate = copilotRate(row)
    if (rate) latest = rate
  }
  return latest
}

function tableExists(db: DatabaseSync, name: string): boolean {
  const row = db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
  return isRecord(row) && row.found === 1
}

/**
 * Fallback for Copilot stores that kept usage in `session-store.db` instead of the
 * event stream. `duration_ms` is the same per-model-call measure. Rows for
 * subagents, compaction and non-completed calls are excluded.
 */
async function readCopilotDb(target: Target): Promise<ProviderRate | null> {
  const path = join(target.account, 'session-store.db')
  const info = await stat(path).catch(() => null)
  if (!info?.isFile()) return null
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    db.exec('PRAGMA query_only = ON')
    if (!tableExists(db, 'assistant_usage_events')) return null
    const rows = db.prepare(`
      SELECT duration_ms AS duration, output_tokens AS output, created_at AS completed
      FROM assistant_usage_events
      WHERE session_id = ?
        AND agent_id IS NULL AND parent_tool_call_id IS NULL
        AND initiator IN ('user', 'agent')
        AND finish_reason IN ('stop', 'tool_calls')
        AND duration_ms > 0 AND output_tokens > 0
        AND created_at LIKE '____-__-__T%'
      ORDER BY created_at DESC, id DESC
      LIMIT 8`).all(target.sessionId)
    // A non-ISO creation time cannot name a completion instant; skip it rather than
    // letting one malformed row hide the newest usable call behind it.
    for (const row of rows) {
      if (!isRecord(row)) continue
      const durationMs = positiveInteger(row.duration) ? row.duration : null
      const outputTokens = positiveInteger(row.output) ? row.output : null
      const completedAt = isoMilliseconds(row.completed)
      if (durationMs === null || outputTokens === null || completedAt === null) continue
      return { scope: 'message', outputTokens, durationMs, completedAt }
    }
    return null
  } finally {
    db.close()
  }
}

async function readCopilot(target: Target): Promise<ProviderRate | null> {
  const events = await readCopilotEvents(target).catch(() => null)
  return events ?? await readCopilotDb(target).catch(() => null)
}

function geminiUsage(value: unknown): AcpTokenUsage | null {
  if (!isRecord(value) || value.type !== 'gemini') return null
  const tokens = value.tokens
  if (!isRecord(tokens)) return null
  const inputTokens = tokenCount(tokens.input)
  const outputTokens = tokenCount(tokens.output)
  const completedAt = timestamp(value.timestamp)
  if (inputTokens === null || outputTokens === null || completedAt === null) return null
  const model = typeof value.model === 'string' && value.model.length > 0
    ? value.model.slice(0, 160)
    : null
  return {
    provider: 'gemini', scope: 'message', model,
    inputTokens, outputTokens,
    cacheReadTokens: tokenCount(tokens.cached),
    reasoningTokens: tokenCount(tokens.thoughts),
    toolTokens: tokenCount(tokens.tool),
    totalTokens: tokenCount(tokens.total),
    completedAt
  }
}

async function readHead(path: string, size: number): Promise<string | null> {
  const file = await open(path, 'r')
  try {
    const length = Math.min(size, HEAD_BYTES)
    const buffer = Buffer.allocUnsafe(length)
    const { bytesRead } = await file.read(buffer, 0, length, 0)
    return bytesRead > 0 ? buffer.toString('utf8', 0, bytesRead) : null
  } finally {
    await file.close()
  }
}

async function geminiSessionId(path: string): Promise<string | null> {
  const info = await stat(path).catch(() => null)
  if (!info?.isFile()) return null
  if (path.toLowerCase().endsWith('.jsonl')) {
    const text = await readHead(path, info.size)
    if (!text) return null
    for (const line of text.split('\n').slice(0, 16)) {
      if (line.length === 0) continue
      let row: unknown
      try { row = JSON.parse(line) } catch { continue }
      if (isRecord(row) && typeof row.sessionId === 'string') return row.sessionId
    }
    return null
  }
  if (info.size > MAX_GEMINI_JSON_BYTES) return null
  let row: unknown
  try { row = JSON.parse(await readFile(path, 'utf8')) } catch { return null }
  return isRecord(row) && typeof row.sessionId === 'string' ? row.sessionId : null
}

/** Find the one chat file whose own session id equals the Orca handle's native id. */
async function findGeminiSession(account: string, sessionId: string): Promise<string | null> {
  const root = join(account, '.gemini', 'tmp')
  const projects = await readdir(root, { withFileTypes: true }).catch(() => [])
  let dirs = 0
  let files = 0
  let found: string | null = null
  for (const project of projects) {
    if (!project.isDirectory()) continue
    if (++dirs > MAX_GEMINI_SCAN_DIRS) return null
    const chats = join(root, project.name, 'chats')
    const entries = await readdir(chats, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      // Subagent sessions are nested under a directory, so only top-level chat files count.
      if (!entry.isFile() || !/\.(?:json|jsonl)$/i.test(entry.name)) continue
      if (++files > MAX_GEMINI_SCAN_FILES) return null
      const path = join(chats, entry.name)
      if (await geminiSessionId(path) !== sessionId) continue
      if (found !== null) return null
      found = path
    }
  }
  return found
}

async function readGeminiUsage(target: Target): Promise<AcpTokenUsage | null> {
  const path = await findGeminiSession(target.account, target.sessionId)
  if (!path) return null
  if (path.toLowerCase().endsWith('.jsonl')) {
    const text = await readTailText(path, MAX_GEMINI_TAIL_BYTES)
    if (!text) return null
    let latest: AcpTokenUsage | null = null
    for (const line of text.split('\n')) {
      if (line.length === 0 || line.length > MAX_LINE_BYTES) continue
      let row: unknown
      try { row = JSON.parse(line) } catch { continue }
      const usage = geminiUsage(row)
      if (usage) latest = usage
    }
    return latest
  }
  const info = await stat(path).catch(() => null)
  if (!info?.isFile() || info.size > MAX_GEMINI_JSON_BYTES) return null
  let doc: unknown
  try { doc = JSON.parse(await readFile(path, 'utf8')) } catch { return null }
  if (!isRecord(doc) || !Array.isArray(doc.messages)) return null
  for (let index = doc.messages.length - 1; index >= 0; index--) {
    const usage = geminiUsage(doc.messages[index])
    if (usage) return usage
  }
  return null
}

/**
 * Read one exact local ACP conversation's latest completed model call.
 * Copilot is supported. Gemini has token counts but no reliable call duration, so
 * it returns null rather than estimating a rate.
 */
export async function readAcpRate(record: unknown): Promise<ProviderRate | null> {
  try {
    const target = decodeRecord(record)
    return target?.agent === 'copilot' ? await readCopilot(target) : null
  } catch {
    return null
  }
}

/**
 * Supported non-throughput metric: Gemini's latest completed response token counts,
 * bound to the same exact conversation. Copilot's equivalent is already a
 * `ProviderRate`, so this returns null for Copilot.
 */
export async function readAcpUsage(record: unknown): Promise<AcpTokenUsage | null> {
  try {
    const target = decodeRecord(record)
    return target?.agent === 'gemini' ? await readGeminiUsage(target) : null
  } catch {
    return null
  }
}
