import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { Window } from 'happy-dom'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { actionReferences, actionSignatures, applicationBoundary, usedActionImports } from './build-renderer.mjs'

const repository = fileURLToPath(new URL('../../..', import.meta.url))
const renderer = join(repository, 'apps/desktop/src/renderer')
let imports = 0
async function moduleFrom({ entry, source, plugins = [] }) {
  const result = await build({
    absWorkingDir: repository, ...(entry ? { entryPoints: [join(renderer, entry)] } : { stdin: { contents: source, sourcefile: 'renderer-contract-test.ts', resolveDir: repository, loader: 'ts' } }),
    write: false, bundle: true, format: 'esm', platform: 'browser', target: 'es2023',
    tsconfig: join(repository, 'apps/desktop/tsconfig.renderer.json'),
    define: { 'process.env.NODE_ENV': '"production"', 'process.env.MIKKA_BASE_PATH': '"/mikka"', 'process.env': '{}' }, plugins,
  })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}#${++imports}`)
}

async function browser(callback) {
  const window = new Window({ url: 'mikka://app/mikka/en' })
  const saved = new Map()
  for (const key of ['window', 'document', 'Event', 'MessageEvent', 'CloseEvent']) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { value: key === 'window' ? window : key === 'document' ? window.document : window[key], configurable: true, writable: true })
  }
  saved.set('fetch', Object.getOwnPropertyDescriptor(globalThis, 'fetch'))
  try { return await callback(window) }
  finally {
    for (const [key, descriptor] of saved) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]
    await window.happyDOM.close()
  }
}

test('local routing preserves workspace history state, locale, query and fragment without treating opaque origins as equal', () => browser(async window => {
  const navigation = await moduleFrom({ entry: 'location.ts' })
  const external = []
  window.mikka = { app: { openExternal: async url => { external.push(url) } } }
  navigation.installNavigation()
  window.history.replaceState({ mikkaEntry: { index: 3, task: { start: 1, doc: 'document', list: true } }, untouched: 'retained' }, '', '/mikka/en')
  const state = window.history.state
  navigation.navigate({ pathname: '/settings', query: { section: 'models', workspace: 'own' }, hash: 'preferred' }, false, { scroll: false }, true)
  assert.equal(window.location.href, 'mikka://app/mikka/en/settings?section=models&workspace=own#preferred')
  assert.deepEqual(window.history.state, state)
  assert.equal(navigation.withoutLocale('/mikka/en/settings'), '/settings')
  assert.equal(navigation.localeOf('/mikka/en/settings'), 'en')
  assert.equal(navigation.localeHref('/mikka/en/?bot=one', 'zh-CN'), '/?bot=one')
  assert.equal(navigation.isOwnURL(new URL('mikka://other/mikka')), false)
  for (const path of ['/mikka/api/desktop/return?state=fixture', '/mikka/api/rpc', '/mikka/v1/devices', '/mikka/.well-known/oauth-authorization-server']) {
    assert.equal(navigation.isClientRoute(new URL(path, window.location.href)), false)
  }
  for (const path of ['/mikka/en/settings?section=models', '/mikka/en/a/shared-fixture', '/mikka/en/w/fixture-workspace']) {
    assert.equal(navigation.isClientRoute(new URL(path, window.location.href)), true)
  }
  const before = window.location.href
  navigation.navigate('https://example.test/help')
  assert.equal(window.location.href, before)
  assert.deepEqual(external, ['https://example.test/help'])
}))

test('generated action stubs preserve declaration arity, including SWR zero-argument fetchers', () => browser(async window => {
  assert.deepEqual(actionSignatures('export async function zero() {}\nexport async function one(value?: string) {}\nexport async function rest(...values: string[]) {}', 'actions.ts'), [
    { name: 'zero', arity: 0, rest: false }, { name: 'one', arity: 1, rest: false }, { name: 'rest', arity: 1, rest: true },
  ])
  assert.throws(() => actionSignatures('export function sync() {}', 'actions.ts'), /must be async/)
  const requests = []
  globalThis.fetch = async (_path, init) => {
    requests.push(JSON.parse(init.body))
    return Response.json({ version: 1, ok: true, result: [] })
  }
  window.mikka = {}
  const actions = await moduleFrom({ source: 'export { listProjects, listWorkspaceProjects } from "@/app/actions/projects"; export { getArtifact } from "@/app/actions/artifacts";', plugins: [applicationBoundary(new Map())] })
  await actions.listProjects('SWR cache key')
  const workspace = 'bf0f49e9-60ef-42a2-9e46-519b6010d7ef'
  await actions.listWorkspaceProjects(workspace, 'extra ignored argument')
  await actions.getArtifact('artifact-id', 'extra ignored argument')
  assert.deepEqual(requests.map(request => [request.action, request.args]), [['projects.listProjects', []], ['projects.listWorkspaceProjects', [workspace]], ['artifacts.getArtifact', ['artifact-id']]])
}))

test('action inventory includes the actual billing re-export chain and excludes type-only aliases', async () => {
  assert.deepEqual(await usedActionImports(['lib/billing/verification-client.ts']), [
    'billing.cardVerificationStatus', 'billing.getHostedUsage', 'billing.startCardVerification', 'billing.startPointsPurchase',
  ])
  assert.deepEqual(actionReferences(`
    import { getBilling as read, type getCreditBilling } from '@/app/actions/billing'
    export { startCardVerification as verify, type getHostedUsage } from '@/app/actions/billing'
    export type { cardVerificationStatus } from '@/app/actions/billing'
    export { startPointsPurchase } from '@/app/actions/billing'
  `, 'consumer.ts'), ['billing.getBilling', 'billing.startCardVerification', 'billing.startPointsPurchase'])
})

test('real billing client re-exports reach the native RPC with only their declared parameters', () => browser(async () => {
  const requests = []
  globalThis.fetch = async (_path, init) => {
    requests.push(JSON.parse(init.body))
    return Response.json({ version: 1, ok: true, result: { url: 'https://checkout.stripe.com/c/fixture' } })
  }
  const client = await moduleFrom({
    source: 'export { startCardVerification, startPointsPurchase } from "@/lib/billing/verification-client";',
    plugins: [applicationBoundary(new Map())],
  })
  const workspace = 'bf0f49e9-60ef-42a2-9e46-519b6010d7ef'
  await client.startCardVerification(workspace)
  await client.startPointsPurchase(workspace, 25)
  assert.deepEqual(requests.map(request => [request.action, request.args]), [
    ['billing.startCardVerification', [workspace]], ['billing.startPointsPurchase', [workspace, 25]],
  ])
}))

test('public configuration keeps only existing flags and discards the previous owner snapshot on reset', async () => {
  const store = await moduleFrom({ entry: 'client-configuration.ts' })
  let changes = 0
  const unsubscribe = store.subscribeClientConfiguration(() => { changes++ })
  const snapshot = { features: { flags: { 'mikka-cloud-computer': true, 'mikka-computer-tab-off': true, 'private-unlisted-flag': true }, cloudComputer: true }, daemonPackageName: '@aspectlylabs/mikka-dev' }
  store.setClientConfiguration(snapshot)
  assert.equal(store.getClientConfiguration().features.flags['mikka-cloud-computer'], true)
  assert.equal(store.getClientConfiguration().features.flags['mikka-computer-tab-off'], true)
  assert.equal(Object.hasOwn(store.getClientConfiguration().features.flags, 'private-unlisted-flag'), false)
  assert.equal(store.getClientConfiguration().daemonPackageName, '@aspectlylabs/mikka-dev')
  store.setClientConfiguration(snapshot)
  assert.equal(changes, 1)
  store.setClientConfiguration(null)
  assert.equal(store.getClientConfiguration().features.cloudComputer, false)
  assert.ok(Object.values(store.getClientConfiguration().features.flags).every(value => value === false))
  assert.equal(changes, 2)
  unsubscribe()
  store.setClientConfiguration(snapshot)
  assert.equal(changes, 2)
})

test('RPC sends only the versioned local envelope and preserves shared cache access-denial semantics', () => browser(async () => {
  const api = await moduleFrom({ source: `export { callAction } from ${JSON.stringify(join(renderer, 'rpc.ts'))}; export { getTransportState } from ${JSON.stringify(join(renderer, 'transport-state.ts'))}; export { readAccessFailure } from '@/lib/swr/persistent-cache';` })
  let request
  globalThis.fetch = async (path, init) => { request = { path, init }; return Response.json({ version: 1, ok: true, result: { saved: true } }) }
  assert.deepEqual(await api.callAction('module.action', [new Date('2026-01-01T00:00:00Z')]), { saved: true })
  assert.equal(request.path, '/mikka/api/desktop/rpc')
  assert.equal(request.init.credentials, 'omit')
  assert.equal(request.init.headers['x-mikka-desktop-protocol'], '1')
  assert.equal(request.init.headers['x-mikka-locale'], 'en')
  assert.equal(Object.hasOwn(request.init.headers, 'authorization'), false)
  assert.ok(request.init.body.includes('2026-01-01T00:00:00.000Z'))
  globalThis.fetch = async () => Response.json({ version: 1, ok: false, error: { code: 'workspaceAccessDenied' } }, { status: 403 })
  await assert.rejects(api.callAction('module.action', []), error => error.code === 'workspaceAccessDenied' && error.status === 403 && api.readAccessFailure(error) === 'workspace')
  assert.equal(api.getTransportState(), 'ready')
  globalThis.fetch = async () => Response.json({ version: 1, ok: false, error: { code: 'not_found' } }, { status: 404 })
  await assert.rejects(api.callAction('module.action', []), error => error.status === 404 && api.readAccessFailure(error) === 'resource')
  globalThis.fetch = async () => new Response('', { status: 401 })
  await assert.rejects(api.callAction('module.action', []), error => error.code === 'desktop_session_expired' && error.status === 401 && api.readAccessFailure(error) === 'session')
  assert.equal(api.getTransportState(), 'unauthenticated')
}))

test('bootstrap only transports a workspace selector and uses server-proved cache authority', () => browser(async () => {
  const { readBootstrap } = await moduleFrom({ entry: 'bootstrap.ts' })
  const id = 'bf0f49e9-60ef-42a2-9e46-519b6010d7ef'
  const requests = []
  globalThis.fetch = async (_path, init) => {
    requests.push(JSON.parse(init.body))
    return Response.json({ version: 1, ok: true, result: { user: { id: 'owner' }, session: { id: 'session' }, cacheWorkspace: { workspaceId: id, role: 'member' }, onboarding: false } })
  }
  assert.deepEqual((await readBootstrap(id)).cacheWorkspace, { workspaceId: id, role: 'member' })
  assert.deepEqual(requests[0].args, [id])
  assert.equal((await readBootstrap('invalid-workspace')).cacheWorkspace, null)
  assert.deepEqual(requests[1].args, [])
  await readBootstrap()
  assert.deepEqual(requests[2].args, [])
}))

test('a pinned expired Web installation can reopen its own sign-in control while an actual outage stays unavailable', () => browser(async () => {
  const { readBootstrap, readAuthentication } = await moduleFrom({ entry: 'bootstrap.ts' })
  let configuration = () => Response.json({ error: 'web_auth_session_expired' }, { status: 401 })
  globalThis.fetch = async path => String(path).endsWith('/api/desktop/config')
    ? configuration() : Response.json({ error: 'unauthorized' }, { status: 401 })
  const signedOut = { user: null, session: null, googleEnabled: false, githubEnabled: false, emailEnabled: false }
  assert.deepEqual(await readBootstrap(), { ...signedOut, cacheWorkspace: null })
  assert.deepEqual(await readAuthentication(), signedOut)
  configuration = () => Response.json({ error: 'temporarily_unavailable' }, { status: 503 })
  await assert.rejects(readBootstrap(), { code: 'desktop_backend_unreachable', status: 503 })
  configuration = () => Response.json({ error: 'unexpected' }, { status: 401 })
  await assert.rejects(readBootstrap(), { code: 'desktop_backend_unreachable', status: 401 })
}))

test('an old safe-session IPC completion cannot restore the previous account after an owner change', () => browser(async window => {
  const { authClient, setSession } = await moduleFrom({ entry: 'auth-client.ts' })
  const old = { user: { id: 'old-owner' }, session: { id: 'old-session' } }
  const current = { user: { id: 'current-owner' }, session: { id: 'current-session' } }
  let resolve
  window.mikka = { bundled: { session: () => new Promise(done => { resolve = done }) } }
  const request = authClient.getSession()
  setSession(current)
  resolve(old)
  assert.deepEqual(await request, { data: current, error: null })
  let reject
  window.mikka.bundled.session = () => new Promise((_resolve, fail) => { reject = fail })
  const failed = authClient.getSession()
  setSession(null)
  reject(new Error('late old account request'))
  assert.deepEqual(await failed, { data: null, error: null })
}))

test('native logout waits for queued shared-cache writes and clears them before returning', () => browser(async window => {
  const api = await moduleFrom({ source: `export { endSession } from ${JSON.stringify(join(renderer, 'auth-client.ts'))}; export { PersistentReadCache } from '@/lib/swr/persistent-cache';` })
  const events = []
  let release
  const writing = new Promise(done => { release = done })
  const storage = {
    activate: async () => [], remove: async () => {},
    write: async () => { events.push('writing'); await writing; events.push('written') },
    clear: async () => { events.push('cleared') },
  }
  const cache = new api.PersistentReadCache({ userId: 'owner', workspaceId: 'workspace', build: 'installed-build', role: 'member' }, storage)
  const disconnect = cache.connect(() => { events.push('retired') })
  window.mikka = { bundled: { signOut: async () => { events.push('signed-out') } } }
  try {
    cache.set('preferences', { _k: 'preferences', data: { theme: 'dark' } })
    await Promise.resolve()
    let settled = false
    const signingOut = api.endSession().then(result => { settled = true; return result })
    await new Promise(done => setImmediate(done))
    assert.equal(cache.isEnabled, false)
    assert.equal(settled, false)
    release()
    assert.equal((await signingOut).error, null)
    assert.deepEqual(events, ['writing', 'signed-out', 'retired', 'written', 'cleared'])
    cache.set('preferences', { data: { theme: 'late request' } })
    assert.equal(cache.size, 0)
  } finally { release(); disconnect(); await cache.flushed() }
}))

test('unsupported renderer state cannot be cleared by an older in-flight success', () => browser(async () => {
  const api = await moduleFrom({ source: `export { callAction } from ${JSON.stringify(join(renderer, 'rpc.ts'))}; export { getTransportState } from ${JSON.stringify(join(renderer, 'transport-state.ts'))};` })
  globalThis.fetch = async () => new Response('', { status: 426 })
  await assert.rejects(api.callAction('module.action', []), { code: 'desktop_client_update_required' })
  globalThis.fetch = async () => Response.json({ version: 1, ok: true, result: null })
  await api.callAction('module.action', [])
  assert.equal(api.getTransportState(), 'update-required')
}))

test('live transport uses a local handle, subscribes before connecting, and closes an aborted preparation', () => browser(async window => {
  const calls = []
  let listener
  const id = 'live-channel-id'
  window.mikka = { bundled: { live: {
    prepare: async workspace => { calls.push(['prepare', workspace]); return { id, expiresAt: 1000 } },
    onEvent: callback => { calls.push(['listen']); listener = callback; return () => { calls.push(['unlisten']) } },
    connect: async key => { calls.push(['connect', key]) }, send: async (key, data) => { calls.push(['send', key, data]) }, close: async key => { calls.push(['close', key]) },
  } } }
  const { browserRuntime } = await moduleFrom({ entry: 'live-runtime.ts' })
  const runtime = browserRuntime('workspace')
  const controller = new AbortController()
  const ticket = await runtime.ticket(controller.signal)
  assert.deepEqual(ticket, { url: `mikka-live://channel/${id}`, protocol: '', expiresAt: 1000 })
  const socket = runtime.socket(ticket)
  assert.deepEqual(calls.slice(1), [['listen'], ['connect', id]])
  const values = []
  socket.onmessage = event => { values.push(event.data) }
  listener({ id: 'other', type: 'message', data: 'ignored' })
  listener({ id, type: 'open' })
  listener({ id, type: 'message', data: 'revision' })
  socket.send('not-ping'); socket.send('ping')
  assert.deepEqual(values, ['revision'])
  assert.deepEqual(calls.at(-1), ['send', id, 'ping'])
  socket.close()
  assert.deepEqual(calls.slice(-2), [['unlisten'], ['close', id]])
  window.mikka.bundled.live.prepare = async () => { controller.abort(); return { id, expiresAt: 1000 } }
  assert.equal(await runtime.ticket(controller.signal), null)
  assert.deepEqual(calls.at(-1), ['close', id])
  assert.equal(await browserRuntime(null).ticket(new AbortController().signal), null)
}))

test('noVNC raw channel forwards exact binary slices and rejects malformed local handles', () => browser(async window => {
  const calls = []
  let listener
  const id = 'd2a80093-1865-48ef-a867-954948ef32e0'
  window.mikka = { bundled: { viewer: {
    onEvent: callback => { calls.push('listen'); listener = callback; return () => { calls.push('unlisten') } },
    connect: async key => { calls.push(['connect', key]) }, send: async (key, data) => { calls.push(['send', key, [...data]]) }, close: async key => { calls.push(['close', key]) },
  } } }
  const { viewerChannel } = await moduleFrom({ entry: 'viewer-socket.ts' })
  const channel = viewerChannel(`wss://desktop-viewer.invalid/${id}`)
  assert.deepEqual(calls, ['listen', ['connect', id]])
  let binary
  let closed = 0
  channel.onmessage = event => { binary = new Uint8Array(event.data) }
  channel.onclose = () => { closed++ }
  listener({ id, type: 'open' })
  listener({ id, type: 'message', data: new Uint8Array([8, 9, 10, 11]).subarray(1, 3) })
  assert.deepEqual([...binary], [9, 10])
  channel.send(new Uint8Array([82, 70, 66]))
  assert.deepEqual(calls.at(-1), ['send', id, [82, 70, 66]])
  channel.close()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(closed, 1)
  assert.equal(channel.readyState, 3)
  assert.throws(() => viewerChannel(`wss://desktop-viewer.invalid/${id}?ticket=forbidden`), /invalid_desktop_viewer/)
  assert.throws(() => viewerChannel(`wss://user:password@desktop-viewer.invalid/${id}`), /invalid_desktop_viewer/)
}))

test('viewer HTTP seam retains shared response errors and routes ordinary requests through the unchanged web transport', () => browser(async window => {
  const calls = []
  window.mikka = { bundled: { viewer: { prepare: async input => { calls.push(input); return { status: 403, body: { error: 'computer_not_available' } } } } } }
  globalThis.fetch = async (path, init) => { calls.push({ path, method: init.method }); return Response.json({ machine: 'sleeping' }) }
  const { computerRequest } = await moduleFrom({ entry: 'computer-request.ts', plugins: [applicationBoundary(new Map())] })
  await assert.rejects(computerRequest('/api/bots/bot-id/computer/viewer', { method: 'POST', json: { mode: 'view' } }), error => error.status === 403 && error.body.error === 'computer_not_available')
  assert.deepEqual(calls[0], { botId: 'bot-id', mode: 'view' })
  assert.deepEqual(await computerRequest('/api/bots/bot-id/computer'), { machine: 'sleeping' })
  assert.equal(calls[1].path, '/mikka/api/bots/bot-id/computer')
}))
