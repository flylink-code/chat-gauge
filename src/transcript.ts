import type { Sample } from './protocol'

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

export function tokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

export class Transcript {
  sample: Sample | null = null
  private started: number | null = null
  private startedForLast: number | null = null
  private seen = new Set<string>()
  private lastId: string | null = null

  consume(line: string, sessionId: string): void {
    let row: unknown
    try { row = JSON.parse(line) } catch { return }
    if (!isRecord(row) || row.sessionId !== sessionId || row.isSidechain === true) return
    if (row.type === 'system' && row.subtype === 'compact_boundary') {
      this.sample = null
      this.lastId = null
      this.started = this.startedForLast = null
      return
    }
    const time = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN
    if (!Number.isFinite(time)) return
    if (row.type === 'api-request') {
      this.started = time
      return
    }
    if (row.type !== 'assistant' || !isRecord(row.message)) return
    const { id, model, usage, stop_reason: stop } = row.message
    if (typeof id !== 'string' || !id || stop === null || typeof stop !== 'string' || !stop) return
    const same = id === this.lastId
    if (!same) {
      if (this.seen.has(id)) return
      this.seen.add(id)
      if (this.seen.size > 256) this.seen.delete(this.seen.values().next().value!)
      this.lastId = id
      this.startedForLast = this.started
      this.started = null
      this.sample = null
    }
    if (typeof model !== 'string' || !model || !isRecord(usage)) return
    const input = tokenCount(usage.input_tokens)
    const output = tokenCount(usage.output_tokens)
    const cacheRead = tokenCount(usage.cache_read_input_tokens ?? 0)
    const cacheWrite = tokenCount(usage.cache_creation_input_tokens ?? 0)
    if (input === null || output === null || cacheRead === null || cacheWrite === null) return
    if (this.sample && time < this.sample.completedAt) return
    const elapsed = this.startedForLast === null ? 0 : time - this.startedForLast
    this.sample = {
      model: model.slice(0, 160), completedAt: time, inputTokens: input + cacheRead + cacheWrite,
      ...(tokenCount(usage.cache_read_input_tokens) !== null ? { cacheReadTokens: cacheRead } : {}),
      outputTokens: output, durationMs: elapsed > 0 ? elapsed : null
    }
  }
}
