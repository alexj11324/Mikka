import assert from 'node:assert/strict'
import { before, beforeEach, mock, test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { NO_MODEL, type BotModelMenu } from '../../lib/bot-model-menu-view'

let data: BotModelMenu | undefined
const cache = new Map()
mock.module('swr', { namedExports: { useSWRConfig: () => ({ cache }) }, defaultExport: (key: readonly string[] | null) => ({ data: key?.[0] === 'bot-model-menu' ? data : undefined, mutate: async () => {} }) })
mock.module('@/lib/intl/i18n-client', { namedExports: { useLocale: () => 'en', useTranslations: () => (key: string, args?: Record<string, string>) => args?.name ? `${key}: ${args.name}` : key } })
mock.module(new URL('../../app/actions/execution-settings.ts', import.meta.url).href, { namedExports: {
  getBotModelMenu: async () => data, chooseBotModel: async () => data, refreshBotModelMenuAction: async () => data,
} })
mock.module(new URL('../../i18n/navigation.ts', import.meta.url).href, { namedExports: { Link: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a> } })
mock.module(new URL('../../app/actions/personal-policy.ts', import.meta.url).href, { namedExports: { getCreditShare: mock.fn(), updateCreditShare: mock.fn() } })
mock.module('@/lib/billing/verification-client', { namedExports: { getHostedUsage: mock.fn() } })
mock.module('@/lib/use-action-error', { namedExports: { useActionError: () => () => '' } })
mock.module('@/components/billing/connect-subscription-dialog', { namedExports: { ConnectSubscriptionButton: () => null } })
let BotModelPicker: typeof import('./bot-model-picker')['BotModelPicker']
let HostedUnavailableNotice: typeof import('./hosted-unavailable-notice')['HostedUnavailableNotice']
before(async () => {
  ;({ BotModelPicker } = await import('./bot-model-picker'))
  ;({ HostedUnavailableNotice } = await import('./hosted-unavailable-notice'))
})
beforeEach(() => {
  data = { groups: [], current: { id: 'subscription-fixture', modelId: 'claude-sonnet-fixture', provider: 'claude', kind: 'subscription', chosen: true, available: true, availability: 'available', credentialLabel: 'fixture@example.test' } }
})
const render = (running = false) => renderToStaticMarkup(<BotModelPicker botId={null} running={running} />)

test('the collapsed chip keeps the model name without account details, including an automatic replacement', () => {
  assert.ok(data)
  data.current = { id: 'apikey:fixture', modelId: 'deepseek-chat', provider: 'deepseek', kind: 'apiKey', chosen: false, available: true, availability: 'available', credentialLabel: '····1234', fallback: 'preference' }
  const html = render()
  assert.match(html, /deepseek-chat/)
  assert.doesNotMatch(html, /····1234|fixture@example\.test/)
  assert.match(html, /fallback/)
  assert.doesNotMatch(html, /nextMessage|data-unavailable/)
})

test('changing the selected model while a reply runs does not add a Next label or account to the chip', () => {
  assert.ok(data)
  let html = render(true)
  assert.match(html, /data-next-message="true"/)
  assert.doesNotMatch(html, /nextMessage|fixture@example\.test/)
  data.current = { ...data.current, id: 'new-subscription', modelId: 'gpt-fixture', provider: 'codex' }
  html = render(true)
  assert.match(html, /gpt-fixture/)
  assert.doesNotMatch(html, /nextMessage|fixture@example\.test/)
  assert.doesNotMatch(render(), /nextMessage|data-next-message/)
})

test('an allowance awaiting a check is distinct from a confirmed exhausted subscription', () => {
  assert.ok(data)
  data.current = { ...data.current, available: false, availability: 'checking' }
  assert.match(render(), /checking/)
  assert.doesNotMatch(render(), /data-unavailable|labelUnavailable/)
  data.current.availability = 'exhausted'
  assert.match(render(), /data-unavailable="true"/)
  assert.match(render(), /labelUnavailable/)
})

const renderNotice = () => renderToStaticMarkup(<HostedUnavailableNotice botId={null} />)
const credits = { id: 'credits:vendor/model', modelId: 'vendor/model', provider: 'mikka' }

test('skipping setup explains why priced models cannot run and links to model setup', () => {
  data = { current: NO_MODEL, groups: [{ kind: 'hosted', points: 0, options: [credits] }] }
  const html = renderNotice()
  assert.match(html, /noCreditsOrConnections/)
  assert.match(html, /href="\/settings\?section=models"[^>]*>setUpModel<\/a>/)
})

test('without any model sources, the notice links to setup without claiming a credit shortage', () => {
  data = { current: NO_MODEL, groups: [] }
  const html = renderNotice()
  assert.match(html, /noModelConnections/)
  assert.match(html, /href="\/settings\?section=models"/)
  assert.doesNotMatch(html, /noCreditsOrConnections/)
})

test('funded credits models can be picked without connecting a model', () => {
  data = { current: NO_MODEL, groups: [{ kind: 'hosted', points: 20, options: [credits] }] }
  const html = renderNotice()
  assert.match(html, /noModelSelected/)
  assert.doesNotMatch(html, /<button|section=models|noCreditsOrConnections/)
})

test('the notice stays hidden while loading and when a model can run', () => {
  assert.equal(renderNotice(), '')
  data = undefined
  assert.equal(renderNotice(), '')
})

test('a selected credits model keeps the existing unavailable notice', () => {
  data = { current: { ...credits, kind: 'hosted', chosen: true, available: false }, groups: [] }
  assert.match(renderNotice(), /hostedUnavailable/)
})
