import assert from 'node:assert/strict'
import { after, before, beforeEach, mock, test } from 'node:test'
import type { RequestLogEntry } from '../../../../../lib/request-log'
import { MAILBOX_NOTICE_HEADER } from '@mikka/protocol/device'

// Keep the real wait helper while replacing database-backed route operations.
mock.module(new URL('../../../../../lib/db/index.ts', import.meta.url).href, {
  namedExports: { db: {}, pool: {} },
})
let actual: typeof import('../../../../../lib/device-link')
const authenticateDevice = mock.fn(async () => ({ userId: 'owner', tokenId: 'token' }) as object | null)
const ownedDevice = mock.fn(async () => ({ id: 'device-1', enabled: true }) as object | null)
const pendingCommands = mock.fn(async (_deviceId: string, _skip: readonly string[], _mailboxNotices?: boolean) => [] as unknown[])
const queuedRuns = mock.fn(async (_deviceId: string, _skip: readonly string[]) => [] as string[])
const sleep = mock.fn(async (ms: number, signal?: AbortSignal) => actual.sleep(ms, signal))
const logs: RequestLogEntry[] = []
for (const method of ['log', 'warn', 'error'] as const) {
  mock.method(console, method, (line: string) => {
    if (typeof line !== 'string' || !line.startsWith('{')) return
    const entry = JSON.parse(line)
    if (entry.msg === 'api_request') logs.push(entry)
  })
}
mock.module(new URL('../../../../../lib/device-route.ts', import.meta.url).href, {
  namedExports: { withDeviceRoute: (handler: unknown) => handler },
})
mock.module('next/server', { namedExports: { NextResponse: Response } })

let GET: typeof import('./route')['GET']
before(async () => {
  actual = await import('../../../../../lib/device-link')
  mock.module(new URL('../../../../../lib/device-link.ts', import.meta.url).href, {
    namedExports: { authenticateDevice, ownedDevice, pendingCommands, queuedRuns, sleep, waitSeconds: actual.waitSeconds },
  })
  GET = (await import('./route')).GET
})
after(() => mock.restoreAll())
beforeEach(() => {
  authenticateDevice.mock.resetCalls()
  authenticateDevice.mock.mockImplementation(async () => ({ userId: 'owner', tokenId: 'token' }))
  ownedDevice.mock.resetCalls()
  ownedDevice.mock.mockImplementation(async () => ({ id: 'device-1', enabled: true }))
  queuedRuns.mock.resetCalls()
  queuedRuns.mock.mockImplementation(async () => [])
  pendingCommands.mock.resetCalls()
  pendingCommands.mock.mockImplementation(async () => [])
  sleep.mock.resetCalls()
  sleep.mock.mockImplementation(actual.sleep)
  logs.length = 0
})

function request(signal?: AbortSignal, wait = 25, skip = '', mailboxNotices = false) {
  return new Request(`https://preview.example.test/mikka/v1/devices/device-1/commands?wait=${wait}${skip ? `&skip=${skip}` : ''}`, { signal,
    headers: mailboxNotices ? { [MAILBOX_NOTICE_HEADER]: '1' } : {} })
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

test('a queued run ends the long-poll at once so the device claims it without waiting for a heartbeat', async () => {
  let polls = 0
  queuedRuns.mock.mockImplementation(async () => (++polls >= 2 ? ['run-new'] : []))
  sleep.mock.mockImplementation(async () => {})
  assert.deepEqual(await (await GET(request(undefined, 25, 'run-old'), params)).json(), { commands: [], queuedRuns: ['run-new'] })
  assert.equal(sleep.mock.callCount(), 1)
  assert.deepEqual(queuedRuns.mock.calls[0].arguments, ['device-1', ['run-old']])
  assert.equal(logs[0].outcome, 'work')
})

test('a device with scheduling off is never offered queued runs', async () => {
  ownedDevice.mock.mockImplementation(async () => ({ id: 'device-1', enabled: false }))
  assert.deepEqual(await (await GET(request(undefined, 0), params)).json(), { commands: [] })
  assert.equal(queuedRuns.mock.callCount(), 0)
})

test('mailbox notice commands require a capable daemon so older clients keep receiving stop and input', async () => {
  await GET(request(undefined, 0), params)
  assert.equal(pendingCommands.mock.calls[0].arguments[2], false)
  await GET(request(undefined, 0, '', true), params)
  assert.equal(pendingCommands.mock.calls[1].arguments[2], true)
})
