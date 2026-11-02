import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { Window } from 'happy-dom'

let reply: unknown = { queued: true }
let calls = 0
mock.module(new URL('../../app/actions/coordinator.ts', import.meta.url).href, { namedExports: {
  retryCoordinatorTurn: async () => { calls++; if (reply instanceof Error) throw reply; if (typeof reply === 'function') return reply(); return reply },
} })
mock.module('next-intl', { namedExports: { useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}` } })
mock.module(new URL('../../lib/use-action-error.ts', import.meta.url).href, { namedExports: { useActionError: () => (key: string) => `Errors.${key}` } })
const browser = new Window({ url: 'https://fixture.example/mikka' })
let container: HTMLDivElement, root: Root
let createRoot: typeof import('react-dom/client')['createRoot']
let RetryReplyButton: typeof import('./retry-reply-button')['RetryReplyButton']
before(async () => {
  Object.assign(globalThis, { window: browser, document: browser.document, IS_REACT_ACT_ENVIRONMENT: true, HTMLElement: browser.HTMLElement, Element: browser.Element })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: browser.navigator })
  for (const key of ['Node', 'getComputedStyle', 'MutationObserver', 'ResizeObserver'] as const) {
    const value = (browser as unknown as Record<string, unknown>)[key]
    Object.defineProperty(globalThis, key, { configurable: true, value: typeof value === 'function' && key === 'getComputedStyle' ? (value as (...args: unknown[]) => unknown).bind(browser) : value })
  }
  ;({ createRoot } = await import('react-dom/client'))
  ;({ RetryReplyButton } = await import('./retry-reply-button'))
})
beforeEach(() => { calls = 0; reply = { queued: true }; container = browser.document.createElement('div') as unknown as HTMLDivElement; document.body.append(container); root = createRoot(container) })
afterEach(async () => { await act(async () => root.unmount()); container.remove() })
after(() => browser.happyDOM.close())
const render = async (onQueued = async () => {}) => { await act(async () => root.render(<RetryReplyButton botId={null} onQueued={onQueued} />)) }
const click = async () => { await act(async () => (container.querySelector('button') as HTMLButtonElement).click()) }

test('a returned action error is visible and does not claim the reply was queued', async () => {
  reply = { error: 'authRequired' }; let queued = 0
  await render(async () => { queued++ }); await click()
  assert.equal(container.querySelector('[role="alert"]')?.textContent, 'Errors.authRequired')
  assert.equal(queued, 0)
})
for (const reason of ['working', 'nothingToRetry', 'unavailable']) test(`queued:false reports ${reason} instead of silent success`, async () => {
  reply = { queued: false, reason }; let refreshed = 0
  await render(async () => { refreshed++ }); await click()
  assert.match(container.textContent ?? '', new RegExp(`Coordinator.replyRetry.${reason}`))
  assert.equal(refreshed, 1)
})
test('a transport rejection reports an unconfirmed retry without exposing its message', async () => {
  reply = new Error('fixture-private-upstream-details')
  await render(); await click()
  assert.match(container.textContent ?? '', /Coordinator.replyRetry.unconfirmed/)
  assert.ok(!container.textContent?.includes('fixture-private'))
})
test('a confirmed enqueue survives a refresh error and cannot be submitted twice while pending', async () => {
  let finish!: (value: unknown) => void
  reply = () => new Promise(resolve => { finish = resolve })
  await render(async () => { throw new Error('fixture-refetch-failed') })
  await act(async () => { const button = container.querySelector('button')!; button.click(); button.click() })
  assert.equal(calls, 1)
  await act(async () => finish({ queued: true }))
  assert.match(container.textContent ?? '', /Coordinator.replyRetry.queued/)
})
