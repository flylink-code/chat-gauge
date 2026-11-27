import { Buffer } from 'node:buffer'
import { lstat, open, readdir, type FileHandle } from 'node:fs/promises'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { readGenCalls } from './agy-gen'
import type { AgyDecode, ProviderRate } from './provider-rate'
import { isRecord, tokenCount } from './transcript'

/**
 * Whole-turn throughput for an Antigravity (agy) native chat.
 *
 * The caller must pass the latest successful Orca root turn it selected, with
 * the exact `startedAt` / `completedAt` recorded by Orca for that turn. This
 * module never picks a turn itself and never falls back to a neighbouring
 * transcript file or timestamp.
 */
export type AgyTurn = { startedAt: number; completedAt: number; durationMs: number }

/** One completed primary model call inside a bound turn. */
export type AgyStep = {
  step: number
  /** Whole-second transcript timestamp. Not a generation start or duration. */
  createdAt: number
  outputTokens: number
  model: string | null
}

type Binding = { nativeId: string; home: string }

type Row = {
  type: string
  at: number | null
  source: string | null
  status: string | null
  step: number | null
  output: number | null
  model: string | null
  truncated: unknown
  tools: unknown
}

type Source = { path: string; size: number }

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i

/**
 * The ACP runtime home Orca's own managed chat writes under, and the agy CLI
 * history home observed on Orca 1.4.274 on Windows. Both sit under GEMINI_HOME.
 */
const BRAIN_ROOTS = ['antigravity-acp', 'antigravity-cli'] as const

/** Bounded tail read: the selected turn must be wholly inside this window. */
const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024
const MAX_CHUNKS = 4096
const MATCH_MS = 1000
const MIN_STREAM_MS = 1000

const safeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value)

function decodeTurn(turn: unknown): AgyTurn | null {
  if (!isRecord(turn)) return null
  const { startedAt, completedAt, durationMs } = turn
  if (!safeInteger(startedAt) || startedAt < 0) return null
  if (!safeInteger(completedAt) || completedAt < 0) return null
  if (!safeInteger(durationMs) || durationMs <= 0) return null
  if (completedAt < startedAt) return null
  // `durationMs` is Orca's measured turn duration when available; it may start
  // at `requestedAt` rather than `startedAt`, so do not force it to equal the
  // span. The caller selected this turn; we only validate it is usable.
  return { startedAt, completedAt, durationMs }
}

function decodeBinding(record: unknown): Binding | null {
  if (!isRecord(record) || record.schemaVersion !== 2 || record.provider !== 'antigravity') return null
  const location = record.location
  if (!isRecord(location) || location.executionHostId !== 'local' || location.wslDistro) return null
  if (!Array.isArray(record.providerHandleChain) || record.providerHandleChain.length === 0) return null
  const link: unknown = record.providerHandleChain.at(-1)
  if (!isRecord(link) || !isRecord(link.handle)) return null
  const handle = link.handle
  if (handle.transport !== 'acp' || (handle.agent !== 'antigravity' && handle.agent !== 'agy')) return null
  if (typeof handle.nativeId !== 'string' || !UUID.test(handle.nativeId)) return null
  const home = record.launchedAccount === undefined ? record.accountHome
    : isRecord(record.launchedAccount) ? record.launchedAccount.accountHome : null
  if (!isRecord(home) || home.variable !== 'GEMINI_HOME' || typeof home.path !== 'string' || !isAbsolute(home.path)) return null
  // The lease records the handle the runtime actually proved. When present it
  // must be the same link; otherwise the chain tail is not the current session.
  if (isRecord(record.lease) && typeof record.lease.provenHandleLinkId === 'string' &&
      typeof link.linkId === 'string' && record.lease.provenHandleLinkId !== link.linkId) return null
  return { nativeId: handle.nativeId, home: home.path }
}

async function realDirectory(path: string): Promise<boolean> {
  const stat = await lstat(path).catch(() => null)
  return !!stat && stat.isDirectory() && !stat.isSymbolicLink()
}

async function realFile(path: string): Promise<Source | null> {
  const stat = await lstat(path).catch(() => null)
  return stat?.isFile() && !stat.isSymbolicLink() ? { path, size: stat.size } : null
}

type Chunks = { sources: Source[]; size: number }

async function listChunks(dir: string): Promise<Chunks | null> {
  if (!(await realDirectory(dir))) return null
  const names = (await readdir(dir).catch(() => null))?.filter((name) => /^\d{8}\.jsonl$/.test(name)).sort()
  if (!names?.length || names.length > MAX_CHUNKS) return null
  const sources: Source[] = []
  let size = 0
  for (let index = 0; index < names.length; index++) {
    if (names[index] !== `${String(index).padStart(8, '0')}.jsonl`) return null
    const source = await realFile(join(dir, names[index]))
    if (!source) return null
    sources.push(source)
    size += source.size
    if (!Number.isSafeInteger(size)) return null
  }
  return { sources, size }
}

type Evidence = { sources: Source[]; size: number }

async function sessionEvidence(root: string, nativeId: string): Promise<Evidence | null> {
  const brain = resolve(root, 'brain')
  const session = resolve(brain, nativeId)
  // Defence in depth: the UUID check already prevents traversal.
  if (!session.startsWith(brain + sep)) return null
  const logs = join(session, '.system_generated', 'logs')
  if (!(await realDirectory(session)) || !(await realDirectory(logs))) return null

  const chunkDir = join(logs, 'chunks', 'transcript')
  const chunkEntry = await lstat(chunkDir).catch(() => null)
  const chunks = await listChunks(chunkDir)
  // A chunk directory that exists but is malformed, linked or gapped cannot
  // corroborate a merged file.
  if (chunkEntry && !chunks) return null
  // transcript.jsonl is the concatenation agy exposes to readers. Prefer it,
  // but only when the chunk files agree on the same byte length.
  const merged = await realFile(join(logs, 'transcript.jsonl'))
  if (merged) {
    if (chunks && chunks.size !== merged.size) return null
    return { sources: [merged], size: merged.size }
  }
  const full = await realFile(join(logs, 'transcript_full.jsonl'))
  if (full) {
    if (chunks && chunks.size !== full.size) return null
    return { sources: [full], size: full.size }
  }
  return chunks ? { sources: chunks.sources, size: chunks.size } : null
}

async function readExact(file: FileHandle, length: number, position: number): Promise<Buffer | null> {
  const buffer = Buffer.allocUnsafe(length)
  let offset = 0
  while (offset < length) {
    const { bytesRead } = await file.read(buffer, offset, length - offset, position + offset)
    if (bytesRead <= 0) return null
    offset += bytesRead
  }
  return buffer
}

async function readSource(source: Source, from: number): Promise<Buffer | null> {
  const file = await open(source.path, 'r')
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size !== source.size || from > source.size) return null
    return await readExact(file, source.size - from, from)
  } finally { await file.close() }
}

/** Read at most MAX_TRANSCRIPT_BYTES from the end of the evidence. */
async function readTail(evidence: Evidence): Promise<Buffer | null> {
  const start = Math.max(0, evidence.size - MAX_TRANSCRIPT_BYTES)
  const parts: Buffer[] = []
  let position = 0
  let began = false
  for (const source of evidence.sources) {
    const end = position + source.size
    if (end <= start) {
      position = end
      continue
    }
    const from = began ? 0 : start - position
    began = true
    const part = await readSource(source, from)
    if (!part) return null
    parts.push(part)
    position = end
  }
  if (!began) return null
  const bytes = Buffer.concat(parts)
  if (bytes.length === 0 || bytes[bytes.length - 1] !== 0x0a) return null
  // If the window starts mid-line, drop that partial line: the selected turn
  // must be found intact or the answer is null.
  if (start > 0) {
    const first = bytes.indexOf(0x0a)
    if (first === -1) return null
    return bytes.subarray(first + 1)
  }
  return bytes
}

function parseRows(bytes: Buffer): Row[] | null {
  const text = bytes.toString('utf8')
  const lines = text.split('\n')
  const rows: Row[] = []
  for (const line of lines) {
    if (!line) continue
    let value: unknown
    try { value = JSON.parse(line) } catch { return null }
    if (!isRecord(value) || typeof value.type !== 'string') return null
    const at = typeof value.created_at === 'string' ? Date.parse(value.created_at) : NaN
    rows.push({
      type: value.type,
      at: Number.isFinite(at) ? at : null,
      source: typeof value.source === 'string' ? value.source : null,
      status: typeof value.status === 'string' ? value.status : null,
      step: safeInteger(value.step_index) && value.step_index >= 0 ? value.step_index : null,
      output: tokenCount(value.output_tokens),
      model: typeof value.model === 'string' && value.model ? value.model.slice(0, 160) : null,
      truncated: value.truncated_fields,
      tools: value.tool_calls
    })
  }
  return rows
}

function truncatesOutput(fields: unknown): boolean {
  if (fields === undefined || fields === null) return false
  if (!Array.isArray(fields)) return true
  return fields.some((field) => field === 'output_tokens' || typeof field !== 'string')
}

function isFinalPlanner(row: Row): boolean {
  if (Array.isArray(row.truncated) && row.truncated.includes('tool_calls')) return false
  if (row.truncated !== undefined && row.truncated !== null && !Array.isArray(row.truncated)) return false
  const tools = row.tools
  return tools === undefined || tools === null || (Array.isArray(tools) && tools.length === 0)
}

type Bound = { turn: AgyTurn; steps: AgyStep[]; outputTokens: number }

function bind(rows: Row[], turn: AgyTurn): Bound | null {
  // The transcript timestamp is whole seconds. A unique USER_INPUT within that
  // precision of Orca's exact startedAt proves which prompt began this turn.
  const candidates = rows.filter((row) =>
    row.type === 'USER_INPUT' && row.at !== null && Math.abs(row.at - turn.startedAt) < MATCH_MS)
  if (candidates.length !== 1) return null
  const start = rows.indexOf(candidates[0])
  let end = start + 1
  while (end < rows.length && rows[end].type !== 'USER_INPUT') end++
  const next = rows[end]
  // A second USER_INPUT inside the turn means one prompt did not bound it.
  if (next && (next.at === null || next.at < turn.completedAt)) return null

  const steps: AgyStep[] = []
  const seen = new Set<number>()
  let previous = -Infinity
  let finalPlanner = false
  for (const row of rows.slice(start + 1, end)) {
    if (row.at === null || row.at < turn.startedAt - MATCH_MS || row.at > turn.completedAt) return null
    if (row.at < previous) return null
    previous = row.at
    if (row.type === 'PLANNER_RESPONSE') {
      if (row.source !== 'MODEL' || row.status !== 'DONE') return null
      if (row.step === null || row.output === null || truncatesOutput(row.truncated)) return null
      if (seen.has(row.step)) return null
      seen.add(row.step)
      steps.push({ step: row.step, createdAt: row.at, outputTokens: row.output, model: row.model })
      finalPlanner = isFinalPlanner(row)
    } else {
      // A tool row can keep a stale RUNNING status after agy moved on; it is
      // not a primary output count, so only a system error and the final-row
      // requirement below can invalidate the turn.
      if (row.type === 'ERROR_MESSAGE') return null
      finalPlanner = false
    }
  }
  // A turn with no model calls, or one whose last event is not a final answer
  // with no pending tools, cannot prove a complete output count.
  if (!steps.length || !finalPlanner) return null
  let total = 0
  for (const step of steps) {
    if (!Number.isSafeInteger(total + step.outputTokens)) return null
    total += step.outputTokens
  }
  if (total <= 0) return null
  return { turn, steps, outputTokens: total }
}

type Located = { bound: Bound; database: string }

async function readBound(record: unknown, turn: AgyTurn): Promise<Located | null> {
  const binding = decodeBinding(record)
  const window = decodeTurn(turn)
  if (!binding || !window) return null
  const home = resolve(binding.home)
  const evidence: { root: string; found: Evidence }[] = []
  for (const root of BRAIN_ROOTS) {
    const found = await sessionEvidence(join(home, root), binding.nativeId)
    if (found) evidence.push({ root, found })
  }
  // Two live homes for one native ID make the primary transcript ambiguous.
  if (evidence.length !== 1) return null
  const bytes = await readTail(evidence[0].found)
  if (!bytes) return null
  const rows = parseRows(bytes)
  const bound = rows ? bind(rows, window) : null
  return bound ? { bound, database: join(home, evidence[0].root, 'conversations', `${binding.nativeId}.db`) } : null
}

/**
 * Model-streaming speed for the bound turn from agy's per-call timing. Every bound
 * call must appear in the database with the same output count and a positive stream
 * time; otherwise there is no decode figure and the whole-turn average stands alone.
 */
async function readDecode(bound: Bound, database: string): Promise<AgyDecode | null> {
  const calls = await readGenCalls(database)
  if (!calls) return null
  let outputTokens = 0
  let streamMs = 0
  const first: number[] = []
  for (const step of bound.steps) {
    const call = calls.get(step.step)
    if (!call || call.outputTokens !== step.outputTokens || call.streamMs === null) return null
    outputTokens += call.outputTokens
    streamMs += call.streamMs
    if (call.firstTokenMs !== null) first.push(call.firstTokenMs)
  }
  // A sub-second stream is mostly one network burst; its ratio says little about decode speed.
  if (outputTokens <= 0 || streamMs < MIN_STREAM_MS) return null
  first.sort((a, b) => a - b)
  const mid = first.length >> 1
  const firstTokenMs = !first.length ? null : first.length % 2 ? first[mid] : (first[mid - 1] + first[mid]) / 2
  return { outputTokens, streamMs, firstTokenMs, calls: bound.steps.length }
}

/**
 * Whole-turn average output throughput for a selected Orca root turn.
 *
 * Returns null unless this module can prove the transcript belongs to the
 * record's current ACP session, the selected prompt boundaries exactly one
 * USER_INPUT, every primary model call is complete, and the final call ended
 * without pending tools. The result is a whole-turn average including tool and
 * approval time, not a live decode rate. It reads only agy's own transcript
 * files for that native ID under the record's GEMINI_HOME; it never consults a
 * shared or "latest" transcript and makes no model calls.
 */
export async function readAgyRate(record: unknown, turn: AgyTurn): Promise<ProviderRate | null> {
  try {
    const located = await readBound(record, turn)
    if (!located) return null
    const { bound } = located
    const rate: ProviderRate = {
      scope: 'turn',
      outputTokens: bound.outputTokens,
      durationMs: bound.turn.durationMs,
      completedAt: bound.turn.completedAt
    }
    // The decode figure is optional: any problem with the database leaves the average intact.
    const decode = await readDecode(bound, located.database).catch(() => null)
    return decode ? { ...rate, decode } : rate
  } catch {
    return null
  }
}

/**
 * Per-model-call output counts for the same unambiguously bound turn, when the
 * whole-turn rate is also safe. No rate is derived here: agy's `created_at` is
 * whole-second wall time, not a generation clock, and using adjacent steps as
 * a duration produces impossible speeds (a local sample showed 12,579 tokens
 * four seconds after the previous step, about 3,100 tok/s). Use this accessor
 * only as evidence for the aggregate count, never as a per-step timer. The real
 * per-call timing comes from `gen_metadata`, see `readAgyRate().decode`.
 */
export async function readAgySteps(record: unknown, turn: AgyTurn): Promise<AgyStep[] | null> {
  try {
    const located = await readBound(record, turn)
    return located ? located.bound.steps.map((step) => ({ ...step })) : null
  } catch {
    return null
  }
}
