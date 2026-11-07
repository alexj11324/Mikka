import assert from 'node:assert/strict'
import test from 'node:test'
import { FastResponse } from 'srvx/node'

test('NextResponse JSON preserves HTTP refusals with the real srvx global Response', async t => {
  const NativeResponse = globalThis.Response
  // Nitro installs this exact adapter before loading the compatibility modules.
  // This file runs in its own node:test process, before any application import.
  globalThis.Response = FastResponse as unknown as typeof Response
  try {
    const { NextResponse } = await import('../compat/server')
    const { createApiHandler } = await import('../src/application')
    assert.equal(Object.getPrototypeOf(NextResponse), FastResponse)

    await t.test('reading headers then body cannot turn a 404 JSON response into 200', async () => {
      const response = NextResponse.json({ error: 'factoryNotFound' }, {
        status: 404, statusText: 'Not Found',
        headers: { 'cache-control': 'no-store', 'x-fixture': 'preserved' },
      })
      assert.equal(response.status, 404)
      const headers = new Headers(response.headers)
      const body = response.body
      assert.equal(response.status, 404)
      assert.equal(response.statusText, 'Not Found')
      const serialized = new NativeResponse(body, {
        status: response.status, statusText: response.statusText, headers,
      })
      assert.equal(serialized.status, 404)
      assert.equal(serialized.headers.get('cache-control'), 'no-store')
      assert.equal(serialized.headers.get('x-fixture'), 'preserved')
      assert.equal(serialized.headers.get('content-type'), 'application/json')
      assert.deepEqual(await serialized.json(), { error: 'factoryNotFound' })
    })

    for (const [status, statusText] of [
      [200, 'OK'], [401, 'Unauthorized'], [403, 'Forbidden'],
      [404, 'Not Found'], [409, 'Conflict'], [429, 'Too Many Requests'],
      [503, 'Service Unavailable'],
    ] as const) {
      await t.test(`the actual API dispatch preserves JSON status ${status}, headers and cookies`, async () => {
        const payload = { status, value: 'preserved' }
        const app = createApiHandler([{
          path: '/mikka/api/fixture', template: '/api/fixture', source: 'fixture', methods: ['GET'],
          load: async () => ({ GET: () => {
            const response = NextResponse.json(payload, {
              status, statusText,
              headers: {
                'cache-control': 'no-store',
                'content-type': 'application/problem+json',
                'x-fixture': 'preserved',
              },
            })
            response.cookies.set('fixture', 'kept', { httpOnly: true, path: '/mikka' })
            return response
          } }),
        }])
        const response = await app.fetch(new Request('https://example.test/mikka/api/fixture'))
        // Repeat the adapter's headers -> body -> status order at the public boundary.
        const headers = new Headers(response.headers)
        const body = response.body
        assert.equal(response.status, status)
        assert.equal(response.statusText, statusText)
        const serialized = new NativeResponse(body, {
          status: response.status, statusText: response.statusText, headers,
        })
        assert.equal(serialized.status, status)
        assert.equal(serialized.statusText, statusText)
        assert.equal(serialized.headers.get('cache-control'), 'no-store')
        assert.equal(serialized.headers.get('content-type'), 'application/problem+json')
        assert.equal(serialized.headers.get('x-fixture'), 'preserved')
        assert.deepEqual(serialized.headers.getSetCookie(), ['fixture=kept; Path=/mikka; HttpOnly'])
        assert.deepEqual(await serialized.json(), payload)
      })
    }
  } finally {
    globalThis.Response = NativeResponse
  }
})
