import type { OrcaWorkerApi } from 'orca/worker'
import { status } from './format'
import { resolveLocale } from './i18n'
import { emptySnapshot, type Snapshot } from './protocol'
import { findTranscript, listChats, nativeContext, nativeTurn, resolveChat } from './source'
import { geminiUsage, providerRate } from './provider-sources'
import { TranscriptTail } from './tail'
import { tokenCount } from './transcript'

const sources = { listChats, nativeContext, nativeTurn, providerRate, geminiUsage, resolveChat, findTranscript, makeTail: (path: string, id: string) => new TranscriptTail(path, id) }
export type Sources = Omit<typeof sources, 'makeTail'> & { makeTail: (path: string, id: string) => Pick<TranscriptTail, 'read'> }

export function start(orca: OrcaWorkerApi, source: Sources, pollMs = 300, clock = () => performance.now()): () => void {
  let disposed = false
  // Manual choice per workspace; Orca exposes no live focused-Chat signal, so nothing guesses it.
  const chosen = new Map<string, string>()
  let previousWorkspace: string | null = null
  let snapshot = emptySnapshot
  let flight: Promise<Snapshot> | null = null
  let timer: ReturnType<typeof setInterval> | undefined
  let tail: { identity: string; reader: Pick<TranscriptTail, 'read'> } | null = null
  let publishedStatus = ''
  let roster: { workspace: string; chats: Snapshot['chats']; until: number } | null = null
  let rosterRefresh: Promise<void> | null = null
  let preferences = { locale: emptySnapshot.locale, windowTokens: null as number | null, until: 0 }
  let metricsUntil = 0

  const read = async (): Promise<Snapshot> => {
    const next: Snapshot = { ...emptySnapshot, phase: 'unavailable' }
    if (pollMs === 0 || clock() >= preferences.until) {
      const settings = await orca.host.call('settings.get').catch(() => null)
      preferences = { locale: resolveLocale(settings?.settings.language), windowTokens: tokenCount(settings?.settings.contextWindowTokens) || null, until: clock() + 2000 }
    }
    next.locale = preferences.locale
    try {
      const context = await orca.host.call('workspace.readContext')
      const workspace = context?.workspaceId ?? null
      const switched = workspace !== previousWorkspace
      if (switched) { tail = null; roster = null; previousWorkspace = workspace; metricsUntil = 0 }
      if (workspace) {
        if (!roster || roster.workspace !== workspace || pollMs === 0) {
          roster = { workspace, chats: await source.listChats(workspace), until: clock() + 1500 }
        } else if (clock() >= roster.until && !rosterRefresh) {
          const current = roster
          current.until = clock() + 1500
          rosterRefresh = source.listChats(workspace).then(chats => {
            if (!disposed && roster === current) current.chats = chats
          }).catch(() => { if (roster === current) roster = null }).finally(() => { rosterRefresh = null })
        }
        next.chats = roster.chats
      }
      const pick = workspace ? chosen.get(workspace) : undefined
      next.selected = next.chats.find((chat) => chat.id === pick)?.id ?? next.chats[0]?.id ?? null
      if (!next.selected) {
        tail = null
        next.phase = 'empty'
        return next
      }
      next.windowTokens = preferences.windowTokens
      // Expensive provider reads keep their own cadence while the same chat stays selected.
      if (!switched && pollMs > 0 && clock() < metricsUntil && snapshot.selected === next.selected && snapshot.phase !== 'unavailable') {
        return { ...snapshot, chats: next.chats, locale: next.locale, windowTokens: next.windowTokens }
      }
      metricsUntil = clock() + 2000
      const chat = next.chats.find((row) => row.id === next.selected)
      next.context = await source.nativeContext(next.selected).catch(() => null)
      if (chat?.agent !== 'claude') {
        tail = null
        const turn = await source.nativeTurn(next.selected).catch(() => null)
        if (turn && !(next.context?.kind === 'unknown' && next.context.capturedAt >= turn.completedAt)) {
          next.turn = turn
          if (chat?.agent === 'gemini') {
            const usage = await source.geminiUsage(next.selected,turn).catch(() => null)
            if (usage) next.messageUsage = usage
          } else if (chat) {
            const rate = await source.providerRate(next.selected, chat.agent, turn).catch(() => null)
            if (rate) next.providerRate = rate
          }
        }
        next.phase = next.turn || (next.context && next.context.kind !== 'unknown') ? 'ready' : 'waiting'
        return next
      }
      const session = await source.resolveChat(next.selected)
      if (!session) {
        tail = null
        next.phase = next.context && next.context.kind !== 'unknown' ? 'ready' : 'missing'
        return next
      }
      const identity = JSON.stringify([next.selected, session.id, session.config])
      if (tail?.identity !== identity) {
        tail = null
        const path = await source.findTranscript(session)
        if (path) tail = { identity, reader: source.makeTail(path, session.id) }
      }
      if (!tail) {
        next.phase = next.context && next.context.kind !== 'unknown' ? 'ready' : 'missing'
        return next
      }
      next.sample = await tail.reader.read()
      next.phase = next.sample || (next.context && next.context.kind !== 'unknown') ? 'ready' : 'waiting'
    } catch {
      // Never forward paths, process output or log contents to either UI surface.
      tail = null
    }
    return next
  }

  const refresh = () => flight ??= read().then(async (next) => {
    if (disposed) return snapshot
    if (JSON.stringify(next) !== JSON.stringify(snapshot)) {
      snapshot = next
      orca.panels.post('gauge.changed', snapshot)
    }
    const item = status(next)
    const key = JSON.stringify(item)
    if (key !== publishedStatus) {
      try {
        await orca.host.call('statusBar.update', { id: 'gauge', ...item })
        publishedStatus = key
      } catch { /* No desktop status bar in some hosts. */ }
    }
    return snapshot
  }).finally(() => { flight = null })

  orca.panels.handle('gauge.get', () => refresh())
  orca.panels.handle('gauge.select', async ({ id }) => {
    if (flight) await flight
    if (!snapshot.chats.some((chat) => chat.id === id)) return snapshot
    if (previousWorkspace) chosen.set(previousWorkspace, id)
    return refresh()
  })
  if (pollMs > 0) timer = setInterval(() => void refresh(), pollMs)
  return () => {
    disposed = true
    clearInterval(timer)
  }
}

let stop: (() => void) | undefined
export default function activate(orca: OrcaWorkerApi): void { stop = start(orca, sources) }
export function deactivate(): void { stop?.(); stop = undefined }
