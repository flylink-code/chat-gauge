import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { assert, test } from 'orca/testing'
import { clearTurnRateCache, readTurnRate } from './turn-metrics'

const base = 1_760_000_000
const iso = (seconds: number) => new Date((base + seconds) * 1000).toISOString()
const thread = '01a139e4-d49f-7e30-b73a-1dab4bc6a51f'
const sessionId = '019ff9b2-b508-7266-b205-7e14ff0c3fc2'
const local = { executionHostId: 'local', wslDistro: null }

function codexRecord(home: string, id = thread, handle: unknown = { provider: 'codex', threadId: id }) {
  return {
    schemaVersion: 2, provider: 'codex', location: local,
    providerHandleChain: [{ handle }],
    accountHome: { variable: 'CODEX_HOME', path: home }
  }
}

function piRecord(path: string, handle: unknown = { transport: 'jsonl-rpc', agent: 'pi', nativeId: path }) {
  return {
    schemaVersion: 2, provider: 'pi', location: local,
    providerHandleChain: [{ handle }],
    accountHome: { variable: 'PI_CODING_AGENT_DIR', path: dirname(path) }
  }
}

const meta = (id = thread) => ({ type: 'session_meta', timestamp: iso(0), payload: { id } })
const started = (turn: string, at = 1) => ({
  type: 'event_msg', timestamp: iso(at),
  payload: { type: 'task_started', turn_id: turn, started_at: base + at }
})
const context = (turn: string, at = 2) => ({ type: 'turn_context', timestamp: iso(at), payload: { turn_id: turn } })
const usage = (at: number, output: number, totalOutput = output, input = 100) => ({
  type: 'event_msg', timestamp: iso(at),
  payload: { type: 'token_count', info: {
    last_token_usage: { input_tokens: input, output_tokens: output, total_tokens: input + output },
    total_token_usage: { input_tokens: input, output_tokens: totalOutput, total_tokens: input + totalOutput }
  } }
})
const complete = (turn: string, at: number, begin = 1, duration?: number) => ({
  type: 'event_msg', timestamp: iso(at),
  payload: {
    type: 'task_complete', turn_id: turn, started_at: base + begin, completed_at: base + at,
    ...(duration === undefined ? {} : { duration_ms: duration })
  }
})

async function writeCodex(home: string, frames: unknown[], day = '02', stamp = '2026-01-02T00-00-00', id = thread): Promise<string> {
  const dir = join(home, 'sessions', '2026', '01', day)
  await mkdir(dir, { recursive: true })
  const path = join(dir, `rollout-${stamp}-${id}.jsonl`)
  await writeFile(path, `${frames.map((frame) => JSON.stringify(frame)).join('\n')}\n`)
  return path
}

async function writePi(path: string, frames: unknown[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${frames.map((frame) => JSON.stringify(frame)).join('\n')}\n`)
}

const piHeader = (id = sessionId) => ({ type: 'session', version: 3, id, timestamp: iso(0), cwd: 'C:\\example' })
const piModel = { type: 'model_change', id: 'm1', parentId: null, timestamp: iso(0), provider: 'openai', modelId: 'example' }
const piUser = (id: string, parentId: string, at = 1) => ({
  type: 'message', id, parentId, timestamp: iso(at), message: { role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: (base + at) * 1000 }
})
const piAssistant = (id: string, parentId: string, at: number, output: number, durationMs?: number, stopReason = 'stop') => ({
  type: 'message', id, parentId, timestamp: iso(at),
  message: {
    role: 'assistant', content: [{ type: 'text', text: 'ok' }], stopReason, timestamp: (base + at) * 1000,
    usage: { input: 10, output, cacheRead: 0, cacheWrite: 0 },
    ...(durationMs === undefined ? {} : { durationMs })
  }
})

test('Codex sums deduplicated request output for the latest completed turn', async () => {
  const home = await mkdtemp(join(tmpdir(), 'chat-gauge-codex-'))
  try {
    await writeCodex(home, [
      meta(), started('t1', 1), context('t1', 2),
      usage(3, 10, 10, 100), usage(4, 15, 25, 200), usage(4, 15, 25, 200),
      complete('t1', 10, 1, 9000)
    ])
    const rate = await readTurnRate(codexRecord(home))
    assert.deepEqual(rate, {
      scope: 'turn', outputTokens: 25, durationMs: 9000, completedAt: (base + 10) * 1000
    })
  } finally {
    clearTurnRateCache()
    await rm(home, { recursive: true, force: true })
  }
})

test('Codex falls back to boundary clocks and reports the newest turn', async () => {
  const home = await mkdtemp(join(tmpdir(), 'chat-gauge-codex-'))
  try {
    await writeCodex(home, [
      meta(), started('t1', 1), context('t1', 2), usage(3, 10),
      complete('t1', 6, 1),
      started('t2', 11), context('t2', 12), usage(13, 20), complete('t2', 16, 11)
    ])
    const rate = await readTurnRate(codexRecord(home))
    assert.deepEqual(rate, {
      scope: 'turn', outputTokens: 20, durationMs: 5000, completedAt: (base + 16) * 1000
    })
  } finally {
    clearTurnRateCache()
    await rm(home, { recursive: true, force: true })
  }
})

test('Codex rejects unsupported locations, ambiguous rollouts, and missing timing or usage', async () => {
  const home = await mkdtemp(join(tmpdir(), 'chat-gauge-codex-'))
  try {
    await writeCodex(home, [
      meta(), started('t1', 1), context('t1', 2),
      { type: 'event_msg', timestamp: iso(3), payload: { type: 'token_count', info: { total_token_usage: { output_tokens: 10, total_tokens: 10 } } } },
      complete('t1', 4, 1)
    ])
    assert.equal(await readTurnRate({ ...codexRecord(home), location: { executionHostId: 'remote' } }), null)
    assert.equal(await readTurnRate({ ...codexRecord(home), location: { executionHostId: 'local', wslDistro: 'Ubuntu' } }), null)
    assert.equal(await readTurnRate({ ...codexRecord(home), provider: 'claude' }), null)
    assert.equal(await readTurnRate(codexRecord(home)), null)
    assert.equal(await readTurnRate(codexRecord(home, thread, {
      transport: 'codex-app-server', agent: 'codex', nativeId: thread, resumeCursor: 'leaf'
    })), null)

    await writeCodex(home, [meta(), started('t1', 1), context('t1', 2), usage(3, 10), complete('t1', 4, 1)], '03', '2026-01-03T00-00-00')
    clearTurnRateCache()
    assert.equal(await readTurnRate(codexRecord(home)), null)
  } finally {
    clearTurnRateCache()
    await rm(home, { recursive: true, force: true })
  }
})

test('Codex uses the exact rollout identity and ignores interrupted or empty turns', async () => {
  const home = await mkdtemp(join(tmpdir(), 'chat-gauge-codex-'))
  try {
    await writeCodex(home, [meta('different-thread'), started('t1', 1), context('t1', 2), usage(3, 10), complete('t1', 4, 1)])
    assert.equal(await readTurnRate(codexRecord(home)), null)

    await rm(join(home, 'sessions'), { recursive: true, force: true })
    clearTurnRateCache()
    await writeCodex(home, [
      meta(), started('t1', 1), context('t1', 2), usage(3, 10),
      { type: 'event_msg', timestamp: iso(4), payload: { type: 'turn_aborted', turn_id: 't1', duration_ms: 3000 } }
    ])
    assert.equal(await readTurnRate(codexRecord(home)), null)

    await rm(join(home, 'sessions'), { recursive: true, force: true })
    clearTurnRateCache()
    await writeCodex(home, [meta(), started('t1', 1), context('t1', 2), usage(3, 0), complete('t1', 3, 1)])
    assert.equal(await readTurnRate(codexRecord(home)), null)
  } finally {
    clearTurnRateCache()
    await rm(home, { recursive: true, force: true })
  }
})

test('Codex reads a completed turn split across appends without losing the partial line', async () => {
  const home = await mkdtemp(join(tmpdir(), 'chat-gauge-codex-'))
  try {
    const path = await writeCodex(home, [meta(), started('t1', 1), context('t1', 2), usage(3, 12)])
    const content = JSON.stringify(complete('t1', 8, 1, 7000))
    await appendFile(path, content.slice(0, 40))
    assert.equal(await readTurnRate(codexRecord(home)), null)
    await appendFile(path, `${content.slice(40)}\n`)
    const rate = await readTurnRate(codexRecord(home))
    assert.deepEqual(rate, {
      scope: 'turn', outputTokens: 12, durationMs: 7000, completedAt: (base + 8) * 1000
    })
  } finally {
    clearTurnRateCache()
    await rm(home, { recursive: true, force: true })
  }
})

test('Codex refuses a turn whose start fell outside the bounded tail, then reads the next turn', async () => {
  const home = await mkdtemp(join(tmpdir(), 'chat-gauge-codex-'))
  try {
    const filler = { type: 'response_item', timestamp: iso(3), payload: { type: 'message', content: 'x'.repeat(1_400_000) } }
    const path = await writeCodex(home, [meta(), started('t1', 1), context('t1', 2), filler, usage(4, 10), complete('t1', 5, 1, 4000)])
    assert.equal(await readTurnRate(codexRecord(home)), null)
    await appendFile(path, [
      started('t2', 6), context('t2', 7), usage(8, 20), complete('t2', 12, 6, 5000)
    ].map((frame) => `${JSON.stringify(frame)}\n`).join(''))
    assert.deepEqual(await readTurnRate(codexRecord(home)), {
      scope: 'turn', outputTokens: 20, durationMs: 5000, completedAt: (base + 12) * 1000
    })
  } finally {
    clearTurnRateCache()
    await rm(home, { recursive: true, force: true })
  }
})

test('Pi reports a completed assistant message only when it carries an explicit duration', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chat-gauge-pi-'))
  const path = join(dir, `2026-01-02T00-00-00-000Z_${sessionId}.jsonl`)
  try {
    await writePi(path, [
      piHeader(), piModel, piUser('u1', 'm1', 1),
      piAssistant('a1', 'u1', 5, 20, 4000)
    ])
    assert.deepEqual(await readTurnRate(piRecord(path)), {
      scope: 'message', outputTokens: 20, durationMs: 4000, completedAt: (base + 5) * 1000
    })

    await writePi(path, [
      piHeader(), piModel, piUser('u1', 'm1', 1),
      piAssistant('a1', 'u1', 5, 20)
    ])
    assert.equal(await readTurnRate(piRecord(path)), null)
  } finally {
    clearTurnRateCache()
    await rm(dir, { recursive: true, force: true })
  }
})

test('Pi rejects failed messages, mismatched file identity, and relative paths', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chat-gauge-pi-'))
  const path = join(dir, `2026-01-02T00-00-00-000Z_${sessionId}.jsonl`)
  try {
    await writePi(path, [
      piHeader(), piModel, piUser('u1', 'm1', 1),
      piAssistant('a1', 'u1', 5, 20, 4000, 'error')
    ])
    assert.equal(await readTurnRate(piRecord(path)), null)

    await writePi(path, [
      piHeader('00000000-0000-4000-8000-000000000000'), piModel, piUser('u1', 'm1', 1),
      piAssistant('a1', 'u1', 5, 20, 4000)
    ])
    assert.equal(await readTurnRate(piRecord(path)), null)

    assert.equal(await readTurnRate(piRecord('relative.jsonl')), null)
  } finally {
    clearTurnRateCache()
    await rm(dir, { recursive: true, force: true })
  }
})

test('Codex does not substitute an older rate for a newer terminal turn without usage', async () => {
  const home = await mkdtemp(join(tmpdir(), 'chat-gauge-codex-'))
  try {
    await writeCodex(home, [
      meta(), started('t1', 1), context('t1', 2), usage(3, 10), complete('t1', 4, 1),
      started('t2', 5), context('t2', 6), complete('t2', 8, 5)
    ])
    assert.equal(await readTurnRate(codexRecord(home)), null)
  } finally {
    clearTurnRateCache()
    await rm(home, { recursive: true, force: true })
  }
})

test('Pi treats a file without parent links as linear', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chat-gauge-pi-'))
  const path = join(dir, `2026-01-02T00-00-00-000Z_${sessionId}.jsonl`)
  try {
    await writePi(path, [
      piHeader(),
      { type: 'model_change', id: 'm1', timestamp: iso(0), provider: 'openai', modelId: 'example' },
      { type: 'message', id: 'u1', timestamp: iso(1), message: { role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: (base + 1) * 1000 } },
      { type: 'message', id: 'a1', timestamp: iso(5), message: {
        role: 'assistant', content: [], stopReason: 'stop', timestamp: (base + 5) * 1000,
        usage: { input: 0, output: 20, cacheRead: 0, cacheWrite: 0 }, durationMs: 4000
      } }
    ])
    assert.deepEqual(await readTurnRate(piRecord(path)), {
      scope: 'message', outputTokens: 20, durationMs: 4000, completedAt: (base + 5) * 1000
    })
  } finally {
    clearTurnRateCache()
    await rm(dir, { recursive: true, force: true })
  }
})

test('Pi follows the current branch and does not cross the newest compaction', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chat-gauge-pi-'))
  const path = join(dir, `2026-01-02T00-00-00-000Z_${sessionId}.jsonl`)
  try {
    await writePi(path, [
      piHeader(), piModel, piUser('u1', 'm1', 1),
      piAssistant('a1', 'u1', 5, 10, 1000),
      { type: 'compaction', id: 'c1', parentId: 'a1', timestamp: iso(6) },
      piUser('u2', 'c1', 7),
      piAssistant('a2', 'u2', 8, 15)
    ])
    assert.equal(await readTurnRate(piRecord(path)), null)

    await appendFile(path, `${JSON.stringify(piAssistant('a3', 'a2', 9, 30, 2000))}\n`)
    assert.deepEqual(await readTurnRate(piRecord(path)), {
      scope: 'message', outputTokens: 30, durationMs: 2000, completedAt: (base + 9) * 1000
    })
  } finally {
    clearTurnRateCache()
    await rm(dir, { recursive: true, force: true })
  }
})

test('requires the persisted Codex handle form and rejects mixed provider chains', async () => {
  const home = await mkdtemp(join(tmpdir(), 'chat-gauge-codex-'))
  try {
    await writeCodex(home, [meta(), started('t1', 1), context('t1', 2), usage(3, 10), complete('t1', 4, 1)])
    assert.deepEqual(await readTurnRate(codexRecord(home)), {
      scope: 'turn', outputTokens: 10, durationMs: 3000, completedAt: (base + 4) * 1000
    })
    // Orca stores Codex only in its typed form; a neutral legacy handle is refused on read.
    assert.equal(await readTurnRate(codexRecord(home, thread, {
      transport: 'codex-app-server', agent: 'codex', nativeId: thread
    })), null)
    const mixed = {
      ...codexRecord(home),
      providerHandleChain: [
        { handle: { provider: 'codex', threadId: thread } },
        { handle: { provider: 'claude', sessionId: thread, leafUuid: null } }
      ]
    }
    assert.equal(await readTurnRate(mixed), null)
  } finally {
    clearTurnRateCache()
    await rm(home, { recursive: true, force: true })
  }
})
