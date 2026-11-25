import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { DatabaseSync as SqliteDatabase } from 'node:sqlite'
import { assert, test } from 'orca/testing'
import { readOpenCode } from './opencode-metrics'

const T = 1_700_000_000_000
const sessionId = 'ses_0123456789abcdef'
const otherSessionId = 'ses_fedcba9876543210'
const profileId = '11111111-1111-4111-8111-111111111111'
const upperProfileId = profileId.toUpperCase()

const V1_SCHEMA = `
  CREATE TABLE session (id TEXT PRIMARY KEY);
  CREATE TABLE message (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL, data TEXT NOT NULL
  );`

const V2_SCHEMA = `
  CREATE TABLE session_v2 (id TEXT PRIMARY KEY);
  CREATE TABLE session_message (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL,
    time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
  );`

type Row = {
  id: string
  sessionId: string
  role: 'user' | 'assistant' | 'idle'
  created: number
  completed?: number
  output?: number
  seq?: number
  text?: string
  raw?: string
}

const expected = (outputTokens: number, durationMs: number, completedAt: number) =>
  ({ scope: 'message', outputTokens, durationMs, completedAt })

function payload(row: Row): string {
  if (row.raw !== undefined) return row.raw
  return JSON.stringify({
    ...(row.role === 'user' || row.role === 'assistant' ? { role: row.role } : {}),
    text: row.text ?? 'SECRET BODY',
    tokens: row.output === undefined ? {} : { input: 1, output: row.output },
    time: row.completed === undefined
      ? { created: row.created }
      : { created: row.created, completed: row.completed }
  })
}

function insertV1(db: SqliteDatabase, row: Row): void {
  db.prepare(
    'INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)'
  ).run(row.id, row.sessionId, row.created, row.completed ?? row.created, payload(row))
}

function insertV2(db: SqliteDatabase, row: Row): void {
  db.prepare(
    `INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.id, row.sessionId, row.role, row.seq ?? 0,
    row.created, row.completed ?? row.created, payload(row)
  )
}

async function createDatabase(
  path: string,
  build: (db: SqliteDatabase) => void
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(path)
  try { build(db) } finally { db.close() }
}

async function writeStore(
  path: string,
  version: 'v1' | 'v2',
  sessions: readonly string[],
  rows: readonly Row[]
): Promise<void> {
  await createDatabase(path, (db) => {
    db.exec(version === 'v1' ? V1_SCHEMA : V2_SCHEMA)
    const insert = db.prepare(
      version === 'v1' ? 'INSERT INTO session (id) VALUES (?)' : 'INSERT INTO session_v2 (id) VALUES (?)'
    )
    for (const id of sessions) insert.run(id)
    for (const row of rows) (version === 'v1' ? insertV1 : insertV2)(db, row)
  })
}

async function withEnvironment<T>(
  values: Record<string, string | undefined>,
  run: () => Promise<T>
): Promise<T> {
  const keys = Object.keys(values)
  const saved = new Map(keys.map((key) => [key, process.env[key]]))
  for (const key of keys) {
    const value = values[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return await run()
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

function record(agent: 'opencode' | 'opencode2' = 'opencode', overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 2,
    provider: agent,
    location: { executionHostId: 'local', wslDistro: null, workspaceId: 'folder:x', workspaceKind: 'folder' },
    providerHandleChain: [{
      linkId: 'link-1', origin: 'created', mintedAtFence: 1, observedAt: 1,
      handle: { transport: 'acp', agent, nativeId: sessionId }
    }],
    accountHome: { kind: 'opencode', locator: { kind: 'unmanaged' } },
    ...overrides
  }
}

const envFor = (path: string) => ({
  OPENCODE_DB: path, XDG_DATA_HOME: undefined, APPDATA: undefined
})

test('reads the latest completed OpenCode 1.x assistant message for the exact session only', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chat-gauge-opencode-'))
  try {
    const path = join(dir, 'opencode.db')
    await writeStore(path, 'v1', [sessionId, otherSessionId], [
      { id: 'old', sessionId, role: 'assistant', created: T + 1_000, completed: T + 2_000, output: 40 },
      { id: 'latest', sessionId, role: 'assistant', created: T + 4_000, completed: T + 6_500, output: 100, text: 'SECRET ANSWER' },
      // A streaming reply and a later user turn neither replace the latest completed request.
      { id: 'streaming', sessionId, role: 'assistant', created: T + 7_000, output: 999 },
      { id: 'user', sessionId, role: 'user', created: T + 8_000 },
      { id: 'other', sessionId: otherSessionId, role: 'assistant', created: T + 9_000, completed: T + 12_000, output: 500 }
    ])
    await withEnvironment(envFor(path), async () => {
      const rate = await readOpenCode(record())
      assert.deepEqual(rate, expected(100, 2_500, T + 6_500))
      assert.deepEqual(Object.keys(rate ?? {}), ['scope', 'outputTokens', 'durationMs', 'completedAt'])
      assert.equal(JSON.stringify(rate).includes('SECRET'), false)
    })
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('reads OpenCode 2 session_message rows and ignores idle, user, in-progress and other sessions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chat-gauge-opencode-'))
  try {
    const path = join(dir, 'opencode.db')
    await writeStore(path, 'v2', [sessionId, otherSessionId], [
      { id: 'latest', sessionId, role: 'assistant', created: T + 3_500, completed: T + 5_000, output: 75, seq: 1 },
      { id: 'streaming', sessionId, role: 'assistant', created: T + 6_000, output: 999, seq: 2 },
      { id: 'idle', sessionId, role: 'idle', created: T + 6_100, completed: T + 7_000, output: 999, seq: 3 },
      { id: 'user', sessionId, role: 'user', created: T + 7_100, seq: 4 },
      { id: 'other', sessionId: otherSessionId, role: 'assistant', created: T + 8_000, completed: T + 9_000, output: 500, seq: 5 }
    ])
    await withEnvironment(envFor(path), async () => {
      assert.deepEqual(await readOpenCode(record('opencode2')), expected(75, 1_500, T + 5_000))
    })
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('uses the live OpenCode 2 conversation over frozen 1.x rows after migration', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chat-gauge-opencode-'))
  try {
    const path = join(dir, 'opencode.db')
    await createDatabase(path, (db) => {
      db.exec(V1_SCHEMA)
      db.exec(V2_SCHEMA)
      db.prepare('INSERT INTO session (id) VALUES (?)').run(sessionId)
      db.prepare('INSERT INTO session_v2 (id) VALUES (?)').run(sessionId)
      insertV1(db, { id: 'frozen', sessionId, role: 'assistant', created: T + 1_000, completed: T + 2_000, output: 10 })
      insertV2(db, { id: 'live', sessionId, role: 'assistant', created: T + 4_000, completed: T + 6_000, output: 90, seq: 1 })
    })
    await withEnvironment(envFor(path), async () => {
      // An `opencode` chat can resume after the 2.x binary migrated its database.
      assert.deepEqual(await readOpenCode(record('opencode')), expected(90, 2_000, T + 6_000))
    })
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('a live v2 conversation without a completed message does not fall back to frozen rows', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chat-gauge-opencode-'))
  try {
    const path = join(dir, 'opencode.db')
    await createDatabase(path, (db) => {
      db.exec(V1_SCHEMA)
      db.exec(V2_SCHEMA)
      db.prepare('INSERT INTO session (id) VALUES (?)').run(sessionId)
      db.prepare('INSERT INTO session_v2 (id) VALUES (?)').run(sessionId)
      insertV1(db, { id: 'frozen', sessionId, role: 'assistant', created: T + 1_000, completed: T + 2_000, output: 10 })
      insertV2(db, { id: 'streaming', sessionId, role: 'assistant', created: T + 5_000, output: 50, seq: 1 })
    })
    await withEnvironment(envFor(path), async () => {
      assert.equal(await readOpenCode(record('opencode2')), null)
    })
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('uses 1.x rows when the exact session has no live v2 conversation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chat-gauge-opencode-'))
  try {
    const path = join(dir, 'opencode.db')
    await createDatabase(path, (db) => {
      db.exec(V1_SCHEMA)
      db.exec(V2_SCHEMA)
      db.prepare('INSERT INTO session (id) VALUES (?)').run(sessionId)
      db.prepare('INSERT INTO session_v2 (id) VALUES (?)').run(otherSessionId)
      insertV1(db, { id: 'v1', sessionId, role: 'assistant', created: T + 2_000, completed: T + 4_000, output: 20 })
      insertV2(db, { id: 'other', sessionId: otherSessionId, role: 'assistant', created: T + 5_000, completed: T + 9_000, output: 90, seq: 1 })
    })
    await withEnvironment(envFor(path), async () => {
      assert.deepEqual(await readOpenCode(record('opencode')), expected(20, 2_000, T + 4_000))
    })
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('binds the last provider handle and rejects non-local, non-ACP or mismatched records', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chat-gauge-opencode-'))
  try {
    const path = join(dir, 'opencode.db')
    await writeStore(path, 'v1', [sessionId, otherSessionId], [
      { id: 'previous', sessionId: otherSessionId, role: 'assistant', created: T + 1_000, completed: T + 2_000, output: 11 },
      { id: 'current', sessionId, role: 'assistant', created: T + 3_000, completed: T + 5_000, output: 22 }
    ])
    await withEnvironment(envFor(path), async () => {
      const chained = record('opencode', {
        providerHandleChain: [
          { linkId: 'old', handle: { transport: 'acp', agent: 'opencode', nativeId: otherSessionId } },
          { linkId: 'new', handle: { transport: 'acp', agent: 'opencode', nativeId: sessionId } }
        ]
      })
      assert.deepEqual(await readOpenCode(chained), expected(22, 2_000, T + 5_000))
      // Native hosts may write an empty distro where newer records write null.
      assert.deepEqual(
        await readOpenCode(record('opencode', { location: { executionHostId: 'local', wslDistro: '' } })),
        expected(22, 2_000, T + 5_000)
      )

      const reversed = record('opencode', {
        providerHandleChain: [
          { linkId: 'old', handle: { transport: 'acp', agent: 'opencode', nativeId: sessionId } },
          { linkId: 'new', handle: { transport: 'acp', agent: 'opencode', nativeId: otherSessionId } }
        ]
      })
      assert.deepEqual(await readOpenCode(reversed), expected(11, 1_000, T + 2_000))

      const invalid: unknown[] = [
        null, [], {},
        { ...record(), schemaVersion: 3 },
        { ...record(), schemaVersion: '2' },
        { ...record(), provider: 'claude' },
        { ...record(), location: { executionHostId: 'remote', wslDistro: null } },
        { ...record(), location: { executionHostId: 'local', wslDistro: 'Ubuntu' } },
        { ...record(), providerHandleChain: [] },
        { ...record(), providerHandleChain: [{ handle: { provider: 'opencode', transport: 'acp', agent: 'opencode', nativeId: sessionId } }] },
        { ...record(), providerHandleChain: [{ handle: { transport: 'acp', agent: 'opencode2', nativeId: sessionId } }] },
        { ...record(), providerHandleChain: [{ handle: { transport: 'claude-sdk', agent: 'opencode', nativeId: sessionId } }] },
        { ...record(), providerHandleChain: [{ handle: { transport: 'acp', agent: 'opencode', nativeId: '' } }] },
        { ...record(), providerHandleChain: [{ handle: { transport: 'acp', agent: 'opencode', nativeId: ` ${sessionId}` } }] },
        { ...record(), providerHandleChain: [{ handle: { transport: 'acp', agent: 'opencode', nativeId: 42 } }] },
        { ...record(), accountHome: { kind: 'opencode', locator: { kind: 'managed', managedProfileId: 'not-a-uuid' } } },
        { ...record(), accountHome: { kind: 'opencode', locator: { kind: 'managed' } } },
        { ...record(), accountHome: { variable: 'XDG_DATA_HOME', path: '/home/user/.local/share' } },
        { ...record(), accountHome: 'unmanaged' },
        { ...record(), accountHome: 'unmanaged', launchedAccount: { fence: 1, accountHome: { kind: 'opencode', locator: { kind: 'unmanaged' } } } },
        { ...record(), launchedAccount: { fence: 0, accountHome: { kind: 'opencode', locator: { kind: 'unmanaged' } } } },
        { ...record(), launchedAccount: { fence: 1, accountHome: { variable: 'X', path: '/x' } } }
      ]
      for (const value of invalid) assert.equal(await readOpenCode(value), null)
    })
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('resolves the exact account through OPENCODE_DB, XDG_DATA_HOME and managed profiles', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chat-gauge-opencode-'))
  try {
    const absolute = join(dir, 'absolute.db')
    const relative = join(dir, 'opencode', 'custom.db')
    const defaults = join(dir, 'opencode', 'opencode.db')
    const appData = join(dir, 'appdata')
    const managed = join(
      appData, 'orca', 'managed-data-accounts', 'opencode', profileId,
      'data', 'opencode', 'opencode.db'
    )
    const row: Row = { id: 'm', sessionId, role: 'assistant', created: T + 1_000, completed: T + 3_000, output: 30 }
    await writeStore(absolute, 'v1', [sessionId], [row])
    await writeStore(relative, 'v1', [sessionId], [row])
    await writeStore(defaults, 'v1', [sessionId], [row])
    await writeStore(managed, 'v2', [sessionId], [
      { ...row, id: 'managed', created: T + 2_000, completed: T + 4_000, output: 40 }
    ])

    await withEnvironment(envFor(absolute), async () => {
      assert.deepEqual(await readOpenCode(record()), expected(30, 2_000, T + 3_000))
    })
    await withEnvironment({ OPENCODE_DB: undefined, XDG_DATA_HOME: dir, APPDATA: undefined }, async () => {
      assert.deepEqual(await readOpenCode(record()), expected(30, 2_000, T + 3_000))
    })
    await withEnvironment({ OPENCODE_DB: 'custom.db', XDG_DATA_HOME: dir, APPDATA: undefined }, async () => {
      assert.deepEqual(await readOpenCode(record()), expected(30, 2_000, T + 3_000))
    })
    await withEnvironment({ OPENCODE_DB: ':memory:', XDG_DATA_HOME: dir, APPDATA: undefined }, async () => {
      assert.equal(await readOpenCode(record()), null)
    })
    await withEnvironment({ OPENCODE_DB: undefined, XDG_DATA_HOME: undefined, APPDATA: appData }, async () => {
      const managedRecord = record('opencode2', {
        accountHome: { kind: 'opencode', locator: { kind: 'managed', managedProfileId: upperProfileId } }
      })
      assert.deepEqual(await readOpenCode(managedRecord), expected(40, 2_000, T + 4_000))
    })

    // The latest runtime account wins over the founding account.
    await withEnvironment({ OPENCODE_DB: absolute, XDG_DATA_HOME: undefined, APPDATA: appData }, async () => {
      const switched = record('opencode', {
        accountHome: { kind: 'opencode', locator: { kind: 'unmanaged' } },
        launchedAccount: {
          fence: 2,
          accountHome: { kind: 'opencode', locator: { kind: 'managed', managedProfileId: upperProfileId } }
        }
      })
      assert.deepEqual(await readOpenCode(switched), expected(40, 2_000, T + 4_000))
    })
    await withEnvironment(envFor(absolute), async () => {
      const broken = record('opencode', {
        launchedAccount: { fence: 1, accountHome: { kind: 'opencode', locator: { kind: 'managed', managedProfileId: 'bad' } } }
      })
      assert.equal(await readOpenCode(broken), null)
    })
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('fails closed for missing sessions, missing stores, directories, garbage and WSL paths', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chat-gauge-opencode-'))
  try {
    const onlyOther = join(dir, 'other.db')
    await writeStore(onlyOther, 'v1', [otherSessionId], [
      { id: 'other', sessionId: otherSessionId, role: 'assistant', created: T + 1_000, completed: T + 2_000, output: 10 }
    ])
    await withEnvironment(envFor(onlyOther), async () => {
      assert.equal(await readOpenCode(record()), null)
    })

    const missing = join(dir, 'missing', 'opencode.db')
    await withEnvironment(envFor(missing), async () => {
      assert.equal(await readOpenCode(record()), null)
    })

    const directory = join(dir, 'directory.db')
    await mkdir(directory)
    await withEnvironment(envFor(directory), async () => {
      assert.equal(await readOpenCode(record()), null)
    })

    const garbage = join(dir, 'garbage.db')
    await writeFile(garbage, 'not a database')
    await withEnvironment(envFor(garbage), async () => {
      assert.equal(await readOpenCode(record()), null)
    })

    await withEnvironment({
      OPENCODE_DB: '//wsl.localhost/Ubuntu/home/user/.local/share/opencode/opencode.db',
      XDG_DATA_HOME: undefined,
      APPDATA: undefined
    }, async () => {
      assert.equal(await readOpenCode(record()), null)
    })
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('requires a completed start and finish, output tokens and a positive duration', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chat-gauge-opencode-'))
  try {
    // Two different messages completed at the same instant cannot be ordered without guessing.
    const tie = join(dir, 'tie.db')
    await writeStore(tie, 'v1', [sessionId], [
      { id: 'tie-a', sessionId, role: 'assistant', created: 2_000_000_000_000, completed: 2_000_000_001_000, output: 10 },
      { id: 'tie-b', sessionId, role: 'assistant', created: 2_000_000_000_000, completed: 2_000_000_001_000, output: 11 }
    ])
    await withEnvironment(envFor(tie), async () => {
      assert.equal(await readOpenCode(record()), null)
    })

    // Read each case as the only completed row so the validator, not ordering, decides.
    type Case = {
      id: string
      created: number
      completed: number
      output?: number
      raw?: string
      expectedRate: ReturnType<typeof expected> | null
    }
    const cases: Case[] = [
      { id: 'seconds', created: 1_700_000_000, completed: 1_700_000_004, output: 12, expectedRate: expected(12, 4_000, 1_700_000_004_000) },
      { id: 'zero', created: 3_000_000_000_000, completed: 3_000_000_000_000, output: 10, expectedRate: null },
      { id: 'backwards', created: 4_000_000_000_000, completed: 3_999_999_999_000, output: 10, expectedRate: null },
      { id: 'no-output', created: 5_000_000_000_000, completed: 5_000_000_001_000, expectedRate: null },
      { id: 'no-created', created: 5_500_000_000_000, completed: 5_500_000_001_000, raw: '{"role":"assistant","tokens":{"output":10},"time":{"completed":5500000001000}}', expectedRate: null },
      { id: 'negative', created: 6_000_000_000_000, completed: 6_000_000_001_000, output: -1, expectedRate: null },
      { id: 'fractional', created: 7_000_000_000_000, completed: 7_000_000_001_000, output: 1.5, expectedRate: null },
      { id: 'string', created: 8_000_000_000_000, completed: 8_000_000_001_000, output: 1, raw: '{"role":"assistant","tokens":{"output":"1"},"time":{"created":8000000000000,"completed":8000000001000}}', expectedRate: null },
      { id: 'invalid', created: 9_000_000_000_000, completed: 9_000_000_001_000, output: 1, raw: 'not json', expectedRate: null }
    ]
    for (const only of cases) {
      const one = join(dir, `${only.id}.db`)
      await writeStore(one, 'v1', [sessionId], [{
        id: only.id, sessionId, role: 'assistant', created: only.created,
        completed: only.completed, output: only.output, raw: only.raw
      }])
      await withEnvironment(envFor(one), async () => {
        assert.deepEqual(await readOpenCode(record()), only.expectedRate)
      })
    }

    // A malformed newest completed row is not replaced by an older valid one.
    const malformedNewest = join(dir, 'malformed-newest.db')
    await writeStore(malformedNewest, 'v1', [sessionId], [
      { id: 'old', sessionId, role: 'assistant', created: T + 1_000, completed: T + 2_000, output: 10 },
      { id: 'new', sessionId, role: 'assistant', created: T + 3_000, completed: T + 4_000 }
    ])
    await withEnvironment(envFor(malformedNewest), async () => {
      assert.equal(await readOpenCode(record()), null)
    })

    // A missing required column is not guessed around.
    const missingColumn = join(dir, 'missing-column.db')
    await createDatabase(missingColumn, (db) => {
      db.exec('CREATE TABLE session (id TEXT PRIMARY KEY);')
      db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT);')
      db.prepare('INSERT INTO session (id) VALUES (?)').run(sessionId)
      db.prepare('INSERT INTO message (id, session_id) VALUES (?, ?)').run('m', sessionId)
    })
    await withEnvironment(envFor(missingColumn), async () => {
      assert.equal(await readOpenCode(record()), null)
    })
  } finally { await rm(dir, { recursive: true, force: true }) }
})
