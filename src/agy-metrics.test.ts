import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, test } from 'orca/testing'
import { readAgyRate, readAgySteps } from './agy-metrics'

const nativeId = '00000000-0000-0000-0000-000000000001'
const otherId = '00000000-0000-0000-0000-000000000002'
const t0 = Date.UTC(2026, 0, 1, 0, 0, 0)
const iso = (ms: number) => new Date(ms).toISOString()

const user = (at: number) => ({
  type: 'USER_INPUT', source: 'USER_EXPLICIT', status: 'DONE', step_index: 0,
  created_at: iso(at), content: 'synthetic'
})
const planner = (step: number, at: number, output: number | null, extra: Record<string, unknown> = {}) => ({
  type: 'PLANNER_RESPONSE', source: 'MODEL', status: 'DONE', step_index: step,
  created_at: iso(at), model: 'synthetic/model', output_tokens: output, ...extra
})
const generic = (step: number, at: number, status = 'DONE') => ({
  type: 'GENERIC', source: 'MODEL', status, step_index: step, created_at: iso(at), content: 'synthetic'
})
const errorRow = (at: number) => ({
  type: 'ERROR_MESSAGE', source: 'SYSTEM', status: 'DONE', created_at: iso(at), error: 'synthetic'
})

const text = (rows: readonly Record<string, unknown>[]) => rows.map((row) => JSON.stringify(row)).join('\n') + '\n'

function record(home: string, patch: Record<string, unknown> = {}) {
  return {
    schemaVersion: 2,
    provider: 'antigravity',
    location: { executionHostId: 'local', wslDistro: null, workspaceId: 'folder:synthetic' },
    accountHome: { variable: 'GEMINI_HOME', path: home },
    options: { model: 'synthetic/model' },
    providerHandleChain: [{
      linkId: `antigravity-2-${nativeId}`,
      handle: { transport: 'acp', agent: 'antigravity', nativeId },
      origin: 'created'
    }],
    lease: { provenHandleLinkId: `antigravity-2-${nativeId}` },
    ...patch
  }
}

const turn = (startedAt: number, durationMs: number, completedAt = startedAt + durationMs) =>
  ({ startedAt, completedAt, durationMs })

type WriteOptions = { root?: string; id?: string }

async function writeSession(home: string, body: string | readonly Record<string, unknown>[], options: WriteOptions = {}) {
  const id = options.id ?? nativeId
  const logs = join(home, options.root ?? 'antigravity-cli', 'brain', id, '.system_generated', 'logs')
  await mkdir(join(logs, 'chunks', 'transcript'), { recursive: true })
  const bytes = typeof body === 'string' ? body : text(body)
  await writeFile(join(logs, 'transcript.jsonl'), bytes)
  await writeFile(join(logs, 'chunks', 'transcript', '00000000.jsonl'), bytes)
  return logs
}

async function fixture(run: (home: string) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), 'chat-gauge-agy-'))
  try { await run(home) } finally { await rm(home, { recursive: true, force: true }) }
}

test('reads a whole-turn primary output count only from the selected native session', () => fixture(async (home) => {
  await writeSession(home, [
    user(t0),
    planner(1, t0 + 1000, 100, { tool_calls: [{ name: 'run_command' }] }),
    generic(2, t0 + 1500),
    planner(3, t0 + 2000, 50)
  ])
  // A tempting newer transcript in the same brain root must never be considered.
  await writeSession(home, [user(t0 + 60_000), planner(1, t0 + 61_000, 99_999)], { id: otherId })

  const window = turn(t0 + 250, 3750, t0 + 4000)
  const rate = await readAgyRate(record(home), window)
  assert.deepEqual(rate, { scope: 'turn', outputTokens: 150, durationMs: 3750, completedAt: t0 + 4000 })
  assert.deepEqual(await readAgySteps(record(home), window), [
    { step: 1, createdAt: t0 + 1000, outputTokens: 100, model: 'synthetic/model' },
    { step: 3, createdAt: t0 + 2000, outputTokens: 50, model: 'synthetic/model' }
  ])
}))

test('rejects every record that does not name one exact local ACP agy session', () => fixture(async (home) => {
  await writeSession(home, [user(t0), planner(1, t0 + 1000, 100)])
  const window = turn(t0 + 250, 3750, t0 + 4000)
  const cases: unknown[] = [
    null,
    {},
    record(home, { schemaVersion: 1 }),
    record(home, { provider: 'claude' }),
    record(home, { location: { executionHostId: 'remote', wslDistro: null } }),
    record(home, { location: { executionHostId: 'local', wslDistro: 'Ubuntu' } }),
    record(home, { accountHome: { variable: 'GEMINI_HOME', path: 'relative/home' } }),
    record(home, { accountHome: { variable: 'HOME', path: home } }),
    record(home, { providerHandleChain: [{ linkId: 'x', handle: { transport: 'acp', agent: 'antigravity', nativeId: '../other' } }] }),
    record(home, { providerHandleChain: [{ linkId: 'x', handle: { transport: 'cli', agent: 'antigravity', nativeId } }] }),
    record(home, { providerHandleChain: [{ linkId: 'x', handle: { transport: 'acp', agent: 'codex', nativeId } }] }),
    record(home, { lease: { provenHandleLinkId: 'different-link' } })
  ]
  for (const value of cases) assert.equal(await readAgyRate(value, window), null)
  assert.equal(await readAgySteps(cases[0], window), null)
}))

test('requires exact turn correspondence and never uses a neighbouring timestamp', () => fixture(async (home) => {
  await writeSession(home, [user(t0 - 1500), planner(1, t0 - 500, 100)])
  const window = turn(t0 + 250, 3750, t0 + 4000)
  assert.equal(await readAgyRate(record(home), window), null)

  // Two prompts inside agy's one-second timestamp precision are ambiguous.
  await writeSession(home, [user(t0), user(t0 + 600), planner(1, t0 + 1000, 100)])
  assert.equal(await readAgyRate(record(home), window), null)
  assert.equal(await readAgySteps(record(home), window), null)

  // A second prompt before Orca finished the turn means one prompt did not bound it.
  await writeSession(home, [user(t0), user(t0 + 2000), planner(1, t0 + 3000, 100)])
  assert.equal(await readAgyRate(record(home), window), null)
}))

test('selects the caller turn, not the newest user input in the transcript', () => fixture(async (home) => {
  await writeSession(home, [
    user(t0), planner(1, t0 + 1000, 100, { tool_calls: [{ name: 'run_command' }] }), planner(2, t0 + 2000, 25),
    user(t0 + 5000), planner(3, t0 + 6000, 900, { tool_calls: [{ name: 'run_command' }] }), planner(4, t0 + 7000, 900)
  ])
  const rate = await readAgyRate(record(home), turn(t0 + 250, 2750, t0 + 3000))
  assert.deepEqual(rate, { scope: 'turn', outputTokens: 125, durationMs: 2750, completedAt: t0 + 3000 })
}))

test('accepts a stale non-primary RUNNING tool row but not an unfinished tail', () => fixture(async (home) => {
  const window = turn(t0 + 250, 3750, t0 + 4000)
  await writeSession(home, [user(t0), generic(1, t0 + 500, 'RUNNING'), planner(2, t0 + 1000, 100)])
  assert.equal((await readAgyRate(record(home), window))?.outputTokens, 100)

  // The same running row after the last model call leaves the turn unfinished.
  await writeSession(home, [
    user(t0), planner(1, t0 + 1000, 100, { tool_calls: [{ name: 'run_command' }] }), generic(2, t0 + 1500, 'RUNNING')
  ])
  assert.equal(await readAgyRate(record(home), window), null)
}))

test('rejects incomplete, failed, duplicated or truncated primary counts', () => fixture(async (home) => {
  const window = turn(t0 + 250, 3750, t0 + 4000)
  const cases: Record<string, unknown>[][] = [
    [user(t0), planner(1, t0 + 1000, 100, { tool_calls: [{ name: 'run_command' }] }), planner(2, t0 + 2000, null)],
    [user(t0), planner(1, t0 + 1000, 100, { status: 'RUNNING' })],
    [user(t0), planner(1, t0 + 1000, 100, { tool_calls: [{ name: 'run_command' }] }), errorRow(t0 + 2000)],
    [user(t0), errorRow(t0 + 500), planner(1, t0 + 1000, 100)],
    [user(t0), planner(1, t0 + 1000, 100, { tool_calls: [{ name: 'run_command' }] })],
    [user(t0), planner(1, t0 + 1000, 100, { truncated_fields: ['output_tokens'] })],
    [user(t0), planner(1, t0 + 1000, 100, { tool_calls: [{ name: 'run_command' }] }), planner(1, t0 + 2000, 100)],
    [user(t0), planner(1, t0 + 1000, 100, { source: 'SUBAGENT' })],
    [user(t0), generic(1, t0 + 1000)],
    [user(t0), planner(1, t0 + 1000, 0)],
    [user(t0), planner(1, t0 + 5000, 100)]
  ]
  for (const rows of cases) {
    await writeSession(home, rows)
    assert.equal(await readAgyRate(record(home), window), null)
  }
}))

test('rejects unreadable or ambiguous transcript evidence', () => fixture(async (home) => {
  const window = turn(t0 + 250, 3750, t0 + 4000)

  // A final record without its newline may be half-written.
  await writeSession(home, text([user(t0), planner(1, t0 + 1000, 100)]).trimEnd())
  assert.equal(await readAgyRate(record(home), window), null)

  // The merged file must agree byte-for-byte with the chunk it claims to concatenate.
  const logs = await writeSession(home, [user(t0), planner(1, t0 + 1000, 100)])
  await writeFile(join(logs, 'transcript.jsonl'), text([user(t0), planner(1, t0 + 1000, 100)]) + 'x')
  assert.equal(await readAgyRate(record(home), window), null)

  // The same native ID under two agy homes is ambiguous.
  await writeSession(home, [user(t0), planner(1, t0 + 1000, 100)])
  await writeSession(home, [user(t0), planner(1, t0 + 1000, 100)], { root: 'antigravity-acp' })
  assert.equal(await readAgyRate(record(home), window), null)
}))

test('returns nothing when the bound transcript is absent', () => fixture(async (home) => {
  const window = turn(t0 + 250, 3750, t0 + 4000)
  assert.equal(await readAgyRate(record(home), window), null)
  await mkdir(join(home, 'antigravity-cli', 'brain', nativeId, '.system_generated', 'logs'), { recursive: true })
  assert.equal(await readAgyRate(record(home), window), null)
}))

test('requires contiguous chunks but can read them when the merged file is gone', () => fixture(async (home) => {
  const window = turn(t0 + 250, 3750, t0 + 4000)
  const rows = [user(t0), planner(1, t0 + 1000, 100)]
  const logs = await writeSession(home, rows)
  const chunks = join(logs, 'chunks', 'transcript')

  await rename(join(chunks, '00000000.jsonl'), join(chunks, '00000001.jsonl'))
  assert.equal(await readAgyRate(record(home), window), null)

  await rename(join(chunks, '00000001.jsonl'), join(chunks, '00000000.jsonl'))
  await rm(join(logs, 'transcript.jsonl'))
  assert.equal((await readAgyRate(record(home), window))?.outputTokens, 100)
}))
