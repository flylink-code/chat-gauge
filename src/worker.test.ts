import { assert, mockHost, mountWorker, test } from 'orca/testing'
import type { Chat, Sample } from './protocol'
import { start, type Sources } from './worker'

const a: Chat = { id: 'a', title: 'Chat A', state: 'working', agent: 'claude' }
const b: Chat = { id: 'b', title: 'Chat B', state: 'done', agent: 'antigravity' }
const sample: Sample = { model: 'example/model', inputTokens: 900, outputTokens: 100, durationMs: 2000, completedAt: 1760000000000 }

test('defaults to the first chat, keeps the manual choice, and clears stale numbers after /clear', async () => {
  let chats = [a, b]
  let providerId = 'provider-a'
  const source: Sources = {
    listChats: async () => chats,
    nativeContext: async (id) => id === b.id ? { kind: 'estimate', usedTokens: 12_345, windowTokens: 200_000, model: null, capturedAt: sample.completedAt } : null,
    geminiUsage: async () => null,
    nativeTurn: async () => ({ startedAt: 1000, completedAt: 4000, durationMs: 3000 }),
    providerRate: async () => ({ scope: 'turn', completedAt: 4000, durationMs: 3000, outputTokens: 90 }),
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
    const first = await worker.request('gauge.get')
    assert.deepEqual(first.chats, [a, b])
    assert.equal(first.selected, a.id)
    assert.equal(first.phase, 'ready')
    assert.equal(first.locale, 'zh-TW')
    assert.deepEqual(first.sample, sample)
    assert.equal(first.windowTokens, 1000)
    assert.equal((await worker.request('gauge.select', { id: 'unknown' })).selected, a.id)
    const other = await worker.request('gauge.select', { id: b.id })
    assert.equal(other.selected, b.id)
    assert.equal(other.phase, 'ready')
    assert.equal(other.sample, null)
    assert.equal(other.providerRate?.outputTokens, 90)
    assert.equal(other.turn?.durationMs, 3000)
    assert.equal(other.context?.kind, 'estimate')
    // The choice is sticky: nothing re-selects a because it is first or working.
    const sticky = await worker.request('gauge.get')
    assert.equal(sticky.selected, b.id)
    providerId = 'after-clear'
    const cleared = await worker.request('gauge.select', { id: a.id })
    assert.equal(cleared.phase, 'missing')
    assert.equal(cleared.sample, null)
    chats = [b]
    assert.equal((await worker.request('gauge.get')).selected, b.id)
    chats = [a, b]; await worker.request('gauge.select', { id: b.id })
    chats = [a]
    assert.equal((await worker.request('gauge.get')).selected, a.id)
    chats = []
    assert.equal((await worker.request('gauge.get')).phase, 'empty')
    assert.deepEqual(worker.refusals, [])
  } finally { await worker.deactivate() }
})

test('remembers the choice per workspace and falls back to the first chat in another one', async () => {
  const where = (id: string) => ({ workspaceId: id, branch: '', displayName: id, terminals: [] })
  const rosters: Record<string, Chat[]> = { 'folder:one': [a, b], 'folder:two': [b, a] }
  const source: Sources = {
    listChats: async (workspace) => rosters[workspace], nativeContext: async () => null, nativeTurn: async () => null,
    geminiUsage: async () => null, providerRate: async () => null,
    resolveChat: async () => null, findTranscript: async () => null, makeTail: () => ({ read: async () => sample })
  }
  const host = mockHost({ results: { 'workspace.readContext': where('folder:one') } })
  let stop: (() => void) | undefined
  const worker = await mountWorker({ default: orca => { stop = start(orca, source, 0) }, deactivate: () => stop?.() }, { host })
  try {
    assert.equal((await worker.request('gauge.get')).selected, a.id)
    assert.equal((await worker.request('gauge.select', { id: b.id })).selected, b.id)
    host.respond('workspace.readContext', where('folder:two'))
    assert.equal((await worker.request('gauge.get')).selected, b.id) // first of two; also unrelated to one's choice
    assert.equal((await worker.request('gauge.select', { id: a.id })).selected, a.id)
    host.respond('workspace.readContext', where('folder:one'))
    assert.equal((await worker.request('gauge.get')).selected, b.id)
    host.respond('workspace.readContext', where('folder:two'))
    assert.equal((await worker.request('gauge.get')).selected, a.id)
  } finally { await worker.deactivate() }
})

test('a manual choice bypasses the metric interval but not the roster interval', async () => {
  let now = 0, lists = 0, metricReads = 0
  const source: Sources = {
    listChats: async () => { lists++; return [a, b] },
    nativeContext: async () => { metricReads++; return null }, nativeTurn: async () => null,
    geminiUsage: async () => null, providerRate: async () => null,
    resolveChat: async () => ({ id: 'provider-a', config: null }), findTranscript: async () => 'example.jsonl',
    makeTail: () => ({ read: async () => sample })
  }
  const host = mockHost({ results: { 'workspace.readContext': { workspaceId: 'folder:test', terminals: [], branch: '', displayName: 'Test' } } })
  let stop: (() => void) | undefined
  const worker = await mountWorker({ default: orca => { stop = start(orca, source, 60_000, () => now) }, deactivate: () => stop?.() }, { host })
  try {
    assert.equal((await worker.request('gauge.get')).selected, a.id)
    now = 300; await worker.request('gauge.get'); assert.equal(metricReads, 1)
    now = 600; const changed = await worker.request('gauge.select', { id: b.id })
    assert.equal(changed.selected, b.id); assert.equal(changed.sample, null); assert.equal(metricReads, 2); assert.equal(lists, 1)
    now = 3000; assert.equal((await worker.request('gauge.get')).selected, b.id); assert.equal(metricReads, 3); assert.equal(lists, 2)
  } finally { await worker.deactivate() }
})