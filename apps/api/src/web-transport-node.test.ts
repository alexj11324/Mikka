import assert from 'node:assert/strict'
import { IncomingMessage, createServer } from 'node:http'
import test from 'node:test'
import { serve } from 'srvx/node'
import type { ServerRequest } from 'srvx'
import { createWebTransport } from '../../../lib/web-connection/transport'
import { after } from '../compat/server'
import { headers, cookies } from '../compat/headers'
import { createApiHandler } from './application'
import { currentRequestScope } from './context'
import type { ApiRoute } from './routes'

const originalNodeRequests = new WeakSet<Request>()
function assertOriginalNodeRequest(request: Request) {
  assert.ok(originalNodeRequests.has(request), 'tracing receives the untouched outer NodeRequest')
  assert.ok((request as ServerRequest).runtime?.node?.req instanceof IncomingMessage)
}

const officialOrigin = 'https://app.aspectlylabs.com'
const authorization = `Bearer ${'s'.repeat(40)}`
const credentialHeaders = { origin: officialOrigin, authorization, cookie: 'cloud=private',
  'x-mikka-session-cache': 'untrusted-cache', 'x-mikka-session-token': 'untrusted-token',
  'content-type': 'application/json' }
const fixture = (path: string, method: string, handler: (request: Request) => Promise<Response>): ApiRoute => ({
  path: `/mikka${path}`, template: path, source: 'web-transport-node-fixture', methods: [method], load: async () => ({ [method]: handler }),
})

/** Real listening HTTP ingress: srvx creates its NodeRequest facade from the
 * socket, and H3 owns response disposal. No Request constructor or handler mock. */
async function nodeApplication(app: ReturnType<typeof createApiHandler>) {
  let facades = 0
  const runtime = serve({ manual: true, gracefulShutdown: false, silent: true, trustProxy: false,
    hostname: '127.0.0.1', port: 0,
    fetch(request) {
      assert.ok(request.runtime?.node?.req instanceof IncomingMessage)
      assert.equal(typeof request.waitUntil, 'function')
      originalNodeRequests.add(request)
      facades++
      return app.fetch(request)
    },
  })
  const server = createServer(runtime.node!.handler)
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return {
    origin: `http://127.0.0.1:${address.port}`,
    get facades() { return facades },
    drain: () => runtime.close(),
    async close() {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      await runtime.close()
    },
  }
}

for (const [path, method, authenticated] of [
  ['/api/desktop/discovery', 'GET', false],
  ['/api/web/begin', 'POST', false],
  ['/api/web/revoke', 'POST', true],
] as const) test(`official-Origin ${method} ${path} adapts the real Node facade without losing its body or after lifetime`, { timeout: 5_000 }, async () => {
  let authenticationReads = 0, afterRuns = 0, traces = 0
  const finished = Promise.withResolvers<void>()
  const body = JSON.stringify({ state: 'synthetic-state', content: '保留 HTTP 请求体' })
  const transport = createWebTransport({ env: {}, authenticate: async incoming => {
    authenticationReads++
    assert.deepEqual([...incoming], [['authorization', authorization]])
    return { user: { id: 'fixture-owner' }, session: { id: 'fixture-session' } }
  }, scope: (_identity, work) => work() })
  const app = createApiHandler([fixture(path, method, async request => {
    assert.equal(request.headers.get('origin'), officialOrigin, 'handoff routes retain the exact caller origin')
    assert.equal(request.headers.get('authorization'), authenticated ? authorization : null)
    for (const name of ['cookie', 'x-mikka-session-cache', 'x-mikka-session-token']) assert.equal(request.headers.has(name), false)
    assert.equal((await headers()).has('cookie'), false)
    const received = await request.text()
    assert.equal(received, method === 'GET' ? '' : body)
    ;(await cookies()).set('must-not-cross', 'private')
    after(() => {
      afterRuns++
      assert.equal(currentRequestScope()?.headers.get('origin'), officialOrigin)
      finished.resolve()
    })
    return Response.json({ body: received }, { headers: { 'x-mikka-session-cache': 'must-not-cross' } })
  })], original => { assertOriginalNodeRequest(original); return { run: work => work(), finish: () => { traces++ } } }, transport)
  const server = await nodeApplication(app)
  try {
    const response = await fetch(`${server.origin}/mikka${path}`, { method, headers: credentialHeaders,
      ...(method === 'POST' ? { body } : {}) })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { body: method === 'GET' ? '' : body })
    assert.equal(response.headers.get('access-control-allow-origin'), officialOrigin)
    assert.equal(response.headers.has('access-control-allow-credentials'), false)
    assert.equal(response.headers.has('set-cookie'), false)
    assert.equal(response.headers.has('x-mikka-session-cache'), false)
    await finished.promise
    await server.drain()
    assert.equal(server.facades, 1)
    assert.equal(authenticationReads, authenticated ? 1 : 0)
    assert.equal(afterRuns, 1); assert.equal(traces, 1)
    assert.equal(currentRequestScope(), undefined)
  } finally { await server.close() }
})

for (const outcome of ['complete', 'cancel'] as const) test(`authenticated Node POST stream ${outcome} retains body, scoped Origin and the original disposal lifetime`, { timeout: 5_000 }, async () => {
  const afterEntered = Promise.withResolvers<void>(), releaseAfter = Promise.withResolvers<void>()
  let controller!: ReadableStreamDefaultController<Uint8Array>
  let afterRuns = 0, traceFinished = 0, serverOrigin = '', streamEnded = false, streamCancelled = false, requestAborted = false
  const payload = JSON.stringify({ message: 'selected server body' })
  const app = createApiHandler([fixture('/api/write', 'POST', async request => {
    assert.equal(request.headers.get('origin'), serverOrigin)
    assert.equal(request.headers.get('sec-fetch-site'), 'same-origin')
    assert.equal(request.headers.get('authorization'), authorization)
    assert.equal(request.headers.has('cookie'), false)
    assert.equal(request.headers.has('x-mikka-session-cache'), false)
    assert.equal(request.headers.has('x-mikka-session-token'), false)
    assert.equal(await request.text(), payload)
    assert.equal((await headers()).get('origin'), serverOrigin)
    request.signal.addEventListener('abort', () => { requestAborted = true }, { once: true })
    after(async () => {
      afterRuns++
      assert.equal(currentRequestScope()?.headers.get('authorization'), authorization)
      assert.equal(currentRequestScope()?.headers.has('cookie'), false)
      afterEntered.resolve()
      await releaseAfter.promise
    })
    return new Response(new ReadableStream<Uint8Array>({
      start(value) { controller = value; value.enqueue(new TextEncoder().encode('first')) },
      cancel() { streamEnded = true; streamCancelled = true },
    }))
  })], original => { assertOriginalNodeRequest(original); return { run: work => work(), finish: () => { traceFinished++ } } }, createWebTransport({ env: {},
    authenticate: async incoming => {
      assert.deepEqual([...incoming], [['authorization', authorization]])
      return { user: { id: 'fixture-owner' }, session: { id: 'fixture-session' } }
    }, scope: (_identity, work) => work(),
  }))
  const server = await nodeApplication(app)
  serverOrigin = server.origin
  try {
    const response = await fetch(`${server.origin}/mikka/api/write`, { method: 'POST', headers: credentialHeaders, body: payload })
    assert.equal(response.status, 200)
    const reader = response.body!.getReader()
    assert.equal(new TextDecoder().decode((await reader.read()).value), 'first')
    assert.equal(afterRuns, 0, 'after cannot run before the response stream disposes')
    assert.equal(traceFinished, 0)
    if (outcome === 'complete') { streamEnded = true; controller.close(); assert.equal((await reader.read()).done, true) }
    else await reader.cancel()
    await afterEntered.promise
    assert.equal(afterRuns, 1); assert.equal(traceFinished, 1)
    let drained = false
    const draining = server.drain().then(() => { drained = true })
    await Promise.resolve()
    assert.equal(drained, false, 'srvx retains H3 waitUntil until after work finishes')
    releaseAfter.resolve()
    await draining
    assert.equal(drained, true); assert.equal(server.facades, 1)
    assert.equal(afterRuns, 1); assert.equal(traceFinished, 1)
    if (outcome === 'cancel') { assert.equal(streamCancelled, true); assert.equal(requestAborted, true) }
  } finally { releaseAfter.resolve(); if (controller && !streamEnded) controller.close(); await server.close() }
})

test('the official Web client can send its original Eve submission id to a selected installation', async () => {
  const path = '/api/agents/eve/v1/session/example/turn'
  const key = 'x-mikka-submission-id'
  const id = '6cc33831-9282-49fa-8780-86b9b33aa097'
  const transport = createWebTransport({ env: {}, authenticate: async incoming => {
    assert.deepEqual([...incoming], [['authorization', authorization]])
    return { user: { id: 'owner' }, session: { id: 'session' } }
  }, scope: (_, work) => work() })
  const route = fixture(path, 'POST', async request => {
    assert.equal(request.headers.get(key), id)
    assert.equal(request.headers.get('cookie'), null)
    return Response.json({ accepted: id })
  })
  const server = await nodeApplication(createApiHandler([route], () => ({ run: work => work(), finish: () => {} }), transport))
  try {
    const preflight = (route: string, header: string) => fetch(server.origin + '/mikka' + route, { method: 'OPTIONS', headers: {
      origin: officialOrigin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type,' + header,
    } })
    const accepted = await preflight(path, key)
    assert.equal(accepted.status, 204)
    assert.equal(accepted.headers.get('access-control-allow-origin'), officialOrigin)
    assert.ok(accepted.headers.get('access-control-allow-headers')?.split(', ').includes(key))
    assert.equal(accepted.headers.has('access-control-allow-credentials'), false)
    assert.equal((await preflight(path, 'x-mikka-session-cache')).status, 403)
    assert.equal((await preflight('/api/desktop/rpc', key)).status, 403)
    const post = (headers: Record<string, string>) => fetch(server.origin + '/mikka' + path, { method: 'POST', headers: { origin: officialOrigin, [key]: id, ...headers } })
    assert.equal((await post({})).status, 401)
    assert.deepEqual(await (await post({ authorization })).json(), { accepted: id })
  } finally { await server.close() }
})
