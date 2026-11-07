import assert from 'node:assert/strict'
import test, { after, afterEach, before, beforeEach, mock } from 'node:test'
import { act, createElement } from 'react'
import { Window } from 'happy-dom'
import { LIVE_KINDS } from '../../../lib/live/events.ts'
import { homeScopeProof, readHomeScopeProof } from '../../../lib/live/home-scope-proof.ts'
import { devicePresenceGrant, readDevicePresenceGrant } from '../../../lib/device-presence-grant.ts'
import { liveTicket } from '../../../lib/live/scope.ts'
import type { Threads } from '../lib/types.ts'

// Real hooks, API adapter, ticket adapter and LiveChannel; only native platform,
// session storage, transport and time are ports. No screen/browser or DB starts.
const home = '19df8afd-0f8c-4c6b-bc9c-20df0b046a72', team = 'e4ec7f73-0a59-4ad4-8b3c-41f8cd510c6d'
const device = '20000000-0000-4000-8000-000000000001', secret = 'mobile-hook-local-fixture'
const origin = 'https://app.test', start = 1_800_000_000_000
const browser = new Window({ url: origin })
const listeners = new Set<(state: string) => void>()
const appState = { currentState: 'active', addEventListener: (_event: string, listener: (state: string) => void) => { listeners.add(listener); return { remove: () => { listeners.delete(listener) } } } }
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)) }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
let owner = 'owner', legacy = false, deviceOnline = true, presenceSupported = true, acknowledge = true, ticketAvailable = true
let nextThread: ReturnType<typeof deferred<void>> | null = null, nextTicket: ReturnType<typeof deferred<void>> | null = null
let nextHeaders: ReturnType<typeof deferred<void>> | null = null
const requests: { path: string; scope: string | null; at: number }[] = [], sockets: Socket[] = []
type Watch = { type: 'presence_watch'; id: string; token: string }
class Socket {
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  commands: Watch[] = []
  constructor(readonly url: string, readonly protocol: string) { sockets.push(this) }
  message(value: unknown) { this.onmessage?.({ data: typeof value === 'string' ? value : JSON.stringify(value) }) }
  open() {
    if (this.readyState === 3) return
    this.readyState = 1; this.onopen?.()
    this.message({ type: 'live_ready', version: 1, kinds: LIVE_KINDS })
    if (presenceSupported) this.message({ type: 'presence_ready', version: 1 })
  }
  send(value: string) {
    if (value === 'ping') { queueMicrotask(() => this.message('pong')); return }
    const command = JSON.parse(value)
    if (command.type !== 'presence_watch') return
    this.commands.push(command)
    if (acknowledge) queueMicrotask(() => this.ack(command))
  }
  ack(command = this.commands.at(-1)!) {
    const channel = new URL(this.url).pathname.split('/')[3]
    const grant = readDevicePresenceGrant(command.token, channel, secret)
    assert.ok(grant, 'the watch must carry the actual data response grant for this ticket channel')
    this.message({ type: 'presence_ack', id: command.id, expiresAt: grant.expiresAt })
  }
  close() { this.readyState = 3 }
}

let api: typeof import('../lib/api.ts'), hooks: typeof import('../lib/useApi.ts'), live: typeof import('../lib/live.ts')
let cache: typeof import('../lib/api-cache.ts').apiCache, proofs: typeof import('../lib/presence-scope.ts').presenceScope
let keys: typeof import('../lib/live-keys.ts'), createRoot: typeof import('react-dom/client').createRoot
let view: ReturnType<typeof createRoot> | null = null, container: HTMLElement | null = null
let state: ReturnType<typeof hooks.useLiveApi<Threads>> | null = null
function Page() { state = hooks.useLiveApi<Threads>('/api/mobile/threads', data => keys.threadsLive(data, home)); return null }
const count = (path: string) => requests.filter(request => request.path === path).length
const reads = () => count('/api/mobile/threads'), tickets = () => count('/api/live/ticket')

before(async () => {
  mock.timers.enable({ apis: ['Date', 'setTimeout'], now: start })
  mock.method(performance, 'now', () => Date.now() - start)
  for (const [key, value] of Object.entries({ window: browser, document: browser.document, navigator: browser.navigator, HTMLElement: browser.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true, WebSocket: Socket })) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  mock.module('react-native', { namedExports: { AppState: appState, Platform: { OS: 'ios' } } })
  mock.module('expo-secure-store', { namedExports: { getItemAsync: async () => { const wait = nextHeaders; nextHeaders = null; await wait?.promise; return null }, setItemAsync: async () => {} } })
  mock.module(new URL('../lib/auth.ts', import.meta.url).href, { namedExports: { authClient: { getCookie: async () => `fixture-session=${owner}` } } })
  mock.module(new URL('../lib/config.ts', import.meta.url).href, { namedExports: {
    API_URL: origin,
    currentAccount: () => ({ id: 'fixture-server', user: { id: owner }, server: { url: origin } }),
    onServerChange: () => () => {},
  } })
  mock.module(new URL('../lib/session.ts', import.meta.url).href, { namedExports: { endLostSession: async () => {} } })
  mock.module(new URL('../lib/tracing.ts', import.meta.url).href, { namedExports: { mobileTraceHeaders: () => ({}) } })
  mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input)), proof = new Headers(init?.headers).get('x-mikka-presence-scope')
    requests.push({ path: url.pathname, scope: proof, at: Date.now() })
    if (url.pathname === '/api/live/ticket') {
      const requested = url.searchParams.get('workspace')!, scope = { ownerId: owner, workspaceId: requested }
      const ticket = liveTicket(scope, { url: 'https://gateway.test', secret })
      const receipt = requested === home ? homeScopeProof(scope, ticket.expiresAt, secret) : null
      const value = ticketAvailable ? { ...ticket, ...(receipt ? { homeScope: receipt } : {}) } : null
      const wait = nextTicket; nextTicket = null; await wait?.promise
      return Response.json(value, { status: value ? 200 : 403 })
    }
    if (url.pathname === '/api/mobile/threads') {
      const scope = proof ? readHomeScopeProof(proof, owner, secret) : null
      const presence = scope ? devicePresenceGrant(scope, [[device, deviceOnline, 0]], secret, Date.now(), scope.expiresAt) : null
      const result: Threads = { threads: [], devices: [{ id: device, name: 'Owned fixture', kind: 'laptop', online: deviceOnline }],
        ...(!legacy ? { live: { ownerId: owner, workspaceId: scope?.workspaceId ?? null, presence } } : {}) }
      const wait = nextThread; nextThread = null; await wait?.promise
      return Response.json(result)
    }
    if (url.pathname === '/api/mobile/other') return Response.json({})
    assert.fail(`unexpected fixture request: ${url.pathname}`)
  })
  api = await import('../lib/api.ts')
  hooks = await import('../lib/useApi.ts')
  live = await import('../lib/live.ts')
  cache = (await import('../lib/api-cache.ts')).apiCache
  proofs = (await import('../lib/presence-scope.ts')).presenceScope
  keys = await import('../lib/live-keys.ts')
  ;({ createRoot } = await import('react-dom/client'))
})
beforeEach(() => {
  owner = 'owner'; legacy = false; deviceOnline = true; presenceSupported = true; acknowledge = true; ticketAvailable = true
  nextThread = null; nextTicket = null; nextHeaders = null; state = null
  cache.setIdentity(`fixture-server:${owner}`, owner); hooks.clearApiCache(); appState.currentState = 'active'
  requests.length = 0; sockets.length = 0
})
afterEach(async () => {
  if (view) { await act(async () => { view!.unmount() }); view = null }
  container?.remove(); container = null
  hooks.clearApiCache()
  assert.equal(listeners.size, 0, 'unmount and reset remove all native foreground listeners')
})
after(async () => { mock.timers.reset(); mock.restoreAll(); await browser.happyDOM.close() })

async function mount() {
  container = browser.document.createElement('div') as unknown as HTMLElement; document.body.append(container)
  view = createRoot(container)
  await act(async () => { view!.render(createElement(Page)); await flush() })
}
async function advance(ms: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += 1000) await act(async () => { mock.timers.tick(Math.min(1000, ms - elapsed)); await flush() })
}
async function open() { await act(async () => { sockets.at(-1)!.open(); await flush() }); await advance(2_100) }

test('the actual hook uses one startup ticket and the existing catch-up, then acknowledged idle reads nothing', async () => {
  await mount()
  assert.equal(reads(), 1)
  assert.equal(tickets(), 1, 'new response metadata must not recreate the home subscription')
  assert.equal(proofs.token() !== null, true)
  await open()
  assert.equal(reads(), 2)
  assert.equal(tickets(), 1)
  assert.ok(sockets.at(-1)!.commands.length)
  await advance(65_000)
  assert.equal(reads(), 2, 'a healthy acknowledged minute has zero business requests')
  assert.equal(tickets(), 1)
})

test('presence support alone keeps the existing minute read until this exact watch is acknowledged', async () => {
  acknowledge = false
  await mount(); await open()
  assert.equal(reads(), 2); assert.equal(tickets(), 1)
  await advance(65_000)
  assert.equal(reads(), 3, 'no ACK leaves the original fallback on')
  await act(async () => { sockets.at(-1)!.ack(); await flush() })
  await advance(65_000)
  assert.equal(reads(), 3, 'the matching ACK stops fallback without a read')
  assert.equal(tickets(), 1)
})

test('legacy online responses keep one minute fallback without recreating the ticket', async () => {
  legacy = true
  await mount(); await open(); await advance(65_000)
  assert.equal(reads(), 3); assert.equal(tickets(), 1)
  assert.equal(sockets[0].commands.length, 0)
})

test('legacy all-offline responses retain their healthy zero-read behavior', async () => {
  legacy = true; deviceOnline = false
  await mount(); await open(); await advance(65_000)
  assert.equal(reads(), 2); assert.equal(tickets(), 1)
  assert.equal(sockets[0].commands.length, 0)
})

test('new all-offline devices still install a reconnect watch and an old Worker keeps fallback', async () => {
  deviceOnline = false
  await mount(); await open(); await advance(65_000)
  assert.equal(reads(), 2); assert.equal(tickets(), 1)
  assert.equal(sockets[0].commands.length, 1)
  await act(async () => { view!.unmount(); view = null }); container?.remove(); container = null
  hooks.clearApiCache(); requests.length = 0; sockets.length = 0
  presenceSupported = false
  await mount(); await open(); await advance(65_000)
  assert.equal(reads(), 3); assert.equal(tickets(), 1)
  assert.equal(sockets[0].commands.length, 0, 'old Workers never falsely acknowledge coverage')
})

test('the initial in-flight read absorbs open catch-up and only the original fallback gets the first grant', async () => {
  const pending = deferred<void>(); nextThread = pending
  await mount(); await open()
  assert.equal(reads(), 1); assert.equal(tickets(), 1)
  assert.equal(requests.find(request => request.path === '/api/mobile/threads')!.scope, null)
  await act(async () => { pending.resolve(); await flush() })
  await advance(2_100)
  assert.equal(reads(), 1, 'no trailing read is added to repair this first-read race')
  await advance(65_000)
  assert.equal(reads(), 2); assert.equal(tickets(), 1)
  assert.equal(sockets[0].commands.length, 1)
  await advance(65_000)
  assert.equal(reads(), 2)
})

test('replacing a grant updates the hook and rejects the old watch ACK without a new ticket', async () => {
  await mount(); await open()
  const socket = sockets[0], old = socket.commands[0]
  acknowledge = false; deviceOnline = false
  await act(async () => { socket.message({ kind: 'device_list', id: home }); await flush() })
  await advance(2_100)
  assert.equal(reads(), 3); assert.equal(tickets(), 1)
  assert.equal(socket.commands.length, 2)
  assert.notEqual(socket.commands[1].id, old.id)
  await act(async () => { socket.ack(old); await flush() })
  await advance(65_000)
  assert.equal(reads(), 4, 'an ACK for the removed watch cannot stop the new grant\'s fallback')
  await act(async () => { socket.ack(); await flush() })
  await advance(65_000)
  assert.equal(reads(), 4); assert.equal(tickets(), 1)
})

test('five-minute renewal uses its existing ticket and open catch-up only', async () => {
  await mount(); await open()
  const expires = readHomeScopeProof(proofs.token()!, owner, secret)!.expiresAt
  await advance(expires - Date.now() + 1)
  assert.equal(tickets(), 2); assert.equal(reads(), 2, 'expiry alone does not issue a data request')
  await open()
  assert.equal(tickets(), 2); assert.equal(reads(), 3)
  assert.equal(sockets[0].readyState, 3)
  assert.equal(sockets[1].commands.length, 1)
  await advance(65_000)
  assert.equal(tickets(), 2); assert.equal(reads(), 3)
})

test('a refused renewal drops the expired proof and resumes only the existing minute fallback', async () => {
  await mount(); await open()
  const expires = readHomeScopeProof(proofs.token()!, owner, secret)!.expiresAt
  ticketAvailable = false
  await advance(expires - Date.now() + 1)
  assert.equal(tickets(), 2); assert.equal(reads(), 2)
  assert.equal(proofs.token(), null)
  assert.equal(sockets[0].readyState, 3)
  await advance(65_000)
  assert.equal(reads(), 3, 'one ordinary fallback read after expiry, not a new expiry-triggered read')
  assert.equal(tickets(), 3, 'only the existing unavailable-channel retry')
  assert.equal(requests.at(-1)!.scope, null)
})

test('renewal racing an ordinary in-flight read keeps fallback until the next existing minute', async () => {
  await mount(); await open()
  const expires = readHomeScopeProof(proofs.token()!, owner, secret)!.expiresAt
  await advance(expires - Date.now() - 5_000)
  const pending = deferred<void>(); nextThread = pending
  let loaded!: Promise<void>
  await act(async () => { loaded = state!.reload(); await flush() })
  assert.equal(reads(), 3)
  await advance(5_001); await open()
  assert.equal(reads(), 3); assert.equal(tickets(), 2)
  await act(async () => { pending.resolve(); await loaded; await flush() })
  await advance(2_100)
  assert.equal(reads(), 3, 'no newly added trailing read after the expired result')
  await advance(65_000)
  assert.equal(reads(), 4); assert.equal(tickets(), 2)
  assert.equal(sockets[1].commands.length, 1)
  await advance(65_000)
  assert.equal(reads(), 4)
})

test('workspace switching reuses the same home, while background and unmount stop requests', async () => {
  await mount(); await open()
  await act(async () => { await api.saveWorkspace(team); await flush() })
  assert.equal(reads(), 3); assert.equal(tickets(), 1)
  assert.ok(requests.at(-1)!.scope, 'the existing post-switch read can use this owner\'s home')
  await act(async () => { appState.currentState = 'background'; for (const listener of [...listeners]) listener('background'); await flush() })
  const before = requests.length
  await advance(10 * 60_000)
  assert.equal(requests.length, before)
  assert.equal(sockets[0].readyState, 3)
  await act(async () => { view!.unmount(); view = null })
  await advance(10 * 60_000)
  assert.equal(requests.length, before)
})

test('late old-account tickets cannot restore cleared proof or open a former account socket', async () => {
  const pending = deferred<void>(); nextTicket = pending
  await mount()
  assert.equal(tickets(), 1); assert.equal(sockets.length, 0)
  await act(async () => { owner = 'next-owner'; cache.setIdentity(`fixture-server:${owner}`, owner); hooks.clearApiCache(); await flush() })
  assert.equal(tickets(), 2); assert.equal(sockets.length, 1)
  assert.ok(readHomeScopeProof(proofs.token()!, owner, secret))
  await act(async () => { pending.resolve(); await flush() })
  assert.equal(sockets.length, 1)
  assert.ok(readHomeScopeProof(proofs.token()!, owner, secret))
  assert.equal(readHomeScopeProof(proofs.token()!, 'owner', secret), null)
  await open()
  await act(async () => { view!.unmount(); view = null; hooks.clearApiCache(); await flush() })
  assert.equal(proofs.token(), null)
  const before = requests.length
  await advance(65_000)
  assert.equal(requests.length, before)
})

test('the actual API attaches home routing only to the current ordinary thread GET', async () => {
  const issued = liveTicket({ ownerId: owner, workspaceId: home }, { url: 'https://gateway.test', secret })
  proofs.remember(home, { ...issued, homeScope: homeScopeProof({ ownerId: owner, workspaceId: home }, issued.expiresAt, secret) }, proofs.begin())
  await api.api('/api/mobile/threads')
  await api.api('/api/mobile/other')
  await api.api('/api/mobile/threads', { method: 'POST', body: {} })
  assert.ok(requests[0].scope)
  assert.equal(requests[1].scope, null); assert.equal(requests[2].scope, null)
  const pending = deferred<void>(); nextHeaders = pending
  const request = api.api('/api/mobile/threads')
  cache.clear(); pending.resolve(); await request
  assert.equal(requests.at(-1)!.scope, null, 'a request awaiting old-context session headers cannot use the current proof')
})
