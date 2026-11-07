import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act, type ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import { Window } from 'happy-dom'
import { Button } from '../ui/button'

let opened: string | null | undefined
mock.module('next-intl', { namedExports: { useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}` } })
mock.module(new URL('../../i18n/navigation.ts', import.meta.url).href, { namedExports: { Link: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a> } })
mock.module(new URL('./bot-model-picker.tsx', import.meta.url).href, { namedExports: { openModelPicker: (botId: string | null) => { opened = botId } } })
const browser = new Window({ url: 'https://fixture.example/mikka' })
let container: HTMLDivElement, root: Root
let createRoot: typeof import('react-dom/client')['createRoot']
let SubscriptionRefusalNotice: typeof import('./subscription-refusal-notice')['SubscriptionRefusalNotice']
let FailureReason: typeof import('./failure-reason')['FailureReason']
before(async () => {
  Object.assign(globalThis, { window: browser, document: browser.document, IS_REACT_ACT_ENVIRONMENT: true, HTMLElement: browser.HTMLElement, Element: browser.Element })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: browser.navigator })
  for (const key of ['Node', 'getComputedStyle', 'MutationObserver', 'ResizeObserver'] as const) {
    const value = (browser as unknown as Record<string, unknown>)[key]
    Object.defineProperty(globalThis, key, { configurable: true, value: typeof value === 'function' && key === 'getComputedStyle' ? (value as (...args: unknown[]) => unknown).bind(browser) : value })
  }
  ;({ createRoot } = await import('react-dom/client'))
  ;({ SubscriptionRefusalNotice } = await import('./subscription-refusal-notice'))
  ;({ FailureReason } = await import('./failure-reason'))
})
beforeEach(() => { opened = undefined; container = browser.document.createElement('div') as unknown as HTMLDivElement; document.body.append(container); root = createRoot(container) })
afterEach(async () => { await act(async () => root.unmount()); container.remove() })
after(() => browser.happyDOM.close())
const render = async (node: ReactNode) => { await act(async () => root.render(node)) }

test('a disconnected subscription opens its settings without offering an ineffective retry', async () => {
  await render(<SubscriptionRefusalNotice notice="reconnect" retry={<Button onClick={() => { opened = 'retry' }}>fixture-retry</Button>} botId="fixture-bot" />)
  assert.match(container.querySelector('a')?.getAttribute('href') ?? '', /section=models/)
  assert.ok(!container.textContent?.includes('fixture-retry'))
  assert.equal(container.querySelector('button'), null)
})

test('a transient rate limit keeps retry next to its specific state', async () => {
  await render(<SubscriptionRefusalNotice notice="rateLimited" retry={<Button onClick={() => { opened = 'retry' }}>fixture-retry</Button>} botId="fixture-bot" />)
  assert.match(container.textContent ?? '', /subscriptionRefusal.rateLimited/)
  assert.equal(container.querySelector('button')?.textContent, 'fixture-retry')
  assert.equal(container.querySelector('a'), null)
})

test('a rejected model opens this Bot model picker', async () => {
  await render(<SubscriptionRefusalNotice notice="modelRejected" retry={<Button onClick={() => { opened = 'retry' }}>fixture-retry</Button>} botId="fixture-bot" />)
  await act(async () => container.querySelector('button')!.click())
  assert.equal(opened, 'fixture-bot')
  assert.ok(!container.textContent?.includes('fixture-retry'))
})

test('a historical failure uses the same recovery and only resends on request', async () => {
  let sent = 0
  await render(<FailureReason failure={{ kind: 'subscription', notice: 'reconnect' }} botId="fixture-bot" onResend={() => { sent++ }} />)
  assert.match(container.querySelector('a')?.getAttribute('href') ?? '', /section=models/)
  assert.equal(sent, 0)
  await render(<FailureReason failure={{ kind: 'subscription', notice: 'rateLimited' }} botId="fixture-bot" onResend={() => { sent++ }} />)
  assert.equal(sent, 0)
  await act(async () => container.querySelector('button')!.click())
  assert.equal(sent, 1)
})

test('a failure line keeps its words and folds the stored codes under 详情 (decision 2026-11-05-0330)', async () => {
  const raw = 'wake_exhausted\nsubscription_generation_failed (provider_request_rejected)'
  await render(<FailureReason failure={{ kind: 'wake', code: 'wake_exhausted', raw }} botId="fixture-bot" onResend={() => {}} />)
  assert.match(container.textContent ?? '', /Coordinator\.wakeErrors\.wake_exhausted/)
  const details = container.querySelector('[data-slot="run-error-details"]')
  assert.ok(details, '详情 is there')
  assert.match(details.textContent ?? '', /IssueThreads\.errorDetails/)
  // The first button is the line's own action; 详情 is the trigger inside the details area.
  await act(async () => (details.querySelector('button') as HTMLElement).click())
  assert.match(details.textContent ?? '', /subscription_generation_failed \(provider_request_rejected\)/)
})

test('without stored codes there is no 详情', async () => {
  await render(<FailureReason failure={{ kind: 'failed' }} botId="fixture-bot" onResend={() => {}} />)
  assert.equal(container.querySelector('[data-slot="run-error-details"]'), null)
})
