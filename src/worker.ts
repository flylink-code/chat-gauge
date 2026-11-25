import type { OrcaWorkerApi } from 'orca/worker'
import { status } from './format'
import { resolveLocale } from './i18n'
import { emptySnapshot, type Snapshot } from './protocol'
import { findTranscript, listChats, nativeContext, resolveChat } from './source'
import { TranscriptTail } from './tail'
import { tokenCount } from './transcript'

const sources = { listChats, nativeContext, resolveChat, findTranscript, makeTail: (path: string, id: string) => new TranscriptTail(path, id) }
export type Sources = Omit<typeof sources, 'makeTail'> & { makeTail: (path: string, id: string) => Pick<TranscriptTail, 'read'> }

export function start(orca: OrcaWorkerApi, source: Sources, pollMs = 2000): () => void {
  let disposed = false
  let selected: string | null = null
  let snapshot = emptySnapshot
  let flight: Promise<Snapshot> | null = null
  let timer: ReturnType<typeof setInterval> | undefined
  let tail: { identity: string; reader: Pick<TranscriptTail, 'read'> } | null = null
  let publishedStatus = ''

  const read = async (): Promise<Snapshot> => {
    const settings = await orca.host.call('settings.get').catch(() => null)
    const next: Snapshot = { ...emptySnapshot, phase: 'unavailable', locale: resolveLocale(settings?.settings.language) }
    try {
      const context = await orca.host.call('workspace.readContext')
      next.chats = context?.workspaceId ? await source.listChats(context.workspaceId) : []
      if (selected && !next.chats.some((chat) => chat.id === selected)) selected = null
      next.selected = selected ?? (next.chats.length === 1 ? next.chats[0].id : null)
      if (!next.selected) {
        tail = null
        next.phase = next.chats.length ? 'choose' : 'empty'
        return next
      }
      next.windowTokens = tokenCount(settings?.settings.contextWindowTokens) || null
      const chat = next.chats.find((row) => row.id === next.selected)
      next.context = await source.nativeContext(next.selected).catch(() => null)
      if (chat?.agent !== 'claude') {
        tail = null
        next.phase = next.context && next.context.kind !== 'unknown' ? 'ready' : 'waiting'
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
    selected = id
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
