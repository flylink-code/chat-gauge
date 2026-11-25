import type { Locale } from './i18n'

export type Chat = { id: string; title: string; state: string; agent: string }
export type ContextCategory = { name: string; tokens: number; deferred?: true }
export type ContextSample =
  | { kind: 'unknown'; capturedAt: number }
  | { kind: 'report' | 'estimate'; usedTokens: number; windowTokens: number | null; model: string | null; capturedAt: number; categories?: ContextCategory[] }
export type Sample = {
  model: string
  completedAt: number
  inputTokens: number
  cacheReadTokens?: number
  outputTokens: number
  durationMs: number | null
}
export type Snapshot = {
  phase: 'loading' | 'unavailable' | 'empty' | 'choose' | 'waiting' | 'missing' | 'ready'
  locale: Locale
  chats: Chat[]
  selected: string | null
  sample: Sample | null
  context: ContextSample | null
  windowTokens: number | null
}
export const emptySnapshot: Snapshot = {
  phase: 'loading', locale: 'en', chats: [], selected: null, sample: null, context: null, windowTokens: null
}

declare module 'orca' {
  interface PluginRequests {
    'gauge.get': { output: Snapshot }
    'gauge.select': { input: { id: string }; output: Snapshot }
  }
  interface PluginPanelEvents {
    'gauge.changed': Snapshot
  }
}
