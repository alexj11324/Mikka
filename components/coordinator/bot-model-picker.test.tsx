import assert from 'node:assert/strict'
import { before, beforeEach, mock, test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import type { BotModelMenu } from '../../lib/bot-model-menu-view'

let data: BotModelMenu
mock.module('swr', { defaultExport: () => ({ data, mutate: async () => {} }) })
mock.module('next-intl', { namedExports: { useTranslations: () => (key: string, args?: Record<string, string>) => args?.name ? `${key}: ${args.name}` : key } })
mock.module(new URL('../../app/actions/execution-settings.ts', import.meta.url).href, { namedExports: {
  getBotModelMenu: async () => data, chooseBotModel: async () => data, refreshBotModelMenuAction: async () => data,
} })
mock.module(new URL('../../i18n/navigation.ts', import.meta.url).href, { namedExports: { Link: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a> } })
let BotModelPicker: typeof import('./bot-model-picker')['BotModelPicker']
before(async () => { ({ BotModelPicker } = await import('./bot-model-picker')) })
beforeEach(() => {
  data = { groups: [], current: { id: 'subscription-fixture', modelId: 'claude-sonnet-fixture', provider: 'claude', kind: 'subscription', chosen: true, available: true, availability: 'available', credentialLabel: 'fixture@example.test' } }
})
const render = (running = false) => renderToStaticMarkup(<BotModelPicker botId={null} running={running} />)

test('the next model names its credential before sending, including an automatic replacement', () => {
  data.current = { id: 'apikey:fixture', modelId: 'deepseek-chat', provider: 'deepseek', kind: 'apiKey', chosen: false, available: true, availability: 'available', credentialLabel: '····1234', fallback: 'preference' }
  const html = render()
  assert.match(html, /deepseek-chat/)
  assert.match(html, /····1234/)
  assert.match(html, /fallback/)
  assert.doesNotMatch(html, /nextMessage|data-unavailable/)
})

test('while a reply runs, a new selection is explicitly for the next message', () => {
  let html = render(true)
  assert.match(html, /data-next-message="true"/)
  assert.match(html, /nextMessage/)
  data.current = { ...data.current, id: 'new-subscription', modelId: 'gpt-fixture', provider: 'codex' }
  html = render(true)
  assert.match(html, /nextMessage.*gpt-fixture/)
  assert.doesNotMatch(render(), /nextMessage|data-next-message/)
})

test('an allowance awaiting a check is distinct from a confirmed exhausted subscription', () => {
  data.current = { ...data.current, available: false, availability: 'checking' }
  assert.match(render(), /checking/)
  assert.doesNotMatch(render(), /data-unavailable|labelUnavailable/)
  data.current.availability = 'exhausted'
  assert.match(render(), /data-unavailable="true"/)
  assert.match(render(), /labelUnavailable/)
})
