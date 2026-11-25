import { assert, mockHost, mountWorker, test } from 'orca/testing'
import type { Chat, Sample } from './protocol'
import { start, type Sources } from './worker'

const a: Chat = { id: 'a', title: 'Chat A', state: 'working', agent: 'claude' }
const b: Chat = { id: 'b', title: 'Chat B', state: 'done', agent: 'antigravity' }
const sample: Sample = { model: 'example/model', inputTokens: 900, outputTokens: 100, durationMs: 2000, completedAt: 1760000000000 }

test('requires a choice for multiple chats and clears stale numbers after /clear or a workspace switch', async () => {
  let chats = [a, b]
  let providerId = 'provider-a'
  const source: Sources = {
    listChats: async () => chats,
    nativeContext: async (id) => id === b.id ? { kind: 'estimate', usedTokens: 12_345, windowTokens: 200_000, model: null, capturedAt: sample.completedAt } : null,
    resolveChat: async () => ({ id: providerId, config: null }),
    findTranscript: async (session) => session.id === 'provider-a' ? 'a.jsonl' : null,
    makeTail: () => ({ read: async () => sample })
  }
  const host = mockHost({ settings: { contextWindowTokens: 1000, language: 'zh-TW' }, results: {
    'workspace.readContext': { workspaceId: 'folder:example', branch: '', displayName: 'Example', terminals: [] }
  } })
  let stop: (() => void) | undefined
  const worker = await mountWorker({ default: (orca) => { stop = start(orca, source, 0) }, deactivate: () => stop?.() }, { host })
  try {
    const choosing = await worker.request('gauge.get')
    assert.equal(choosing.phase, 'choose')
    assert.equal(choosing.locale, 'zh-TW')
    assert.equal((await worker.request('gauge.select', { id: 'unknown' })).selected, null)
    const selected = await worker.request('gauge.select', { id: a.id })
    assert.equal(selected.selected, a.id)
    assert.deepEqual(selected.sample, sample)
    assert.equal(selected.windowTokens, 1000)
    providerId = 'after-clear'
    const cleared = await worker.request('gauge.get')
    assert.equal(cleared.phase, 'missing')
    assert.equal(cleared.sample, null)
    const other = await worker.request('gauge.select', { id: b.id })
    assert.equal(other.phase, 'ready')
    assert.equal(other.sample, null)
    assert.equal(other.context?.kind, 'estimate')
    chats = []
    assert.equal((await worker.request('gauge.get')).phase, 'empty')
    assert.deepEqual(worker.refusals, [])
  } finally { await worker.deactivate() }
})
