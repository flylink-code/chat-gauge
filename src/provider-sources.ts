import { resolveRecord } from './source'
import { isRecord } from './transcript'
import type { NativeTurn } from './native-turn'
import type { ProviderRate } from './provider-rate'
import { readOpenCode } from './opencode-metrics'
import { readTurnRate } from './turn-metrics'
import { readAcpRate, readAcpUsage } from './acp-metrics'
import { readAgyRate } from './agy-metrics'

// Keep verified samples and briefly debounce missing data. Re-resolve the record so
// resets, account changes or a new native handle immediately invalidate it.
let cached: { key: string; rate: ProviderRate | null; until: number } | null = null

export async function geminiUsage(chatId: string, turn: NativeTurn) {
  const usage = await readAcpUsage(await resolveRecord(chatId))
  if (!usage || usage.completedAt < turn.startedAt || usage.completedAt > turn.completedAt) return null
  const { model, inputTokens, outputTokens, completedAt } = usage
  return { model, inputTokens, outputTokens, completedAt }
}

export async function providerRate(chatId: string, agent: string, turn: NativeTurn): Promise<ProviderRate | null> {
  if (!['opencode','opencode2','codex','pi','copilot','gemini','antigravity'].includes(agent)) return null
  const record = await resolveRecord(chatId)
  if (!isRecord(record) || record.provider !== agent) return null
  const key = JSON.stringify([chatId, agent, record.providerHandleChain, record.accountHome, record.launchedAccount, record.providerContextBoundary, isRecord(record.lease) ? record.lease.runtimeFence : null, turn])
  if (cached?.key === key && cached.until > Date.now()) return cached.rate
  // Provider files may arrive later than the turn marker. Retry misses at most twice a minute.
  cached = { key, rate: null, until: Date.now() + 30_000 }
  const rate = agent === 'opencode' || agent === 'opencode2' ? await readOpenCode(record)
    : agent === 'codex' || agent === 'pi' ? await readTurnRate(record)
    : agent === 'antigravity' ? await readAgyRate(record,turn) : await readAcpRate(record)
  // Never reattach a previous turn/epoch's sample or a newly running turn's partial count.
  if (!rate || !Number.isSafeInteger(rate.outputTokens) || rate.outputTokens < 0 || !Number.isFinite(rate.durationMs) || rate.durationMs <= 0 || !Number.isFinite(rate.completedAt) || rate.completedAt < turn.startedAt || rate.completedAt > turn.completedAt) return null
  cached = { key, rate, until: Infinity }
  return rate
}
