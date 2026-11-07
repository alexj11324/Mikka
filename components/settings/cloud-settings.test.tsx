import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act, useSyncExternalStore } from 'react'
import type { Root } from 'react-dom/client'
import { Window } from 'happy-dom'
import type { CloudConnectionView } from '../../lib/cloud-services/types'

const savedBasePath = process.env.MIKKA_BASE_PATH
process.env.MIKKA_BASE_PATH = '/mikka'
after(() => { if (savedBasePath === undefined) delete process.env.MIKKA_BASE_PATH; else process.env.MIKKA_BASE_PATH = savedBasePath })
const zh = JSON.parse(readFileSync(new URL('../../messages/zh-CN.json', import.meta.url), 'utf8'))
const translator = (namespace: string) => (key: string) => {
  const value = `${namespace}.${key}`.split('.').reduce((node, part) => node?.[part], zh)
  assert.equal(typeof value, 'string', `missing ${namespace}.${key}`)
  return value as string
}
mock.module('next-intl', { namedExports: { useTranslations: translator } })
let data: CloudConnectionView
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
const snapshot = () => data
const mutate = async (value: CloudConnectionView) => { data = value; for (const listener of listeners) listener(); return data }
mock.module('swr', { defaultExport: () => ({ data: useSyncExternalStore(subscribe, snapshot), mutate }), namedExports: { unstable_serialize: (key: unknown) => JSON.stringify(key) } })
mock.module(new URL('../../hooks/use-live-key.tsx', import.meta.url).href, { namedExports: { useLiveKey: () => undefined } })

const browser = new Window({ url: 'https://fixture.example/mikka/settings?section=account' })
let container: HTMLDivElement, root: Root
let createRoot: typeof import('react-dom/client')['createRoot']
let CloudSettings: typeof import('./cloud-settings')['CloudSettings']
let response: Response
const requests: Array<{ url: string; method: string | undefined; body: unknown }> = []
before(async () => {
  Object.assign(globalThis, { window: browser, document: browser.document, IS_REACT_ACT_ENVIRONMENT: true })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: browser.navigator })
  for (const key of ['HTMLElement', 'Element', 'Node', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'MutationObserver', 'ResizeObserver'] as const) {
    const value = (browser as unknown as Record<string, unknown>)[key]
    if (value !== undefined) Object.defineProperty(globalThis, key, { configurable: true, value: typeof value === 'function' && /^[a-z]/.test(key) ? (value as (...args: unknown[]) => unknown).bind(browser) : value })
  }
  ;({ createRoot } = await import('react-dom/client'))
  ;({ CloudSettings } = await import('./cloud-settings'))
})
beforeEach(() => {
  data = { registered: true, serverId: null, serviceUrl: 'https://cloud.example/mikka/cloud', administrator: false, pushContent: 'full',
    personal: { connected: false, revoked: true, scopes: ['models'] }, team: { connected: true, scopes: ['models'] } }
  requests.length = 0
  response = Response.json({ ...data, personal: { connected: false, revoked: false, scopes: [] } })
  mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(url), method: init?.method, body: JSON.parse(String(init?.body)) })
    return response
  })
  container = browser.document.createElement('div') as unknown as HTMLDivElement
  document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); mock.restoreAll() })
after(() => browser.close())
const button = (label: string) => [...container.querySelectorAll('button')].find(item => item.textContent?.trim() === label)
const render = async () => { await act(async () => root.render(<CloudSettings personal userKey="fixture-user" workspaceId="fixture-workspace" />)) }

test('a revoked personal binding can be explicitly removed before team billing becomes available', async () => {
  await render()
  assert.ok(container.textContent?.includes(zh.Settings.cloud.revoked))
  assert.ok(!container.textContent?.includes(zh.Settings.cloud.teamBilling))
  assert.ok(button(zh.Settings.cloud.connectAccount), 'the person may reconnect instead')
  const disconnect = button(zh.Settings.cloud.disconnect)
  assert.ok(disconnect, 'revocation must not remove the explicit disconnect action')
  await act(async () => disconnect.click())
  assert.deepEqual(requests, [{ url: '/mikka/api/cloud/disconnect', method: 'POST', body: { action: 'personal' } }])
  assert.ok(container.textContent?.includes(zh.Settings.cloud.teamBilling))
  assert.equal(button(zh.Settings.cloud.disconnect), undefined)
  assert.ok(button(zh.Settings.cloud.connectAccount))
})

test('a failed disconnect keeps the revoked binding visible and does not claim team billing is ready', async () => {
  response = Response.json({ error: 'cloud_unavailable' }, { status: 503 })
  await render()
  const disconnect = button(zh.Settings.cloud.disconnect)
  assert.ok(disconnect)
  await act(async () => disconnect.click())
  assert.ok(container.textContent?.includes(zh.RunErrors.cloud_unavailable.default))
  assert.ok(container.textContent?.includes(zh.Settings.cloud.revoked))
  assert.ok(!container.textContent?.includes(zh.Settings.cloud.teamBilling))
  assert.equal(button(zh.Settings.cloud.disconnect)?.disabled, false)
})

test('an active personal binding retains its existing disconnect action and personal billing indication', async () => {
  data = { ...data, personal: { connected: true, revoked: false, scopes: ['models'] } }
  await render()
  assert.ok(button(zh.Settings.cloud.disconnect))
  assert.equal(button(zh.Settings.cloud.connectAccount), undefined)
  assert.ok(container.textContent?.includes(zh.Settings.cloud.personalBilling))
  assert.ok(!container.textContent?.includes(zh.Settings.cloud.teamBilling))
})
