import { agentLabel, compact, count, metrics } from './format'
import { contextCopy, localTimestamp, messages, resolveLocale } from './i18n'
import { emptySnapshot, type Snapshot } from './protocol'
import { disposeMap, renderMap } from './html-map'
import { rateCopy } from './rate-copy'

const extra = {
  en: { why: 'Why is this unavailable?', na: 'Unavailable', noMap: 'No category breakdown', buffer: 'Reserved for compaction', manual: 'Custom limit', failed: 'Could not switch chats.' },
  'zh-CN': { why: '为什么没有？', na: '暂无', noMap: '没有分类明细', buffer: '压缩预留', manual: '手动上限', failed: '未能切换对话。' },
  'zh-TW': { why: '為什麼沒有？', na: '暫無', noMap: '沒有分類明細', buffer: '壓縮預留', manual: '手動上限', failed: '未能切換對話。' }
}
const stateLabels = new Map(Object.entries({ working: 'working', done: 'idle', waiting: 'waitingState', blocked: 'blocked' } as const))
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string) {
  const node = document.createElement(tag)
  if (cls) node.className = cls
  if (text !== undefined) node.textContent = text
  return node
}
const session = document.getElementById('session')!, tabs = document.getElementById('tabs')!, content = document.getElementById('content')!
let snapshot: Snapshot = { ...emptySnapshot, locale: resolveLocale('auto', window.orca?.locale) }
let mode: 'used' | 'window' = 'used'
let revision = 0, tabsKey = ''
let mountedMap: HTMLElement | null = null
const tabError = el('p','note'); tabError.setAttribute('role','alert'); tabError.hidden = true; tabs.after(tabError)
const failure = (text: string) => { tabError.textContent = text; tabError.hidden = !text }

function paintTabs() {
  const { chats, selected, locale } = snapshot
  tabs.hidden = chats.length < 2
  tabs.setAttribute('aria-label', messages(locale).selectChat)
  const key = JSON.stringify([locale, selected, chats.map(a => [a.id, a.agent, a.title, a.state])])
  if (key === tabsKey) return
  tabsKey = key
  const had = tabs.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.id : undefined
  tabs.replaceChildren(...chats.map(a => {
    const tab = el('button', 'tab'), on = a.id === selected
    tab.type = 'button'; tab.dataset.id = a.id; tab.title = `${agentLabel(a.agent)} · ${a.title}`
    tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', String(on)); tab.tabIndex = on ? 0 : -1
    tab.append(el('i', a.state === 'working' ? 'dot working' : 'dot'), el('span', 'tab-title', a.title))
    tab.onclick = () => void choose(a.id)
    return tab
  }))
  if (had) tabs.querySelector<HTMLElement>(`[data-id="${CSS.escape(had)}"]`)?.focus({ preventScroll: true })
}
tabs.onkeydown = (event) => {
  const keys: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1, Home: 0, End: 0 }
  if (!(event.key in keys)) return
  const ids = snapshot.chats.map(a => a.id), at = ids.indexOf(snapshot.selected ?? '')
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? ids.length - 1 : (at + keys[event.key] + ids.length) % ids.length
  event.preventDefault(); tabs.querySelector<HTMLElement>(`[data-id="${CSS.escape(ids[next])}"]`)?.focus(); void choose(ids[next])
}
async function choose(id: string) {
  if (id === snapshot.selected) return
  const started = revision; failure('')
  try { const next = await window.orca.plugin.request('gauge.select', { id }); if (revision === started) accept(next) }
  catch { failure(extra[snapshot.locale].failed) }
}

function paint() {
  const { chats, selected, locale, sample, context, phase } = snapshot
  const chat = chats.find((row) => row.id === selected), t = messages(locale), c = contextCopy[locale], x = extra[locale]
  const agy = chat?.agent === 'antigravity' || chat?.agent === 'agy'
  const m = metrics(snapshot)
  document.documentElement.lang = locale
  const focus = document.activeElement as HTMLElement | null
  const focusKey = focus?.id || ''
  const focusedSummary = focus?.tagName === 'SUMMARY' ? focus.textContent : null
  const expanded = new Set(Array.from(content.querySelectorAll('details[open]')).map(n => (n as HTMLElement).dataset.state || n.querySelector('summary')?.textContent))
  if (mountedMap) { disposeMap(mountedMap); mountedMap = null }
  const title = el('h1', '', chat?.title || t.workspace); title.title = title.textContent || ''
  const meta = el('div', 'meta')
  if (chat) {
    const state = el('span','pill'); state.append(el('i', chat.state === 'working' ? 'dot working' : 'dot'),t[stateLabels.get(chat.state) ?? 'unknown'])
    meta.append(el('span','pill',agentLabel(chat.agent)), state)
  }
  session.replaceChildren(title,meta); paintTabs()
  const frag = document.createDocumentFragment()
  if (!chat || (m.used === null && !sample && !snapshot.turn && !m.rate)) {
    const p = el('p','notice',t[phase]); p.setAttribute('role','status'); frag.append(p)
  } else {
    const overview = el('section'); overview.id = 'overview'
    const head = el('div','headrow'); head.append(el('h2','',t.context)); overview.append(head)
    if (m.percent !== null) {
      const pct = el('span',`percent ${m.tone}`,`${m.percent}%`); pct.title = m.tone === 'danger' ? t.nearLimit : m.tone === 'warning' ? t.high : t.used; head.append(pct)
    }
    const hero = el('div','hero'); hero.append(el('b','',m.used === null ? '—' : compact(m.used)), el('span','unit',m.window ? `/ ${compact(m.window)} ${t.tokens}` : t.tokens)); overview.append(hero)
    let reserve = 0
    if (m.percent !== null && m.window && m.used !== null) {
      const bar = el('div','bar'); bar.setAttribute('role','meter'); bar.setAttribute('aria-label',t.contextUsed); bar.setAttribute('aria-valuemin','0'); bar.setAttribute('aria-valuemax',String(m.window)); bar.setAttribute('aria-valuenow',String(Math.min(m.used,m.window))); bar.setAttribute('aria-valuetext',`${count(m.used)} / ${count(m.window)} ${t.tokens}`)
      const fill = el('span','fill'); fill.style.width = `${Math.min(100,m.used/m.window*100)}%`; bar.append(fill)
      if (context?.kind === 'report' && m.breakdown?.at === m.contextAt && context.windowTokens === m.window) {
        const n = context.categories?.filter(a => !a.deferred && /^autocompact buffer$/i.test(a.name)).reduce((s,a)=>s+a.tokens,0) ?? 0
        if (n > 0 && n <= (m.free ?? 0)) { reserve = n; const r = el('span','reserve'); r.style.width = `${n/m.window*100}%`; bar.append(r) }
      }
      overview.append(bar)
    }
    const facts = el('div','facts'); if (m.used !== null) facts.append(el('span','',`${t.used} ${count(m.used)}`)); if (m.free !== null) facts.append(el('span','',`${c.free} ${count(m.free)}`)); overview.append(facts)
    overview.append(el('p','note',[m.used === null ? t.contextUnavailable : m.contextEstimated ? t.estimated : t.reported, !m.window ? t.windowUnknown : snapshot.windowTokens ? `${x.manual} ${count(m.window)}` : `${t.windowLimit} ${count(m.window)}`,reserve ? `${x.buffer} ${compact(reserve)}` : '', m.contextAt ? localTimestamp(m.contextAt,locale) : ''].filter(Boolean).join(' · ')))
    frag.append(overview)
    const cards = el('div'); cards.id = 'metrics'
    if (m.cache && sample) { const card = el('section','metric'); card.append(el('h2','',c.cache),el('b','reading',`${m.cache.percent.toFixed(1)}%`),el('p','note',`${compact(m.cache.read)} / ${compact(sample.inputTokens)} · ${c.last}`)); cards.append(card) }
    const rate = el('section',`metric${m.rate ? '' : ' unavailable'}`); rate.append(el('h2','',t.throughput),el('b','reading',m.rate ?? x.na))
    if (m.rate) rate.append(el('p','note',m.rateNote)); else { const why = el('details'); why.dataset.state = 'rate'; why.append(el('summary','',x.why),el('p','note',agy ? c.agyRate : t.timingUnavailable)); rate.append(why) }
    cards.append(rate)
    if (snapshot.turn) {
      const clock = el('section','metric'); clock.append(el('h2','',rateCopy[locale].elapsed),el('b','reading',`${(snapshot.turn.durationMs/1000).toFixed(2)} s`),el('p','note',`${rateCopy[locale].finished} · ${localTimestamp(snapshot.turn.completedAt,locale)}`)); cards.append(clock)
    }
    frag.append(cards)
    if (m.breakdown && context?.kind === 'report') {
      const section = el('section'); section.id = 'map-view'; frag.append(section)
      if (chat.agent === 'claude') {
        mountedMap = section
        renderMap(section, { ...m.breakdown, usedTokens: context.usedTokens, windowTokens: context.windowTokens }, locale, mode, next => { mode = next; paint() })
      }
      else { section.append(el('h2','',c.breakdown)); for (const row of m.breakdown.categories) section.append(el('p','note',`${row.name}${row.deferred ? ` · ${c.deferred}` : ''}: ${count(row.tokens)}`)) }
      section.append(el('p','note report-at',`${m.breakdown.at === m.contextAt ? t.reported : c.previous} · ${localTimestamp(m.breakdown.at,locale)}`))
    } else if (m.used !== null) {const note = el('aside','notice'); note.append(el('strong','',x.noMap),el('p','note',agy ? c.agy : c.missing)); frag.append(note)}
    const model = sample?.model ?? snapshot.messageUsage?.model ?? (context?.kind === 'report' ? context.model : null)
    if (sample || model || snapshot.messageUsage || snapshot.providerRate) {
      const d = el('details','details'); d.dataset.state = 'request'; const list = el('dl'); d.append(el('summary','',t.details),list)
      const pair = (label:string,value:string) => { const row = el('div','pair'); row.append(el('dt','',label),el('dd','',value)); list.append(row) }
      if (snapshot.messageUsage) { pair(t.output,count(snapshot.messageUsage.outputTokens)); pair(t.requestRecorded,localTimestamp(snapshot.messageUsage.completedAt,locale)) }
      if (snapshot.providerRate) { pair(t.output,count(snapshot.providerRate.outputTokens)); pair(rateCopy[locale][snapshot.providerRate.scope],`${(snapshot.providerRate.durationMs/1000).toFixed(2)} s`); pair(rateCopy[locale].finished,localTimestamp(snapshot.providerRate.completedAt,locale)) }
      if (model) pair(t.model,model); if (sample) { pair(t.input,count(sample.inputTokens)); pair(t.output,count(sample.outputTokens)); pair(t.duration,sample.durationMs === null ? '—' : `≈${(sample.durationMs/1000).toFixed(2)} s`); pair(t.requestRecorded,localTimestamp(sample.completedAt,locale)) }; frag.append(d)
    }
  }
  content.replaceChildren(frag)
  for (const d of Array.from(content.querySelectorAll('details'))) if (expanded.has(d.dataset.state || d.querySelector('summary')?.textContent)) d.open = true
  const target = focusedSummary ? Array.from(content.querySelectorAll('summary')).find(s => s.textContent === focusedSummary)
    : focusKey ? document.getElementById(focusKey) : null
  target?.focus({preventScroll:true})
}
function accept(next: Snapshot) {
  if (next.selected !== snapshot.selected) {
    mode = 'used'; failure(''); content.replaceChildren()
  }
  snapshot=next; paint()
}
paint()
const initialRevision=revision
try {
  const sub=window.orca.plugin.on('gauge.changed',next=>{revision++; accept(next)})
  window.addEventListener('pagehide',()=>{ sub.dispose(); if (mountedMap) disposeMap(mountedMap) },{once:true})
  void window.orca.plugin.request('gauge.get',undefined).then(next=>{if(revision===initialRevision) accept(next)}).catch(()=>{if(revision===initialRevision) accept({...snapshot,phase:'unavailable'})})
} catch {accept({...snapshot,phase:'unavailable'})}
