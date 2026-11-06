import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act, type ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import { Window } from 'happy-dom'
import type { OrderChange, OrderRow, OrderView } from '../../lib/model-order'

const workspaceId = randomUUID(), connectionId = randomUUID(), keyId = randomUUID()
let data: OrderView
let configured: boolean | undefined = true
let refreshFails = false
let refreshUnconfirmed = false
let changeFails: 'response' | 'network' | null = null
let rereadFails = false
let savedAutoRouting = true
const changes: OrderChange[] = []
const events: string[] = []
const translate = Object.assign((key: string) => key, { has: () => false })
mock.module('next-intl', { namedExports: { useTranslations: () => translate, useFormatter: () => ({ dateTime: () => 'time', relativeTime: () => 'ago' }), useNow: () => new Date() } })
mock.module('swr', { defaultExport: () => ({ data, mutate: async (value?: OrderView) => {
  events.push(value ? 'order-cache' : 'order')
  if (value) data = value
  else {
    if (rereadFails) throw new Error('fixture offline')
    data = { ...data, autoModelRouting: savedAutoRouting }
  }
  return data
} }), namedExports: { unstable_serialize: (key: unknown) => JSON.stringify(key) } })
const liveKeys: unknown[] = []
mock.module(new URL('../../hooks/use-live-key.tsx', import.meta.url).href, { namedExports: { useLiveKey: (...args: unknown[]) => { liveKeys.push(args) } } })
mock.module('next/link', { defaultExport: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a> })
mock.module(new URL('../../app/actions/model-order.ts', import.meta.url).href, { namedExports: {
  changeModelOrder: async (change: typeof changes[number], workspace: string) => {
    assert.equal(workspace, workspaceId)
    changes.push(change)
    if (changeFails === 'network') throw new Error('fixture offline')
    if (changeFails === 'response') return { error: 'unavailable' }
    if (change.kind === 'autoRouting') savedAutoRouting = change.enabled
    return { ...data, autoModelRouting: savedAutoRouting }
  },
  checkModelOrderQuota: async (id: string, workspace: string) => {
    assert.equal(workspace, workspaceId)
    assert.ok(data.entries.some(row => row.source.kind === 'subscription' && row.source.connectionId === id))
    events.push('probe')
    if (refreshFails) throw new Error('fixture failure')
    if (!refreshUnconfirmed) data = { ...data, entries: data.entries.map(row => ({ ...row, block: null })) }
    return data
  },
} })
mock.module(new URL('./e2b-key-dialog.tsx', import.meta.url).href, { namedExports: {
  useOwnE2BKey: () => ({ configured }), E2BKeyDialog: () => <div role="dialog">E2B key</div>,
} })
mock.module(new URL('../reui/kanban.tsx', import.meta.url).href, { namedExports: {
  Kanban: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  KanbanColumnContent: ({ children }: { children: ReactNode }) => <ol>{children}</ol>,
  KanbanItem: ({ children }: { children: ReactNode }) => <li>{children}</li>,
  KanbanItemHandle: ({ children }: { children: ReactNode }) => <span>{children}</span>,
} })

const browser = new Window({ url: 'https://mikka.test/settings?section=models' })
let container: HTMLDivElement, root: Root
let createRoot: typeof import('react-dom/client')['createRoot']
let ModelOrderSettings: typeof import('./model-order-settings')['ModelOrderSettings']

before(async () => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browser })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: browser.document })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: browser.navigator })
  for (const key of ['HTMLElement', 'Element', 'Node', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'MutationObserver', 'ResizeObserver'] as const) {
    const value = (browser as unknown as Record<string, unknown>)[key]
    if (value !== undefined) Object.defineProperty(globalThis, key, { configurable: true, value: typeof value === 'function' && /^[a-z]/.test(key) ? (value as (...args: unknown[]) => unknown).bind(browser) : value })
  }
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  ;({ createRoot } = await import('react-dom/client'))
  ;({ ModelOrderSettings } = await import('./model-order-settings'))
})
beforeEach(() => {
  configured = true; refreshFails = false; refreshUnconfirmed = false; events.length = 0
  changeFails = null; rereadFails = false; savedAutoRouting = true; changes.length = 0; liveKeys.length = 0
  data = { location: 'cloud', customized: true, autoModelRouting: true, preferredHarness: 'claude_code', credentials: 1, entries: [], candidates: [], devices: 0, cloudReady: true, cloudModels: {}, places: { cloud: 'ready', devices: [] }, first: { kind: 'cloud' }, readyDeviceIds: [], deviceModels: {} }
  container = browser.document.createElement('div') as unknown as HTMLDivElement
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove() })
after(() => browser.close())
const render = async () => { await act(async () => root.render(<ModelOrderSettings workspaceId={workspaceId} />)) }
const row = (block: OrderRow['block'], source: OrderRow['source'] = { kind: 'subscription', connectionId }): OrderRow => ({ id: randomUUID(), model: 'fixture-model', harness: 'claude_code', provider: 'claude', agents: ['claude_code'], source, block })
const button = (label: string) => [...container.querySelectorAll('button')].find(item => item.textContent?.trim() === label)

test('empty model order offers distinct subscription and API key destinations', async () => {
  data.credentials = 0
  await render()
  assert.equal(container.querySelector('a[href="#subscriptions-heading"]')?.textContent, 'connectSubscription')
  assert.equal(container.querySelector('a[href="#api-keys-heading"]')?.textContent, 'addApiKey')
})

test('blocked entries point to their own credential or the workspace devices', async () => {
  data.entries = [row({ reason: 'paused' }), row({ reason: 'expired' }), row({ reason: 'keyRefused' }, { kind: 'api_key', keyId }), row({ reason: 'noDevice', device: { why: 'none' } })]
  await render()
  const links = [...container.querySelectorAll('li a')]
  assert.deepEqual(links.slice(0, 3).map(link => link.getAttribute('href')), [`#subscription-${connectionId}`, `#subscription-${connectionId}`, `#api-key-${keyId}`])
  const devices = new URL(links[3].getAttribute('href')!, 'https://mikka.test')
  assert.equal(devices.pathname, '/settings')
  assert.equal(devices.searchParams.get('section'), 'computers')
  assert.equal(devices.searchParams.get('workspace'), workspaceId)
  assert.deepEqual(links.map(link => link.textContent), ['enableSubscription', 'reconnectSubscription', 'openApiKey', 'openDevices'])
})

test('an unknown allowance stays neutral and checks the provider before rereading the order', async () => {
  data.entries = [row({ reason: 'checking' })]
  await render()
  const status = container.querySelector('li [role="status"]')
  assert.equal(status?.textContent, 'blocked.checking')
  assert.ok(!status?.querySelector('.bg-warning'))
  assert.ok(button('checkQuota'))
  await act(async () => button('checkQuota')!.click())
  assert.deepEqual(events, ['probe', 'order-cache'])
  assert.equal(container.querySelector('li [role="status"]')?.textContent, 'ready')
})

test('a shared subscription allowance check uses the authorized row action without requiring an owner-only usage row', async () => {
  const sharedConnectionId = randomUUID()
  data.entries = [row({ reason: 'checking' }, { kind: 'subscription', connectionId: sharedConnectionId })]
  await render()
  await act(async () => button('checkQuota')!.click())
  assert.deepEqual(events, ['probe', 'order-cache'])
  assert.equal(container.querySelector('[role="alert"]'), null)
  assert.equal(container.querySelector('li [role="status"]')?.textContent, 'ready')
})

test('each 运行位置 is drawn in dispatch order, with no sentence about where runs go (Alex, 2026-11-06)', async () => {
  await render()
  const places = () => [...container.querySelectorAll('[data-slot="dispatch-order"] [role="listitem"] button')].map(item => item.getAttribute('aria-label'))
  // 云端: the cloud, then servers, then computers; the cloud is used first.
  assert.deepEqual(places(), ['cloud · stage.ready · firstHere', 'placeServers · noServers', 'placeComputers · noComputers'])
  assert.ok(!container.textContent?.includes('clauseSeparator'), 'no 「现在都跑不了」 line')
  await act(async () => root.unmount())
  root = createRoot(container)
  const server = { id: randomUUID(), name: 'vm', server: true, stage: 'offline' as const, lastSeenAt: Date.now() - 5 * 86_400_000 }
  const computer = { id: randomUUID(), name: 'MacBook', server: false, stage: 'off' as const, lastSeenAt: null }
  data = { ...data, location: 'local', cloudReady: false, places: { cloud: null, devices: [computer, server] }, first: null }
  await render()
  // 本地: no cloud; each place says why it cannot take a run.
  assert.deepEqual(places(), ['placeServers · stage.offline', 'placeComputers · stage.off'])
  assert.ok(container.querySelector('a')?.textContent === 'openDevices', '打开设备 sits on the 运行位置 row when nothing takes the run')
})

test('云端 without an E2B key: rows stay ready, the 运行位置 line says where runs go instead, and its button opens the key dialog', async () => {
  configured = false
  data = { ...data, cloudReady: false, places: { cloud: 'noKey', devices: [] }, first: { kind: 'device', id: randomUUID(), name: 'Box', server: true }, entries: [row(null)] }
  await render()
  assert.equal(container.querySelector('li [role="status"]')?.textContent, 'ready')
  assert.ok(![...container.querySelectorAll('li button')].some(item => item.textContent === 'setE2BKey'), 'the key is the 运行位置 row\'s, not each model\'s')
  assert.ok(container.querySelector('[data-slot="dispatch-order"] button')?.getAttribute('aria-label')?.startsWith('cloud · cloudNoKey'))
  await act(async () => button('setE2BKey')!.click())
  assert.equal(container.querySelector('[role="dialog"]')?.textContent, 'E2B key')
})

test('a refused allowance check keeps the selection and offers retry', async () => {
  data.entries = [row({ reason: 'checking' })]; refreshFails = true
  await render()
  await act(async () => button('checkQuota')!.click())
  assert.equal(data.entries.length, 1)
  assert.ok(container.querySelector('[role="alert"]'))
  refreshFails = false
  await act(async () => button('retry')!.click())
  assert.equal(container.querySelector('[role="alert"]'), null)
  assert.equal(container.querySelector('li [role="status"]')?.textContent, 'ready')
})

test('an unavailable provider read keeps checking even when the HTTP request succeeds', async () => {
  data.entries = [row({ reason: 'checking' })]; refreshUnconfirmed = true
  await render()
  await act(async () => button('checkQuota')!.click())
  assert.ok(container.querySelector('[role="alert"]')?.textContent?.includes('quotaCheckUnconfirmed'))
  assert.equal(container.querySelector('li [role="status"]')?.textContent, 'blocked.checking')
})


test('automatic model routing reflects the saved setting and saves each toggle for the current workspace', async () => {
  await render()
  const toggle = () => container.querySelector<HTMLButtonElement>('[role="switch"][aria-label="autoRouting"]')!
  assert.equal(toggle().getAttribute('aria-checked'), 'true')
  await act(async () => toggle().click())
  assert.deepEqual(changes, [{ kind: 'autoRouting', enabled: false }])
  assert.equal(toggle().getAttribute('aria-checked'), 'false')
  assert.equal(data.autoModelRouting, false)
  await act(async () => toggle().click())
  assert.deepEqual(changes[1], { kind: 'autoRouting', enabled: true })
  assert.equal(toggle().getAttribute('aria-checked'), 'true')
  assert.equal(container.querySelector('[role="alert"]'), null)
})

test('a refused routing change restores the saved setting and retry applies the intended value', async () => {
  changeFails = 'response'
  await render()
  const toggle = () => container.querySelector<HTMLButtonElement>('[role="switch"][aria-label="autoRouting"]')!
  await act(async () => toggle().click())
  assert.equal(toggle().getAttribute('aria-checked'), 'true')
  assert.equal(savedAutoRouting, true)
  assert.ok(container.querySelector('[role="alert"]'))
  changeFails = null
  await act(async () => button('retry')!.click())
  assert.equal(toggle().getAttribute('aria-checked'), 'false')
  assert.equal(container.querySelector('[role="alert"]'), null)
})

test('an offline routing save restores the last saved setting even when revalidation fails', async () => {
  changeFails = 'network'; rereadFails = true
  await render()
  const toggle = container.querySelector<HTMLButtonElement>('[role="switch"][aria-label="autoRouting"]')!
  await act(async () => toggle.click())
  assert.equal(data.autoModelRouting, true)
  assert.equal(toggle.getAttribute('aria-checked'), 'true')
  assert.ok(container.querySelector('[role="alert"]'))
})

test('the list is the 优先使用的 Agent\'s own: the other Agent\'s rows stay out, a move sends only its rows, and the list re-reads on a live push', async () => {
  const claude = [{ ...row(null), model: 'claude-opus' }, { ...row(null), model: 'claude-sonnet' }]
  const codex = { ...row(null), model: 'gpt-codex', harness: 'codex' as const, provider: 'codex', agents: ['codex' as const] }
  data = { ...data, entries: [claude[0], codex, claude[1]] }
  await render()
  const text = container.textContent ?? ''
  assert.match(text, /claude-opus/); assert.match(text, /claude-sonnet/)
  assert.doesNotMatch(text, /gpt-codex/, 'Codex rows belong to the Codex list')
  assert.ok(liveKeys.some(args => (args as unknown[])[0] === 'model_settings'), 'it listens for 模型与订阅 changes only')
  assert.ok(!liveKeys.some(args => (args as unknown[])[0] === 'workspace_settings'), 'not the app-wide settings kind')
  const menus = [...container.querySelectorAll('button')].filter(item => item.getAttribute('aria-label') === 'rowMenu')
  assert.equal(menus.length, 2, 'one menu per Claude Code row')
  await act(async () => { menus[0].click() })
  const down = [...document.querySelectorAll('[role="menuitem"]')].find(item => item.textContent?.trim() === 'moveDown')
  assert.ok(down, 'the first row can move down')
  await act(async () => { (down as HTMLElement).click() })
  const reorder = changes.find(change => (change as { kind?: string }).kind === 'reorder') as { ids: string[] } | undefined
  assert.ok(reorder, 'a move sends a reorder')
  assert.deepEqual(reorder.ids, [claude[1].id, claude[0].id], 'only this Agent\'s rows, in their new order')
  data = { ...data, preferredHarness: 'codex' }
  await render()
  assert.match(container.textContent ?? '', /gpt-codex/)
  assert.doesNotMatch(container.textContent ?? '', /claude-opus/)
})

test('nothing for the 优先使用的 Agent but models for the other: the line says tasks go there, and one button switches', async () => {
  const keyId = randomUUID()
  data = { ...data, candidates: [{ harness: 'codex', model: 'gpt-codex', name: 'gpt-codex', provider: 'openai', source: { kind: 'api_key', keyId } }] as OrderView['candidates'] }
  await render()
  assert.ok(container.textContent?.includes('emptyUseOther'), 'not 「订阅和 API Key 还没有报告模型」')
  assert.ok(!container.textContent?.includes('emptyNoModels'))
  await act(async () => button('switchAgent')!.click())
  assert.deepEqual(changes.at(-1), { kind: 'preferred', harness: 'codex' })
})

test('the other Agent\'s list folds under this one as the fallback, an API key marked as billed by its provider', async () => {
  const claude = { ...row(null), model: 'claude-opus' }
  const codex = { ...row(null, { kind: 'api_key', keyId: randomUUID() }), model: 'gpt-codex', harness: 'codex' as const, provider: 'openai', agents: ['codex' as const] }
  data = { ...data, entries: [claude, codex] }
  await render()
  const fold = button('backup')
  assert.ok(fold, 'one line for the fallback list')
  assert.doesNotMatch(container.textContent ?? '', /gpt-codex/, 'folded until tapped')
  await act(async () => fold!.click())
  assert.match(container.textContent ?? '', /gpt-codex/)
  assert.match(container.textContent ?? '', /billedByProvider/)
})
