import { join } from 'node:path'
import type { ContextCategory, ContextSample } from './protocol'
import { isRecord, tokenCount } from './transcript'

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i

export type ContextRow = Record<string, unknown>
const positive = (value: unknown) => tokenCount(value) || null

function parseCategories(raw: unknown): ContextCategory[] {
  if (typeof raw !== 'string' || raw.length > 32_768) return []
  let decoded: unknown
  try { decoded = JSON.parse(raw) } catch { return [] }
  if (!Array.isArray(decoded)) return []
  return decoded.slice(0, 64).flatMap((row) => {
    if (!isRecord(row) || typeof row.name !== 'string' || !row.name.trim()) return []
    const tokens = positive(row.tokens)
    if (tokens === null) return []
    return [{ name: row.name.trim().slice(0, 80), tokens, ...(row.deferred === true ? { deferred: true as const } : {}) }]
  })
}

/** Rows are ordered newest first. The two context facts can arrive separately. */
export function contextFromRows(rows: ContextRow[]): ContextSample | null {
  const latest = rows.find((row) => row.usedKind !== null && row.usedKind !== undefined)
  const window = rows.find((row) => row.windowTokens !== null && row.windowTokens !== undefined)
  if (!latest) return null
  const capturedAt = positive(latest.capturedAt)
  if (!capturedAt) return null
  if (latest.usedKind === 'unknown') return { kind: 'unknown', capturedAt }
  const model = typeof latest.model === 'string' && latest.model && latest.model !== 'unknown' ? latest.model.slice(0, 160) : null
  if (latest.usedKind === 'report') {
    const usedTokens = tokenCount(latest.usedTokens)
    const categories = parseCategories(latest.categories)
    return usedTokens === null ? null : {
      kind: 'report', usedTokens, windowTokens: positive(latest.reportWindow), model, capturedAt,
      ...(categories.length ? { categories } : {})
    }
  }
  if (latest.usedKind === 'estimate') {
    const input = tokenCount(latest.input)
    const read = tokenCount(latest.cacheRead)
    const write = tokenCount(latest.cacheWrite)
    if (input === null || read === null || write === null) return null
    const usedTokens = tokenCount(input + read + write)
    return usedTokens === null ? null : { kind: 'estimate', usedTokens, windowTokens: positive(window?.windowTokens), model, capturedAt }
  }
  return null
}

export async function readNativeContext(appData: string, sessionId: string): Promise<ContextSample | null> {
  if (!uuid.test(sessionId)) return null
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(appData, 'orca', 'agent-session-domain.db'), { readOnly: true })
  try {
    // Only context facts, not the turn body or transcript. Stop at the latest visible clear in the active epoch.
    const rows = db.prepare(`
      SELECT json_extract(i.payload_json, '$.body.contextUsage.used.kind') AS usedKind,
             json_extract(i.payload_json, '$.body.contextUsage.used.capturedAt') AS capturedAt,
             json_extract(i.payload_json, '$.body.contextUsage.used.usedTokens') AS usedTokens,
             json_extract(i.payload_json, '$.body.contextUsage.used.windowTokens') AS reportWindow,
             json_extract(i.payload_json, '$.body.contextUsage.used.model') AS model,
             json_extract(i.payload_json, '$.body.contextUsage.used.categories') AS categories,
             json_extract(i.payload_json, '$.body.contextUsage.used.usage.inputTokens') AS input,
             json_extract(i.payload_json, '$.body.contextUsage.used.usage.cacheReadInputTokens') AS cacheRead,
             json_extract(i.payload_json, '$.body.contextUsage.used.usage.cacheCreationInputTokens') AS cacheWrite,
             json_extract(i.payload_json, '$.body.contextUsage.window.tokens') AS windowTokens
      FROM journal_chat_state s JOIN journal_items i ON i.session_id=s.session_id AND i.epoch=s.epoch
      WHERE s.session_id=? AND i.kind='turn' AND i.turn_marker=1 AND i.hidden=0
        AND i.root=1 AND i.subagent_row=0
        AND json_type(i.payload_json, '$.body.contextUsage')='object'
        AND i.sequence > coalesce((SELECT max(c.sequence) FROM journal_items c
          WHERE c.session_id=s.session_id AND c.epoch=s.epoch AND c.hidden=0 AND c.context_clear=1), 0)
      ORDER BY i.sequence DESC, i.ordinal DESC LIMIT 32
    `).all(sessionId)
    return contextFromRows(rows)
  } finally { db.close() }
}
