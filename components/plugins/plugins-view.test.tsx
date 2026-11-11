import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act, type ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import { Window } from 'happy-dom'
import type { McpWorkspacePage } from '@/lib/plugins/contracts'

type App = 'github' | 'linear' | 'telegram'
type State = 'connected' | 'notConnected' | 'paused' | null
type Read = { states: Partial<Record<App, State>>; failed: App[]; codes?: Partial<Record<App, string>> }
let read: { data?: Read; error?: Error; isLoading?: boolean; isValidating?: boolean }
let ownFetcher: () => Promise<Read>
let mcpRead: { data?: McpWorkspacePage; error?: Error }
const retry = mock.fn(async () => undefined)
const names = { github: 'GitHub', linear: 'Linear', telegram: 'Telegram' }
const t = (key: string, args?: Record<string, string>) => key === 'connectionStatusFailed' ? `Could not read ${args?.names}` : key
mock.module('next-intl', { namedExports: { useTranslations: () => t } })
mock.module('swr', { defaultExport: (key: unknown, fetcher: () => Promise<Read>) => {
  if (key === null) return { mutate: retry }
  if (Array.isArray(key) && key[0] === 'settings:mcp-connections') return { ...mcpRead, mutate: retry }
  ownFetcher = fetcher
  return { ...read, mutate: retry }
}, namedExports: { useSWRConfig: () => ({ cache: new Map([['plugin-own-app-states', { data: read.data }]]) }) } })
mock.module('swr/infinite', { defaultExport: () => ({ size: 1, setSize: async () => undefined }) })
let connected: { loading: boolean; error: string; connectedToolkits(): string[]; accountsFor(): never[]; pending: string; canLink: boolean }
mock.module(new URL('./connected-apps.tsx', import.meta.url).href, { namedExports: {
  OWN_APPS: ['github', 'linear', 'telegram'], isOwnApp: (id: string) => Object.hasOwn(names, id),
  useConnectedApps: () => connected, useAppInfo: () => (id: App) => ({ name: names[id], iconUrl: null }),
  useStoreCatalog: () => ({ data: { apps: [], popular: [], latest: [], categories: [] } }),
  ConnectedAppsStatus: () => connected.error ? <p role="alert">Composio read failed</p> : null,
  PluginRow: ({ app, name, children }: { app: string; name: string; children: ReactNode }) => <div data-native-app={app}>{name}{children}</div>,
  ConnectedAppRow: ({ app }: { app: string }) => <div>{app}</div>, AppTile: () => null,
  ConnectedAppDetail: () => null, PluginBreadcrumb: () => null,
} })
mock.module(new URL('./credential-dialog.tsx', import.meta.url).href, { namedExports: { CredentialDialog: () => null } })
mock.module(new URL('./github-settings.tsx', import.meta.url).href, { namedExports: { GitHubSettings: () => null } })
mock.module(new URL('../settings/linear-settings.tsx', import.meta.url).href, { namedExports: { LinearSettings: () => null } })
mock.module(new URL('../settings/telegram-settings.tsx', import.meta.url).href, { namedExports: { TelegramSettings: () => null } })
const linear = mock.fn(async () => ({ configured: true, connected: true }))
const telegram = mock.fn(async () => ({ configured: true, connected: true }))
mock.module(new URL('../../app/actions/linear-sync.ts', import.meta.url).href, { namedExports: { getLinearIntegrationState: linear } })
mock.module(new URL('../../app/actions/telegram.ts', import.meta.url).href, { namedExports: { getTelegramIntegrationStatus: telegram } })
mock.module('@/i18n/navigation', { namedExports: { Link: ({ children }: { children: ReactNode }) => <span>{children}</span> } })

const browser = new Window({ url: 'https://mikka.test/settings?section=connections' })
let container: HTMLDivElement, root: Root
let createRoot: typeof import('react-dom/client')['createRoot']
// Exercise the public controllers and their loading/error components. The trusted
// paired build exercises the private store and settings screens themselves.
mock.module('@ui-slot/settings-connections', { namedExports: {
  AppPage: () => null,
  ConnectionsList: (props: Parameters<typeof ConnectedList>[0]) => <ConnectedList {...props} />,
} })
mock.module('@ui-slot/plugins', { namedExports: {
  PluginsPage: () => <OwnAppsStatus read={usePluginsView('plugins').ownRead} />,
} })
let usePluginsView: typeof import('./plugins-view')['usePluginsView']
let ConnectedList: typeof import('./connected-list')['ConnectedList']
let OwnAppsStatus: typeof import('./connected-list')['OwnAppsStatus']
let PluginsView: typeof import('./plugins-view')['PluginsView']
let fetchOwnAppStates: (previous?: Partial<Record<App, State>>) => Promise<Read>
let githubResponse: { ok: boolean; data?: unknown }, linearResponse: { ok: boolean; data?: unknown }
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
  const module = await import('./plugins-view')
  usePluginsView = module.usePluginsView
  const shared = await import('./connected-list')
  ConnectedList = shared.ConnectedList
  OwnAppsStatus = shared.OwnAppsStatus
  PluginsView = module.PluginsView
  fetchOwnAppStates = module.fetchOwnAppStates as unknown as typeof fetchOwnAppStates
})
beforeEach(() => {
  read = { data: { states: { github: null, linear: null, telegram: null }, failed: [] } }
  mcpRead = {}
  connected = { loading: false, error: '', connectedToolkits: () => [], accountsFor: () => [], pending: '', canLink: true }
  retry.mock.resetCalls(); linear.mock.resetCalls(); telegram.mock.resetCalls()
  linear.mock.mockImplementation(async () => ({ configured: true, connected: true }))
  telegram.mock.mockImplementation(async () => ({ configured: true, connected: true }))
  githubResponse = { ok: true, data: { configured: true, connected: true, installed: true } }
  linearResponse = { ok: true, data: { enabled: true } }
  mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    const result = String(url).includes('/github') ? githubResponse : linearResponse
    return { ok: result.ok, json: async () => result.data } as Response
  })
  container = browser.document.createElement('div') as unknown as HTMLDivElement
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); mock.restoreAll() })
after(() => browser.close())
const render = async (section: 'connections' | 'plugins' = 'connections', workspaceId?: string) => { await act(async () => root.render(<PluginsView section={section} rootLabel="Connections" workspaceId={workspaceId} />)) }
const retryButton = () => [...container.querySelectorAll('button')].find(item => item.textContent === 'retry')

test('successfully empty connections show the empty state', async () => {
  await render()
  assert.ok(container.textContent?.includes('noConnections'))
  assert.equal(container.querySelector('[role="alert"]'), null)
})

test('custom MCP connections and their read failures participate in the existing Connections empty state', async () => {
  const workspaceId = '00000000-0000-4000-8000-000000000001'
  mcpRead = { data: { workspaceId, workspaceKind: 'team', canShare: true, count: 1, servers: [{
    id: '00000000-0000-4000-8000-000000000002', name: 'Research MCP', url: null, transport: 'http',
    enabled: true, revision: 1, authKind: 'header', createdAt: '2026-11-04T00:00:00.000Z',
    ownerId: 'peer', ownerName: 'Peer', mine: false, shared: true,
  }] } }
  await render('connections', workspaceId)
  assert.ok(container.textContent?.includes('Research MCP'))
  assert.ok(!container.textContent?.includes('noConnections'))
  mcpRead = { error: new Error('Unavailable') }
  await render('connections', workspaceId)
  assert.ok(container.querySelector('[role="alert"]')?.textContent?.includes('loadFailed'))
  assert.ok(!container.textContent?.includes('noConnections'))
  mcpRead = { data: { workspaceId, workspaceKind: 'team', canShare: true, count: 0, servers: [] } }
  await render('connections', workspaceId)
  assert.ok(container.textContent?.includes('noConnections'))
})

test('initial native reads show loading without claiming no connections', async () => {
  read = { isLoading: true }
  await render()
  assert.ok(container.querySelector('[role="status"]'))
  assert.ok(!container.textContent?.includes('noConnections'))
})

for (const app of ['github', 'linear', 'telegram'] as const) {
  test(`${app} first read failure is visible and retries without a false empty state`, async () => {
    read = { data: { states: {}, failed: [app] } }
    await render()
    assert.ok(container.querySelector('[role="alert"]')?.textContent?.includes(names[app]))
    assert.ok(!container.textContent?.includes('noConnections'))
    await act(async () => retryButton()!.click())
    assert.equal(retry.mock.callCount(), 1)
  })
}

test('a failed refresh preserves the last known connected row and names the failed app', async () => {
  read = { data: { states: { github: 'connected', linear: null, telegram: null }, failed: ['github'] } }
  await render()
  assert.ok(container.querySelector('[data-native-app="github"]')?.textContent?.includes('state.connected'))
  assert.ok(container.querySelector('[role="alert"]')?.textContent?.includes('GitHub'))
  assert.ok(!container.textContent?.includes('noConnections'))
})

test('Composio failure does not claim that the whole connection list is empty', async () => {
  connected.error = 'read failed'
  await render()
  assert.ok(!container.textContent?.includes('noConnections'))
})

test('the plugin store also shows native status failures with retry', async () => {
  read = { data: { states: {}, failed: ['linear'] } }
  await render('plugins')
  assert.ok(container.querySelector('[role="alert"]')?.textContent?.includes('Linear'))
  assert.ok(retryButton())
})

test('successful native reads retain meaningful configured, connected and paused states', async () => {
  assert.deepEqual(await fetchOwnAppStates(), { states: { github: 'connected', linear: 'connected', telegram: 'connected' }, failed: [], codes: {} })
  githubResponse.data = { configured: false }
  linearResponse.data = { enabled: false }
  telegram.mock.mockImplementation(async () => ({ configured: false, connected: false }))
  assert.deepEqual(await fetchOwnAppStates(), { states: { github: null, linear: 'paused', telegram: null }, failed: [], codes: {} })
})

for (const app of ['github', 'linear', 'telegram'] as const) {
  test(`${app} HTTP/action failure stays unknown and preserves its previous successful state`, async () => {
    if (app === 'github') githubResponse = { ok: false }
    else if (app === 'linear') linearResponse = { ok: false }
    else telegram.mock.mockImplementation(async () => { throw new Error('private upstream details') })
    const first = await fetchOwnAppStates()
    assert.equal(first.states[app], undefined)
    assert.deepEqual(first.failed, [app])
    // 详情 carries a code and the cause's kind, never the upstream message.
    assert.match(first.codes?.[app] ?? '', new RegExp(`^${app}_status_failed \\(`))
    assert.ok(!first.codes?.[app]?.includes('private upstream details'))
    const refreshed = await fetchOwnAppStates({ [app]: 'connected' })
    assert.equal(refreshed.states[app], 'connected')
    assert.deepEqual(refreshed.failed, [app])
    if (app === 'linear') assert.equal(linear.mock.callCount(), 0, 'unreadable deployment status cannot establish paused or connected')
  })
}


test('an unreadable Linear flag (PostHog timeout, quota) is no read failure: the row keeps its state, else paused', async () => {
  linearResponse = { ok: true, data: { enabled: false, state: 'unavailable' } }
  assert.deepEqual(await fetchOwnAppStates({ linear: 'connected' }), { states: { github: 'connected', linear: 'connected', telegram: 'connected' }, failed: [], codes: {} })
  assert.deepEqual(await fetchOwnAppStates(), { states: { github: 'connected', linear: 'paused', telegram: 'connected' }, failed: [], codes: {} })
  assert.equal(linear.mock.callCount(), 0)
})

test('without PostHog the status route says disabled, so Linear shows paused with no banner', async () => {
  linearResponse = { ok: true, data: { enabled: false, state: 'disabled' } }
  assert.deepEqual(await fetchOwnAppStates(), { states: { github: 'connected', linear: 'paused', telegram: 'connected' }, failed: [], codes: {} })
})

test('a malformed answer from our own status endpoint is still a read failure', async () => {
  linearResponse = { ok: true, data: { state: 'enabled' } }
  assert.deepEqual(await fetchOwnAppStates({ linear: 'connected' }), { states: { github: 'connected', linear: 'connected', telegram: 'connected' }, failed: ['linear'], codes: { linear: 'linear_status_failed (malformed)' } })
})

test('revalidation reads the existing SWR cache so a failed refresh retains its connected row', async () => {
  read = { data: { states: { github: 'connected', linear: null, telegram: null }, failed: [] } }
  githubResponse = { ok: false }
  await render()
  const result = await ownFetcher()
  assert.equal(result.states.github, 'connected')
  assert.deepEqual(result.failed, ['github'])
  read = { data: result }
  await render()
  assert.ok(container.querySelector('[data-native-app="github"]'))
  assert.ok(container.querySelector('[role="alert"]')?.textContent?.includes('GitHub'))
})
