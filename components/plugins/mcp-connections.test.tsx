import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import type { SWRResponse } from 'swr'
import { Window } from 'happy-dom'
import type { McpWorkspacePage } from '@/lib/plugins/contracts'
import { withBasePath } from '@/lib/base-path'

const translate = (key: string, args?: Record<string, string>) => args ? `${key} ${Object.values(args).join(' ')}` : key
mock.module('@/lib/intl/i18n-client', { namedExports: { useLocale: () => 'en', useTranslations: () => translate } })
mock.module(new URL('./connected-apps.tsx', import.meta.url).href, { namedExports: {
  AppTile: () => <span data-app-icon="mcp" />,
} })

const browser = new Window({ url: 'https://mikka.test/mikka/settings?section=connections' })
let container: HTMLDivElement, root: Root
let createRoot: typeof import('react-dom/client')['createRoot']
let McpConnections: typeof import('./mcp-connections')['McpConnections']
let readMcpConnections: typeof import('./mcp-connections')['readMcpConnections']
let useMcpConnections: typeof import('./mcp-connections')['useMcpConnections']
let page: McpWorkspacePage | undefined, error: Error | undefined
let requests: { url: string; method: string; body?: unknown }[]
let respond: (method: string, body?: unknown) => Promise<Response>
const workspaceId = '00000000-0000-4000-8000-000000000001'
const fixture = (): McpWorkspacePage => ({ workspaceId, workspaceKind: 'team', canShare: true, count: 1, servers: [{
  id: '00000000-0000-4000-8000-000000000002', name: 'Research tools', url: 'https://private.example.com/mcp',
  transport: 'http', enabled: true, revision: 1, authKind: 'header', createdAt: '2026-11-04T00:00:00.000Z',
  ownerId: 'owner', ownerName: 'Connection owner', mine: true, shared: false,
}] })
const mutate = mock.fn(async (next: McpWorkspacePage) => { page = next; error = undefined; return next })

mock.module('swr', { defaultExport: () => ({ data: page, error, mutate, isLoading: !page && !error, isValidating: false }) as unknown as SWRResponse<McpWorkspacePage> })

function Panel({ query, visible }: { query?: string; visible: boolean }) {
  const read = useMcpConnections(workspaceId)
  return visible ? <McpConnections workspaceId={workspaceId} workspaceName="Research workspace" read={read} query={query} /> : null
}
function render(query?: string, visible = true) {
  root.render(<Panel query={query} visible={visible} />)
}
const shareSwitch = () => container.querySelector<HTMLElement>('[role="switch"][aria-label^="shareLabel"]')
const enabledSwitch = () => container.querySelector<HTMLElement>('[role="switch"][aria-label^="enabledLabel"]')
const button = (text: string) => [...document.querySelectorAll('button')].find(value => value.textContent === text) as HTMLButtonElement | undefined

before(async () => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browser })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: browser.document })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: browser.navigator })
  for (const key of ['HTMLElement', 'HTMLButtonElement', 'HTMLInputElement', 'Element', 'Node', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'MutationObserver', 'ResizeObserver'] as const) {
    const value = (browser as unknown as Record<string, unknown>)[key]
    if (value !== undefined) Object.defineProperty(globalThis, key, { configurable: true, value: typeof value === 'function' && /^[a-z]/.test(key) ? (value as (...args: unknown[]) => unknown).bind(browser) : value })
  }
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  ;({ createRoot } = await import('react-dom/client'))
  ;({ McpConnections, readMcpConnections, useMcpConnections } = await import('./mcp-connections'))
})
beforeEach(() => {
  page = fixture(); error = undefined; requests = []
  mutate.mock.resetCalls()
  respond = async (_method, body) => {
    const result = fixture()
    result.servers[0].shared = Boolean((body as { shared?: boolean })?.shared)
    return Response.json(result)
  }
  mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? 'GET', body = init?.body ? JSON.parse(String(init.body)) : undefined
    requests.push({ url: String(url), method, body })
    return respond(method, body)
  })
  container = browser.document.createElement('div') as unknown as HTMLDivElement
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); mock.restoreAll() })
after(() => browser.close())

test('only connection owners in a shareable workspace have a sharing control; peer endpoint stays absent', async () => {
  page!.servers[0] = { ...page!.servers[0], mine: false, shared: true, url: null }
  await act(async () => render())
  assert.equal(shareSwitch(), null)
  assert.equal(enabledSwitch(), null)
  assert.ok(container.textContent?.includes('sharedBy Connection owner'))
  assert.ok(!container.innerHTML.includes('private.example.com'))
  page = { ...fixture(), workspaceKind: 'personal', canShare: false }
  await act(async () => render())
  assert.equal(shareSwitch(), null)
  assert.equal(enabledSwitch()?.getAttribute('aria-checked'), 'true')
  assert.ok(container.textContent?.includes('onlyYou'))
  assert.equal(requests.length, 0)
})

test('owner confirms current workspace and authority before the exact normal share PATCH', async () => {
  await act(async () => render())
  await act(async () => shareSwitch()!.click())
  assert.equal(requests.length, 0)
  assert.ok(document.body.textContent?.includes('confirmTitle Research tools Research workspace'))
  assert.ok(document.body.textContent?.includes('confirmAuthority'))
  await act(async () => button('cancel')!.click())
  assert.equal(requests.length, 0)
  await act(async () => shareSwitch()!.click())
  await act(async () => button('confirmShare')!.click())
  assert.deepEqual(requests, [{ url: withBasePath('/api/integrations/mcp/shares'), method: 'PATCH',
    body: { serverId: fixture().servers[0].id, workspaceId, shared: true } }])
  assert.equal(shareSwitch()!.getAttribute('aria-checked'), 'true')
})

test('unconfirmed revoke disables writes and checks persisted state without repeating the mutation', async () => {
  page!.servers[0].shared = true
  respond = async method => {
    if (method === 'PATCH') throw new TypeError('Response lost after the server applied the revoke')
    return Response.json(fixture())
  }
  await act(async () => render())
  await act(async () => shareSwitch()!.click())
  assert.ok(container.textContent?.includes('shareUnconfirmed'))
  assert.equal(shareSwitch()!.getAttribute('aria-disabled'), 'true')
  assert.equal(requests.length, 1)
  assert.deepEqual(requests[0].body, { serverId: fixture().servers[0].id, workspaceId, shared: false })
  await act(async () => button('checkAgain')!.click())
  assert.deepEqual(requests.map(value => value.method), ['PATCH', 'GET'])
  assert.ok(requests[1].url.includes(`workspaceId=${workspaceId}`))
  assert.equal(shareSwitch()!.getAttribute('aria-checked'), 'false')
  assert.notEqual(shareSwitch()!.getAttribute('aria-disabled'), 'true')
  assert.ok(!container.textContent?.includes('shareUnconfirmed'))
})

test('an owner can disable and re-enable their connection through the existing endpoint', async () => {
  const server = fixture().servers[0]
  const saved = fixture()
  saved.servers[0].shared = true
  respond = async (method, body) => {
    if (method !== 'PATCH') return Response.json(saved)
    saved.servers[0].enabled = (body as { enabled: boolean }).enabled
    saved.servers[0].revision++
    return Response.json({ server: saved.servers[0] })
  }
  await act(async () => render())
  assert.equal(enabledSwitch()?.getAttribute('aria-checked'), 'true')
  await act(async () => enabledSwitch()!.click())
  assert.deepEqual(requests, [
    { url: withBasePath('/api/integrations/mcp'), method: 'PATCH', body: { id: server.id, enabled: false } },
    { url: withBasePath(`/api/integrations/mcp?workspaceId=${workspaceId}`), method: 'GET', body: undefined },
  ])
  assert.equal(enabledSwitch()?.getAttribute('aria-checked'), 'false')
  assert.equal(shareSwitch()?.getAttribute('aria-checked'), 'true')
  assert.equal(button('viewTools'), undefined)
  await act(async () => enabledSwitch()!.click())
  assert.deepEqual(requests[2].body, { id: server.id, enabled: true })
  assert.equal(requests[3].method, 'GET')
  assert.equal(enabledSwitch()?.getAttribute('aria-checked'), 'true')
  assert.ok(button('viewTools'))
})

test('an uncertain enabled change remains blocked after switching tabs and can be checked without another write', async () => {
  const saved = fixture()
  saved.servers[0].enabled = false
  respond = async method => {
    if (method === 'PATCH') throw new TypeError('Response lost after the server disabled the connection')
    return Response.json(saved)
  }
  await act(async () => render())
  await act(async () => enabledSwitch()!.click())
  assert.ok(container.textContent?.includes('enabledUnconfirmed'))
  await act(async () => render('', false))
  await act(async () => render())
  assert.equal(enabledSwitch()?.getAttribute('aria-disabled'), 'true')
  await act(async () => button('checkAgain')!.click())
  assert.deepEqual(requests.map(value => value.method), ['PATCH', 'GET'])
  assert.equal(enabledSwitch()?.getAttribute('aria-checked'), 'false')
  assert.notEqual(enabledSwitch()?.getAttribute('aria-disabled'), 'true')
})

test('the MCP tab search trims and filters names without matching private endpoints', async () => {
  await act(async () => render('  RESEArch  '))
  assert.ok(container.textContent?.includes('Research tools'))
  assert.equal(requests.length, 0)
  await act(async () => render('private.example.com'))
  assert.ok(container.textContent?.includes('noMatches'))
  assert.ok(!container.textContent?.includes('Research tools'))
  assert.ok(button('add'))
  assert.equal(requests.length, 0)
})

test('read failure remains visible and an unexpected workspace response is rejected', async () => {
  page = undefined; error = new Error('Disconnected')
  respond = async () => Response.json({ ...fixture(), workspaceId: 'another-workspace' })
  await act(async () => render())
  assert.ok(container.textContent?.includes('loadFailed'))
  assert.equal(shareSwitch(), null)
  await assert.rejects(readMcpConnections(workspaceId), /workspace response mismatch/)
  await act(async () => button('checkAgain')!.click())
  assert.ok(container.textContent?.includes('loadFailed'))
  assert.equal(mutate.mock.callCount(), 0)
})

test('an empty connections list still offers the native MCP form and clears credentials on close', async () => {
  page!.servers = []
  await act(async () => render())
  assert.ok(container.textContent?.includes('empty'))
  await act(async () => button('add')!.click())
  assert.ok(document.querySelector('#mcp-url'))
  assert.equal(document.querySelector('#mcp-command'), null)
  const select = document.querySelector<HTMLSelectElement>('#mcp-transport')!
  await act(async () => {
    select.value = 'stdio'
    select.dispatchEvent(new browser.Event('change', { bubbles: true }) as unknown as Event)
  })
  assert.equal(document.querySelector('#mcp-url'), null)
  assert.ok(document.querySelector('#mcp-command'))
  assert.ok(document.querySelector('#mcp-args'))
  assert.ok(document.querySelector('#mcp-cwd'))
  assert.ok(document.body.textContent?.includes('taskReadable'))
  await act(async () => button('addVariable')!.click())
  assert.equal(document.querySelector('input[aria-label="variableValue 1"]')?.getAttribute('type'), 'password')
  await act(async () => button('cancel')!.click())
  await act(async () => button('add')!.click())
  assert.equal(document.querySelector('input[type="password"]'), null)
  assert.equal(requests.length, 0)
})

test('the owner opens a live tool page, follows its cursor and retries a fresh read without changing the connection', async () => {
  const serverId = fixture().servers[0].id
  let names = ['first'], unavailable = false
  respond = async (method, body) => {
    assert.equal(method, 'POST')
    assert.equal((body as { serverId: string }).serverId, serverId)
    if (unavailable) return new Response(null, { status: 503 })
    const following = (body as { cursor?: string }).cursor === 'two'
    return Response.json({ serverId, tools: (following ? ['last'] : names).map(name => ({ name })), nextCursor: following ? null : 'two' })
  }
  await act(async () => render())
  assert.equal(requests.length, 0)
  await act(async () => button('viewTools')!.click())
  assert.ok(document.body.textContent?.includes('first'))
  await act(async () => button('nextTools')!.click())
  assert.ok(document.body.textContent?.includes('last'))
  assert.equal(button('nextTools'), undefined)
  unavailable = true
  await act(async () => button('refreshTools')!.click())
  assert.ok(document.body.textContent?.includes('toolsFailed'))
  assert.ok(!document.body.textContent?.includes('last'))
  unavailable = false; names = []
  await act(async () => button('checkAgain')!.click())
  assert.ok(document.body.textContent?.includes('emptyTools'))
  assert.deepEqual(requests.map(row => row.body), [{ serverId }, { serverId, cursor: 'two' }, { serverId }, { serverId }])
  assert.ok(requests.every(row => row.url === withBasePath('/api/integrations/mcp/refresh')))
})

test('shared, disabled and machine-local MCP installations have no owner remote-discovery control', async () => {
  for (const state of [{ mine: false, shared: true }, { enabled: false }, { transport: 'stdio' as const }]) {
    page = fixture()
    Object.assign(page.servers[0], state)
    await act(async () => render())
    assert.equal(button('viewTools'), undefined)
  }
  assert.equal(requests.length, 0)
})
