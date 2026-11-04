import assert from 'node:assert/strict'
import { before, mock, test } from 'node:test'
import type { ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import chinese from '../../messages/zh-CN.json'
import english from '../../messages/en.json'
import type { ThreadModelFallbackView } from '../../lib/run-model-fallback-view'

let locale: 'zh-CN' | 'en' = 'zh-CN'
const messages = () => locale === 'en' ? english : chinese
const lookup = (path: string) => path.split('.').reduce<unknown>((value, key) => (value as Record<string, unknown>)[key], messages()) as string
mock.module('next-intl', { namedExports: { useTranslations: (namespace: string) => (key: string) => lookup(`${namespace}.${key}`), useMessages: messages } })
mock.module(new URL('../../i18n/navigation.ts', import.meta.url).href, { namedExports: { Link: (props: ComponentProps<'a'>) => <a {...props} href={props.href} /> } })
mock.module(new URL('../../app/actions/agents.ts', import.meta.url).href, { namedExports: { resumeQuotaPausedRunOnApiKey: async () => {}, retryQuotaPausedRun: async () => {} } })
mock.module(new URL('../coordinator/quota-notice.tsx', import.meta.url).href, { namedExports: { subscriptionName: () => '', useKeyName: () => () => '', useResetTime: () => () => '' } })
let Notice: typeof import('./thread-quota')['ThreadModelFallbackNotice']
before(async () => { ({ ThreadModelFallbackNotice: Notice } = await import('./thread-quota')) })

const from = { harness: 'codex', model: 'fixture-first', source: 'api_key' } as const
const to = { harness: 'claude_code', model: 'fixture-next', source: 'subscription' } as const
const switched: ThreadModelFallbackView = { runId: 'fixture-run', state: 'switched', continuationRunId: 'fixture-child', from, to, failure: 'balance' }

test('confirmed switches name both models and the reason in either locale, with shared entity marks', () => {
  for (const language of ['zh-CN', 'en'] as const) {
    locale = language
    const html = renderToStaticMarkup(<Notice item={switched} />)
    assert.match(html, /data-thread-model-switch/)
    assert.ok(html.includes(from.model) && html.includes(to.model))
    assert.ok(html.includes(messages().AgentCopy.needsModelBalance))
    assert.ok(html.includes(messages().IssueThreads.modelSwitched))
    assert.equal((html.match(/<svg/g) ?? []).length, 4, 'each named Agent and model has its shared mark')
  }
})

test('all-unavailable cards localize per-model causes and link to setup without showing provider text', () => {
  locale = 'en'
  const item: ThreadModelFallbackView = {
    runId: 'fixture-run', state: 'blocked', failure: 'balance', from,
    reasons: [{ choice: from, reason: 'balance' }, { choice: to, reason: 'quota' }, { choice: { ...to, model: 'fixture-no-device' }, reason: 'noDevice' }],
    card: { title: 'must-not-render-provider-text', description: 'must-not-render-provider-text', options: [{ value: 'models', label: 'must-not-render-provider-text', action: 'modelSettings' }] },
  }
  const html = renderToStaticMarkup(<Notice item={item} />)
  assert.match(html, /data-thread-model-blocked/)
  assert.ok(html.includes(english.AgentCopy.needsModelTitle))
  assert.ok(html.includes(english.AgentCopy.needsModelBalance) && html.includes(english.Settings.modelOrder.blocked.quota))
  assert.ok(html.includes(english.AgentCopy.needsModelNoPlace))
  assert.ok(!html.includes(english.AgentCopy.needsModelNoComputer), 'an incapable computer is not described as disconnected')
  assert.match(html, /href="\/settings\?section=models"/)
  assert.ok(!html.includes('must-not-render-provider-text'))
})

test('an explicit model stays identified as unswitched with setup and the existing retry control', () => {
  locale = 'zh-CN'
  let retries = 0
  const item: ThreadModelFallbackView = { runId: 'fixture-run', state: 'picked', from, failure: 'auth' }
  const html = renderToStaticMarkup(<Notice item={item} retry={() => { retries++ }} retrying />)
  assert.ok(html.includes(chinese.AgentCopy.needsModelPinned))
  assert.ok(html.includes(chinese.AgentCopy.needsModelKeyRefused))
  assert.match(html, /href="\/settings\?section=models"/)
  assert.match(html, /<button[^>]*disabled/)
  assert.ok(!html.includes('data-thread-model-switch'))
  assert.equal(retries, 0)
})
