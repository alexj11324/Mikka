import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mock, test } from 'node:test'
import type { PoolClient } from 'pg'

const callbacks: (() => Promise<void>)[] = []
const reviewRevokes = mock.fn(async (..._args: unknown[]) => ({ closed: 0, pending: 0 }))
mock.module(new URL('./coding-workspace/review-sessions.ts', import.meta.url).href, { namedExports: { revokeReviewSessions: reviewRevokes } })
let outsideNext = false
mock.module('next/server', { namedExports: { after: (callback: () => Promise<void>) => {
  if (outsideNext) throw new Error('No request scope')
  callbacks.push(callback)
} } })
const id = '11111111-1111-4111-8111-111111111111'

test('committed work survives the response boundary, with bounded transient retries and no work body', async () => {
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

test('a stop or policy write wakes the devices holding its runs only after it commits (#1212)', async () => {
  const { runControlChanged, notifyRunControl } = await import('./device-gateway-notify')
  const { observeCommitEffects } = await import('./db/commit-effects')
  const devices = ['22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333']
  const lookups: { text: string; values: unknown[] }[] = []
  const lookup = { query: async (text: string, values: unknown[]) => { lookups.push({ text, values }); return { rows: devices.map(deviceId => ({ deviceId })) } } }
  const client = { query: async (text: string) => ({ command: text.trim().split(/\s/)[0].toUpperCase(), rows: [], rowCount: 0 }) } as unknown as PoolClient
  observeCommitEffects(client)
  const previous = { url: process.env.DEVICE_GATEWAY_URL, secret: process.env.DEVICE_GATEWAY_PUSH_SECRET }
  callbacks.length = 0
  try {
    // The daemon gateway is optional; human review must still close.
    delete process.env.DEVICE_GATEWAY_URL
    await notifyRunControl(lookup, { userId: 'owner-1' })
    assert.equal(lookups.length, 0)
    assert.deepEqual(reviewRevokes.mock.calls.at(-1)?.arguments, [lookup, { userId: 'owner-1' }, 'run_control'])
    reviewRevokes.mock.resetCalls()
    process.env.DEVICE_GATEWAY_URL = 'http://127.0.0.1:9'
    process.env.DEVICE_GATEWAY_PUSH_SECRET = 'isolated-test-gateway-secret'

    await client.query('BEGIN')
    runControlChanged(client, { runIds: [id] }, lookup)
    await client.query('ROLLBACK')
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(lookups.length, 0, 'a rolled-back stop wakes nobody')
    assert.equal(reviewRevokes.mock.callCount(), 0)

    await client.query('BEGIN')
    runControlChanged(client, { runIds: [id] }, lookup)
    runControlChanged(client, { runIds: [id] }, lookup)
    assert.equal(lookups.length, 0, 'nothing is sent before COMMIT')
    await client.query('COMMIT')
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(callbacks.length, 1, 'the remote close is retained after the response boundary')
    assert.equal(reviewRevokes.mock.callCount(), 0)
    await callbacks.shift()!()
    assert.equal(lookups.length, 1, 'repeated changes in one transaction coalesce')
    assert.deepEqual(reviewRevokes.mock.calls[0].arguments, [lookup, { runIds: [id] }, 'run_control'])
    assert.deepEqual(lookups[0]!.values, [[id]])
    assert.equal(callbacks.length, devices.length, 'one wake per device holding the runs')

    await notifyRunControl(lookup, { workspaceId: id })
    assert.match(lookups[1]!.text, /"botId" IN \(SELECT id FROM bots WHERE "workspaceId"=\$1\)/)
    await notifyRunControl(lookup, { runIds: [] })
    assert.equal(lookups.length, 2)
  } finally {
    callbacks.length = 0
    if (previous.url === undefined) delete process.env.DEVICE_GATEWAY_URL
    else process.env.DEVICE_GATEWAY_URL = previous.url
    if (previous.secret === undefined) delete process.env.DEVICE_GATEWAY_PUSH_SECRET
    else process.env.DEVICE_GATEWAY_PUSH_SECRET = previous.secret
  }
})
