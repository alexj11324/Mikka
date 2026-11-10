import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { Window } from 'happy-dom'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'

const repository = fileURLToPath(new URL('../../../', import.meta.url))
const renderer = resolve(repository, 'apps/desktop/src/renderer')
const require = createRequire(import.meta.url)
const directory = await mkdtemp(join(tmpdir(), 'mikka-workspace-live-'))
const key = Symbol.for('mikka.test.workspace-live')
const stateAccess = 'globalThis[Symbol.for("mikka.test.workspace-live")]'
const wrapper = '({ children }) => children'
const fixtureModules = new Map([
  ['next-intl', `export const NextIntlClientProvider = ${wrapper}; export const useTranslations = () => value => value; export const useLocale = () => 'en';`],
  ['lucide-react', 'export const ArrowLeft = () => null;'],
  ['sonner', 'export const toast = { error() {}, dismiss() {} };'],
  ['@/messages/en.json', 'export default {};'], ['@/messages/zh-CN.json', 'export default {};'],
  ['@/components/theme-provider', `export const ThemeProvider = ${wrapper};`],
  ['@/components/swr-defaults', `export const SWRDefaults = ${wrapper};`],
  ['@/components/ui/sonner', 'export const Toaster = () => null;'],
  ['@/components/ui/button', `export const Button = ${wrapper}; export const buttonVariants = () => '';`],
  ['@/components/blocks/auth-19/components/auth', `export const Auth = ${wrapper};`],
  ['@/components/blocks/auth-19/components/auth-card', `export const AuthCard = ${wrapper};`],
  ['@/components/workspace/workspace-loading', 'import { createElement } from "react"; export const WorkspaceLoading = () => createElement("div", { "data-loading": true });'],
  ['@/components/workspace/create-workspace-form', 'export const CreateWorkspaceForm = () => null;'],
  ['@/components/workspace/invitation-card', 'export const InvitationCard = () => null;'],
  ['@/components/device-authorization', 'import { createElement } from "react"; export const DeviceAuthorization = () => createElement("div", { "data-device": true });'],
  ['@/components/plugins/github-settings', 'export const GitHubSettings = () => null;'],
  ['@/app/[locale]/not-found', 'export default () => null;'],
  ['@/lib/swr/persistent-cache', `export const clearPersistentReadCaches = async () => { ${stateAccess}.cacheClears++; }; export class PersistentReadCache extends Map {} export const readCacheShareNamespace = () => null;`],
  ['@/lib/live/browser-runtime', `export const browserRuntime = scope => ${stateAccess}.runtime(scope); export const watchPageVisibility = () => () => {};`],
  ['@/lib/platform/public-origin', `export const publicAppOrigin = () => ${stateAccess}.server;`],
])

const workspaceSource = `
import { createElement, useLayoutEffect, useState } from 'react'
import useSWR, { SWRConfig } from 'swr'
import { LiveProvider, useLiveKey, useLiveScope } from '@/hooks/use-live-key'
const state = () => globalThis[Symbol.for('mikka.test.workspace-live')]
function Reads({ workspaceId }) {
  useSWR('fixture-workspace', async () => {
    state().firstReads.push({ tickets: state().tickets.length, path: window.location.pathname })
    return { ready: true }
  }, { revalidateOnFocus: false, revalidateOnReconnect: false })
  useLiveKey('workspace_settings', workspaceId, ['fixture-workspace'], workspaceId)
  const live = useLiveScope()
  useLayoutEffect(() => { state().live = live }, [live])
  return createElement('div', { 'data-workspace': true })
}
export default function Workspace({ user, bootstrap, livePreparation }) {
  const [config] = useState(() => ({ provider: () => new Map() }))
  useLayoutEffect(() => { state().mounts++; state().preparations.push(livePreparation) }, [livePreparation])
  return createElement(SWRConfig, { value: config }, createElement(LiveProvider, {
    ownerId: user.id, workspaceId: bootstrap.cacheWorkspace?.workspaceId, preparation: livePreparation,
  }, createElement(Reads, { workspaceId: bootstrap.cacheWorkspace?.workspaceId })))
}
`
const compiled = await build({
  absWorkingDir: repository,
  stdin: {
    contents: 'export { App } from "./app"; export { navigate, installNavigation, refresh } from "./location"; export { setTransportState, getTransportState } from "./transport-state";',
    resolveDir: renderer, sourcefile: 'workspace-live-contract.ts', loader: 'ts',
  },
  bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2023', jsx: 'automatic', logLevel: 'silent',
  tsconfig: resolve(repository, 'apps/desktop/tsconfig.renderer.json'),
  define: { 'process.env.NODE_ENV': '"test"', 'process.env.MIKKA_BASE_PATH': '"/mikka"', 'process.env': '{}' },
  plugins: [{ name: 'workspace-live-public-boundaries', setup(builder) {
    builder.onResolve({ filter: /^(?:react(?:\/.*)?|swr)$/ }, args => ({ path: require.resolve(args.path), external: true }))
    builder.onResolve({ filter: /^mikka:platform$/ }, () => ({ path: resolve(renderer, 'platform.tsx') }))
    builder.onResolve({ filter: /.*/ }, args => fixtureModules.has(args.path) ? { path: args.path, namespace: 'live-fixture' } : undefined)
    builder.onResolve({ filter: /^\.\// }, args => {
      const target = resolve(dirname(args.importer), args.path)
      for (const name of ['workspace', 'offline', 'deep-link-routes', 'auth-form', 'auth-client', 'open-settings']) {
        if (target !== resolve(renderer, name)) continue
        if (name === 'workspace' && args.importer !== resolve(renderer, 'workspace-loader.ts')) continue
        return { path: name, namespace: 'live-fixture' }
      }
    })
    builder.onLoad({ filter: /.*/, namespace: 'live-fixture' }, args => ({ loader: 'js', resolveDir: repository, contents:
      args.path === 'workspace' ? workspaceSource
        : args.path === 'offline' ? 'import { createElement } from "react"; export const Offline = () => createElement("div", { "data-offline": true });'
          : args.path === 'deep-link-routes' ? 'export const SharedArtifactRoute = () => null; export const WorkspaceLinkRoute = () => null;'
            : args.path === 'auth-form' ? 'import { createElement } from "react"; export const AuthForm = () => createElement("div", { "data-auth": true });'
              : args.path === 'auth-client' ? 'export const setSession = () => {};'
                : args.path === 'open-settings' ? 'export const openCurrentPageInBrowser = async () => "desktop";'
                  : fixtureModules.get(args.path) }))
  } }],
})
const filename = join(directory, 'application.mjs')
await writeFile(filename, compiled.outputFiles[0].contents)
after(() => rm(directory, { recursive: true, force: true }))

const workspaceId = '8d992f67-2388-4372-92eb-410170899f61'
const kinds = ['workspace_settings']
const session = (id = 'owner', sessionId = 'session') => ({ user: { id, name: id, email: 'fixture@example.invalid' }, session: { id: sessionId } })
const publicConfig = { googleEnabled: false, githubEnabled: false, emailEnabled: true, features: { flags: {}, cloudComputer: false } }
const fullBootstrap = identity => ({ ...(identity ?? { user: null, session: null }), ...publicConfig,
  cacheWorkspace: identity ? { workspaceId, role: 'member' } : null, liveHomeWorkspaceId: identity ? workspaceId : null, onboarding: false, computer: 'none' })
const envelope = result => ({ version: 1, ok: true, result })
const packet = result => Response.json(envelope(result))
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
let sequence = 0

async function fixture(t, { path = '/mikka/en/', fetch: fetchResponse } = {}) {
  const window = new Window({ url: 'mikka://app' + path })
  Object.defineProperty(window.document, 'visibilityState', { configurable: true, value: 'visible' })
  const state = { identity: session(), server: 'https://fixture.invalid', requests: [], tickets: [], sockets: [],
    firstReads: [], mounts: 0, preparations: [], cacheClears: 0, listeners: new Set(), watchers: new Set(), timers: new Map() }
  let timerId = 0
  state.runtime = scope => ({
    async ticket(signal) { state.tickets.push({ scope, signal }); return { url: 'wss://fixture.invalid/live', protocol: 'fixture', expiresAt: Date.now() + 600_000 } },
    socket() {
      const socket = { readyState: 0, onopen: null, onmessage: null, onclose: null, onerror: null,
        send() {}, close() { this.readyState = 3 },
        open() { this.readyState = 1; this.onopen?.({}); this.onmessage?.({ data: JSON.stringify({ type: 'live_ready', version: 1, kinds }) }) } }
      state.sockets.push(socket)
      return socket
    },
    visible: () => true,
    watchVisibility(callback) { state.watchers.add(callback); return () => state.watchers.delete(callback) },
    now: Date.now, monotonicNow: () => performance.now(),
    later(callback) { const id = ++timerId; state.timers.set(id, callback); return id },
    cancel(id) { state.timers.delete(id) },
  })
  window.mikka = { bundled: {
    session: async () => state.identity,
    onSessionChanged(callback) { state.listeners.add(callback); return () => state.listeners.delete(callback) },
  }, app: { runtime: 'electron', serverUrl: state.server } }
  const values = { window, document: window.document, navigator: window.navigator, HTMLElement: window.HTMLElement, Node: window.Node,
    MutationObserver: window.MutationObserver, Event: window.Event, IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async (path, init) => {
      const request = { path, action: init?.body ? JSON.parse(init.body).action : null, args: init?.body ? JSON.parse(init.body).args : null }
      state.requests.push(request)
      if (fetchResponse) { const response = await fetchResponse(request, state); if (response !== undefined) return response }
      if (String(path).endsWith('/config')) return Response.json(publicConfig)
      assert.equal(path, '/mikka/api/desktop/rpc')
      assert.equal(request.action, 'desktop.bootstrap')
      return packet(fullBootstrap(state.identity))
    } }
  const saved = new Map(Object.keys(values).map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]))
  for (const [name, value] of Object.entries(values)) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
  globalThis[key] = state
  const api = await import(pathToFileURL(filename).href + '?case=' + ++sequence)
  api.installNavigation()
  const container = window.document.createElement('div')
  window.document.body.appendChild(container)
  const root = createRoot(container)
  t.after(async () => {
    await act(() => root.unmount())
    assert.equal(state.watchers.size, 0, 'unmount releases every prepared and ordinary live watcher')
    assert.equal(state.timers.size, 0, 'unmount cancels every live timer')
    await window.happyDOM.close()
    delete globalThis[key]
    for (const [name, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name] }
  })
  await act(async () => root.render(createElement(api.App)))
  return { state, api, window, container,
    navigate: href => act(async () => api.navigate(href)),
    transport: value => act(async () => api.setTransportState(value)),
    open: () => act(async () => { for (const socket of state.sockets) if (socket.readyState === 0) socket.open() }),
    owner: value => act(async () => { state.identity = value; for (const listener of state.listeners) listener() }) }
}

test('the actual App prepares before the first workspace read and the real LiveProvider joins that connection', async t => {
  const f = await fixture(t)
  assert.ok(f.container.querySelector('[data-workspace]'))
  assert.ok(f.state.firstReads.length > 0)
  assert.equal(f.state.firstReads[0].tickets, 1, 'bootstrap must prepare before the first workspace business read')
  assert.equal(f.state.tickets.length, 1, 'mounting a consumer must join the prepared registry')
  assert.deepEqual(f.state.tickets.map(call => call.scope), [workspaceId])
  await f.open()
  assert.equal(f.state.live.channels.keyConnected('fixture-workspace'), true)
  assert.equal(f.state.tickets.length, 1)
})

test('a response status is insufficient: preparation waits for the complete bootstrap body and validation', async t => {
  const body = deferred()
  let readingBody = 0
  const f = await fixture(t, { fetch: request => request.action === 'desktop.bootstrap'
    ? { status: 200, ok: true, json: () => { readingBody++; return body.promise } } : undefined })
  assert.equal(readingBody, 1)
  assert.equal(f.state.tickets.length, 0)
  assert.equal(f.state.firstReads.length, 0)
  await act(async () => body.resolve(envelope(fullBootstrap(f.state.identity))))
  assert.equal(f.state.firstReads[0].tickets, 1)
  assert.equal(f.state.tickets.length, 1)
})

test('a history write before its queued route notification blocks the old bootstrap preparation', async t => {
  const body = deferred()
  const f = await fixture(t, { fetch: request => request.action === 'desktop.bootstrap'
    ? { status: 200, ok: true, json: () => body.promise } : undefined })
  const dispatch = f.window.dispatchEvent.bind(f.window), queued = []
  // Hold only the navigation notification, so the URL is current while the
  // React requested ref is deliberately still the previous rendered route.
  f.window.dispatchEvent = event => {
    if (event.type === 'mikka:desktop-location') { queued.push(event); return true }
    return dispatch(event)
  }
  await act(async () => {
    body.resolve(envelope(fullBootstrap(f.state.identity)))
    f.window.history.pushState(null, '', '/mikka/en/device')
  })
  assert.ok(queued.length > 0)
  assert.equal(f.state.tickets.length, 0)
  assert.equal(f.state.firstReads.length, 0)
  f.window.dispatchEvent = dispatch
  await act(async () => { for (const event of queued) dispatch(event) })
  assert.ok(f.container.querySelector('[data-device]'))
  assert.equal(f.state.tickets.length, 0)
})

test('leaving and returning to a workspace starts an ordinary live lifetime without a new bootstrap', async t => {
  const f = await fixture(t)
  await f.open()
  const first = f.state.sockets[0], prepared = f.state.preparations[0]
  const bootstraps = f.state.requests.filter(request => request.action === 'desktop.bootstrap').length
  await f.navigate('/mikka/en/device')
  assert.equal(first.readyState, 3)
  assert.equal(prepared.isAuthorityRetired, true)
  assert.ok(f.container.querySelector('[data-device]'))
  await f.navigate('/mikka/en/')
  assert.ok(f.container.querySelector('[data-workspace]'))
  assert.equal(f.state.requests.filter(request => request.action === 'desktop.bootstrap').length, bootstraps)
  assert.equal(f.state.preparations.at(-1), undefined, 'a legal remount must not receive the authority-retired preparation')
  assert.equal(f.state.tickets.length, 2)
  await f.open()
  assert.equal(f.state.live.channels.keyConnected('fixture-workspace'), true)
})

test('an update-required boundary retires preparation and a stale ready signal cannot revive it', async t => {
  const f = await fixture(t)
  await f.open()
  const first = f.state.sockets[0], prepared = f.state.preparations[0]
  await f.transport('update-required')
  assert.equal(first.readyState, 3)
  assert.equal(prepared.isAuthorityRetired, true)
  assert.equal(f.container.querySelector('[data-workspace]'), null)
  await f.transport('ready')
  assert.equal(f.api.getTransportState(), 'update-required', 'the existing transport state is terminal for this document')
  assert.equal(f.container.querySelector('[data-workspace]'), null)
  assert.equal(f.state.tickets.length, 1)
  assert.equal(f.state.watchers.size, 0)
})

test('a confirmed session expiry closes the owned connection and cannot leave a prepared route behind', async t => {
  const f = await fixture(t)
  await f.open()
  const prepared = f.state.preparations[0]
  await f.transport('unauthenticated')
  assert.equal(prepared.isAuthorityRetired, true)
  assert.ok(f.state.sockets.every(socket => socket.readyState === 3))
  assert.equal(f.container.querySelector('[data-workspace]'), null)
  assert.ok(f.container.querySelector('[data-auth]'))
  assert.equal(f.state.tickets.length, 1)
  assert.equal(f.state.watchers.size, 0)
})

test('a superseded bootstrap body cannot prepare after a new owner has been accepted', async t => {
  const body = deferred()
  let requests = 0
  const f = await fixture(t, { fetch: request => {
    if (request.action === 'desktop.bootstrap' && ++requests === 1) return { status: 200, ok: true, json: () => body.promise }
  } })
  assert.equal(f.state.tickets.length, 0)
  await f.owner(session('new-owner', 'new-session'))
  assert.equal(f.state.tickets.length, 1)
  const current = f.state.preparations.at(-1)
  await act(async () => body.resolve(envelope(fullBootstrap(session('old-owner', 'old-session')))))
  assert.equal(f.state.tickets.length, 1)
  assert.equal(f.state.preparations.at(-1), current)
  assert.equal(current.isAuthorityRetired, false)
})

test('an owner change retires the first connection and prepares a distinct registry lifetime', async t => {
  const f = await fixture(t)
  await f.open()
  const previous = f.state.preparations[0], socket = f.state.sockets[0]
  await f.owner(session('other-owner', 'other-session'))
  assert.equal(previous.isAuthorityRetired, true)
  assert.equal(socket.readyState, 3)
  assert.notEqual(f.state.preparations.at(-1), previous)
  assert.equal(f.state.tickets.length, 2)
  await f.open()
  assert.equal(f.state.live.channels.keyConnected('fixture-workspace'), true)
})

test('authenticated non-workspace routes never prepare a live channel', async t => {
  for (const path of ['/mikka/en/device', '/mikka/en/sign-in?addAccount=1', '/mikka/en/invite/' + 'a'.repeat(64), '/mikka/en/a/public-share']) {
    await t.test(path, async t => {
      const f = await fixture(t, { path })
      assert.equal(f.state.tickets.length, 0)
      assert.equal(f.state.firstReads.length, 0)
      assert.equal(f.container.querySelector('[data-workspace]'), null)
    })
  }
})
