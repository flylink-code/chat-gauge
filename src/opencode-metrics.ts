// OpenCode / OpenCode 2 message-average throughput from one exact Orca conversation.
//
// Orca v1.4.274 stores OpenCode 1.x assistant messages in `message` and OpenCode 2
// messages in `session_v2` / `session_message` (see
// ../orca/src/main/opencode-usage/opencode-usage-row-queries.ts and
// ../orca/src/main/native-chat/transcript-history/opencode/transcript-opencode2-sqlite.ts).
// This reader projects only numeric token and time fields; message text and tool rows
// never leave SQLite. The current provider handle names the exact conversation, and the
// account locator names the exact store: there is no recency or cross-account fallback.

import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { ProviderRate } from './provider-rate'
import { isRecord } from './transcript'

type Agent = 'opencode' | 'opencode2'
type Account = { kind: 'unmanaged' } | { kind: 'managed'; profileId: string }

const MAX_HANDLE_LENGTH = 512
const MAX_CHAIN_LENGTH = 256
const MANAGED_PROFILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
// A WSL UNC link can boot or stall a distro from an ordinary file read.
const WSL_UNC = /^[\\/]{2}(?:wsl\$|wsl\.localhost)[\\/]/i

const isAgent = (value: unknown): value is Agent => value === 'opencode' || value === 'opencode2'

const positiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0

const nonNegativeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

function isHandleField(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_HANDLE_LENGTH &&
    value === value.trim() && !value.includes('\u0000')
}

/** OpenCode records pin a locator, not a directory: managed accounts relocate XDG_DATA_HOME. */
function decodeAccount(value: unknown): Account | null {
  if (!isRecord(value) || value.kind !== 'opencode' || !isRecord(value.locator)) return null
  const locator = value.locator
  if (locator.kind === 'unmanaged') return { kind: 'unmanaged' }
  if (locator.kind === 'managed' && typeof locator.managedProfileId === 'string' &&
      MANAGED_PROFILE.test(locator.managedProfileId)) {
    return { kind: 'managed', profileId: locator.managedProfileId.toLowerCase() }
  }
  return null
}

/** `launchedAccount` is the latest runtime account; absent means the founding `accountHome`. */
function launchedAccount(value: unknown): { account: Account } | null | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value) || !positiveInteger(value.fence)) return null
  const account = decodeAccount(value.accountHome)
  return account ? { account } : null
}

type Target = { agent: Agent; sessionId: string; account: Account }

function decodeRecord(record: unknown): Target | null {
  if (!isRecord(record) || record.schemaVersion !== 2) return null
  const provider = record.provider
  if (!isAgent(provider)) return null
  const location = record.location
  // Local native chats only: a WSL or remote record names a store this worker cannot read.
  if (!isRecord(location) || location.executionHostId !== 'local' ||
      (location.wslDistro !== null && location.wslDistro !== undefined && location.wslDistro !== '')) return null
  const chain = record.providerHandleChain
  if (!Array.isArray(chain) || chain.length === 0 || chain.length > MAX_CHAIN_LENGTH) return null
  const link = chain.at(-1)
  if (!isRecord(link) || !isRecord(link.handle)) return null
  const handle = link.handle
  // OpenCode is an ACP agent. A typed `provider` handle belongs to Claude or Codex.
  if (Object.hasOwn(handle, 'provider') || handle.transport !== 'acp' || handle.agent !== provider) return null
  if (!isHandleField(handle.nativeId)) return null

  // The founding account must always be valid; the latest launch may override where it lives.
  const home = decodeAccount(record.accountHome)
  if (!home) return null
  const launched = launchedAccount(record.launchedAccount)
  if (launched === null) return null
  return { agent: provider, sessionId: handle.nativeId, account: launched?.account ?? home }
}

function appData(environment: NodeJS.ProcessEnv, home: string): string {
  return environment.APPDATA || join(home, 'AppData', 'Roaming')
}

/**
 * The one database the exact account writes. Managed accounts use the Orca user-data
 * profile directory, matching managed-data-accounts/service.ts in v1.4.274.
 */
function databasePath(target: Target, environment = process.env, home = homedir()): string | null {
  if (target.account.kind === 'managed') {
    const path = join(
      appData(environment, home), 'orca', 'managed-data-accounts', 'opencode',
      target.account.profileId, 'data', 'opencode', 'opencode.db'
    )
    return WSL_UNC.test(path) ? null : path
  }
  const selection = environment.OPENCODE_DB?.trim()
  if (selection === ':memory:') return null
  const dataDirectory = join(
    environment.XDG_DATA_HOME?.trim() || join(home, '.local', 'share'), 'opencode'
  )
  const path = selection && isAbsolute(selection)
    ? selection
    : join(dataDirectory, selection || 'opencode.db')
  return WSL_UNC.test(path) ? null : path
}

function tableExists(db: DatabaseSync, name: string): boolean {
  const row = db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
  return isRecord(row) && row.found === 1
}

function columns(db: DatabaseSync, table: string): Set<string> {
  const names = new Set<string>()
  for (const row of db.prepare(`PRAGMA table_info(${table})`).all()) {
    if (isRecord(row) && typeof row.name === 'string') names.add(row.name)
  }
  return names
}

function hasSchema(db: DatabaseSync, table: string, required: readonly string[]): boolean {
  if (!tableExists(db, table)) return false
  const present = columns(db, table)
  return required.every((column) => present.has(column))
}

function hasSession(db: DatabaseSync, table: 'session' | 'session_v2', sessionId: string): boolean {
  return db.prepare(`SELECT 1 AS found FROM ${table} WHERE id = ?`).get(sessionId)?.found === 1
}

// Case guards keep malformed JSON rows from raising through json_extract. Completed
// assistant rows are ordered newest-first; only the latest is read, never the body.
const V1_QUERY = `
  SELECT
    CASE WHEN json_valid(data) THEN json_extract(data, '$.tokens.output') END AS output,
    CASE WHEN json_valid(data) THEN json_extract(data, '$.time.created') END AS created,
    CASE WHEN json_valid(data) THEN json_extract(data, '$.time.completed') END AS completed
  FROM message
  WHERE session_id = ?
    AND CASE WHEN json_valid(data) THEN json_extract(data, '$.role') END = 'assistant'
    AND CASE WHEN json_valid(data) THEN json_type(data, '$.time.completed') END IN ('integer', 'real')
  ORDER BY completed DESC
  LIMIT 2`

const V2_QUERY = `
  SELECT
    CASE WHEN json_valid(data) THEN json_extract(data, '$.tokens.output') END AS output,
    CASE WHEN json_valid(data) THEN json_extract(data, '$.time.created') END AS created,
    CASE WHEN json_valid(data) THEN json_extract(data, '$.time.completed') END AS completed
  FROM session_message
  WHERE session_id = ?
    AND type = 'assistant'
    AND CASE WHEN json_valid(data) THEN json_type(data, '$.time.completed') END IN ('integer', 'real')
  ORDER BY completed DESC
  LIMIT 2`

function milliseconds(value: unknown): number | null {
  if (!positiveInteger(value)) return null
  // OpenCode writes milliseconds; tolerate second-based writers like Orca's parser does.
  const ms = value < 10_000_000_000 ? value * 1000 : value
  return Number.isSafeInteger(ms) ? ms : null
}

function rateFromRows(rows: readonly unknown[]): ProviderRate | null {
  const latest = rows[0]
  if (!isRecord(latest)) return null
  const next = rows[1]
  // Two equally new completed messages cannot be ordered without guessing.
  if (isRecord(next) && next.completed === latest.completed) return null
  const outputTokens = nonNegativeInteger(latest.output) ? latest.output : null
  const created = milliseconds(latest.created)
  const completed = milliseconds(latest.completed)
  if (outputTokens === null || created === null || completed === null) return null
  const durationMs = completed - created
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0) return null
  return { scope: 'message', outputTokens, durationMs, completedAt: completed }
}

type Probe = { kind: 'absent' } | { kind: 'value'; rate: ProviderRate | null }

/** OpenCode 2 migrated rows copy into `session_v2`; a live v2 conversation wins over frozen v1 rows. */
function readV2(db: DatabaseSync, sessionId: string): Probe {
  if (!hasSchema(db, 'session_v2', ['id']) ||
      !hasSchema(db, 'session_message', ['session_id', 'type', 'data'])) return { kind: 'absent' }
  if (!hasSession(db, 'session_v2', sessionId)) return { kind: 'absent' }
  return { kind: 'value', rate: rateFromRows(db.prepare(V2_QUERY).all(sessionId)) }
}

function readV1(db: DatabaseSync, sessionId: string): Probe {
  if (!hasSchema(db, 'session', ['id']) ||
      !hasSchema(db, 'message', ['session_id', 'data'])) return { kind: 'absent' }
  if (!hasSession(db, 'session', sessionId)) return { kind: 'absent' }
  return { kind: 'value', rate: rateFromRows(db.prepare(V1_QUERY).all(sessionId)) }
}

async function readTarget(target: Target): Promise<ProviderRate | null> {
  const path = databasePath(target)
  if (!path) return null
  const info = await stat(path).catch(() => null)
  if (!info?.isFile()) return null
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    db.exec('PRAGMA query_only = ON')
    const v2 = readV2(db, target.sessionId)
    if (v2.kind === 'value') return v2.rate
    const v1 = readV1(db, target.sessionId)
    return v1.kind === 'value' ? v1.rate : null
  } finally {
    db.close()
  }
}

/**
 * Read one exact local OpenCode conversation's latest completed assistant message.
 * Returns null for any unsupported, ambiguous, missing, or unreadable record/store.
 */
export async function readOpenCode(record: unknown): Promise<ProviderRate | null> {
  try {
    const target = decodeRecord(record)
    return target ? await readTarget(target) : null
  } catch {
    return null
  }
}
