import type { Snapshot } from './protocol'
import { messages } from './i18n'
import { rateCopy } from './rate-copy'

const agents = new Map(Object.entries({
  claude: 'Claude Code', codex: 'Codex', antigravity: 'Antigravity', agy: 'Antigravity',
  opencode: 'OpenCode', opencode2: 'OpenCode 2', pi: 'Pi', omp: 'OMP', gemini: 'Gemini CLI',
  copilot: 'GitHub Copilot', cursor: 'Cursor', grok: 'Grok', kimi: 'Kimi', hermes: 'Hermes', kiro: 'Kiro',
  goose: 'Goose', aug: 'Auggie', kilo: 'Kilocode', 'mimo-code': 'MiMo Code', droid: 'Droid',
  'qwen-code': 'Qwen Code', cline: 'Cline', devin: 'Devin', codebuddy: 'CodeBuddy'
}))
export const agentLabel = (agent: string) => agents.get(agent) ?? agent

const integer = new Intl.NumberFormat('en', { maximumFractionDigits: 0 })
export const count = (n: number): string => integer.format(n)
export const compact = (n: number): string => n < 1_000 ? String(n) : n < 999_950 ? `${+(n / 1_000).toFixed(1)}k` : `${+(n / 1_000_000).toFixed(2)}M`

export function metrics(snapshot: Snapshot) {
  const { sample, context, windowTokens } = snapshot
  const dc = snapshot.providerRate?.decode
  const decode = dc ? { rate: `≈${(dc.outputTokens * 1000 / dc.streamMs).toFixed(1)} tok/s`, calls: dc.calls,
    first: dc.firstTokenMs === null ? null : `${(dc.firstTokenMs / 1000).toFixed(2)} s` } : null
  const native = context && context.kind !== 'unknown' ? context : null
  const useNative = native && (!sample || native.capturedAt >= sample.completedAt)
  const used = useNative ? native.usedTokens
    : sample && (!context || sample.completedAt > context.capturedAt) ? sample.inputTokens + sample.outputTokens : null
  // A previous report can still supply the limit, but not for a different model.
  const nativeWindow = native && (useNative || !native.model || native.model === sample?.model) ? native.windowTokens : null
  const window = windowTokens ?? nativeWindow
  const percent = used !== null && window ? Math.round(used / window * 100) : null
  const free = used !== null && window ? Math.max(0, window - used) : null
  const cache = sample && sample.cacheReadTokens !== undefined && sample.inputTokens > 0 && sample.cacheReadTokens <= sample.inputTokens
    ? { read: sample.cacheReadTokens, percent: sample.cacheReadTokens / sample.inputTokens * 100 }
    : null
  const tone = percent !== null && percent >= 90 ? 'danger' : percent !== null && percent >= 75 ? 'warning' : 'neutral'
  const timed = snapshot.providerRate ?? sample
  const rate = timed?.durationMs ? `≈${(timed.outputTokens * 1000 / timed.durationMs).toFixed(1)} tok/s` : null
  const rateNote = snapshot.providerRate ? rateCopy[snapshot.locale][snapshot.providerRate.scope] : messages(snapshot.locale).lastRequest
  const breakdown = native?.kind === 'report' && native.categories?.length && (useNative || (native.model && native.model === sample?.model))
    ? { at: native.capturedAt, categories: [...native.categories].sort((a, b) =>
      Number(!!a.deferred) - Number(!!b.deferred) || b.tokens - a.tokens) }
    : null
  return { used, percent, rate, rateNote, decode, tone, window, free, cache, breakdown, contextEstimated: useNative ? native.kind === 'estimate' : used !== null,
    contextAt: useNative ? native.capturedAt : used !== null ? sample?.completedAt ?? null : null } as const
}

export function status(snapshot: Snapshot) {
  const { used, rate, decode, tone, window, contextEstimated } = metrics(snapshot)
  const t = messages(snapshot.locale)
  const agent = snapshot.chats.find((chat) => chat.id === snapshot.selected)?.agent
  const context = used === null ? null : `${compact(used)}${window ? `/${compact(window)}` : ''}`
  const text = [context, rate].filter(Boolean).join(' · ')
  if (!text) return { text: '—', tooltip: `Chat Gauge\n${t[snapshot.phase]}`, tone }
  const detail = [agent ? agentLabel(agent) : 'Chat Gauge']
  if (used !== null) detail.push(`${t.contextTokens}：${count(used)}${window ? ` / ${count(window)}` : ` · ${t.windowUnknown}`}${contextEstimated ? ` · ${t.estimated}` : ''}`)
  if (rate) detail.push(`${t.throughput}：${rate}`, snapshot.providerRate ? rateCopy[snapshot.locale][snapshot.providerRate.scope] : t.lastRequest)
  if (decode) detail.push(`${rateCopy[snapshot.locale].decode}：${decode.rate}`)
  return { text, tooltip: detail.join('\n'), tone }
}
