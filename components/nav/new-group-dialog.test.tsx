import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { Window } from 'happy-dom'
import type { BotView } from '@/app/actions/bots'

mock.module('next-intl', { namedExports: { useTranslations: () => (key: string) => key } })
// Avatar rendering is outside this asynchronous form lifetime regression.
mock.module(new URL('./bot-avatar.tsx', import.meta.url).href, { namedExports: { BotAvatar: () => <span aria-hidden="true" /> } })
const browser = new Window({ url: 'https://mikka.test/mikka' })
let root: Root, container: HTMLDivElement
let createRoot: typeof import('react-dom/client')['createRoot']
let NewGroupDialog: typeof import('./new-group-dialog')['NewGroupDialog']
const bot = { id: '00000000-0000-4000-8000-000000000001', name: 'Fixture bot', color: 'bleu', shape: 'cercle', coordinator: false } as BotView

before(async () => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browser })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: browser.document })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: browser.navigator })
  for (const key of ['HTMLElement', 'HTMLButtonElement', 'HTMLInputElement', 'Element', 'Node', 'SVGElement', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'MutationObserver', 'ResizeObserver'] as const) {
    const value = (browser as unknown as Record<string, unknown>)[key]
    if (value !== undefined) Object.defineProperty(globalThis, key, { configurable: true, value: typeof value === 'function' && /^[a-z]/.test(key) ? (value as (...args: unknown[]) => unknown).bind(browser) : value })
  }
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  ;({ createRoot } = await import('react-dom/client'))
  ;({ NewGroupDialog } = await import('./new-group-dialog'))
})
beforeEach(() => { container = browser.document.createElement('div') as unknown as HTMLDivElement; document.body.append(container); root = createRoot(container) })
afterEach(async () => { await act(async () => root.unmount()); container.remove(); mock.restoreAll() })
after(() => browser.close())

test('a completed create from an unmounted workspace cannot navigate the current workspace or replay the POST', async () => {
  let resolve!: (response: Response) => void
  const response = new Promise<Response>(done => { resolve = done })
  const request = mock.method(globalThis, 'fetch', () => response)
  const created = mock.fn()
  const render = (workspaceId: string) => root.render(<NewGroupDialog key={workspaceId} open workspaceId={workspaceId} bots={[bot]}
    onOpenChange={() => {}} onCreated={created} onNewBot={() => {}} onReviewGroups={() => {}} />)
  await act(async () => render('00000000-0000-4000-8000-000000000010'))
  const input = document.querySelector<HTMLInputElement>('#new-group-title')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value')!.set!.call(input, 'Fixture group')
    input.dispatchEvent(new browser.Event('input', { bubbles: true }) as unknown as Event)
    document.querySelector<HTMLElement>('[role="checkbox"]')!.click()
  })
  const form = document.querySelector('form')!
  await act(async () => {
    form.dispatchEvent(new browser.Event('submit', { bubbles: true, cancelable: true }) as unknown as Event)
    form.dispatchEvent(new browser.Event('submit', { bubbles: true, cancelable: true }) as unknown as Event)
  })
  assert.equal(request.mock.callCount(), 1)
  await act(async () => render('00000000-0000-4000-8000-000000000020'))
  await act(async () => { resolve(Response.json({ id: 'created-in-old-workspace', title: 'Fixture group' }, { status: 201 })); await response })
  assert.equal(created.mock.callCount(), 0)
  assert.equal(request.mock.callCount(), 1)
  assert.equal(document.querySelector<HTMLInputElement>('#new-group-title')!.value, '')
  assert.equal(document.querySelector('[role="alert"]'), null)
})
