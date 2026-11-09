import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { FastResponse, serve } from 'srvx/node'
import type { ApiRoute } from './routes'

const cases = [
  { status: 200, body: { ok: true } },
  { status: 401, body: { error: 'authRequired' } },
  { status: 404, body: { error: 'factoryNotFound' } },
  { status: 409, body: { error: 'factoryConflict' } },
  { status: 503, body: { error: 'unavailable' } },
] as const

// Node runs this file in its own test process. Load the compatibility layer
// after installing the actual Nitro Node response class, then restore it.
test('NextResponse JSON preserves HTTP status after FastResponse headers and body materialize', { timeout: 15_000 }, async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'Response')!
  const NativeResponse = globalThis.Response
  Object.defineProperty(globalThis, 'Response', { configurable: true, writable: true, value: FastResponse })
  try {
    const { NextResponse } = await import('../compat/server')
    const { createApiHandler } = await import('./application')
    assert.equal(Object.getPrototypeOf(NextResponse), FastResponse)
    const makeResponse = (entry: typeof cases[number]) => NextResponse.json(entry.body, {
      status: entry.status, statusText: `Fixture ${entry.status}`,
      headers: { 'cache-control': 'private, no-store', 'x-response-contract': 'preserved' },
    })
    for (const entry of cases) {
      const response = makeResponse(entry)
      // The production API bridge reads headers before body. This order used
      // to lose non-200 status when srvx spread a Response used as its init.
      const headers = new Headers(response.headers)
      const body = response.body
      assert.equal(response.status, entry.status)
      assert.equal(response.statusText, `Fixture ${entry.status}`)
      assert.equal(headers.get('content-type'), 'application/json')
      assert.equal(headers.get('cache-control'), 'private, no-store')
      assert.equal(headers.get('x-response-contract'), 'preserved')
      assert.deepEqual(await new NativeResponse(body).json(), entry.body)
    }

    const routes: ApiRoute[] = cases.map(entry => ({
      path: `/mikka/api/json/${entry.status}`, template: `/api/json/${entry.status}`,
      source: 'fast-response-contract', methods: ['GET'],
      load: async () => ({ GET: () => makeResponse(entry) }),
    }))
    const application = createApiHandler(routes)
    const runtime = serve({ manual: true, gracefulShutdown: false, silent: true, trustProxy: false,
      hostname: '127.0.0.1', port: 0, fetch: request => application.fetch(request),
    })
    const server = createServer(runtime.node!.handler)
    try {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
      const address = server.address()
      assert.ok(address && typeof address !== 'string')
      for (const entry of cases) {
        const response = await fetch(`http://127.0.0.1:${address.port}/mikka/api/json/${entry.status}`, { signal: AbortSignal.timeout(5_000) })
        assert.equal(response.status, entry.status)
        assert.equal(response.statusText, `Fixture ${entry.status}`)
        assert.equal(response.headers.get('content-type'), 'application/json')
        assert.equal(response.headers.get('cache-control'), 'private, no-store')
        assert.equal(response.headers.get('x-response-contract'), 'preserved')
        assert.deepEqual(await response.json(), entry.body)
      }
    } finally {
      server.closeAllConnections()
      if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      await runtime.close()
    }
  } finally { Object.defineProperty(globalThis, 'Response', descriptor) }
})
