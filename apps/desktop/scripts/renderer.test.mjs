import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { Window } from 'happy-dom'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { actionSignatures, applicationBoundary } from './build-renderer.mjs'

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
  const actions = await moduleFrom({ source: 'export { listProjects } from "@/app/actions/projects"; export { getArtifact } from "@/app/actions/artifacts";', plugins: [applicationBoundary(new Map())] })
  await actions.listProjects('SWR cache key')
  await actions.getArtifact('artifact-id', 'extra ignored argument')
  assert.deepEqual(requests.map(request => [request.action, request.args]), [['projects.listProjects', []], ['artifacts.getArtifact', ['artifact-id']]])
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

test('RPC sends only the versioned local envelope, preserves Dates and does not sign out for business denials', () => browser(async () => {
  const api = await moduleFrom({ source: `export { callAction } from ${JSON.stringify(join(renderer, 'rpc.ts'))}; export { getTransportState } from ${JSON.stringify(join(renderer, 'transport-state.ts'))};` })
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
  await assert.rejects(api.callAction('module.action', []), { code: 'workspaceAccessDenied' })
  assert.equal(api.getTransportState(), 'ready')
  globalThis.fetch = async () => new Response('', { status: 401 })
  await assert.rejects(api.callAction('module.action', []), { code: 'desktop_session_expired' })
  assert.equal(api.getTransportState(), 'unauthenticated')
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
