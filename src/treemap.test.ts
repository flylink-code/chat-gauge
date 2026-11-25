import { assert, test } from 'orca/testing'
import { layoutTiles, occupiedCategories, type Tile } from './treemap'

function leaves(tile: Tile): Extract<Tile, { category: unknown }>[] {
  return 'category' in tile ? [tile] : [...leaves(tile.first), ...leaves(tile.rest)]
}

test('treemap areas follow reported occupied categories, not total, free, reserve or deferred counts', () => {
  const categories = occupiedCategories([
    { name: 'Other', tokens: 10 }, { name: 'System tools', tokens: 20 },
    { name: 'Messages', tokens: 70 }, { name: 'Free space', tokens: 29_000 },
    { name: 'Autocompact buffer', tokens: 1_000 }, { name: 'System tools', tokens: 500, deferred: true }
  ])
  assert.deepEqual(categories.map(({ index, name }) => [index, name]), [[1, 'Messages'], [2, 'System tools'], [3, 'Other']])
  const tile = layoutTiles(categories, 250, 130)
  assert.ok(tile)
  if (!tile) return
  for (const { category, width, height } of leaves(tile)) {
    assert.ok(Math.abs(width * height / (250 * 130) - category.tokens / 100) < 1e-10)
  }
})

test('tiny categories keep positive geometry even next to very large counts', () => {
  const tile = layoutTiles(occupiedCategories([
    { name: 'Messages', tokens: Number.MAX_SAFE_INTEGER },
    { name: 'System prompt', tokens: 1 }, { name: 'Memory files', tokens: 1 }
  ]))
  assert.ok(tile)
  if (!tile) return
  assert.equal(leaves(tile).length, 3)
  assert.ok(leaves(tile).every(({ width, height }) => width > 0 && height > 0))
})

test('empty and reserve-only reports do not create an occupied chart', () => {
  assert.equal(layoutTiles(occupiedCategories([])), null)
  assert.equal(layoutTiles(occupiedCategories([{ name: 'Free space', tokens: 5 }, { name: 'Tools', tokens: 1, deferred: true }])), null)
})
