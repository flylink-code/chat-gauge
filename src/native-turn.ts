import { join } from 'node:path'
import { tokenCount } from './transcript'

export type NativeTurn = { startedAt: number; completedAt: number; durationMs: number }

/** No thread text, user previews or tool payloads leave SQLite. A newer unfinished,
 * interrupted or failed turn invalidates the old timing rather than reusing it. */
export async function readNativeTurn(appData: string, sessionId: string): Promise<NativeTurn | null> {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(sessionId)) return null
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(appData, 'orca', 'agent-session-domain.db'), { readOnly: true })
  try {
    const row = db.prepare(`SELECT json_extract(i.payload_json,'$.body.startedAt') AS start,
      json_extract(i.payload_json,'$.body.completedAt') AS end,
      json_extract(i.payload_json,'$.body.durationMs') AS measured,
      json_extract(i.payload_json,'$.body.state') AS state, json_extract(i.payload_json,'$.body.outcome') AS outcome,
      i.queue_command_turn AS command
      FROM journal_chat_state s JOIN journal_items i ON i.session_id=s.session_id AND i.epoch=s.epoch
      WHERE s.session_id=? AND i.hidden=0 AND i.root=1 AND i.subagent_row=0 AND i.kind='turn' AND i.turn_marker=1
      AND i.sequence > coalesce((SELECT max(c.sequence) FROM journal_items c WHERE c.session_id=s.session_id
        AND c.epoch=s.epoch AND c.hidden=0 AND c.context_clear=1),0)
      ORDER BY i.sequence DESC,i.ordinal DESC LIMIT 1`).get(sessionId)
    if (!row || row.command !== 0 || row.state !== 'completed' || row.outcome !== 'success') return null
    const startedAt = tokenCount(row.start), completedAt = tokenCount(row.end)
    if (!startedAt || !completedAt || completedAt <= startedAt) return null
    const durationMs = tokenCount(row.measured) || (completedAt-startedAt)
    return { startedAt, completedAt, durationMs }
  } finally { db.close() }
}
