import assert from 'node:assert/strict'
import { after, before, beforeEach, mock, test } from 'node:test'
import type { RequestLogEntry } from '../../../../../lib/request-log'

// Keep the real wait helper while replacing database-backed route operations.
mock.module(new URL('../../../../../lib/db/index.ts', import.meta.url).href, {
  namedExports: { db: {}, pool: {} },
})
const actual = await import('../../../../../lib/device-link')
const authenticateDevice = mock.fn(async () => ({ userId: 'owner', tokenId: 'token' }) as object | null)
const ownedDevice = mock.fn(async () => ({ id: 'device-1' }) as object | null)
const pendingCommands = mock.fn(async () => [] as unknown[])
const sleep = mock.fn(actual.sleep)
const logs: RequestLogEntry[] = []
for (const method of ['log', 'warn', 'error'] as const) {
  mock.method(console, method, (line: string) => {
    if (typeof line !== 'string' || !line.startsWith('{')) return
    const entry = JSON.parse(line)
    if (entry.msg === 'api_request') logs.push(entry)
  })
}
mock.module(new URL('../../../../../lib/device-link.ts', import.meta.url).href, {
  namedExports: { authenticateDevice, ownedDevice, pendingCommands, sleep, waitSeconds: actual.waitSeconds },
})
mock.module(new URL('../../../../../lib/device-route.ts', import.meta.url).href, {
  namedExports: { withDeviceRoute: (handler: unknown) => handler },
})
mock.module('next/server', { namedExports: { NextResponse: Response } })

let GET: typeof import('./route')['GET']
before(async () => { ({ GET } = await import('./route')) })
after(() => mock.restoreAll())
beforeEach(() => {
  authenticateDevice.mock.resetCalls()
  authenticateDevice.mock.mockImplementation(async () => ({ userId: 'owner', tokenId: 'token' }))
  ownedDevice.mock.resetCalls()
  ownedDevice.mock.mockImplementation(async () => ({ id: 'device-1' }))
  pendingCommands.mock.resetCalls()
  pendingCommands.mock.mockImplementation(async () => [])
  sleep.mock.resetCalls()
  sleep.mock.mockImplementation(actual.sleep)
  logs.length = 0
})

function request(signal?: AbortSignal, wait = 25) {
  return new Request(`https://preview.example.test/mikka/v1/devices/device-1/commands?wait=${wait}`, { signal })
}
const params = { params: Promise.resolve({ deviceId: 'device-1' }) }

test('an already disconnected client never queries pending commands', async () => {
  const controller = new AbortController()
  controller.abort()
  assert.equal((await GET(request(controller.signal), params)).status, 204)
  assert.equal(pendingCommands.mock.callCount(), 0)
  assert.equal(sleep.mock.callCount(), 0)
  assert.equal(logs[0].outcome, 'ignored')
})

test('disconnect during the idle wait cancels the timer and prevents the next database query', async () => {
  const controller = new AbortController()
  sleep.mock.mockImplementation(async (ms, signal) => {
    const waiting = actual.sleep(ms, signal)
    controller.abort()
    await waiting
  })
  assert.equal((await GET(request(controller.signal), params)).status, 204)
  assert.equal(pendingCommands.mock.callCount(), 1)
  assert.equal(sleep.mock.callCount(), 1)
  assert.equal(sleep.mock.calls[0].arguments[1]?.aborted, true)
  assert.equal(logs[0].outcome, 'ignored')
})

test('disconnect while a query is in flight prevents waiting or another query', async () => {
  const controller = new AbortController()
  pendingCommands.mock.mockImplementation(async () => { controller.abort(); return [] })
  assert.equal((await GET(request(controller.signal), params)).status, 204)
  assert.equal(pendingCommands.mock.callCount(), 1)
  assert.equal(sleep.mock.callCount(), 0)
})

test('work returns immediately and a zero-wait empty queue is recorded separately', async () => {
  const commands = [{ kind: 'stop', runId: 'run-1' }]
  pendingCommands.mock.mockImplementation(async () => commands)
  assert.deepEqual(await (await GET(request(), params)).json(), { commands })
  assert.equal(sleep.mock.callCount(), 0)
  assert.equal(logs[0].outcome, 'work')
  pendingCommands.mock.mockImplementation(async () => [])
  assert.deepEqual(await (await GET(request(undefined, 0), params)).json(), { commands: [] })
  assert.equal(logs[1].outcome, 'empty')
  assert.ok(logs.every(entry => entry.route === '/v1/devices/[deviceId]/commands'))
  assert.ok(!JSON.stringify(logs).includes('device-1'))
})

test('authentication and ownership failures do not query the queue or label an empty result', async () => {
  authenticateDevice.mock.mockImplementation(async () => null)
  assert.equal((await GET(request(), params)).status, 401)
  authenticateDevice.mock.mockImplementation(async () => ({ userId: 'owner', tokenId: 'token' }))
  ownedDevice.mock.mockImplementation(async () => null)
  assert.equal((await GET(request(), params)).status, 404)
  assert.equal(pendingCommands.mock.callCount(), 0)
  assert.ok(logs.every(entry => entry.outcome === undefined))
})

test('sleep accepts an already aborted signal and still supports ordinary waits', async () => {
  const controller = new AbortController()
  controller.abort()
  await actual.sleep(25_000, controller.signal)
  await actual.sleep(0)
  await assert.rejects(actual.sleep(1, {} as AbortSignal), TypeError)
})
