import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mock, test } from 'node:test'

const callbacks: (() => Promise<void>)[] = []
let outsideNext = false
mock.module('next/server', { namedExports: { after: (callback: () => Promise<void>) => {
  if (outsideNext) throw new Error('No request scope')
  callbacks.push(callback)
} } })
const id = '11111111-1111-4111-8111-111111111111'

test('work is sent after the response/commit boundary, with bounded transient retries and no work body', async () => {
  const { notifyDeviceWork } = await import('./device-gateway-notify')
  const received: string[] = []
  let committed = false
  const server = createServer(async (request, response) => {
    assert.equal(committed, true, 'the device must not be woken before committed work is readable')
    assert.equal(request.method, 'POST')
    assert.equal(request.url, `/v1/devices/${id}/push`)
    assert.equal(request.headers.authorization, 'Bearer isolated-test-gateway-secret')
    let body = ''
    for await (const chunk of request) body += chunk
    received.push(body)
    response.writeHead(received.length === 1 ? 503 : 204).end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const previous = { url: process.env.DEVICE_GATEWAY_URL, secret: process.env.DEVICE_GATEWAY_PUSH_SECRET }
  process.env.DEVICE_GATEWAY_URL = `http://127.0.0.1:${address.port}`
  process.env.DEVICE_GATEWAY_PUSH_SECRET = 'isolated-test-gateway-secret'
  try {
    notifyDeviceWork(id)
    assert.equal(callbacks.length, 1)
    assert.equal(received.length, 0)
    committed = true
    await callbacks.shift()!()
    assert.deepEqual(received, ['', ''])

    // A non-Next function still registers a promise with Vercel's real helper.
    outsideNext = true
    const symbol = Symbol.for('@vercel/request-context')
    const globals = globalThis as unknown as Record<symbol, unknown>
    const before = globals[symbol]
    const pending: Promise<unknown>[] = []
    globals[symbol] = { get: () => ({ waitUntil: (promise: Promise<unknown>) => pending.push(promise) }) }
    try {
      notifyDeviceWork(id)
      assert.equal(pending.length, 1)
      await pending[0]
      assert.equal(received.length, 3)
    } finally { globals[symbol] = before; outsideNext = false }
  } finally {
    if (previous.url === undefined) delete process.env.DEVICE_GATEWAY_URL
    else process.env.DEVICE_GATEWAY_URL = previous.url
    if (previous.secret === undefined) delete process.env.DEVICE_GATEWAY_PUSH_SECRET
    else process.env.DEVICE_GATEWAY_PUSH_SECRET = previous.secret
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
