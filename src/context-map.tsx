import { Box, KeyValue, Stack, Text, type BoxLength } from 'orca'
import { compact, count } from './format'
import { contextCopy, messages, type Locale } from './i18n'
import type { ContextCategory } from './protocol'
import { layoutTiles, mapHeight, occupiedCategories, occupiesContext, type Tile } from './treemap'

const pct = (n: number): BoxLength => `${n}%`

function draw(tile: Tile, width: BoxLength = '100%', height: BoxLength = '100%') {
  if ('category' in tile) {
    const { category, width: w, height: h } = tile
    const labeled = w >= 34 && h >= 24
    const named = w >= 120 && h >= 46
    return <Box width={width} height={height} shrink={false} background="accent" border={w >= 4 && h >= 4} radius="sm"
      paddingX={labeled ? 'xs' : 'none'} gap={named ? 'xs' : 'none'} justify="center">
      {named ? <Text size="xs" weight="semibold" truncate>{category.name}</Text> : null}
      {labeled ? <Text size="xs" weight="medium" truncate>{w >= 88 ? `${category.index} · ${compact(category.tokens)}` : `${category.index}`}</Text> : null}
    </Box>
  }
  // Native Box accepts whole percentages. Keep both halves on the same grid.
  const first = Math.round(tile.share * 100)
  const rest = 100 - first
  const across = tile.axis === 'row'
  return <Box width={width} height={height} shrink={false} direction={tile.axis} align="stretch">
    {first ? draw(tile.first, across ? pct(first) : '100%', across ? '100%' : pct(first)) : null}
    {rest ? draw(tile.rest, across ? pct(rest) : '100%', across ? '100%' : pct(rest)) : null}
  </Box>
}

export function ContextMap({ categories, locale }: { categories: readonly ContextCategory[]; locale: Locale }) {
  const c = contextCopy[locale]
  const t = messages(locale)
  const occupied = occupiedCategories(categories)
  const map = layoutTiles(occupied)
  const outside = categories.filter((category) => !occupiesContext(category))
  const amount = (tokens: number) => `${count(tokens)} ${t.tokens}`
  return <Stack gap="sm">
    {map ? <Stack gap="xs">
      <Text muted size="xs">{c.occupied}</Text>
      <Box width="100%" height={mapHeight}>{draw(map)}</Box>
      <KeyValue label={c.occupied} items={occupied.map(({ name, index, tokens }) => ({
        label: `${index} · ${name}`, value: amount(tokens)
      }))} />
    </Stack> : null}
    {outside.length ? <Stack gap="xs">
      <Text muted size="xs">{c.outside}</Text>
      <KeyValue label={c.outside} items={outside.map(({ name, tokens, deferred }) => ({
        label: deferred ? `${name} · ${c.deferred}` : name, value: amount(tokens)
      }))} />
    </Stack> : null}
  </Stack>
}
