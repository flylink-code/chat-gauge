import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, test } from 'orca/testing'
import { status } from './format'
import { emptySnapshot } from './protocol'
import { decodeSession } from './source'
import { TranscriptTail } from './tail'
import { Transcript } from './transcript'

const sessionId = '00000000-0000-0000-0000-000000000001'
const line = (type: string, seconds: number, extra = {}) => JSON.stringify({
  type, sessionId, timestamp: new Date(1760000000000 + seconds * 1000).toISOString(), ...extra
})
const assistant = (id: string, t: number, output = 100, stop: string | null = 'end_turn') => line('assistant', t, {
  message: { id, model: '网关/example', stop_reason: stop, usage: { input_tokens: 10, cache_read_input_tokens: 800, cache_creation_input_tokens: 90, output_tokens: output } }
})

test('uses final usage, resolves duplicate message blocks and does not reuse a consumed request clock', () => {
  const parser = new Transcript()
  for (const row of [line('api-request', 1), assistant('first', 2, 2, null), assistant('first', 3), assistant('first', 4, 120)]) parser.consume(row, sessionId)
  assert.equal(parser.sample?.inputTokens, 900)
  assert.equal(parser.sample?.cacheReadTokens, 800)
  assert.equal(parser.sample?.outputTokens, 120)
  assert.equal(parser.sample?.durationMs, 3000)
  const badge = status({ ...emptySnapshot, sample: parser.sample, windowTokens: 2000 })
  assert.equal(badge.text, '1k/2k · ≈40.0 tok/s')
  parser.consume(assistant('second', 5), sessionId)
  assert.equal(parser.sample?.durationMs, null)
  parser.consume(assistant('first', 6, 999), sessionId)
  assert.equal(parser.sample?.outputTokens, 100)
  parser.consume(line('system', 7, { subtype: 'compact_boundary' }), sessionId)
  assert.equal(parser.sample, null)
})

test('ignores unrelated session rows and subagents', () => {
  const parser = new Transcript()
  const row = JSON.parse(assistant('first', 3))
  parser.consume(JSON.stringify({ ...row, sessionId: 'other' }), sessionId)
  parser.consume(JSON.stringify({ ...row, isSidechain: true }), sessionId)
  assert.equal(parser.sample, null)
})

test('JSONL tail handles partial UTF-8 writes and truncation without keeping stale readings', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chat-gauge-test-'))
  try {
    const path = join(dir, 'session.jsonl')
    const bytes = Buffer.from(assistant('first', 3) + '\n')
    const split = bytes.indexOf(Buffer.from('网')) + 1
    await writeFile(path, line('api-request', 1) + '\n')
    await appendFile(path, bytes.subarray(0, split))
    const tail = new TranscriptTail(path, sessionId)
    assert.equal(await tail.read(), null)
    await appendFile(path, bytes.subarray(split))
    assert.equal((await tail.read())?.model, '网关/example')
    await writeFile(path, '')
    assert.equal(await tail.read(), null)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('requires a supported local session and uses the latest provider handle', () => {
  const record = { schemaVersion: 2, provider: 'claude', location: { executionHostId: 'local' }, providerHandleChain: [
    { handle: { provider: 'claude', sessionId: '00000000-0000-0000-0000-000000000000' } },
    { handle: { provider: 'claude', sessionId } }
  ] }
  assert.deepEqual(decodeSession(record), { id: sessionId, config: null })
  assert.equal(decodeSession({ ...record, schemaVersion: 3 }), null)
  assert.equal(decodeSession({ ...record, location: { executionHostId: 'local', wslDistro: 'Ubuntu' } }), null)
  assert.equal(decodeSession({ ...record, providerHandleChain: [...record.providerHandleChain, { handle: { provider: 'claude', sessionId: '../../other' } }] }), null)
})
