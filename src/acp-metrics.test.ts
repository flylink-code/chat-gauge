import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, test } from 'orca/testing'
import { readAcpRate, readAcpUsage } from './acp-metrics'

const T = 1_700_000_000_000
const copilotId = '11111111-1111-4111-8111-111111111111'
const otherCopilotId = '22222222-2222-4222-8222-222222222222'
const geminiId = 'gemini-session-1'
const otherGeminiId = 'gemini-session-2'

type Provider = 'copilot' | 'gemini'

function record(provider: Provider, nativeId: string, account: string, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 2,
    provider,
    location: { executionHostId: 'local', wslDistro: null, workspaceId: 'folder:x', workspaceKind: 'folder' },
    providerHandleChain: [{
      linkId: 'link-1', origin: 'created', mintedAtFence: 1, observedAt: 1,
      handle: { transport: 'acp', agent: provider, nativeId }
    }],
    accountHome: {
      variable: provider === 'copilot' ? 'COPILOT_HOME' : 'GEMINI_CLI_HOME',
      path: account
    },
    ...overrides
  }
}

function usage(
  overrides: Record<string, unknown> = {},
  outer: Record<string, unknown> = {},
  completedAt = T + 5_000
) {
  return {
    type: 'session.usage_record',
    timestamp: new Date(completedAt).toISOString(),
    data: {
      usage: {
        apiCallId: 'call-1',
        initiator: 'agent',
        finishReason: 'tool_calls',
        duration: 2_500,
        outputTokens: 125,
        inputTokens: 10,
        ...overrides
      }
    },
    ...outer
  }
}

function gemini(
  overrides: Record<string, unknown> = {},
  completedAt = T + 2_000
) {
  return {
    type: 'gemini',
    content: 'SECRET ANSWER',
    model: 'gemini-test',
    tokens: { input: 10, output: 20, cached: 1, thoughts: 2, tool: 3, total: 36 },
    timestamp: new Date(completedAt).toISOString(),
    ...overrides
  }
}

async function writeCopilot(
  account: string,
  sessionId: string,
  lines: readonly unknown[]
): Promise<void> {
  const dir = join(account, 'session-state', sessionId)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'events.jsonl'), lines.map((line) => JSON.stringify(line)).join('\n') + '\n')
}

async function writeGemini(
  account: string,
  project: string,
  fileName: string,
  lines: readonly unknown[]
): Promise<void> {
  const dir = join(account, '.gemini', 'tmp', project, 'chats')
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, fileName),
    lines.map((line) => typeof line === 'string' ? line : JSON.stringify(line)).join('\n') + '\n'
  )
}

const expectedRate = (outputTokens: number, durationMs: number, completedAt: number) =>
  ({ scope: 'message', outputTokens, durationMs, completedAt })

const expectedUsage = (overrides: Partial<ReturnType<typeof geminiUsageShape>> = {}) => ({
  ...geminiUsageShape(),
  ...overrides
})

function geminiUsageShape() {
  return {
    provider: 'gemini' as const,
    scope: 'message' as const,
    model: 'gemini-test',
    inputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: 1,
    reasoningTokens: 2,
    toolTokens: 3,
    totalTokens: 36,
    completedAt: T + 2_000
  }
}

test('Copilot reads the latest root model call and ignores subagents, compaction and unusable rows', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chat-gauge-acp-'))
  try {
    const account = join(dir, 'copilot-home')
    await writeCopilot(account, copilotId, [
      usage({ apiCallId: 'old', duration: 1_000, outputTokens: 10 }, {}, T + 1_000),
      usage({ apiCallId: 'sub', duration: 9_000, outputTokens: 900, parentToolCallId: 'parent' }, { agentId: 'subagent' }, T + 9_000),
      usage({ apiCallId: 'compaction', duration: 8_000, outputTokens: 800, initiator: 'compaction' }, {}, T + 8_000),
      usage({ apiCallId: 'zero', duration: 7_000, outputTokens: 0 }, {}, T + 7_000),
      usage({ apiCallId: 'latest', duration: 2_500, outputTokens: 125 }, {}, T + 5_000),
      usage({ apiCallId: 'unknown-finish', duration: 3_000, outputTokens: 300, finishReason: null }, {}, T + 6_000),
      { type: 'user.message', timestamp: new Date(T + 4_000).toISOString(), data: { content: 'SECRET PROMPT' } }
    ])
    const rate = await readAcpRate(record('copilot', copilotId, account))
    assert.deepEqual(rate, expectedRate(125, 2_500, T + 5_000))
    assert.deepEqual(Object.keys(rate ?? {}), ['scope', 'outputTokens', 'durationMs', 'completedAt'])
    assert.equal(JSON.stringify(rate).includes('SECRET'), false)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('Copilot reads exactly the selected session, behind a multi-megabyte tail', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chat-gauge-acp-'))
  try {
    const account = join(dir, 'copilot-home')
    const filler = 'x'.repeat(64 * 1024)
    await writeCopilot(account, copilotId, [
      ...Array.from({ length: 70 }, () => filler),
      usage({ apiCallId: 'tail', duration: 2_000, outputTokens: 100 }, {}, T + 2_000)
    ])
    await writeCopilot(account, otherCopilotId, [
      usage({ apiCallId: 'other', duration: 9_000, outputTokens: 900 }, {}, T + 9_000)
    ])
    assert.deepEqual(
      await readAcpRate(record('copilot', copilotId, account)),
      expectedRate(100, 2_000, T + 2_000)
    )
    // The other chat's own record is readable only for its own handle.
    assert.deepEqual(
      await readAcpRate(record('copilot', otherCopilotId, account)),
      expectedRate(900, 9_000, T + 9_000)
    )
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('Copilot falls back to the exact root rows in the account session-store database', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chat-gauge-acp-'))
  try {
    const account = join(dir, 'copilot-home')
    await mkdir(account, { recursive: true })
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(account, 'session-store.db'))
    try {
      db.exec(`CREATE TABLE assistant_usage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        agent_id TEXT,
        parent_tool_call_id TEXT,
        initiator TEXT,
        finish_reason TEXT,
        duration_ms INTEGER,
        output_tokens INTEGER,
        created_at TEXT
      )`)
      const insert = db.prepare(
        `INSERT INTO assistant_usage_events
         (session_id, agent_id, parent_tool_call_id, initiator, finish_reason, duration_ms, output_tokens, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      insert.run(copilotId, null, null, 'agent', 'tool_calls', 2_000, 100, new Date(T + 2_000).toISOString())
      insert.run(copilotId, null, null, 'compaction', 'stop', 9_000, 900, new Date(T + 9_000).toISOString())
      insert.run(copilotId, 'subagent', 'parent', 'sub-agent', 'stop', 8_000, 800, new Date(T + 8_000).toISOString())
      insert.run(copilotId, null, null, 'agent', 'stop', 3_000, 150, new Date(T + 3_000).toISOString())
      insert.run(otherCopilotId, null, null, 'agent', 'stop', 5_000, 500, new Date(T + 5_000).toISOString())
      insert.run(copilotId, null, null, 'agent', 'stop', 4_000, 400, '2026-01-01 00:00:00')
    } finally { db.close() }
    assert.deepEqual(
      await readAcpRate(record('copilot', copilotId, account)),
      expectedRate(150, 3_000, T + 3_000)
    )
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('Copilot returns null for missing or unusable stores instead of throwing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chat-gauge-acp-'))
  try {
    const account = join(dir, 'copilot-home')
    await mkdir(account, { recursive: true })
    assert.equal(await readAcpRate(record('copilot', copilotId, account)), null)

    await writeFile(join(account, 'session-store.db'), 'not a database')
    assert.equal(await readAcpRate(record('copilot', copilotId, account)), null)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('records must be local, ACP, exact-session and pinned to the matching account', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chat-gauge-acp-'))
  try {
    const account = join(dir, 'copilot-home')
    await writeCopilot(account, copilotId, [
      usage({ apiCallId: 'latest', duration: 2_500, outputTokens: 125 }, {}, T + 5_000)
    ])
    const base = record('copilot', copilotId, account)
    assert.ok(await readAcpRate(base))

    const handle = (overrides: Record<string, unknown>) => ({
      ...base,
      providerHandleChain: [{
        ...base.providerHandleChain[0],
        handle: { ...base.providerHandleChain[0].handle, ...overrides }
      }]
    })
    const rejected = [
      { ...base, schemaVersion: 3 },
      { ...base, provider: 'gemini' },
      { ...base, location: { ...base.location, executionHostId: 'remote' } },
      { ...base, location: { ...base.location, wslDistro: 'Ubuntu' } },
      { ...base, accountHome: { variable: 'GEMINI_CLI_HOME', path: account } },
      { ...base, accountHome: { variable: 'COPILOT_HOME', path: 'relative/path' } },
      { ...base, accountHome: { variable: 'COPILOT_HOME', path: '\\\\wsl$\\Ubuntu\\home\\x' } },
      { ...base, launchedAccount: { fence: 0, accountHome: { variable: 'COPILOT_HOME', path: account } } },
      handle({ nativeId: '../escape' }),
      handle({ agent: 'gemini' }),
      handle({ transport: 'claude-sdk' }),
      handle({ provider: 'copilot' })
    ]
    for (const value of rejected) assert.equal(await readAcpRate(value), null)

    // The latest launched account wins over the founding account home.
    const launched = {
      ...base,
      accountHome: { variable: 'COPILOT_HOME', path: join(dir, 'old-home') },
      launchedAccount: { fence: 2, accountHome: { variable: 'COPILOT_HOME', path: account } }
    }
    assert.deepEqual(await readAcpRate(launched), expectedRate(125, 2_500, T + 5_000))
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('Gemini exposes exact last-response tokens but never inventes a rate', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chat-gauge-acp-'))
  try {
    const account = join(dir, 'gemini-home')
    await writeGemini(account, 'project-a', 'session-a.jsonl', [
      { sessionId: geminiId, projectHash: 'hash', startTime: new Date(T).toISOString(), lastUpdated: new Date(T).toISOString(), kind: 'main' },
      { id: 'u1', type: 'user', content: 'SECRET QUESTION', timestamp: new Date(T + 500).toISOString() },
      gemini({ id: 'g1', outputTokens: 99 } as Record<string, unknown>, T + 1_000),
      gemini({ id: 'g2' }, T + 2_000),
      { $set: { lastUpdated: new Date(T + 2_100).toISOString() } }
    ])
    // Another session, and a nested subagent session, must never supply the numbers.
    await writeGemini(account, 'project-a', 'session-b.jsonl', [
      { sessionId: otherGeminiId, kind: 'main' },
      gemini({ outputTokens: 999 }, T + 9_000)
    ])
    const nested = join(account, '.gemini', 'tmp', 'project-a', 'chats', geminiId)
    await mkdir(nested, { recursive: true })
    await writeFile(
      join(nested, `${geminiId}.jsonl`),
      JSON.stringify({ sessionId: geminiId, type: 'gemini', tokens: { input: 1, output: 888 }, timestamp: new Date(T + 8_000).toISOString() }) + '\n'
    )

    const usage = await readAcpUsage(record('gemini', geminiId, account))
    assert.deepEqual(usage, expectedUsage())
    assert.equal(await readAcpRate(record('gemini', geminiId, account)), null)
    assert.equal(JSON.stringify(usage).includes('SECRET'), false)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('Gemini reads a legacy JSON session document', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chat-gauge-acp-'))
  try {
    const account = join(dir, 'gemini-home')
    const chats = join(account, '.gemini', 'tmp', 'project-a', 'chats')
    await mkdir(chats, { recursive: true })
    await writeFile(join(chats, 'legacy.json'), JSON.stringify({
      sessionId: geminiId,
      messages: [
        { type: 'user', content: 'SECRET QUESTION' },
        gemini({ model: 'old-model' }, T + 1_000),
        gemini({ model: 'new-model' }, T + 2_000)
      ]
    }))
    assert.deepEqual(
      await readAcpUsage(record('gemini', geminiId, account)),
      expectedUsage({ model: 'new-model' })
    )
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('Gemini fails closed on ambiguity, missing tokens, malformed files and unsafe handles', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chat-gauge-acp-'))
  try {
    const account = join(dir, 'gemini-home')
    await writeGemini(account, 'project-a', 'one.jsonl', [
      { sessionId: geminiId, kind: 'main' },
      gemini()
    ])
    await writeGemini(account, 'project-b', 'two.jsonl', [
      { sessionId: geminiId, kind: 'main' },
      gemini()
    ])
    assert.equal(await readAcpUsage(record('gemini', geminiId, account)), null)

    const clean = join(dir, 'clean-home')
    await writeGemini(clean, 'project-a', 'one.jsonl', [
      { sessionId: geminiId, kind: 'main' },
      { type: 'gemini', content: 'no tokens', timestamp: new Date(T).toISOString() },
      '{not json'
    ])
    assert.equal(await readAcpUsage(record('gemini', geminiId, clean)), null)
    assert.equal(await readAcpUsage(record('gemini', '../escape', clean)), null)
    assert.equal(await readAcpUsage(record('gemini', geminiId, join(dir, 'missing'))), null)
    assert.equal(await readAcpUsage(record('copilot', copilotId, clean)), null)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
