import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, test } from 'orca/testing'
import { contextFromRows, readNativeContext } from './context'
import { metrics, status } from './format'
import { emptySnapshot, type Snapshot } from './protocol'

const id = '00000000-0000-0000-0000-000000000001'
const example = { usedKind: 'estimate', capturedAt: 2000, input: 100, cacheRead: 300, cacheWrite: 2 }

test('independently takes latest estimate and window; unknown invalidates old estimates', () => {
  assert.deepEqual(contextFromRows([{ windowTokens: 1000 }, example]), {
    kind: 'estimate', usedTokens: 402, windowTokens: 1000, model: null, capturedAt: 2000
  })
  assert.deepEqual(contextFromRows([{ usedKind: 'unknown', capturedAt: 3000 }, example]), { kind: 'unknown', capturedAt: 3000 })
})

test('does not display missing throughput or replace a fresh estimate with an old report', () => {
  const context = { kind: 'report', usedTokens: 55, windowTokens: 1000, model: 'old', capturedAt: 2000 } as const
  const snapshot: Snapshot = { ...emptySnapshot, phase: 'ready', context }
  assert.equal(status(snapshot).text, '55/1k')
  const fresh = { ...snapshot, sample: { model: 'new', completedAt: 3000, inputTokens: 90, outputTokens: 10, durationMs: null } }
  assert.equal(metrics(fresh).used, 100)
  assert.equal(metrics(fresh).window, null)
  assert.equal(metrics({ ...fresh, context: { kind: 'unknown', capturedAt: 3100 } }).used, null)
})

test('queries only visible facts in the active epoch and after the newest clear', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chat-gauge-context-'))
  try {
    await mkdir(join(dir, 'orca'))
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(dir, 'orca', 'agent-session-domain.db'))
    try {
      db.exec(`CREATE TABLE journal_chat_state(session_id TEXT, epoch TEXT);
        CREATE TABLE journal_items(session_id TEXT, epoch TEXT, kind TEXT, hidden INTEGER, turn_marker INTEGER, context_clear INTEGER, sequence INTEGER, ordinal INTEGER, payload_json TEXT, root INTEGER, subagent_row INTEGER, context_window INTEGER);`)
      db.prepare('INSERT INTO journal_chat_state VALUES (?, ?)').run(id, 'active')
      const add = db.prepare('INSERT INTO journal_items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      const categories = [{ name: 'Messages', tokens: 10 }, { name: 'MCP tools', tokens: 25, deferred: true }]
      const report = JSON.stringify({ body: { contextUsage: { used: {
        kind: 'report', usedTokens: 10, windowTokens: 100, capturedAt: 1000, categories
      } } } })
      add.run(id, 'active', 'turn', 0, 1, 0, 1, 1, report, 1, 0, 0)
      add.run(id, 'active', 'message', 0, 0, 1, 2, 2, '{}', 1, 0, 0)
      add.run(id, 'old', 'turn', 0, 1, 0, 9, 9, report, 1, 0, 0)
      add.run(id, 'active', 'turn', 1, 1, 0, 9, 9, report, 1, 0, 0)
      add.run(id, 'active', 'turn', 0, 1, 0, 9, 9, report, 0, 1, 0)
      assert.equal(await readNativeContext(dir, id), null)
      // Codex reports the limit inside `used`, without a separate window fact.
      add.run(id, 'active', 'turn', 0, 1, 0, 3, 3, report, 1, 0, 0)
      const context = await readNativeContext(dir, id)
      assert.equal(context?.kind, 'report')
      assert.deepEqual(context?.kind === 'report' && context.categories, categories)
    } finally { db.close() }
  } finally { await rm(dir, { recursive: true, force: true }) }
})
