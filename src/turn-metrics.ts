import { Buffer } from 'node:buffer'
import { lstat, open, readdir, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, join } from 'node:path'
import type { ProviderRate } from './provider-rate'
import { isRecord, tokenCount } from './transcript'

// Provider handles mirror Orca v1.4.274's persisted decode
// (src/shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding.ts).
const SCHEMA_VERSION = 2
const MAX_CHAIN_LINKS = 256
const MAX_HANDLE_FIELD = 512
const MAX_RESUME_CURSOR = 4096
const MAX_PATH = 4096
const NAMESPACE_PART = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/
const NEUTRAL_FIELDS = ['transport', 'agent', 'nativeId', 'resumeCursor'] as const
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i
const CODEX_ROLLOUT = /^rollout-(.+)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:_[0-9a-f-]{36})?\.jsonl$/i
const PI_FILE_ID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i

const HEADER_BYTES = 64 * 1024
const TAIL_BYTES = 1024 * 1024
const MAX_LINE_BYTES = 1024 * 1024
const MAX_TURNS = 64
const MAX_USAGE_KEYS = 20_000
const MAX_PENDING_USAGE = 4096
const MAX_PI_RECORDS = 20_000
const MAX_DURATION_MS = 7 * 24 * 60 * 60 * 1000
const MAX_OUTPUT_TOKENS = 100_000_000
const SCAN_TTL_MS = 1000
const MAX_SCAN_DIRS = 2048
const MAX_CACHED_READERS = 8
const MAX_CACHED_SCANS = 64

type DecodedHandle = { transport: string; agent: string; nativeId: string }
type DecodedRecord = { provider: 'codex' | 'pi'; handle: DecodedHandle; codexHome: string | null }

const isHandleField = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= MAX_HANDLE_FIELD && value === value.trim()

const isNamespacePart = (value: unknown): value is string =>
  typeof value === 'string' && NAMESPACE_PART.test(value)

const sameId = (left: string, right: string): boolean =>
  left === right || (UUID.test(left) && UUID.test(right) && left.toLowerCase() === right.toLowerCase())

function decodeStoredHandle(value: unknown): DecodedHandle | null {
  if (!isRecord(value)) return null
  const hasProvider = Object.hasOwn(value, 'provider')
  if (hasProvider && NEUTRAL_FIELDS.some((field) => Object.hasOwn(value, field))) return null
  if (hasProvider) {
    if (value.provider === 'claude') {
      const sessionId = value.sessionId
      const leaf = value.leafUuid
      return isHandleField(sessionId) && (leaf === null || isHandleField(leaf))
        ? { transport: 'claude-sdk', agent: 'claude', nativeId: sessionId }
        : null
    }
    if (value.provider === 'codex') {
      return isHandleField(value.threadId)
        ? { transport: 'codex-app-server', agent: 'codex', nativeId: value.threadId }
        : null
    }
    return null
  }
  const { transport, agent, nativeId, resumeCursor } = value
  if (!isNamespacePart(transport) || !isNamespacePart(agent) || !isHandleField(nativeId)) return null
  if ((transport === 'claude-sdk' && agent === 'claude') ||
      (transport === 'codex-app-server' && agent === 'codex')) return null
  if (resumeCursor !== undefined &&
      (typeof resumeCursor !== 'string' || resumeCursor.length === 0 || resumeCursor.length > MAX_RESUME_CURSOR)) {
    return null
  }
  return { transport, agent, nativeId }
}

function decodeRecord(record: unknown, provider: 'codex' | 'pi'): DecodedRecord | null {
  if (!isRecord(record) || record.schemaVersion !== SCHEMA_VERSION || record.provider !== provider) return null
  const location = record.location
  if (!isRecord(location) || location.executionHostId !== 'local' || location.wslDistro) return null
  const chain = record.providerHandleChain
  if (!Array.isArray(chain) || chain.length === 0 || chain.length > MAX_CHAIN_LINKS) return null
  let head: DecodedHandle | null = null
  for (const link of chain) {
    const handle = isRecord(link) ? decodeStoredHandle(link.handle) : null
    if (!handle) return null
    if (head && (handle.transport !== head.transport || handle.agent !== head.agent)) return null
    head = handle
  }
  if (!head || head.agent !== provider) return null
  if (provider === 'codex' && head.transport !== 'codex-app-server') return null
  if (provider === 'pi' && head.transport !== 'jsonl-rpc') return null
  const home = record.accountHome
  let codexHome: string | null = null
  if (provider === 'codex') {
    if (!isRecord(home) || 'kind' in home || home.variable !== 'CODEX_HOME' ||
        typeof home.path !== 'string' || !isAbsolute(home.path) || home.path.length > MAX_PATH) return null
    codexHome = home.path
  }
  return { provider, handle: head, codexHome }
}

type TailState = {
  identity: string
  offset: number
  pending: Buffer
  skipLine: boolean
  headerOk: boolean
  fromStart: boolean
}
type PumpResult = { state: TailState; reset: boolean; lines: string[] }

function headerRecord(view: Buffer): { ok: boolean; record: unknown } {
  const end = view.indexOf(10)
  if (end === -1) return { ok: false, record: null }
  let line = view.toString('utf8', 0, end).replace(/\r$/, '')
  if (line.charCodeAt(0) === 0xfeff) line = line.slice(1)
  try { return { ok: true, record: JSON.parse(line) } } catch { return { ok: false, record: null } }
}

async function readHeader(file: Awaited<ReturnType<typeof open>>, size: number): Promise<{ ok: boolean; record: unknown }> {
  if (size <= 0) return { ok: false, record: null }
  const length = Math.min(size, HEADER_BYTES)
  const buffer = Buffer.allocUnsafe(length)
  const { bytesRead } = await file.read(buffer, 0, length, 0)
  return headerRecord(buffer.subarray(0, bytesRead))
}

async function pumpTail(
  path: string,
  prior: TailState | null,
  validateHeader: (record: unknown) => boolean
): Promise<PumpResult | null> {
  let file: Awaited<ReturnType<typeof open>>
  try { file = await open(path, 'r') } catch { return null }
  try {
    const stats = await file.stat()
    if (!stats.isFile()) return null
    const identity = `${stats.dev}:${stats.ino}:${stats.birthtimeMs}`
    const reset = !prior || prior.identity !== identity || stats.size < prior.offset
    let state: TailState
    if (reset) {
      const offset = Math.max(0, stats.size - TAIL_BYTES)
      let skipLine = false
      if (offset > 0) {
        const probe = Buffer.allocUnsafe(1)
        const { bytesRead } = await file.read(probe, 0, 1, offset - 1)
        skipLine = !(bytesRead === 1 && probe[0] === 10)
      }
      state = { identity, offset, pending: Buffer.alloc(0), skipLine, headerOk: false, fromStart: offset === 0 }
      const header = await readHeader(file, stats.size)
      state.headerOk = header.ok && validateHeader(header.record)
      if (!state.headerOk) return { state, reset, lines: [] }
    } else {
      state = prior
      if (!state.headerOk) {
        const header = await readHeader(file, stats.size)
        state.headerOk = header.ok && validateHeader(header.record)
        if (!state.headerOk) return { state, reset, lines: [] }
      }
    }
    const available = stats.size - state.offset
    if (available <= 0) return { state, reset, lines: [] }
    const length = Math.min(available, TAIL_BYTES)
    const buffer = Buffer.allocUnsafe(length)
    const { bytesRead } = await file.read(buffer, 0, length, state.offset)
    state.offset += bytesRead
    let bytes = bytesRead === length ? buffer : buffer.subarray(0, bytesRead)
    if (state.pending.length > 0) bytes = Buffer.concat([state.pending, bytes])
    state.pending = Buffer.alloc(0)
    const lines: string[] = []
    let start = 0
    if (state.skipLine) {
      const newline = bytes.indexOf(10)
      if (newline === -1) return { state, reset, lines }
      start = newline + 1
      state.skipLine = false
    }
    for (let newline = bytes.indexOf(10, start); newline !== -1; newline = bytes.indexOf(10, start)) {
      if (newline - start <= MAX_LINE_BYTES) {
        lines.push(bytes.toString('utf8', start, newline).replace(/\r$/, ''))
      }
      start = newline + 1
    }
    const rest = bytes.subarray(start)
    if (rest.length > MAX_LINE_BYTES) {
      state.skipLine = true
      state.pending = Buffer.alloc(0)
    } else if (rest.length > 0) {
      // A newline-less tail may be a complete object or a partial write; only consume it when it parses.
      const text = rest.toString('utf8').replace(/\r$/, '')
      if (text.trimEnd().endsWith('}')) {
        try {
          JSON.parse(text)
          lines.push(text)
          state.pending = Buffer.alloc(0)
        } catch {
          state.pending = Buffer.from(rest)
        }
      } else {
        state.pending = Buffer.from(rest)
      }
    } else {
      state.pending = Buffer.alloc(0)
    }
    return { state, reset, lines }
  } finally {
    await file.close()
  }
}

function rowTime(row: Record<string, unknown>): number | null {
  if (typeof row.timestamp !== 'string') return null
  const time = Date.parse(row.timestamp)
  return Number.isFinite(time) && time > 0 ? time : null
}

const positiveNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null

// Codex writes started_at/completed_at in seconds; tolerate millisecond values.
const epochValue = (value: unknown): number | null => {
  const number = positiveNumber(value)
  if (number === null) return null
  return number >= 1e12 ? number : number * 1000
}

const millisValue = (value: unknown): number | null => positiveNumber(value)

const durationValue = (value: unknown): number | null => {
  const duration = positiveNumber(value)
  return duration !== null && duration <= MAX_DURATION_MS ? duration : null
}

const turnId = (payload: Record<string, unknown>): string | null => {
  const value = payload.turn_id
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_HANDLE_FIELD ? value : null
}

const explicitStart = (payload: Record<string, unknown>): number | null =>
  millisValue(payload.started_at_ms) ?? epochValue(payload.started_at)

const tupleOf = (usage: unknown): string | null => {
  if (!isRecord(usage)) return null
  const count = (key: string) => tokenCount(usage[key]) ?? 0
  return [
    count('input_tokens'),
    tokenCount(usage.cached_input_tokens) ?? tokenCount(usage.cache_read_input_tokens) ?? 0,
    count('cache_write_input_tokens'),
    count('output_tokens'),
    count('reasoning_output_tokens'),
    count('total_tokens')
  ].join(',')
}

const outputOf = (usage: unknown): number | null => {
  if (!isRecord(usage)) return null
  const output = tokenCount(usage.output_tokens)
  return output !== null && output <= MAX_OUTPUT_TOKENS ? output : null
}

type CodexTurn = {
  id: string
  startedAt: number | null
  startSeen: boolean
  usage: Set<string>
  output: number
  overflow: boolean
  completedAt: number | null
  durationMs: number | null
  terminalSeq: number
}
type CodexParser = {
  currentTurnId: string | null
  turns: Map<string, CodexTurn>
  pending: Array<{ key: string; output: number }>
  seq: number
  completeFromStart: boolean
}

function ensureTurn(parser: CodexParser, id: string): CodexTurn {
  let turn = parser.turns.get(id)
  if (turn) return turn
  if (parser.turns.size >= MAX_TURNS) {
    for (const key of parser.turns.keys()) {
      if (key !== parser.currentTurnId) {
        parser.turns.delete(key)
        break
      }
    }
    if (parser.turns.size >= MAX_TURNS) {
      const oldest = parser.turns.keys().next().value
      if (oldest !== undefined) parser.turns.delete(oldest)
    }
  }
  turn = { id, startedAt: null, startSeen: false, usage: new Set(), output: 0, overflow: false, completedAt: null, durationMs: null, terminalSeq: 0 }
  parser.turns.set(id, turn)
  return turn
}

function addUsage(turn: CodexTurn, key: string, output: number): void {
  if (turn.overflow || turn.usage.has(key)) return
  if (turn.usage.size >= MAX_USAGE_KEYS) {
    turn.overflow = true
    return
  }
  turn.usage.add(key)
  const total = turn.output + output
  if (!Number.isSafeInteger(total) || total > MAX_OUTPUT_TOKENS) {
    turn.overflow = true
    return
  }
  turn.output = total
}

function consumeCodexRow(parser: CodexParser, row: unknown): void {
  if (!isRecord(row)) return
  const payload = isRecord(row.payload) ? row.payload : null
  if (!payload) return
  if (row.type === 'turn_context') {
    const id = turnId(payload)
    if (!id) return
    parser.currentTurnId = id
    parser.pending.length = 0
    ensureTurn(parser, id).startSeen = true
    return
  }
  if (row.type !== 'event_msg') return
  const type = payload.type
  if (type === 'task_started' || type === 'turn_started') {
    const id = turnId(payload)
    if (!id) return
    parser.currentTurnId = id
    parser.pending.length = 0
    const turn = ensureTurn(parser, id)
    turn.startSeen = true
    const start = explicitStart(payload) ?? rowTime(row)
    if (start !== null) turn.startedAt = start
    return
  }
  if (type === 'token_count') {
    const info = isRecord(payload.info) ? payload.info : null
    if (!info) return
    const last = info.last_token_usage
    const output = outputOf(last)
    const lastTuple = tupleOf(last)
    if (output === null || lastTuple === null) return
    const totalTuple = tupleOf(info.total_token_usage)
    const key = totalTuple !== null
      ? `T|${totalTuple}|${lastTuple}`
      : `S|${typeof row.timestamp === 'string' ? row.timestamp : ''}|${lastTuple}`
    const id = turnId(payload) ?? parser.currentTurnId
    if (!id) {
      if (parser.pending.length < MAX_PENDING_USAGE) parser.pending.push({ key, output })
      return
    }
    addUsage(ensureTurn(parser, id), key, output)
    return
  }
  if (type === 'task_complete' || type === 'turn_complete') {
    const id = turnId(payload) ?? parser.currentTurnId
    if (!id) return
    if (turnId(payload)) parser.currentTurnId = id
    const turn = ensureTurn(parser, id)
    for (const pending of parser.pending) addUsage(turn, pending.key, pending.output)
    parser.pending.length = 0
    const start = explicitStart(payload)
    if (start !== null && (turn.startedAt === null || start < turn.startedAt)) turn.startedAt = start
    let completedAt = millisValue(payload.completed_at_ms) ?? epochValue(payload.completed_at) ?? rowTime(row)
    let durationMs = durationValue(payload.duration_ms)
    if (durationMs === null && completedAt !== null && turn.startedAt !== null && completedAt > turn.startedAt) {
      const elapsed = completedAt - turn.startedAt
      if (elapsed > 0 && elapsed <= MAX_DURATION_MS) durationMs = elapsed
    }
    if (completedAt === null && durationMs !== null && turn.startedAt !== null) {
      completedAt = turn.startedAt + durationMs
    }
    turn.terminalSeq = ++parser.seq
    if (completedAt === null || durationMs === null || durationMs <= 0) return
    turn.completedAt = completedAt
    turn.durationMs = durationMs
    return
  }
  if (type === 'turn_aborted') {
    const id = turnId(payload)
    if (id) parser.currentTurnId = id
    parser.pending.length = 0
  }
}

function latestCodexRate(parser: CodexParser): ProviderRate | null {
  // The last terminal turn wins even when it lacks usable counts: an older rate must not stand in for it.
  let latest: CodexTurn | null = null
  for (const turn of parser.turns.values()) {
    if (turn.terminalSeq > (latest?.terminalSeq ?? 0)) latest = turn
  }
  if (!latest || latest.overflow || latest.completedAt === null || latest.durationMs === null) return null
  // A tail that began mid-turn cannot prove it saw every request in that turn.
  if (!latest.startSeen && !parser.completeFromStart) return null
  if (latest.output <= 0 || latest.output > MAX_OUTPUT_TOKENS) return null
  return { scope: 'turn', outputTokens: latest.output, durationMs: latest.durationMs, completedAt: latest.completedAt }
}

function parseCodexRolloutId(name: string): { threadId: string; stamp: string } | null {
  const match = CODEX_ROLLOUT.exec(name)
  return match ? { threadId: match[2].toLowerCase(), stamp: match[1] } : null
}

function validCodexHeader(record: unknown, expected: string, path: string): boolean {
  const rollout = parseCodexRolloutId(basename(path))
  if (!rollout || !sameId(rollout.threadId, expected)) return false
  // A short or synthetic fixture may omit session_meta; the exact rollout filename is still the identity.
  if (!isRecord(record) || record.type !== 'session_meta') return true
  const payload = isRecord(record.payload) ? record.payload : null
  return !!payload && typeof payload.id === 'string' && sameId(payload.id, expected)
}

type ScanState = { path: string | null; at: number; rootMtimeMs: number | null }

const scanCache = new Map<string, ScanState>()

async function scanRollouts(root: string, expected: string): Promise<{ path?: string; ambiguous?: boolean }> {
  const matches: string[] = []
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }]
  let budget = MAX_SCAN_DIRS
  let exhausted = false
  while (stack.length > 0) {
    if (budget-- <= 0) {
      exhausted = true
      break
    }
    const current = stack.pop()!
    let entries
    try { entries = await readdir(current.dir, { withFileTypes: true }) } catch { continue }
    const dirs: string[] = []
    for (const entry of entries) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.jsonl')) {
        const rollout = parseCodexRolloutId(entry.name)
        if (rollout && sameId(rollout.threadId, expected)) {
          matches.push(join(current.dir, entry.name))
          if (matches.length > 1) return { ambiguous: true }
        }
      } else if (entry.isDirectory() && current.depth < 4) {
        dirs.push(join(current.dir, entry.name))
      }
    }
    // Date-like directory names sort chronologically; LIFO visits the newest first.
    dirs.sort()
    for (const dir of dirs) stack.push({ dir, depth: current.depth + 1 })
  }
  if (matches.length === 0) return {}
  return matches.length === 1 && !exhausted ? { path: matches[0] } : { ambiguous: true }
}

async function findRollout(home: string, expected: string): Promise<string | null> {
  const key = `${home}\u0000${expected.toLowerCase()}`
  const cached = scanCache.get(key)
  if (cached?.path) {
    const found = await lstat(cached.path).catch(() => null)
    if (found?.isFile()) return cached.path
    scanCache.delete(key)
  }
  const root = join(home, 'sessions')
  const rootStats = await stat(root).catch(() => null)
  if (cached && cached.path === null && Date.now() - cached.at < SCAN_TTL_MS &&
      (rootStats?.mtimeMs ?? null) === cached.rootMtimeMs) {
    return null
  }
  const found = await scanRollouts(root, expected)
  scanCache.set(key, { path: found.path ?? null, at: Date.now(), rootMtimeMs: rootStats?.mtimeMs ?? null })
  while (scanCache.size > MAX_CACHED_SCANS) {
    const oldest = scanCache.keys().next().value
    if (oldest === undefined) break
    scanCache.delete(oldest)
  }
  return found.path ?? null
}

type CachedReader<P> = { tail: TailState; parser: P }
const codexReaders = new Map<string, CachedReader<CodexParser>>()
const piReaders = new Map<string, CachedReader<PiParser>>()

function cacheReader<P>(readers: Map<string, CachedReader<P>>, path: string, reader: CachedReader<P>): void {
  readers.delete(path)
  readers.set(path, reader)
  while (readers.size > MAX_CACHED_READERS) {
    const oldest = readers.keys().next().value
    if (oldest === undefined) break
    readers.delete(oldest)
  }
}

const locks = new Map<string, Promise<void>>()

function withLock<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve()
  const tail = previous.then(run, run)
  const settled = tail.then(() => undefined, () => undefined)
  locks.set(key, settled)
  void settled.then(() => { if (locks.get(key) === settled) locks.delete(key) })
  return tail
}

async function readCodexRate(record: DecodedRecord): Promise<ProviderRate | null> {
  const expected = record.handle.nativeId
  const home = record.codexHome
  if (!home) return null
  const path = await findRollout(home, expected)
  if (!path) return null
  return withLock(path, async () => {
    const prior = codexReaders.get(path)
    const pumped = await pumpTail(path, prior?.tail ?? null, (row) => validCodexHeader(row, expected, path))
    if (!pumped || !pumped.state.headerOk) {
      codexReaders.delete(path)
      return null
    }
    const parser = prior && !pumped.reset
      ? prior.parser
      : { currentTurnId: null, turns: new Map(), pending: [], seq: 0, completeFromStart: pumped.state.fromStart } satisfies CodexParser
    for (const line of pumped.lines) {
      let row: unknown
      try { row = JSON.parse(line) } catch { continue }
      consumeCodexRow(parser, row)
    }
    cacheReader(codexReaders, path, { tail: pumped.state, parser })
    return latestCodexRate(parser)
  })
}

function piFileId(path: string): string | null {
  const match = PI_FILE_ID.exec(basename(path, extname(path)))
  return match ? match[1].toLowerCase() : null
}

function validPiHeader(record: unknown, expected: string | null): boolean {
  // Pi always writes a session header; allow a minimal fixture that starts at a message.
  if (!isRecord(record)) return false
  if (record.type !== 'session') return true
  return typeof record.id === 'string' && (expected === null || sameId(record.id, expected))
}

function piMessageRate(row: Record<string, unknown>, message: Record<string, unknown>): ProviderRate | null {
  if (typeof message.errorMessage === 'string' && message.errorMessage.length > 0) return null
  const stop = message.stopReason
  if (stop !== 'stop' && stop !== 'length' && stop !== 'toolUse') return null
  const usage = isRecord(message.usage) ? message.usage : null
  const output = usage ? (tokenCount(usage.output) ?? tokenCount(usage.outputTokens) ?? tokenCount(usage.output_tokens)) : null
  if (output === null || output <= 0 || output > MAX_OUTPUT_TOKENS) return null
  const durationMs = durationValue(message.durationMs)
  if (durationMs === null) return null
  const stamp = message.timestamp
  const completedAt = typeof stamp === 'number' && Number.isFinite(stamp) && stamp > 0
    ? stamp
    : typeof stamp === 'string' && Number.isFinite(Date.parse(stamp))
      ? Date.parse(stamp)
      : rowTime(row)
  if (completedAt === null || completedAt <= 0) return null
  return { scope: 'message', outputTokens: output, durationMs, completedAt }
}

type PiRecord = {
  id: string
  parentId: string | null
  kind: 'assistant' | 'compaction' | 'other'
  rate: ProviderRate | null
}
type PiParser = { records: Map<string, PiRecord>; lastId: string | null }

function consumePiRow(parser: PiParser, row: unknown): void {
  if (!isRecord(row) || row.type === 'session') return
  const id = row.id
  if (typeof id !== 'string' || id.length === 0 || id.length > MAX_HANDLE_FIELD) return
  const parentId = typeof row.parentId === 'string' && row.parentId.length > 0 && row.parentId.length <= MAX_HANDLE_FIELD
    ? row.parentId
    // Older or synthetic Pi files omit parentId; they append linearly rather than branching.
    : Object.hasOwn(row, 'parentId') ? null : parser.lastId === id ? null : parser.lastId
  let kind: PiRecord['kind'] = 'other'
  let rate: ProviderRate | null = null
  if (row.type === 'compaction') {
    kind = 'compaction'
  } else if (row.type === 'message') {
    const message = isRecord(row.message) ? row.message : null
    if (message?.role === 'assistant') {
      rate = piMessageRate(row, message)
      if (rate) kind = 'assistant'
    }
  }
  parser.records.set(id, { id, parentId, kind, rate })
  parser.lastId = id
  while (parser.records.size > MAX_PI_RECORDS) {
    const oldest = parser.records.keys().next().value
    if (oldest === undefined) break
    parser.records.delete(oldest)
  }
}

function latestPiRate(parser: PiParser): ProviderRate | null {
  let id = parser.lastId
  const seen = new Set<string>()
  while (id !== null && !seen.has(id)) {
    seen.add(id)
    const record = parser.records.get(id)
    if (!record) return null
    // Compaction starts a new context; rates from before it must not be reported as current.
    if (record.kind === 'compaction') return null
    if (record.kind === 'assistant' && record.rate) return record.rate
    id = record.parentId
  }
  return null
}

async function readPiRate(record: DecodedRecord): Promise<ProviderRate | null> {
  const path = record.handle.nativeId
  if (!isAbsolute(path) || extname(path).toLowerCase() !== '.jsonl') return null
  const expected = piFileId(path)
  return withLock(path, async () => {
    const prior = piReaders.get(path)
    const pumped = await pumpTail(path, prior?.tail ?? null, (row) => validPiHeader(row, expected))
    if (!pumped || !pumped.state.headerOk) {
      piReaders.delete(path)
      return null
    }
    const parser = prior && !pumped.reset
      ? prior.parser
      : { records: new Map(), lastId: null } satisfies PiParser
    for (const line of pumped.lines) {
      let row: unknown
      try { row = JSON.parse(line) } catch { continue }
      consumePiRow(parser, row)
    }
    cacheReader(piReaders, path, { tail: pumped.state, parser })
    return latestPiRate(parser)
  })
}

export function clearTurnRateCache(): void {
  scanCache.clear()
  codexReaders.clear()
  piReaders.clear()
  locks.clear()
}

export async function readTurnRate(record: unknown): Promise<ProviderRate | null> {
  try {
    const codex = decodeRecord(record, 'codex')
    if (codex) return await readCodexRate(codex)
    const pi = decodeRecord(record, 'pi')
    if (pi) return await readPiRate(pi)
    return null
  } catch {
    return null
  }
}
