import { Buffer } from 'node:buffer'
import { lstat } from 'node:fs/promises'

/**
 * Per-model-call timing from agy's own conversation database
 * (`<GEMINI_HOME>/<root>/conversations/<id>.db`, table `gen_metadata`).
 *
 * The field numbers were reverse-engineered by the third-party q1uuuu/agy-context
 * plugin and re-checked locally against transcript output counts; Google does not
 * document them. Every consumer must therefore cross-check the counts and treat
 * any mismatch as "no data". Only numeric fields are read; no text leaves SQLite.
 *
 * gen_metadata.data = message { f1: call { f4: usage { f3: output_tokens },
 *   f11: Duration first_text, f12: Duration stream } }
 */
export type GenCall = { outputTokens: number; firstTokenMs: number | null; streamMs: number | null }

/** Planner calls keyed by the transcript/steps `step_index`. */
export type GenCalls = Map<number, GenCall>

const MAX_BLOB_BYTES = 16 * 1024 * 1024
const MAX_ROWS = 20_000
const PLANNER_STEP_TYPE = 15

type Field = { num: number; wire: number; varint: bigint | null; bytes: Buffer | null }

function varint(buf: Buffer, at: number): { value: bigint; next: number } {
  let value = 0n
  let shift = 0n
  for (let offset = at; offset < buf.length && shift < 70n; offset++) {
    const byte = buf[offset]
    value |= BigInt(byte & 0x7f) << shift
    if ((byte & 0x80) === 0) return { value, next: offset + 1 }
    shift += 7n
  }
  throw new Error('bad varint')
}

function fields(buf: Buffer): Field[] {
  const out: Field[] = []
  let at = 0
  while (at < buf.length) {
    const tag = varint(buf, at)
    at = tag.next
    const num = Number(tag.value >> 3n)
    const wire = Number(tag.value & 7n)
    if (wire === 0) {
      const v = varint(buf, at)
      at = v.next
      out.push({ num, wire, varint: v.value, bytes: null })
    } else if (wire === 2) {
      const len = varint(buf, at)
      const end = len.next + Number(len.value)
      if (!Number.isSafeInteger(end) || end > buf.length) throw new Error('bad length')
      out.push({ num, wire, varint: null, bytes: buf.subarray(len.next, end) })
      at = end
    } else if (wire === 1 || wire === 5) {
      at += wire === 1 ? 8 : 4
      if (at > buf.length) throw new Error('bad fixed')
    } else throw new Error('bad wire')
  }
  return out
}

const message = (buf: Buffer | null, num: number): Buffer | null =>
  buf ? fields(buf).find((f) => f.num === num && f.wire === 2)?.bytes ?? null : null

const integer = (buf: Buffer | null, num: number): number | null => {
  const value = buf ? fields(buf).find((f) => f.num === num && f.wire === 0)?.varint : null
  return value === null || value === undefined || value > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(value)
}

/** protobuf Duration -> milliseconds; absent, zero or malformed is null. */
function durationMs(buf: Buffer | null): number | null {
  if (!buf) return null
  const seconds = integer(buf, 1) ?? 0
  const nanos = integer(buf, 2) ?? 0
  if (nanos >= 1e9) return null
  const ms = seconds * 1000 + nanos / 1e6
  return Number.isFinite(ms) && ms > 0 ? ms : null
}

export function decodeGenCall(data: Uint8Array): GenCall | null {
  try {
    const call = message(Buffer.from(data), 1)
    const outputTokens = integer(message(call, 4), 3)
    if (outputTokens === null) return null
    return { outputTokens, firstTokenMs: durationMs(message(call, 11)), streamMs: durationMs(message(call, 12)) }
  } catch {
    return null
  }
}

/**
 * Read all planner calls. The nth `steps` row of the planner step type is the nth
 * `gen_metadata` row; both counts must agree or the database is not trusted.
 */
export async function readGenCalls(path: string): Promise<GenCalls | null> {
  const stat = await lstat(path).catch(() => null)
  if (!stat?.isFile() || stat.isSymbolicLink()) return null
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const planners = db.prepare('SELECT idx FROM steps WHERE step_type = ? ORDER BY idx LIMIT ?').all(PLANNER_STEP_TYPE, MAX_ROWS + 1)
    const rows = db.prepare(
      'SELECT idx, CASE WHEN length(data) <= ? THEN data ELSE NULL END AS data FROM gen_metadata ORDER BY idx LIMIT ?'
    ).all(MAX_BLOB_BYTES, MAX_ROWS + 1)
    if (!planners.length || planners.length !== rows.length || rows.length > MAX_ROWS) return null
    const calls: GenCalls = new Map()
    for (let ordinal = 0; ordinal < rows.length; ordinal++) {
      const step = planners[ordinal].idx
      const data = rows[ordinal].data
      if (typeof step !== 'number' || !(data instanceof Uint8Array)) return null
      const call = decodeGenCall(data)
      if (!call) return null
      calls.set(step, call)
    }
    return calls
  } finally {
    db.close()
  }
}
