import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import type { State } from 'swr'
import { Window } from 'happy-dom'
import { LIVE_KINDS } from '../lib/live/events'
import type { DesktopNotification, DesktopRun } from '../lib/platform/desktop-notifications'
import type { LocalDevice } from '@mikka/protocol/bridge'

const home = '10000000-0000-4000-8000-000000000001'
const otherHome = '10000000-0000-4000-8000-000000000002'
const issueId = '20000000-0000-4000-8000-000000000001'
const runId = '30000000-0000-4000-8000-000000000001'
const deferred = <T,>() => {
  let resolve!: (value: T) => void
  return { promise: new Promise<T>(done => { resolve = done }), resolve: (value: T) => resolve(value) }
}
type Choice = { ids: string[]; result: ReturnType<typeof deferred<{ show: string[] }>> }
type Snapshot = { items: DesktopRun[]; live: { ownerId: string; workspaceId: string } }
let snapshot: Snapshot, taskReads: number, preferenceReads: number, runtime: 'web' | 'desktop'
let router: { push: (href: string) => void }
let choices: Choice[], clicks: ReturnType<typeof deferred<string | null>>[], shown: DesktopNotification[], badges: number[]
let clickListeners: Set<(href: string) => void>
let deviceReads: number, readDevices: () => Promise<{ id: string }[]>

mock.module(new URL('../app/actions/task-runs.ts', import.meta.url).href, { namedExports: {
  pollTaskRuns: async () => { taskReads++; return structuredClone(snapshot) }, syncThreadList: async () => { throw Error('unexpected thread read') },
} })
mock.module(new URL('../app/actions/issues.ts', import.meta.url).href, { namedExports: { syncIssueList: async () => { throw Error('unexpected issue read') } } })
mock.module(new URL('../app/actions/coordinator.ts', import.meta.url).href, { namedExports: { pollBotChatSummaries: async () => { throw Error('unexpected chat read') } } })
mock.module(new URL('../app/actions/bots.ts', import.meta.url).href, { namedExports: { pollBots: async () => { throw Error('unexpected bot read') } } })
mock.module(new URL('../app/actions/agents.ts', import.meta.url).href, { namedExports: { listDevices: () => { deviceReads++; return readDevices() } } })
mock.module(new URL('../app/actions/desktop-notifications.ts', import.meta.url).href, { namedExports: {
  chooseDesktopNotifications: (candidates: { id: string }[]) => {
    const choice = { ids: candidates.map(candidate => candidate.id), result: deferred<{ show: string[] }>() }
    choices.push(choice)
    return choice.result.promise
  },
} })
mock.module(new URL('../lib/platform/use-platform.ts', import.meta.url).href, { namedExports: { usePlatform: () => ({ runtime }) } })
mock.module(new URL('../i18n/navigation.ts', import.meta.url).href, { namedExports: { useRouter: () => router } })

const browser = new Window({ url: 'https://mikka.example/mikka/en' })
const originalFetch = globalThis.fetch, originalSocket = globalThis.WebSocket
let createRoot: typeof import('react-dom/client')['createRoot']
let SWRConfig: typeof import('swr')['SWRConfig']
let LiveProvider: typeof import('../hooks/use-live-key')['LiveProvider']
let DesktopIntegration: typeof import('../components/desktop/desktop-integration')['DesktopIntegration']
let useLiveTaskRunList: typeof import('../hooks/use-live-lists')['useLiveTaskRunList']
let root: Root, container: HTMLDivElement, cache: Map<string, State>
let refresh: () => Promise<unknown>
const sockets: FakeSocket[] = []

class FakeSocket {
  readyState = 0
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  constructor(readonly url: string) { sockets.push(this) }
  open() {
    if (this.readyState !== 0) return
    this.readyState = 1; this.onopen?.()
    this.onmessage?.({ data: JSON.stringify({ type: 'live_ready', version: 1, kinds: LIVE_KINDS }) })
  }
  send(value: string) { if (value === 'ping') this.onmessage?.({ data: 'pong' }) }
  close() { this.readyState = 3; this.onclose?.() }
}

/** Real component, React, SWR, shared list hook and live channel. Only server,
 * native IPC and router boundaries are replaced; no model or server is called. */
function BoardReader({ owner }: { owner: string }) {
  const runs = useLiveTaskRunList(owner)
  refresh = () => runs.mutate()
  return null
}

before(async () => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browser })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: browser.document })
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, WebSocket: FakeSocket })
  ;({ createRoot } = await import('react-dom/client'))
  ;({ SWRConfig } = await import('swr'))
  ;({ LiveProvider } = await import('../hooks/use-live-key'))
  ;({ useLiveTaskRunList } = await import('../hooks/use-live-lists'))
  ;({ DesktopIntegration } = await import('../components/desktop/desktop-integration'))
})
beforeEach(() => {
  taskReads = 0; preferenceReads = 0; runtime = 'desktop'; choices = []; clicks = []; shown = []; badges = []; clickListeners = new Set(); sockets.length = 0
  deviceReads = 0; readDevices = async () => { throw Error('no device setup belongs in the notification fixture') }
  router = { push: () => { throw Error('unexpected navigation') } }
  snapshot = runs()
  cache = new Map()
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  Object.defineProperty(browser, 'mikka', { configurable: true, value: { notifications: {
    show: async (notification: DesktopNotification) => { shown.push(notification) },
    setBadge: async (badge: number) => { badges.push(badge) },
    onClick: (listener: (href: string) => void) => { clickListeners.add(listener); return () => { clickListeners.delete(listener) } },
    consumePendingClick: () => { const click = deferred<string | null>(); clicks.push(click); return click.promise },
  } } })
  globalThis.fetch = async (input, options) => {
    assert.ok(!options?.method || options.method === 'GET', 'no mutation/model request belongs in this fixture')
    const url = new URL(String(input), 'https://mikka.example')
    if (url.pathname.endsWith('/api/live/ticket')) {
      return Response.json({ url: `wss://fixture.invalid/${url.searchParams.get('workspace')}`, protocol: 'fixture', expiresAt: Date.now() + 600_000 })
    }
    assert.ok(url.pathname.endsWith('/api/settings/preferences'), `unexpected network boundary ${url.pathname}`)
    preferenceReads++
    return Response.json({ proactive: true, pushFinished: true })
  }
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); globalThis.fetch = originalFetch })
after(async () => { Object.assign(globalThis, { WebSocket: originalSocket }); mock.restoreAll(); await browser.close() })

function runs(status: DesktopRun['status'] = 'running', owner = 'owner'): Snapshot {
  return { items: [{ issueId, runId, issueTitle: `${owner} task`, agentName: 'Fixture', status }], live: { ownerId: owner, workspaceId: owner === 'owner' ? home : otherHome } }
}
async function render(owner = 'owner', integration = true) {
  // The installed Vite application also remounts its SWR subtree on account change.
  await act(async () => root.render(<SWRConfig key={owner} value={{ provider: () => cache }}>
    <LiveProvider ownerId={owner} workspaceId={snapshot.live.workspaceId}>
      <BoardReader owner={owner} />
      {integration && <DesktopIntegration userId={owner} />}
    </LiveProvider>
  </SWRConfig>))
}
async function settled(ms = 30) { await act(async () => { await new Promise(resolve => setTimeout(resolve, ms)) }) }
async function transition(status: DesktopRun['status']) {
  snapshot = runs(status, snapshot.live.ownerId)
  await act(async () => { await refresh() })
}
async function beginDecision() {
  await render(); await settled()
  assert.equal(taskReads, 1, 'board and integration share their initial authorized list read')
  await act(async () => { for (const socket of sockets) socket.open() })
  await settled(160) // Let the existing connection-opening catch-up finish before the transition.
  assert.equal(choices.length, 0, 'the initial list is a baseline')
  await transition('waiting_input')
  assert.equal(choices.length, 1)
  return choices[0]
}
async function approve(choice: Choice) { await act(async () => { choice.result.resolve({ show: choice.ids }); await choice.result.promise }) }

test('desktop startup and unchanged snapshots never read a notification preference they cannot use', async () => {
  snapshot = runs('succeeded')
  await render(); await settled()
  assert.equal(taskReads, 1)
  assert.equal(preferenceReads, 0, 'the launch baseline only needs the run list for its Dock badge')
  assert.deepEqual(choices, [], 'a historical completion must not ask for a notification decision')
  assert.deepEqual(shown, [])
  await transition('succeeded')
  assert.equal(preferenceReads, 0, 'an unchanged list never needs a notification preference either')
  assert.deepEqual(choices, [])
})

test('a real completion asks the server to enforce current preferences before showing its decision', async () => {
  await render(); await settled()
  await transition('succeeded')
  assert.equal(choices.length, 1)
  assert.match(choices[0].ids[0], /:finished:/)
  assert.equal(preferenceReads, 0, 'only the server decision reads the current completion preference')
  assert.equal(shown.length, 0)
  await approve(choices[0])
  assert.deepEqual(shown.map(notification => notification.id), choices[0].ids)
  await transition('succeeded')
  assert.equal(choices.length, 1, 'a later unchanged snapshot never replays the completion')
})

test('a decision that returns after the integration unmounts cannot raise an OS notification', async () => {
  const choice = await beginDecision()
  await render('owner', false)
  const reads = taskReads
  await approve(choice)
  assert.deepEqual(shown, [])
  assert.equal(taskReads, reads, 'discarding a stale native side effect does not refetch')
})

test('a prior account decision cannot notify after the Vite account subtree is replaced', async () => {
  const choice = await beginDecision()
  cache = new Map(); snapshot = runs('running', 'next-owner')
  await render('next-owner'); await settled()
  await approve(choice)
  assert.equal(shown.length, 0)
  assert.equal(choices.length, 1, 'the new account gets its own quiet baseline')
  await transition('failed'); await approve(choices[1])
  assert.deepEqual(shown.map(notification => notification.title), ['next-owner task'])
})

test('an ordinary list refresh does not discard a valid pending decision from the same session', async () => {
  const choice = await beginDecision()
  await transition('running')
  const reads = taskReads
  await approve(choice)
  assert.equal(shown.length, 1, 'a list rerender is not the end of the desktop session')
  assert.equal(shown[0].id, choice.ids[0])
  assert.equal(taskReads, reads)
  assert.equal(preferenceReads, 0)
})

test('changing from the desktop runtime invalidates an outstanding notification decision', async () => {
  const choice = await beginDecision()
  runtime = 'web'; await render()
  await approve(choice)
  assert.deepEqual(shown, [])
})

test('a pending notification click cannot navigate after the integration unmounts', async () => {
  const destinations: string[] = []; router = { push: href => { destinations.push(href) } }
  await render(); await settled()
  const pending = clicks[0]
  await render('owner', false)
  assert.equal(clickListeners.size, 0)
  await act(async () => { pending.resolve('/notification-destination'); await pending.promise })
  assert.deepEqual(destinations, [])
})

test('replacing the router discards the old pending click and keeps the current click handler', async () => {
  const oldDestinations: string[] = [], currentDestinations: string[] = []
  router = { push: href => { oldDestinations.push(href) } }
  await render(); await settled()
  const oldClick = clicks[0]
  router = { push: href => { currentDestinations.push(href) } }
  await render()
  assert.equal(clickListeners.size, 1)
  await act(async () => { oldClick.resolve('/notification-destination'); await oldClick.promise })
  assert.deepEqual(oldDestinations, [])
  assert.deepEqual(currentDestinations, [])
  await act(async () => { clicks[1].resolve('/notification-destination'); await clicks[1].promise })
  assert.deepEqual(currentDestinations, ['/notification-destination'])
})

function nativeSetup(status: () => Promise<LocalDevice>) {
  const actions: string[] = []
  Object.assign(Reflect.get(browser, 'mikka'), { device: { status }, ssh: { autoLocal: async (action: string) => { actions.push(action) } } })
  return actions
}
const localDevice = (patch: Partial<LocalDevice>): LocalDevice => ({ status: 'online', signedIn: true, deviceId: 'local', workspaceId: null, server: 'online', ...patch })

for (const [name, local, expected] of [
  ['connecting', localDevice({ status: 'connecting' }), []],
  ['offline', localDevice({ status: 'offline' }), ['repair']],
  ['unsigned', localDevice({ signedIn: false }), ['install']],
  ['unregistered', localDevice({ deviceId: null }), ['install']],
] as const) test(`native setup does not read the device list when ${name}`, async () => {
  const actions = nativeSetup(async () => local)
  readDevices = async () => [{ id: 'local' }]
  await render()
  assert.equal(deviceReads, 0)
  assert.deepEqual(actions, expected)
})

test('native setup still reads ownership before retaining or replacing an online signed-in device', async () => {
  const actions = nativeSetup(async () => localDevice({}))
  readDevices = async () => [{ id: 'local' }]
  await render()
  assert.equal(deviceReads, 1)
  assert.deepEqual(actions, [])
  await render('owner', false)
  readDevices = async () => [{ id: 'other' }]
  await render()
  assert.equal(deviceReads, 2)
  assert.deepEqual(actions, ['install'])
})

test('native setup does not start an ownership read after its account has unmounted', async () => {
  const status = deferred<LocalDevice>()
  const actions = nativeSetup(() => status.promise)
  readDevices = async () => []
  await render()
  await render('owner', false)
  await act(async () => { status.resolve(localDevice({})); await status.promise })
  assert.equal(deviceReads, 0)
  assert.deepEqual(actions, [])
})

test('an old ownership response cannot install a device after the account changes', async () => {
  const devices = deferred<{ id: string }[]>()
  const actions = nativeSetup(async () => localDevice({}))
  readDevices = () => devices.promise
  await render()
  assert.equal(deviceReads, 1)
  nativeSetup(async () => localDevice({ status: 'connecting' }))
  cache = new Map(); snapshot = runs('running', 'next-owner')
  await render('next-owner')
  await act(async () => { devices.resolve([]); await devices.promise })
  assert.deepEqual(actions, [])
  assert.equal(deviceReads, 1)
})

test('failed ownership verification never becomes an install decision', async () => {
  const actions = nativeSetup(async () => localDevice({}))
  readDevices = async () => { throw Error('fixture ownership unavailable') }
  await render()
  assert.equal(deviceReads, 1)
  assert.deepEqual(actions, [])
})
