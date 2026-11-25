import type { ContextCategory } from './protocol'

export type OccupiedCategory = ContextCategory & { index: number }
export type Tile = { category: OccupiedCategory; width: number; height: number }
  | { axis: 'row' | 'column'; share: number; first: Tile; rest: Tile }

export const mapHeight = 132

export function occupiesContext({ name, deferred }: ContextCategory): boolean {
  // Claude reports free capacity and the autocompact reserve alongside actual usage.
  return !deferred && !/^(?:free space|autocompact buffer)$/i.test(name)
}

export function occupiedCategories(categories: readonly ContextCategory[]): OccupiedCategory[] {
  return categories.filter(occupiesContext).sort((a, b) => b.tokens - a.tokens)
    .map((category, i) => ({ ...category, index: i + 1 }))
}

/** Split along the longer side, keeping large categories together and areas proportional to tokens. */
export function layoutTiles(categories: readonly OccupiedCategory[], width = 260, height = mapHeight): Tile | null {
  if (!categories.length) return null
  const split = (group: readonly OccupiedCategory[], w: number, h: number): Tile => {
    if (group.length === 1) return { category: group[0], width: w, height: h }
    const half = group.reduce((sum, category) => sum + category.tokens, 0) / 2
    let cut = 1
    let firstWeight = group[0].tokens
    while (cut < group.length - 1 && firstWeight + group[cut].tokens / 2 < half) {
      firstWeight += group[cut++].tokens
    }
    const remainder = group.slice(cut)
    const restWeight = remainder.reduce((sum, category) => sum + category.tokens, 0)
    const total = firstWeight + restWeight
    const share = firstWeight / total
    const restShare = restWeight / total
    const alongWidth = w >= h
    return {
      axis: alongWidth ? 'row' : 'column', share,
      first: split(group.slice(0, cut), alongWidth ? w * share : w, alongWidth ? h : h * share),
      rest: split(remainder, alongWidth ? w * restShare : w, alongWidth ? h : h * restShare)
    }
  }
  return split(categories, width, height)
}
