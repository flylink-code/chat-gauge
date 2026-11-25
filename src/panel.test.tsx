import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'
import { detailed, ready } from './panel.check.ts'
import { emptySnapshot } from './protocol'

test('shows data received from the worker, then removes stale values', async () => {
  const host = mockHost({ requests: { 'gauge.get': () => ready } })
  const view = await mount(panel, { host })
  try {
    assert.ok(view.find({ text: '≈13.9 tok/s' }))
    assert.ok(view.find({ text: '93,911 tokens' }))
    assert.ok(view.find({ text: '94% · Near limit' }))
    await view.post('gauge.changed', { ...ready, locale: 'zh-CN' })
    assert.ok(view.find({ text: '上下文窗口' }))
    assert.ok(view.find({ text: '平均吞吐' }))
    assert.ok(view.find({ text: '94% · 接近上限' }))
    assert.equal(view.find({ text: 'Average throughput' }), null)
    await view.post('gauge.changed', { ...ready, locale: 'zh-TW' })
    assert.ok(view.find({ text: '上下文視窗' }))
    assert.ok(view.find({ text: '執行中' }))
    assert.ok(view.find({ text: 'gateway/example' }))
    await view.post('gauge.changed', { ...emptySnapshot, phase: 'empty' })
    assert.ok(view.find({ text: 'No local agent chats in this workspace.' }))
    assert.equal(view.find({ text: '≈13.9 tok/s' }), null)
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.warnings, [])
    assert.deepEqual(view.refusals, [])
  } finally { await view.unmount() }
})

test('shows cache and breakdown only when supplied for the selected chat', async () => {
  const view = await mount(panel, { host: mockHost({ requests: { 'gauge.get': () => detailed } }) })
  try {
    assert.ok(view.find({ text: '提示词缓存命中率' }))
    assert.ok(view.find({ type: 'Collapsible' }))
    assert.ok(view.find({ text: '已占用分类 · 面积按 token 数分配' }))
    assert.ok(view.find({ text: '1 · 73k' }))
    const tree = JSON.stringify(view.tree())
    assert.ok(tree.includes('1 · Messages'))
    assert.ok(tree.includes('MCP tools · 按需加载'))
    assert.ok(tree.includes('Autocompact buffer'))
    assert.ok(!tree.includes('5 · Free space'))
    await view.post('gauge.changed', { ...detailed, sample: { ...ready.sample!, completedAt: 1760000001000 } })
    assert.ok(JSON.stringify(view.tree()).includes('上次报告'))
    await view.post('gauge.changed', { ...detailed, sample: { ...ready.sample!, completedAt: 1760000001000, model: 'other' } })
    assert.equal(view.find({ text: '已占用分类 · 面积按 token 数分配' }), null)
    await view.post('gauge.changed', {
      ...detailed, sample: null,
      chats: [{ id: 'example', title: 'Antigravity Chat', state: 'done', agent: 'antigravity' }],
      context: { kind: 'estimate', usedTokens: 10_000, windowTokens: 100_000, capturedAt: 1760000000000, model: null }
    })
    assert.ok(view.find({ text: '剩余 90,000 token' }))
    assert.ok(view.find({ text: 'Orca 记录了 Antigravity 的上下文总量，但没有分类或缓存明细。' }))
    assert.ok(view.find({ text: '未能为已完成的轮次匹配完整的 Antigravity 输出 token 数。' }))
    assert.equal(view.find({ text: '1 · 73k' }), null)
    assert.equal(view.find({ text: '提示词缓存命中率' }), null)
    assert.equal(view.find({ text: '上下文构成' }), null)
    assert.deepEqual(view.errors, [])
  } finally { await view.unmount() }
})
