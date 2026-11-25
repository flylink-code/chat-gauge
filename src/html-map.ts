import { compact, count } from './format'
import type { Locale } from './i18n'
import type { ContextCategory } from './protocol'
import { occupiedCategories, type OccupiedCategory } from './treemap'

export type MapMode = 'used' | 'window'

export type MapBreakdown = {
  categories: ContextCategory[]
  at: number
  windowTokens: number | null
  usedTokens: number
}

export type WindowState = 'complete' | 'no-window' | 'used-mismatch' | 'window-mismatch'

export type ReportSummary = {
  occupied: OccupiedCategory[]
  deferred: ContextCategory[]
  free: ContextCategory[]
  reserve: ContextCategory[]
  occupiedTokens: number
  freeTokens: number
  reserveTokens: number
  deferredTokens: number
  usedTokens: number
  windowTokens: number | null
  windowState: WindowState
  windowAvailable: boolean
}

export type ChartItem =
  | { kind: 'category'; category: OccupiedCategory; tokens: number }
  | { kind: 'merged'; categories: OccupiedCategory[]; tokens: number }
  | { kind: 'free'; tokens: number }
  | { kind: 'reserve'; tokens: number }

export type ChartRect = { item: ChartItem; x: number; y: number; width: number; height: number }

export type ChartModel = {
  width: number
  height: number
  /** The mode actually drawn: a window request falls back to used when the report is incomplete. */
  mode: MapMode
  /** The percentage denominator: occupied tokens, or the whole window in window mode. */
  total: number
  /** The sum of the weighted items; it can differ from `total` by provider rounding. */
  areaTotal: number
  /** The geometry denominator. It is `total` unless rounding made the lines exceed it. */
  areaDenominator: number
  rects: ChartRect[]
  merged: OccupiedCategory[]
  empty: boolean
  windowAvailable: boolean
}

export type Weighted<T> = { tokens: number; value: T }
export type WeightedRect<T> = { x: number; y: number; width: number; height: number; value: T }

export type TileText = { primary: string | null; secondary: string | null }

export type TileDetail = { label: string; lines: string[]; aria: string }

export type LegendEntry = {
  kind: 'category' | 'free' | 'reserve' | 'deferred'
  name: string
  index?: number
  tokens: number
  percent: number | null
  color: string | null
}

export type LegendModel = {
  occupied: LegendEntry[]
  outside: LegendEntry[]
  deferred: LegendEntry[]
  unusedPercent: number | null
}

export const MIN_TILE_AREA = 900

const freeSpace = /^free space$/i
const autocompact = /^autocompact buffer$/i
const sum = (rows: readonly { tokens: number }[]): number => rows.reduce((total, row) => total + row.tokens, 0)

/**
 * How far the category lines may differ from the reported totals before the
 * whole-window view is refused. Providers may round both individual lines and
 * their sums, so exact equality would hide a report that is otherwise coherent.
 */
export function roundingTolerance(windowTokens: number, contributingLines: number): number {
  const window = Number.isFinite(windowTokens) && windowTokens > 0 ? windowTokens : 0
  return Math.max(64, Math.ceil(window * 0.005), Math.max(0, Math.floor(contributingLines)) * 8)
}

/**
 * Split reported categories into the parts the chart may draw. Free space and
 * the compaction buffer leave the occupied area; deferred rows never consume
 * the current window. The whole-window view is available only when the reported
 * lines reconcile with both the used total and the window size.
 */
export function analyzeBreakdown({ categories, usedTokens, windowTokens }: MapBreakdown): ReportSummary {
  const rows = (Array.isArray(categories) ? categories : []).filter(
    (row): row is ContextCategory & { tokens: number } =>
      !!row && typeof row.name === 'string' && Number.isFinite(row.tokens) && row.tokens > 0
  )
  const free = rows.filter((row) => row.deferred !== true && freeSpace.test(row.name.trim()))
  const reserve = rows.filter((row) => row.deferred !== true && autocompact.test(row.name.trim()))
  const occupiedRows = rows.filter((row) =>
    row.deferred !== true && !freeSpace.test(row.name.trim()) && !autocompact.test(row.name.trim())
  )
  const occupied = occupiedCategories(occupiedRows)
  const deferred = rows.filter((row) => row.deferred === true)
  const occupiedTokens = sum(occupied)
  const freeTokens = sum(free)
  const reserveTokens = sum(reserve)
  const window = typeof windowTokens === 'number' && Number.isFinite(windowTokens) && windowTokens > 0 ? windowTokens : null
  const used = typeof usedTokens === 'number' && Number.isFinite(usedTokens) && usedTokens >= 0 ? usedTokens : 0
  let windowState: WindowState
  if (window === null) windowState = 'no-window'
  else {
    const tolerance = roundingTolerance(window, occupied.length + free.length + reserve.length)
    const usedMatches = Math.abs(occupiedTokens - used) <= tolerance
    const lines = occupiedTokens + freeTokens + reserveTokens
    const windowMatches = used <= window && Math.abs(lines - window) <= tolerance
    windowState = !usedMatches ? 'used-mismatch' : !windowMatches ? 'window-mismatch' : 'complete'
  }
  return {
    occupied, deferred, free, reserve, occupiedTokens, freeTokens, reserveTokens,
    deferredTokens: sum(deferred), usedTokens: used, windowTokens: window,
    windowState, windowAvailable: windowState === 'complete'
  }
}

export function mapHeightFor(width: number): number {
  const safe = Number.isFinite(width) && width > 0 ? width : 0
  return safe ? Math.round(Math.min(210, Math.max(128, safe * 0.62))) : 0
}

/**
 * Squarified treemap over the positive weights. Weights are sorted descending
 * here so a caller cannot accidentally produce thin, unreadable slivers. A
 * denominator larger than the weights leaves the rounding residual blank, which
 * keeps the whole-window view honest when providers round their lines.
 */
export function squarify<T>(
  items: readonly Weighted<T>[], width: number, height: number, denominator?: number
): WeightedRect<T>[] {
  const rows = items
    .filter((item) => Number.isFinite(item.tokens) && item.tokens > 0)
    .slice()
    .sort((left, right) => right.tokens - left.tokens)
  const total = rows.reduce((n, item) => n + item.tokens, 0)
  const area = width * height
  const scaleTotal = Math.max(total, denominator !== undefined && Number.isFinite(denominator) ? denominator : total)
  if (!(total > 0) || !Number.isFinite(total) || !(width > 0) || !(height > 0) || !Number.isFinite(area)) return []
  const scale = area / scaleTotal
  const out: WeightedRect<T>[] = []
  let rest = rows
  let x = 0
  let y = 0
  let w = width
  let h = height
  const worst = (row: readonly Weighted<T>[], side: number): number => {
    let rowArea = 0
    let largest = -Infinity
    let smallest = Infinity
    for (const item of row) {
      const value = item.tokens * scale
      rowArea += value
      if (value > largest) largest = value
      if (value < smallest) smallest = value
    }
    if (!(rowArea > 0) || !Number.isFinite(rowArea) || !(side > 0)) return Infinity
    return Math.max(
      (side * side * largest) / (rowArea * rowArea),
      (rowArea * rowArea) / (side * side * smallest)
    )
  }
  while (rest.length) {
    const side = Math.min(w, h)
    if (!(side > 0)) break
    let cut = 1
    let score = worst(rest.slice(0, 1), side)
    while (cut < rest.length) {
      const next = worst(rest.slice(0, cut + 1), side)
      if (!(next <= score)) break
      score = next
      cut += 1
    }
    const row = rest.slice(0, cut)
    rest = rest.slice(cut)
    const rowTokens = row.reduce((n, item) => n + item.tokens, 0)
    if (w >= h) {
      const column = Math.min(w, (rowTokens * scale) / h)
      if (!(column > 0) || !Number.isFinite(column)) break
      let cursor = y
      for (let index = 0; index < row.length; index += 1) {
        const item = row[index]
        const available = Math.max(0, y + h - cursor)
        const heightHere = index === row.length - 1
          ? available
          : Math.min(available, (item.tokens * scale) / column)
        out.push({ x, y: cursor, width: column, height: heightHere, value: item.value })
        cursor += heightHere
      }
      x += column
      w -= column
    } else {
      const rowHeight = Math.min(h, (rowTokens * scale) / w)
      if (!(rowHeight > 0) || !Number.isFinite(rowHeight)) break
      let cursor = x
      for (let index = 0; index < row.length; index += 1) {
        const item = row[index]
        const available = Math.max(0, x + w - cursor)
        const widthHere = index === row.length - 1
          ? available
          : Math.min(available, (item.tokens * scale) / rowHeight)
        out.push({ x: cursor, y, width: widthHere, height: rowHeight, value: item.value })
        cursor += widthHere
      }
      y += rowHeight
      h -= rowHeight
    }
  }
  return out
}

/**
 * Used mode draws only occupied categories. Window mode adds the reported free
 * space and compaction reserve, with the whole window as the denominator; it is
 * never used for an incoherent report.
 */
export function layoutChart(summary: ReportSummary, width: number, requested: MapMode): ChartModel {
  const windowMode = requested === 'window' && summary.windowAvailable
  const mode: MapMode = windowMode ? 'window' : 'used'
  const w = Number.isFinite(width) && width > 0 ? Math.floor(width) : 0
  const height = mapHeightFor(w)
  const total = windowMode ? summary.windowTokens ?? 0 : summary.occupiedTokens
  if (!w || !height || !(total > 0)) {
    return { width: w, height, mode, total, areaTotal: 0, areaDenominator: total, rects: [], merged: [], empty: true, windowAvailable: summary.windowAvailable }
  }
  const weighted: Weighted<ChartItem>[] = []
  const small: OccupiedCategory[] = []
  for (const category of summary.occupied) {
    if ((category.tokens / total) * w * height < MIN_TILE_AREA) small.push(category)
    else weighted.push({ tokens: category.tokens, value: { kind: 'category', category, tokens: category.tokens } })
  }
  let merged: OccupiedCategory[] = []
  if (small.length >= 2) {
    merged = small
    weighted.push({
      tokens: sum(small),
      value: { kind: 'merged', categories: small, tokens: sum(small) }
    })
  } else {
    for (const category of small) weighted.push({ tokens: category.tokens, value: { kind: 'category', category, tokens: category.tokens } })
  }
  if (windowMode) {
    if (summary.freeTokens > 0) weighted.push({ tokens: summary.freeTokens, value: { kind: 'free', tokens: summary.freeTokens } })
    if (summary.reserveTokens > 0) weighted.push({ tokens: summary.reserveTokens, value: { kind: 'reserve', tokens: summary.reserveTokens } })
  }
  const areaTotal = sum(weighted)
  const areaDenominator = Math.max(total, areaTotal)
  const rects: ChartRect[] = areaTotal > 0
    ? squarify(weighted, w, height, areaDenominator).map(({ value, x, y, width, height: tileHeight }) => ({ item: value, x, y, width, height: tileHeight }))
    : []
  return { width: w, height, mode, total, areaTotal, areaDenominator, rects, merged, empty: rects.length === 0, windowAvailable: summary.windowAvailable }
}

const slots: ReadonlyMap<string, number> = new Map([
  ['messages', 1], ['system tools', 2], ['skills', 3], ['system prompt', 4],
  ['mcp server instructions', 5], ['mcp tools', 6], ['memory files', 7]
])

/** A category keeps its color for the life of the name; unknown names stay neutral. */
export function colorFor(name: string): string {
  const slot = slots.get(name.trim().toLowerCase())
  return slot === undefined ? 'var(--cg-cx)' : `var(--cg-c${slot})`
}

export function darkTextFor(name: string): boolean {
  return slots.get(name.trim().toLowerCase()) === 4
}

export function legendModel(summary: ReportSummary, requested: MapMode): LegendModel {
  const mode: MapMode = requested === 'window' && summary.windowAvailable ? 'window' : 'used'
  const base = mode === 'window' ? summary.windowTokens : summary.occupiedTokens
  const percent = (tokens: number, denominator: number | null): number | null =>
    denominator !== null && denominator > 0 ? tokens / denominator * 100 : null
  const windowBase = summary.windowTokens
  return {
    occupied: summary.occupied.map((category) => ({
      kind: 'category', name: category.name, index: category.index, tokens: category.tokens,
      percent: percent(category.tokens, base), color: colorFor(category.name)
    })),
    outside: [
      ...(summary.freeTokens > 0 ? [{ kind: 'free' as const, name: '', tokens: summary.freeTokens, percent: percent(summary.freeTokens, windowBase), color: null }] : []),
      ...(summary.reserveTokens > 0 ? [{ kind: 'reserve' as const, name: '', tokens: summary.reserveTokens, percent: percent(summary.reserveTokens, windowBase), color: null }] : [])
    ],
    deferred: summary.deferred.map((category) => ({
      kind: 'deferred', name: category.name, tokens: category.tokens, percent: null, color: null
    })),
    unusedPercent: windowBase !== null && windowBase > 0 ? (summary.freeTokens + summary.reserveTokens) / windowBase * 100 : null
  }
}

type Copy = {
  title: string
  range: string
  used: string
  window: string
  area: string
  empty: string
  other: (count: number) => string
  merged: (items: string, count: number) => string
  free: string
  reserve: string
  outside: string
  deferredGroup: string
  deferred: string
  unused: (percent: number | null) => string
  windowUnavailable: string
  windowNoWindow: string
  usedMismatch: string
  windowMismatch: string
  legend: string
  tokens: string
  ariaSeparator: string
}

const en: Copy = {
  title: 'Context breakdown', range: 'Range', used: 'Used', window: 'Whole window',
  area: 'Area by token count', empty: 'No occupied categories to chart.',
  other: (n) => `Other ${n} items`,
  merged: (items, n) => `Items ${items} are too small and merged into “Other ${n}”`,
  free: 'Remaining', reserve: 'Compress reserve',
  outside: 'Remaining, reserve and loaded on demand',
  deferredGroup: 'Loaded on demand · not in the current window', deferred: 'deferred',
  unused: (percent) => percent === null ? 'Unused space' : `Unused space · ${percent}% of window`,
  windowUnavailable: 'Whole-window view is unavailable.',
  windowNoWindow: 'This chat does not report a window size.',
  usedMismatch: 'The reported categories do not add up to the used total.',
  windowMismatch: 'The reported categories do not cover the whole window.',
  legend: 'Category details', tokens: 'tokens', ariaSeparator: ', '
}

const zhCN: Copy = {
  title: '上下文构成', range: '范围', used: '已占用', window: '整个窗口',
  area: '面积按 token 数分配', empty: '暂无可绘制的已占用分类。',
  other: (n) => `其他 ${n} 项`,
  merged: (items, n) => `第 ${items} 项太小，图中合并为「其他 ${n} 项」`,
  free: '剩余空间', reserve: '压缩预留',
  outside: '剩余、压缩预留与按需加载',
  deferredGroup: '按需加载 · 不占当前窗口', deferred: '按需加载',
  unused: (percent) => percent === null ? '未用空间' : `未用空间 · 占窗口 ${percent}%`,
  windowUnavailable: '整个窗口视图暂不可用。',
  windowNoWindow: '此对话未报告窗口大小。',
  usedMismatch: '分类合计与已用总量不一致。',
  windowMismatch: '分类合计未覆盖整个窗口。',
  legend: '分类明细', tokens: 'token', ariaSeparator: '，'
}

const zhTW: Copy = {
  title: '上下文構成', range: '範圍', used: '已占用', window: '整個視窗',
  area: '面積按 token 數分配', empty: '暫無可繪製的已占用分類。',
  other: (n) => `其他 ${n} 項`,
  merged: (items, n) => `第 ${items} 項太小，圖中合併為「其他 ${n} 項」`,
  free: '剩餘空間', reserve: '壓縮預留',
  outside: '剩餘、壓縮預留與按需載入',
  deferredGroup: '按需載入 · 不占目前視窗', deferred: '按需載入',
  unused: (percent) => percent === null ? '未用空間' : `未用空間 · 占視窗 ${percent}%`,
  windowUnavailable: '整個視窗檢視暫不可用。',
  windowNoWindow: '此對話未回報視窗大小。',
  usedMismatch: '分類合計與已用總量不一致。',
  windowMismatch: '分類合計未覆蓋整個視窗。',
  legend: '分類明細', tokens: 'token', ariaSeparator: '，'
}

const copies: Record<Locale, Copy> = { en, 'zh-CN': zhCN, 'zh-TW': zhTW }
const copyFor = (locale: Locale): Copy => copies[locale] ?? en

function itemLabel(item: ChartItem, copy: Copy): string {
  if (item.kind === 'category') return `${item.category.index} · ${item.category.name}`
  if (item.kind === 'merged') return copy.other(item.categories.length)
  return item.kind === 'free' ? copy.free : copy.reserve
}

function estimatedTextWidth(text: string, size: number): number {
  let units = 0
  for (const character of text) {
    const point = character.codePointAt(0) ?? 0
    units += point >= 0x2e80 ? 1 : 0.62
  }
  return units * size
}

function fits(text: string, width: number, size: number, padding = 12): boolean {
  return text.length > 0 && estimatedTextWidth(text, size) <= Math.max(0, width - padding)
}

/** Two-line label when it fits; a category index or an ellipsis in tighter tiles. */
export function tileText(item: ChartItem, width: number, height: number, locale: Locale): TileText {
  if (!(width > 0) || !(height > 0)) return { primary: null, secondary: null }
  const copy = copyFor(locale)
  if (width >= 76 && height >= 36) {
    const label = itemLabel(item, copy)
    let primary: string | null = null
    if (fits(label, width, 12)) primary = label
    else if (item.kind === 'category' && fits(item.category.name, width, 12)) primary = item.category.name
    const amount = compact(item.tokens)
    return { primary, secondary: fits(amount, width, 11) ? amount : null }
  }
  if (width >= 30 && height >= 22) {
    if (item.kind === 'category') {
      const index = String(item.category.index)
      return { primary: fits(index, width, 12) ? index : null, secondary: null }
    }
    if (item.kind === 'merged') return { primary: fits('…', width, 12) ? '…' : null, secondary: null }
  }
  return { primary: null, secondary: null }
}

/** Exact values for the hover/focus tooltip and the tile's accessible name. */
export function tileDetail(item: ChartItem, total: number, locale: Locale): TileDetail {
  const copy = copyFor(locale)
  const share = total > 0 ? `${(item.tokens / total * 100).toFixed(1)}%` : null
  const amount = `${count(item.tokens)} ${copy.tokens}${share ? ` · ${share}` : ''}`
  if (item.kind === 'merged') {
    const label = copy.other(item.categories.length)
    const members = item.categories.map((category) => `${category.index} · ${category.name} ${count(category.tokens)}`)
    return { label, lines: [label, amount, ...members], aria: [label, amount, ...members].join(copy.ariaSeparator) }
  }
  const label = itemLabel(item, copy)
  return { label, lines: [label, amount], aria: `${label}${copy.ariaSeparator}${amount}` }
}

function windowReason(state: WindowState, copy: Copy): string {
  if (state === 'no-window') return copy.windowNoWindow
  if (state === 'used-mismatch') return copy.usedMismatch
  if (state === 'window-mismatch') return copy.windowMismatch
  return ''
}

function listOf(values: readonly number[], locale: Locale): string {
  return values.join(locale === 'en' ? ', ' : '、')
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

const GAP = 2
const requestFrame = (callback: () => void): number =>
  typeof requestAnimationFrame === 'function' ? requestAnimationFrame(callback) : setTimeout(callback, 16) as unknown as number
const cancelFrame = (id: number): void => {
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id)
  else clearTimeout(id)
}

type MapState = {
  container: HTMLElement
  observer: ResizeObserver | null
  frame: number
  resizeListener: (() => void) | null
  fresh: boolean
  disposed: boolean
}

const live = new Set<MapState>()
const byContainer = new WeakMap<HTMLElement, MapState>()
let instances = 0
let pruneQueued = false

function disposeState(state: MapState): void {
  if (state.disposed) return
  state.disposed = true
  if (state.frame) { cancelFrame(state.frame); state.frame = 0 }
  state.observer?.disconnect()
  state.observer = null
  if (state.resizeListener) {
    window.removeEventListener('resize', state.resizeListener)
    state.resizeListener = null
  }
  if (byContainer.get(state.container) === state) byContainer.delete(state.container)
  live.delete(state)
  state.container.replaceChildren()
}

/** Prune state left behind by a container the caller recreated on a later snapshot. */
function pruneStates(): void {
  for (const state of Array.from(live)) {
    if (state.fresh) { state.fresh = false; continue }
    if (!state.disposed && !state.container.isConnected) disposeState(state)
  }
}

function schedulePrune(): void {
  if (pruneQueued) return
  pruneQueued = true
  const run = (): void => { pruneQueued = false; pruneStates() }
  if (typeof queueMicrotask === 'function') queueMicrotask(run)
  else void Promise.resolve().then(run)
}

/** Stop a map drawn by renderMap, for callers that unmount before the next snapshot. */
export function disposeMap(container: HTMLElement): void {
  const state = byContainer.get(container)
  if (state) disposeState(state)
}

/**
 * Draw the context treemap into `container`. The container is owned by this
 * function and is replaced on each call; ResizeObserver state for a recreated
 * container is pruned as soon as the old node leaves the document. All text is
 * written with textContent, so category names are never interpreted as HTML.
 */
export function renderMap(
  container: HTMLElement,
  breakdown: MapBreakdown,
  locale: Locale,
  mode: MapMode,
  onMode: (mode: MapMode) => void
): void {
  if (typeof document === 'undefined' || !container) return
  pruneStates()
  disposeMap(container)
  const copy = copyFor(locale)
  const summary = analyzeBreakdown(breakdown)
  const effective: MapMode = mode === 'window' && summary.windowAvailable ? 'window' : 'used'
  const active = effective

  const root = element('section', 'chat-gauge-map')
  root.setAttribute('aria-label', copy.title)

  const head = element('div', 'cg-head')
  const title = element('h2', 'cg-title', copy.title)
  const range = element('span', 'cg-seg')
  range.setAttribute('role', 'group')
  range.setAttribute('aria-label', copy.range)
  const usedButton = element('button', 'cg-mode', copy.used)
  usedButton.type = 'button'
  usedButton.id = 'cg-mode-used'
  usedButton.setAttribute('aria-pressed', String(active === 'used'))
  usedButton.addEventListener('click', () => { if (mode !== 'used') onMode('used') })
  const windowButton = element('button', 'cg-mode', copy.window)
  windowButton.type = 'button'
  windowButton.id = 'cg-mode-window'
  windowButton.setAttribute('aria-pressed', String(active === 'window'))
  if (!summary.windowAvailable) {
    const reasonId = `cg-window-reason-${++instances}`
    const reason = element('span', 'cg-sr', windowReason(summary.windowState, copy))
    reason.id = reasonId
    windowButton.setAttribute('aria-disabled', 'true')
    windowButton.setAttribute('aria-describedby', reasonId)
    windowButton.title = windowReason(summary.windowState, copy)
    root.append(reason)
  }
  windowButton.addEventListener('click', () => {
    if (summary.windowAvailable && mode !== 'window') onMode('window')
  })
  range.append(usedButton, windowButton)
  head.append(title, range)
  root.append(head)

  if (mode === 'window' && !summary.windowAvailable) {
    root.append(element('p', 'cg-note', `${copy.windowUnavailable} ${windowReason(summary.windowState, copy)}`))
  }

  const plot = element('div', 'cg-plot')
  plot.setAttribute('role', 'group')
  plot.setAttribute('aria-label', copy.title)
  const note = element('p', 'cg-note')
  const tip = element('div', 'cg-tip')
  tip.hidden = true
  tip.setAttribute('role', 'tooltip')
  root.append(plot, note)

  const legend = legendModel(summary, active)
  const rows = (entries: readonly LegendEntry[], twoColumns: boolean, label: string): HTMLElement => {
    const list = element('ul', twoColumns ? 'cg-legend cg-legend--two' : 'cg-legend')
    list.setAttribute('aria-label', label)
    for (const entry of entries) {
      const row = element('li', '')
      const swatch = element('span', 'cg-sw')
      if (entry.kind === 'deferred') swatch.classList.add('cg-hatch')
      else if (entry.kind === 'free' || entry.kind === 'reserve') swatch.style.backgroundColor = 'var(--cg-free)'
      else if (entry.color) swatch.style.backgroundColor = entry.color
      const entryLabel = entry.kind === 'category'
        ? `${entry.index} · ${entry.name}`
        : entry.kind === 'free' ? copy.free
          : entry.kind === 'reserve' ? copy.reserve
            : /deferred|按需|載入|加载/i.test(entry.name) ? entry.name : `${entry.name} · ${copy.deferred}`
      const name = element('span', 'cg-nm', entryLabel)
      const number = element('span', 'cg-num', count(entry.tokens))
      row.append(swatch, name, number)
      if (!twoColumns) row.append(element('span', 'cg-pc', entry.percent === null ? '' : `${entry.percent.toFixed(1)}%`))
      list.append(row)
    }
    return list
  }
  if (legend.occupied.length) root.append(rows(legend.occupied, false, copy.legend))
  if (legend.outside.length || legend.deferred.length) {
    const details = element('details', 'cg-details')
    details.append(element('summary', '', copy.outside))
    if (legend.outside.length) {
      details.append(element('div', 'cg-group', copy.unused(legend.unusedPercent === null ? null : Math.round(legend.unusedPercent))))
      details.append(rows(legend.outside, false, `${copy.free} / ${copy.reserve}`))
    }
    if (legend.deferred.length) {
      details.append(element('div', 'cg-group', copy.deferredGroup))
      details.append(rows(legend.deferred, true, copy.deferredGroup))
    }
    root.append(details)
  }
  root.append(tip)

  const state: MapState = { container, observer: null, frame: 0, resizeListener: null, fresh: true, disposed: false }
  byContainer.set(container, state)
  live.add(state)
  container.replaceChildren(root)

  let lastWidth = -1
  let retries = 2
  const draw = (): void => {
    if (state.disposed) return
    const width = Math.round(plot.clientWidth)
    if (!(width > 0)) {
      if (retries-- > 0) schedule()
      return
    }
    retries = 2
    if (width === lastWidth) return
    lastWidth = width
    const model = layoutChart(summary, width, active)
    plot.style.height = `${model.height}px`
    const focused = plot.contains(document.activeElement)
      ? (document.activeElement as HTMLElement).dataset.cgKey ?? null
      : null
    const fragment = document.createDocumentFragment()
    if (model.empty) fragment.append(element('div', 'cg-empty', copy.empty))
    else for (const rect of model.rects) fragment.append(tile(rect, model))
    tip.hidden = true
    plot.replaceChildren(fragment)
    note.textContent = model.merged.length
      ? `${copy.area} · ${copy.merged(listOf(model.merged.map((category) => category.index), locale), model.merged.length)}`
      : copy.area
    if (focused) {
      const next = plot.querySelector<HTMLElement>(`[data-cg-key="${focused}"]`)
      next?.focus({ preventScroll: true })
    }

    function tile(rect: ChartRect, chart: ChartModel): HTMLElement {
      const item = rect.item
      const node = element('div', 'cg-tile')
      const key = item.kind === 'category' ? `category-${item.category.index}` : item.kind
      node.dataset.cgKey = key
      node.setAttribute('role', 'img')
      const detail = tileDetail(item, chart.total, locale)
      node.setAttribute('aria-label', detail.aria)
      if (item.kind === 'free' || item.kind === 'reserve') node.classList.add('cg-hatch')
      else if (item.kind === 'category') {
        node.style.backgroundColor = colorFor(item.category.name)
        if (darkTextFor(item.category.name)) node.classList.add('cg-dark-text')
      } else node.style.backgroundColor = 'var(--cg-cx)'
      node.style.left = `${rect.x + GAP / 2}px`
      node.style.top = `${rect.y + GAP / 2}px`
      node.style.width = `${Math.max(1, rect.width - GAP)}px`
      node.style.height = `${Math.max(1, rect.height - GAP)}px`
      const text = tileText(item, Math.max(0, rect.width - GAP), Math.max(0, rect.height - GAP), locale)
      if (text.primary) node.append(element('span', 'cg-name', text.primary))
      if (text.secondary) node.append(element('span', 'cg-amount', text.secondary))
      if (!text.primary && !text.secondary) node.classList.add('cg-bare')
      if (rect.width >= 8 && rect.height >= 8) node.tabIndex = 0
      const showAt = (left: number, top: number): void => {
        tip.textContent = detail.lines.join('\n')
        tip.hidden = false
        const viewportWidth = typeof window === 'undefined' ? 0 : window.innerWidth || 0
        const viewportHeight = typeof window === 'undefined' ? 0 : window.innerHeight || 0
        const tipWidth = tip.offsetWidth || 240
        const tipHeight = tip.offsetHeight || 60
        tip.style.left = `${Math.max(8, Math.min(viewportWidth - tipWidth - 8, left))}px`
        tip.style.top = `${Math.max(8, Math.min(viewportHeight - tipHeight - 8, top))}px`
      }
      const hide = (): void => { tip.hidden = true }
      node.addEventListener('pointerenter', (event) => showAt(event.clientX + 10, event.clientY + 12))
      node.addEventListener('pointermove', (event) => showAt(event.clientX + 10, event.clientY + 12))
      node.addEventListener('pointerleave', hide)
      node.addEventListener('focus', () => {
        const box = node.getBoundingClientRect()
        showAt(box.left, box.bottom + 4)
      })
      node.addEventListener('blur', hide)
      node.addEventListener('keydown', (event) => { if (event.key === 'Escape') hide() })
      return node
    }
  }

  function schedule(): void {
    if (state.disposed || state.frame) return
    state.frame = requestFrame(() => { state.frame = 0; draw() })
  }

  schedule()
  if (typeof ResizeObserver === 'function') {
    state.observer = new ResizeObserver(schedule)
    state.observer.observe(plot)
  } else {
    state.resizeListener = schedule
    window.addEventListener('resize', schedule)
  }
  schedulePrune()
}
