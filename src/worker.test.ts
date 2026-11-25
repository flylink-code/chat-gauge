import { assert, mockHost, mountWorker, test } from 'orca/testing'
import type { Chat, Sample } from './protocol'
import { start, type Sources } from './worker'

const a: Chat = { id: 'a', title: 'Chat A', state: 'working', agent: 'claude' }
const b: Chat = { id: 'b', title: 'Chat B', state: 'done', agent: 'antigravity' }
const sample: Sample = { model: 'example/model', inputTokens: 900, outputTokens: 100, durationMs: 2000, completedAt: 1760000000000 }

test('requires a choice for multiple chats and clears stale numbers after /clear or a workspace switch', async () => {
  let chats = [a, b]
  let focus: string | null = null
  let providerId = 'provider-a'
  const source: Sources = {
    listChats: async () => chats,
    focusedChat: async () => focus,
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
    assert.equal(other.providerRate?.outputTokens,90)
    assert.equal(other.turn?.durationMs,3000)
    assert.equal(other.context?.kind, 'estimate')
    // Focus wins even though a is working and b was manually selected.
    providerId = 'provider-a'; focus = a.id
    const focusedA = await worker.request('gauge.get')
    assert.equal(focusedA.following,true); assert.equal(focusedA.selected,a.id)
    assert.deepEqual(focusedA.sample,sample); assert.equal(focusedA.providerRate,undefined)
    focus = b.id
    const focusedB = await worker.request('gauge.get')
    assert.equal(focusedB.selected,b.id); assert.equal(focusedB.sample,null)
    focus = 'other-workspace'
    assert.equal((await worker.request('gauge.get')).phase,'choose')
    chats = []
    assert.equal((await worker.request('gauge.get')).phase, 'empty')
    assert.deepEqual(worker.refusals, [])
  } finally { await worker.deactivate() }
})

test('focus changes bypass both the roster and metric refresh intervals', async () => {
  let now = 0, focus = a.id, lists = 0, metricReads = 0
  const source: Sources = {
    listChats: async () => { lists++; return [a,b] }, focusedChat: async () => focus,
    nativeContext: async () => { metricReads++; return null }, nativeTurn: async () => null,
    geminiUsage: async () => null, providerRate: async () => null,
    resolveChat: async () => ({id:'provider-a',config:null}), findTranscript: async () => 'example.jsonl',
    makeTail: () => ({read:async () => sample})
  }
  const host = mockHost({results:{'workspace.readContext':{workspaceId:'folder:test',terminals:[],branch:'',displayName:'Test'}}})
  let stop: (() => void) | undefined
  const worker = await mountWorker({default: orca => {stop=start(orca,source,60_000,()=>now)},deactivate:()=>stop?.()},{host})
  try {
    assert.equal((await worker.request('gauge.get')).selected,a.id)
    now=300; await worker.request('gauge.get'); assert.equal(metricReads,1)
    now=600; focus=b.id; const changed=await worker.request('gauge.get')
    assert.equal(changed.selected,b.id); assert.equal(changed.sample,null); assert.equal(metricReads,2); assert.equal(lists,1)
    now=3000; await worker.request('gauge.get'); assert.equal(metricReads,3); assert.equal(lists,2)
  } finally { await worker.deactivate() }
})
