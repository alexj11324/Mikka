import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act, useSyncExternalStore } from 'react'
import type { Root } from 'react-dom/client'
import { Window } from 'happy-dom'

/**
 * 「添加 API Key」的默认路径必须让「用自己的 endpoint」可被发现。
 *
 * The dialog used to open on a preset provider and render the Base URL field
 * only behind a `provider === 'custom'` radio buried at the end of the list, so
 * a person adding their own endpoint saw a lone API key field. The capability
 * existed (lib/model-api-keys.ts accepts baseUrl); the affordance did not.
 */

type Key = { id: string; provider: string; last4: string; baseUrl: string | null; shared: boolean; models: { count: number } | null; modelsError: string | null; features: Record<string, boolean>; harnesses: string[]; protocols: string[] }
const workspaceId = '11111111-1111-4111-8111-111111111111'
let data: { keys: Key[]; canShare: boolean; apiKeyAfterQuota: boolean }
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
const snapshot = () => data

mock.module('next-intl', { namedExports: {
  useTranslations: () => {
    const t = (key: string) => key
    t.has = () => true
    return t
  },
  useFormatter: () => ({ dateTime: () => 'time' }),
} })
mock.module(new URL('../../hooks/settings/use-api-keys.ts', import.meta.url).href, { namedExports: {
  apiKeysKey: (id: string) => ['settings:api-keys', id] as const,
  readApiKeys: async () => data,
  useApiKeyLabels: () => ({
    title: (key: { provider: string; name?: string | null }) => key.provider === 'custom' ? key.name ?? 'custom' : key.provider,
    agents: () => '',
    protocolAgents: (protocols: readonly string[]) => protocols.join('、'),
  }),
  useApiKeys: () => ({ data: useSyncExternalStore(subscribe, snapshot), loadError: null, pending: false, failed: null, share: async () => undefined, setFeature: async () => undefined, refetch: async () => undefined, reload: async () => undefined, remove: async () => undefined, add: async () => null, setAfterQuota: async () => null }),
} })
mock.module(new URL('../../hooks/use-live-key.tsx', import.meta.url).href, { namedExports: { useLiveKey: () => undefined } })

const browser = new Window({ url: 'https://fixture.example/settings?section=models' })
let container: HTMLDivElement, root: Root
let createRoot: typeof import('react-dom/client')['createRoot']
let useApiKeyList: typeof import('./api-key-settings')['useApiKeyList']
let Harness: () => React.ReactNode

before(async () => {
  Object.assign(globalThis, { window: browser, document: browser.document, IS_REACT_ACT_ENVIRONMENT: true })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: browser.navigator })
  for (const key of ['HTMLElement', 'Element', 'Node', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'MutationObserver', 'ResizeObserver'] as const) {
    const value = (browser as unknown as Record<string, unknown>)[key]
    if (value !== undefined) Object.defineProperty(globalThis, key, { configurable: true, value: typeof value === 'function' && /^[a-z]/.test(key) ? (value as (...args: unknown[]) => unknown).bind(browser) : value })
  }
  ;({ createRoot } = await import('react-dom/client'))
  ;({ useApiKeyList } = await import('./api-key-settings'))
  Harness = () => {
    const { section, dialogs } = useApiKeyList(workspaceId)
    return <>{section}{dialogs}</>
  }
})

beforeEach(() => {
  data = { keys: [], canShare: false, apiKeyAfterQuota: true }
  container = browser.document.createElement('div') as unknown as HTMLDivElement
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  mock.restoreAll()
})

after(() => browser.close())

const render = async () => { await act(async () => root.render(<Harness />)) }
const click = async (target: Element) => { await act(async () => (target as HTMLElement).click()) }
const button = (label: string) => [...container.querySelectorAll('button')].find(item => item.textContent?.trim() === label)
/** A Dialog portals into document.body, outside the container we render into. */
const inDocument = <T extends Element>(selector: string) => document.querySelector<T>(selector)
const documentText = () => document.body.textContent ?? ''

test('a custom endpoint is one visible choice away from the dialog opening', async () => {
  await render()
  const open = button('add')
  assert.ok(open, 'the section offers 添加 API Key')
  await click(open)

  // The person's own endpoint is the first provider offered, not a radio at the end.
  const text = documentText()
  const customIndex = text.indexOf('custom')
  const anthropicIndex = text.indexOf('anthropic')
  assert.ok(customIndex >= 0, 'the dialog names the custom provider')
  assert.ok(customIndex < anthropicIndex, 'the custom provider is listed before the presets')

  // Choosing it reveals the Base URL field the custom provider needs.
  const customLabel = [...document.querySelectorAll('label')].find(item => item.textContent?.includes('custom'))
  assert.ok(customLabel, 'the custom provider is selectable')
  await click(customLabel)
  assert.ok(inDocument('#api-key-base-url'), 'choosing the custom provider shows Base URL')
})

test('the dialog keeps every preset provider listed', async () => {
  await render()
  await click(button('add')!)
  const text = documentText()
  for (const preset of ['custom', 'anthropic', 'openai', 'deepseek', 'kimi']) assert.ok(text.includes(preset), `every provider stays listed (missing ${preset})`)
  assert.ok(inDocument('#api-key-value'), 'the API key field is still there')
})

test('a preset key row names its provider, not a placeholder URL', async () => {
  data = { keys: [{ id: 'k1', provider: 'anthropic', last4: 'abcd', baseUrl: null, shared: false, models: { count: 3 }, modelsError: null, features: {}, harnesses: ['claude_code'], protocols: ['anthropic'] }], canShare: false, apiKeyAfterQuota: true }
  await render()
  const text = container.textContent ?? ''
  assert.ok(!/API Key · ••••abcd/.test(text), 'the description does not put the literal "API Key" where an endpoint host belongs')
  assert.ok(text.includes('••••abcd'), 'the masked key still shows')
})
