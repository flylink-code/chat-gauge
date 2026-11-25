import {
  atom, Badge, Box, Collapsible, EmptyState, Heading, KeyValue, plugin, Progress, read,
  Row, Select, Separator, set, Stack, Text, type PanelContext
} from 'orca'
import { ContextMap } from './context-map'
import { agentLabel, count, metrics } from './format'
import { contextCopy, localTimestamp, messages, resolveLocale } from './i18n'
import { emptySnapshot } from './protocol'

const initial = { ...emptySnapshot, locale: resolveLocale('auto') }
const current = atom(initial)

export function setup(ctx: PanelContext): void {
  let posted = false
  ctx.subscriptions.push(plugin.on('gauge.changed', (value) => { posted = true; set(current, value) }))
  void plugin.request('gauge.get', undefined, { signal: ctx.signal }).then((value) => {
    if (!ctx.signal.aborted && !posted) set(current, value)
  }).catch(() => {
    if (!ctx.signal.aborted && !posted) set(current, { ...initial, phase: 'unavailable' })
  })
}

async function select(id: string): Promise<void> {
  try { await plugin.request('gauge.select', { id }) } catch { /* A later worker update can recover. */ }
}

const stateLabels = new Map(Object.entries({ working: 'working', done: 'idle', waiting: 'waitingState', blocked: 'blocked' } as const))

export default function Panel() {
  const snapshot = read(current)
  const { sample, chats, selected, phase, context, locale } = snapshot
  const t = messages(locale)
  const c = contextCopy[locale]
  const { used, percent, rate, tone, window, free, cache, breakdown, contextEstimated, contextAt } = metrics(snapshot)
  const chat = chats.find((option) => option.id === selected)
  const isAgy = chat?.agent === 'antigravity' || chat?.agent === 'agy'
  const model = sample?.model ?? (context?.kind === 'report' ? context.model : null)
  return (
    <Stack gap="md">
      <Stack gap="xs">
        <Heading>Chat Gauge</Heading>
        {chat ? <>
          <Text weight="medium" truncate>{chat.title}</Text>
          <Row gap="xs" wrap><Badge>{agentLabel(chat.agent)}</Badge><Badge>{t[stateLabels.get(chat.state) ?? 'unknown']}</Badge></Row>
        </> : <Text muted size="xs">{t.workspace}</Text>}
      </Stack>
      {chats.length > 1 ? <Select label={t.selectChat} value={selected ?? undefined} placeholder={t.chooseChat}
        options={chats.map(({ id, title, agent }) => ({ value: id, label: `${agentLabel(agent)} · ${title} · ${id.slice(0, 8)}` }))}
        onChange={select} /> : null}
      {sample || used !== null ? <>
        <Box gap="sm" padding="sm" border radius="md" background="muted">
          <Stack gap="xs">
            <Text muted size="xs">{t.context}</Text>
            <Row gap="xs" align="center" wrap>
              <Heading level={2}>{used === null ? '—' : `${count(used)} ${t.tokens}`}</Heading>
              {percent !== null ? <Badge tone={tone}>{`${percent}% · ${tone === 'danger' ? t.nearLimit : tone === 'warning' ? t.high : t.used}`}</Badge> : null}
            </Row>
            {percent !== null && window ? <Progress label={t.contextUsed} labelHidden value={Math.min(100, percent)} /> : null}
            <Text muted size="xs">{used === null ? t.contextUnavailable : `${contextEstimated ? t.estimated : t.reported} · ${window ? `${t.windowLimit} ${count(window)} ${t.tokens}` : t.windowUnknown}`}</Text>
            {free !== null ? <Text muted size="xs">{`${c.free} ${count(free)} ${t.tokens}`}</Text> : null}
            {contextAt ? <Text muted size="xs">{`${t.updated} ${localTimestamp(contextAt, locale)}`}</Text> : null}
          </Stack>
          {cache && sample ? <>
            <Separator />
            <Stack gap="xs">
              <Text muted size="xs">{c.cache}</Text>
              <Heading level={2}>{`${cache.percent.toFixed(2)}%`}</Heading>
              <Text muted size="xs">{`${count(cache.read)} / ${count(sample.inputTokens)} ${t.tokens} · ${c.last}`}</Text>
            </Stack>
          </> : null}
          <Separator />
          <Stack gap="xs">
            <Text muted size="xs">{t.throughput}</Text>
            <Heading level={2}>{rate ?? '—'}</Heading>
            <Text muted size="xs">{rate ? t.lastRequest : isAgy ? c.agyRate : t.timingUnavailable}</Text>
          </Stack>
        </Box>
        {breakdown ? <Collapsible title={c.breakdown}
          description={`${breakdown.at === contextAt ? t.reported : c.previous} · ${localTimestamp(breakdown.at, locale)}`} defaultOpen>
          {chat?.agent === 'claude' ? <ContextMap categories={breakdown.categories} locale={locale} /> :
            <KeyValue label={c.breakdown} items={breakdown.categories.map(({ name, tokens, deferred }) => ({
              label: deferred ? `${name} · ${c.deferred}` : name,
              value: `${count(tokens)} ${t.tokens}`
            }))} />}
        </Collapsible> : used !== null ? <Text muted size="xs">{isAgy ? c.agy : c.missing}</Text> : null}
        {sample || model ? <Stack gap="sm">
          <Heading level={3}>{t.details}</Heading>
          {model ? <Stack gap="xs"><Text muted size="xs">{t.model}</Text><Text truncate>{model}</Text></Stack> : null}
          {sample ? <>
            <KeyValue items={[
              { label: t.input, value: count(sample.inputTokens) },
              { label: t.output, value: count(sample.outputTokens) },
              { label: t.duration, value: sample.durationMs === null ? '—' : `≈${(sample.durationMs / 1000).toFixed(2)} s` }
            ]} />
            <Text muted size="xs">{`${t.requestRecorded} ${localTimestamp(sample.completedAt, locale)}`}</Text>
          </> : null}
        </Stack> : null}
      </> : <EmptyState icon="gauge" title={t[phase]} />}
    </Stack>
  )
}
