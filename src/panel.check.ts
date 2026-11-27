import { defineCheck } from 'orca/testing'
import { emptySnapshot, type Snapshot } from './protocol'

export const ready: Snapshot = {
  ...emptySnapshot, phase: 'ready', selected: 'example', windowTokens: 100_000,
  chats: [{ id: 'example', title: 'Local Claude Chat', state: 'working', agent: 'claude' }],
  context: null,
  sample: { model: 'gateway/example', inputTokens: 93_591, outputTokens: 320, durationMs: 23_000, completedAt: 1760000000000 }
}

export const detailed: Snapshot = {
  ...ready, locale: 'zh-CN',
  sample: ready.sample ? { ...ready.sample, cacheReadTokens: 90_000 } : null,
  context: { kind: 'report', usedTokens: 93_911, windowTokens: 100_000, model: 'gateway/example', capturedAt: 1760000000000,
    categories: [{ name: 'Messages', tokens: 73_000 }, { name: 'System prompt', tokens: 10_000 },
      { name: 'System tools', tokens: 9_911 }, { name: 'Memory files', tokens: 1_000 },
      { name: 'Free space', tokens: 4_000 }, { name: 'Autocompact buffer', tokens: 2_089 },
      { name: 'MCP tools', tokens: 12_000, deferred: true }] }
}

export default defineCheck({
  'with breakdown': { requests: { 'gauge.get': () => detailed } },
  'no chats': { requests: { 'gauge.get': () => ({ ...emptySnapshot, phase: 'empty' }) } },
  'high context': { requests: { 'gauge.get': () => ready } },
  'simplified chinese': { requests: { 'gauge.get': () => ({ ...ready, locale: 'zh-CN' }) } },
  'traditional chinese': { requests: { 'gauge.get': () => ({ ...ready, locale: 'zh-TW' }) } },
  'chat tabs': { requests: { 'gauge.get': () => ({ ...ready, chats: [...ready.chats, { id: 'other', title: 'Other chat', state: 'done', agent: 'pi' }] }) } },
  'antigravity decode': { requests: { 'gauge.get': () => ({
    ...ready, locale: 'zh-CN', sample: null, windowTokens: null,
    chats: [{ id: 'example', title: 'Antigravity decode sample', state: 'done', agent: 'antigravity' }],
    context: { kind: 'estimate', usedTokens: 138_881, windowTokens: 1_048_576, model: null, capturedAt: 1760000000000 },
    providerRate: { scope: 'turn', outputTokens: 11_144, durationMs: 130_000, completedAt: 1760000000000,
      decode: { outputTokens: 11_144, streamMs: 100_839, firstTokenMs: 15_634, calls: 3 } }
  }) } },
  'context only': { requests: { 'gauge.get': () => ({
    ...ready, sample: null, windowTokens: null,
    chats: [{ id: 'example', title: 'A long Antigravity conversation title to fit in a narrow sidebar', state: 'working', agent: 'antigravity' }],
    context: { kind: 'estimate', usedTokens: 316_516, windowTokens: 1_048_576, model: null, capturedAt: 1760000000000 }
  }) } }
})
