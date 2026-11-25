import { assert, test } from 'orca/testing'
import { status } from './format'
import { localTimestamp, resolveLocale } from './i18n'
import { emptySnapshot } from './protocol'

test('auto maps system Chinese scripts and falls back to English for unsupported locales', () => {
  for (const locale of ['zh', 'zh-CN', 'zh-SG', 'zh_Hans_CN']) assert.equal(resolveLocale('auto', locale), 'zh-CN')
  for (const locale of ['zh-TW', 'zh-HK', 'zh-MO', 'zh-Hant', 'zh-Hant-CN']) assert.equal(resolveLocale('auto', locale), 'zh-TW')
  for (const locale of ['en-US', 'fr-FR', 'ja-JP', 'invalid locale']) assert.equal(resolveLocale('auto', locale), 'en')
  assert.equal(resolveLocale('en', 'zh-CN'), 'en')
  assert.equal(resolveLocale('zh-TW', 'en-US'), 'zh-TW')
})

test('only status tooltip and timestamps are localized; the readout has no labels', () => {
  const context = { kind: 'report', usedTokens: 20_000, windowTokens: 100_000, model: null, capturedAt: 1760000000000 } as const
  const snapshot = { ...emptySnapshot, context }
  for (const locale of ['en', 'zh-CN', 'zh-TW'] as const) {
    assert.equal(status({ ...snapshot, locale }).text, '20k/100k')
  }
  assert.equal(status({ ...snapshot, context: { ...context, windowTokens: null } }).text, '20k')
  assert.equal(status(emptySnapshot).text, '—')
  assert.equal(status({ ...snapshot, context: { kind: 'unknown', capturedAt: context.capturedAt + 1 },
    sample: { model: 'example', completedAt: context.capturedAt, durationMs: 2000, inputTokens: 300, outputTokens: 23 }
  }).text, '≈11.5 tok/s')
  assert.ok(status({ ...snapshot, locale: 'zh-CN' }).tooltip.includes('上下文'))
  assert.ok(status({ ...emptySnapshot, phase: 'empty', locale: 'zh-TW' }).tooltip.includes('目前工作區'))
  assert.ok(localTimestamp(1760000000000, 'zh-CN').includes('月'))
  assert.equal(localTimestamp(NaN, 'en'), '—')
})
