import { assert, test } from 'orca/testing'
import {
  analyzeBreakdown, colorFor, darkTextFor, layoutChart, legendModel, mapHeightFor,
  squarify, tileDetail, tileText, type ChartModel, type MapBreakdown
} from './html-map'

const real: MapBreakdown = {
  at: 1760000000000,
  windowTokens: 400_000,
  usedTokens: 272_132,
  categories: [
    { name: 'System prompt', tokens: 1_391 },
    { name: 'System tools', tokens: 6_529 },
    { name: 'MCP server instructions', tokens: 391 },
    { name: 'MCP tools (deferred)', tokens: 11_870, deferred: true },
    { name: 'System tools (deferred)', tokens: 5_560, deferred: true },
    { name: 'Memory files', tokens: 713 },
    { name: 'Skills', tokens: 4_515 },
    { name: 'Messages', tokens: 258_593 },
    { name: 'Autocompact buffer', tokens: 33_000 },
    { name: 'Free space', tokens: 94_868 }
  ]
}

function assertAreas(model: ChartModel): void {
  const area = model.width * model.height
  assert.ok(area > 0)
  for (const rect of model.rects) {
    const expected = rect.item.tokens / model.areaDenominator
    const actual = rect.width * rect.height / area
    assert.ok(Math.abs(actual - expected) < 1e-6, `${rect.item.kind}: ${actual} vs ${expected}`)
  }
}

test('reported categories split into occupied, free, reserve and deferred with stable indexes', () => {
  const summary = analyzeBreakdown(real)
  assert.deepEqual(summary.occupied.map(({ index, name }) => [index, name]), [
    [1, 'Messages'], [2, 'System tools'], [3, 'Skills'],
    [4, 'System prompt'], [5, 'Memory files'], [6, 'MCP server instructions']
  ])
  assert.equal(summary.occupiedTokens, 272_132)
  assert.equal(summary.freeTokens, 94_868)
  assert.equal(summary.reserveTokens, 33_000)
  assert.equal(summary.deferredTokens, 17_430)
  assert.equal(summary.deferred.length, 2)
  assert.equal(summary.windowState, 'complete')
  assert.ok(summary.windowAvailable)
})

test('used mode draws only occupied categories and keeps their areas proportional', () => {
  const model = layoutChart(analyzeBreakdown(real), 320, 'used')
  assert.equal(model.mode, 'used')
  assert.equal(model.total, 272_132)
  assert.equal(model.areaTotal, 272_132)
  assert.equal(model.areaDenominator, 272_132)
  assert.equal(model.merged.map(({ name }) => name).sort().join(','),
    ['MCP server instructions', 'Memory files', 'System prompt'].sort().join(','))
  assert.ok(model.rects.every(({ item }) => item.kind === 'category' || item.kind === 'merged'))
  assert.ok(model.rects.every(({ item }) => item.kind !== 'category' ||
    !/free space|autocompact buffer/i.test(item.category.name)))
  assert.ok(!model.rects.some(({ item }) => item.kind === 'category' && item.category.deferred))
  assertAreas(model)
})

test('window mode includes free and reserve and keeps the whole window as denominator', () => {
  const summary = analyzeBreakdown(real)
  const model = layoutChart(summary, 400, 'window')
  assert.equal(model.mode, 'window')
  assert.equal(model.total, 400_000)
  assert.equal(model.areaTotal, 400_000)
  assert.equal(model.areaDenominator, 400_000)
  const free = model.rects.filter(({ item }) => item.kind === 'free')
  const reserve = model.rects.filter(({ item }) => item.kind === 'reserve')
  assert.equal(free.length, 1)
  assert.equal(reserve.length, 1)
  assert.equal(free[0].item.tokens, 94_868)
  assert.equal(reserve[0].item.tokens, 33_000)
  assert.ok(!model.rects.some(({ item }) => item.kind === 'category' && item.category.deferred))
  assertAreas(model)
})

test('window mode is refused unless used total and window size both reconcile', () => {
  assert.equal(analyzeBreakdown({ ...real, windowTokens: null }).windowState, 'no-window')
  assert.equal(analyzeBreakdown({ ...real, usedTokens: 277_132 }).windowState, 'used-mismatch')
  assert.equal(analyzeBreakdown({ ...real, usedTokens: 273_132 }).windowState, 'complete')

  const noFree = {
    ...real,
    categories: real.categories.filter(({ name }) => !/^free space$/i.test(name))
  }
  assert.equal(analyzeBreakdown(noFree).windowState, 'window-mismatch')
  const overWindow = analyzeBreakdown({
    at: 1, windowTokens: 400_000, usedTokens: 400_001,
    categories: [{ name: 'Messages', tokens: 400_001 }]
  })
  assert.equal(overWindow.windowState, 'window-mismatch')
})

test('provider rounding is tolerated inside a small margin, not beyond it', () => {
  const within = analyzeBreakdown({
    ...real,
    categories: real.categories.map((row) => row.name === 'Free space' ? { ...row, tokens: row.tokens + 1_000 } : row)
  })
  assert.equal(within.windowState, 'complete')
  const beyond = analyzeBreakdown({
    ...real,
    categories: real.categories.map((row) => row.name === 'Free space' ? { ...row, tokens: row.tokens + 5_000 } : row)
  })
  assert.equal(beyond.windowState, 'window-mismatch')
})

test('a rounded-down report keeps the window as the geometry denominator', () => {
  const summary = analyzeBreakdown({
    ...real,
    categories: real.categories.map((row) => row.name === 'Free space' ? { ...row, tokens: row.tokens - 1_000 } : row)
  })
  assert.equal(summary.windowState, 'complete')
  const model = layoutChart(summary, 400, 'window')
  assert.equal(model.total, 400_000)
  assert.equal(model.areaTotal, 399_000)
  assert.equal(model.areaDenominator, 400_000)
  const area = model.width * model.height
  const covered = model.rects.reduce((total, rect) => total + rect.width * rect.height, 0)
  assert.ok(Math.abs(covered - area * 399_000 / 400_000) < 1e-6)
  for (const rect of model.rects) {
    assert.ok(Math.abs(rect.width * rect.height / area - rect.item.tokens / 400_000) < 1e-6)
  }
})

test('an unavailable window request falls back to used mode', () => {
  const summary = analyzeBreakdown({ ...real, windowTokens: null })
  const model = layoutChart(summary, 320, 'window')
  assert.equal(model.mode, 'used')
  assert.equal(model.total, 272_132)
  assert.ok(!model.rects.some(({ item }) => item.kind === 'free' || item.kind === 'reserve'))
  assert.equal(legendModel(summary, 'window').outside.length, 2)
})

test('squarify fills the box, preserves every weight and keeps tiny tiles positive', () => {
  const weighted = [{ tokens: 1, value: 'a' }, { tokens: 2, value: 'b' }, { tokens: 6, value: 'c' }]
  const rects = squarify(weighted, 100, 50)
  const weights: Record<string, number> = { a: 1, b: 2, c: 6 }
  assert.equal(rects.length, 3)
  assert.deepEqual(rects.map(({ value }) => value).sort(), ['a', 'b', 'c'])
  for (const rect of rects) {
    assert.ok(rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= 100 + 1e-9 && rect.y + rect.height <= 50 + 1e-9)
    assert.ok(Math.abs(rect.width * rect.height - weights[rect.value] / 9 * 5000) < 1e-6)
  }
  const tiny = squarify([
    { tokens: Number.MAX_SAFE_INTEGER, value: 'huge' },
    { tokens: 1, value: 'one' }, { tokens: 1, value: 'two' }
  ], 100, 50)
  assert.equal(tiny.length, 3)
  assert.ok(tiny.every(({ width, height }) => width > 0 && height > 0))

  const partial = squarify([{ tokens: 1, value: 'a' }, { tokens: 1, value: 'b' }], 100, 50, 4)
  const covered = partial.reduce((total, rect) => total + rect.width * rect.height, 0)
  assert.ok(Math.abs(covered - 2500) < 1e-6)

  assert.deepEqual(squarify([], 100, 50), [])
  assert.deepEqual(squarify([{ tokens: 0, value: 'x' }], 100, 50), [])
  assert.deepEqual(squarify([{ tokens: 1, value: 'x' }], 0, 50), [])
})

test('tile labels fit the rendered box and never put an oversized name in it', () => {
  const messages = layoutChart(analyzeBreakdown(real), 400, 'used').rects
    .map(({ item }) => item)
    .find((item) => item.kind === 'category' && item.category.name === 'Messages')
  assert.ok(messages && messages.kind === 'category')
  const big = tileText(messages, 200, 100, 'en')
  assert.equal(big.primary, '1 · Messages')
  assert.equal(big.secondary, '258.6k')

  const narrow = tileText(messages, 40, 24, 'en')
  assert.equal(narrow.primary, '1')
  assert.equal(narrow.secondary, null)

  const ghost = tileText(messages, 10, 10, 'en')
  assert.equal(ghost.primary, null)
  assert.equal(ghost.secondary, null)

  const noRoomForName = tileText({ kind: 'category', category: { index: 6, name: 'MCP server instructions', tokens: 391 }, tokens: 391 }, 80, 40, 'en')
  assert.equal(noRoomForName.primary, null)
  assert.equal(noRoomForName.secondary, '391')

  const merged = tileText({ kind: 'merged', categories: [], tokens: 2_495 }, 200, 100, 'en')
  assert.equal(merged.primary, 'Other 0 items')
  assert.equal(merged.secondary, '2.5k')
  assert.equal(tileText({ kind: 'merged', categories: [], tokens: 2_495 }, 40, 24, 'en').primary, '…')
})

test('tooltip and accessible name list merged members and use the chart denominator', () => {
  const summary = analyzeBreakdown(real)
  const model = layoutChart(summary, 320, 'used')
  const merged = model.rects.map(({ item }) => item).find((item) => item.kind === 'merged')
  assert.ok(merged && merged.kind === 'merged')
  const detail = tileDetail(merged, model.total, 'zh-CN')
  assert.ok(detail.lines[0].includes('其他 3 项'))
  assert.ok(detail.lines[1].includes('2,495'))
  assert.equal(detail.lines.length, 5)
  assert.ok(detail.lines.some((line) => line.includes('4 · System prompt')))
  assert.ok(detail.aria.includes('，'))

  const category = model.rects.map(({ item }) => item).find((item) =>
    item.kind === 'category' && item.category.name === 'Messages')
  assert.ok(category && category.kind === 'category')
  const categoryDetail = tileDetail(category, model.total, 'en')
  assert.ok(categoryDetail.aria.includes('1 · Messages'))
  assert.ok(categoryDetail.aria.includes('95.0%'))

  const window = layoutChart(summary, 400, 'window')
  const free = window.rects.map(({ item }) => item).find((item) => item.kind === 'free')
  assert.ok(free && free.kind === 'free')
  assert.ok(tileDetail(free, window.total, 'en').aria.includes('23.7%'))
})

test('legend lists every occupied category, separates outside rows and omits deferred percentages', () => {
  const summary = analyzeBreakdown(real)
  const used = legendModel(summary, 'used')
  assert.equal(used.occupied.length, 6)
  assert.equal(used.outside.length, 2)
  assert.equal(used.deferred.length, 2)
  assert.ok(Math.abs((used.occupied[0].percent ?? 0) - 258_593 / 272_132 * 100) < 1e-9)
  assert.ok(Math.abs((used.outside[0].percent ?? 0) - 94_868 / 400_000 * 100) < 1e-9)
  assert.ok(used.deferred.every(({ percent }) => percent === null))
  assert.ok(Math.abs((used.unusedPercent ?? 0) - 127_868 / 400_000 * 100) < 1e-9)

  const window = legendModel(summary, 'window')
  assert.ok(Math.abs((window.occupied[0].percent ?? 0) - 258_593 / 400_000 * 100) < 1e-9)
})

test('color slots follow category names, not rank, and unknown names stay neutral', () => {
  assert.equal(colorFor('Messages'), 'var(--cg-c1)')
  assert.equal(colorFor('system tools'), 'var(--cg-c2)')
  assert.equal(colorFor('System prompt'), 'var(--cg-c4)')
  assert.equal(colorFor('Not a known category'), 'var(--cg-cx)')
  assert.equal(darkTextFor('System prompt'), true)
  assert.equal(darkTextFor('Messages'), false)
})

test('chart height and empty reports stay bounded', () => {
  assert.equal(mapHeightFor(0), 0)
  assert.equal(mapHeightFor(320), 198)
  assert.equal(mapHeightFor(1_000), 210)
  const empty = analyzeBreakdown({ at: 1, windowTokens: null, usedTokens: 0, categories: [] })
  assert.equal(empty.occupied.length, 0)
  assert.equal(empty.windowState, 'no-window')
  const model = layoutChart(empty, 300, 'used')
  assert.equal(model.empty, true)
  assert.deepEqual(model.rects, [])
})
