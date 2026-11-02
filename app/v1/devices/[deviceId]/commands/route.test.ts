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
const ownsDevice = mock.fn(async () => ({ id: 'device-1', enabled: true }) as object | null)
type Work = { commands: unknown[]; queuedRuns: string[] }
const deviceWork = mock.fn(async (_deviceId: string, _skip: readonly string[], _options?: { mailboxNotices?: boolean; queued?: boolean }): Promise<Work> => ({ commands: [], queuedRuns: [] }))
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
    namedExports: { authenticateDevice, deviceWork, ownsDevice, sleep, waitSeconds: actual.waitSeconds },
  })
  GET = (await import('./route')).GET
})
after(() => mock.restoreAll())
beforeEach(() => {
  authenticateDevice.mock.resetCalls()
  authenticateDevice.mock.mockImplementation(async () => ({ userId: 'owner', tokenId: 'token' }))
  ownsDevice.mock.resetCalls()
  ownsDevice.mock.mockImplementation(async () => ({ id: 'device-1', enabled: true }))
  deviceWork.mock.resetCalls()
  deviceWork.mock.mockImplementation(async () => ({ commands: [], queuedRuns: [] }))
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
  assert.equal(deviceWork.mock.callCount(), 0)
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
  assert.equal(deviceWork.mock.callCount(), 1)
  assert.equal(sleep.mock.callCount(), 1)
  assert.equal(sleep.mock.calls[0].arguments[0], 2_000, 'an idle device is checked every 2 s')
  assert.equal(sleep.mock.calls[0].arguments[1]?.aborted, true)
  assert.equal(logs[0].outcome, 'ignored')
})

test('disconnect while a query is in flight prevents waiting or another query', async () => {
  const controller = new AbortController()
  deviceWork.mock.mockImplementation(async () => { controller.abort(); return { commands: [], queuedRuns: [] } })
  assert.equal((await GET(request(controller.signal), params)).status, 204)
  assert.equal(deviceWork.mock.callCount(), 1)
  assert.equal(sleep.mock.callCount(), 0)
})

test('work returns immediately and a zero-wait empty queue is recorded separately', async () => {
  const commands = [{ kind: 'stop', runId: 'run-1' }]
  deviceWork.mock.mockImplementation(async () => ({ commands, queuedRuns: [] }))
  assert.deepEqual(await (await GET(request(), params)).json(), { commands })
  assert.equal(sleep.mock.callCount(), 0)
  assert.equal(logs[0].outcome, 'work')
  deviceWork.mock.mockImplementation(async () => ({ commands: [], queuedRuns: [] }))
  assert.deepEqual(await (await GET(request(undefined, 0), params)).json(), { commands: [] })
  assert.equal(logs[1].outcome, 'empty')
  assert.ok(logs.every(entry => entry.route === '/v1/devices/[deviceId]/commands'))
  assert.ok(!JSON.stringify(logs).includes('device-1'))
})

test('authentication and ownership failures do not query the queue or label an empty result', async () => {
  authenticateDevice.mock.mockImplementation(async () => null)
  assert.equal((await GET(request(), params)).status, 401)
  authenticateDevice.mock.mockImplementation(async () => ({ userId: 'owner', tokenId: 'token' }))
  ownsDevice.mock.mockImplementation(async () => null)
  assert.equal((await GET(request(), params)).status, 404)
  assert.equal(deviceWork.mock.callCount(), 0)
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
  deviceWork.mock.mockImplementation(async () => ({ commands: [], queuedRuns: ++polls >= 2 ? ['run-new'] : [] }))
  sleep.mock.mockImplementation(async () => {})
  assert.deepEqual(await (await GET(request(undefined, 25, 'run-old'), params)).json(), { commands: [], queuedRuns: ['run-new'] })
  assert.equal(sleep.mock.callCount(), 1)
  assert.deepEqual(deviceWork.mock.calls[0].arguments, ['device-1', ['run-old'], { mailboxNotices: false, queued: true }], 'one read per check finds both commands and queued runs')
  assert.equal(logs[0].outcome, 'work')
})

test('a device with scheduling off is never offered queued runs', async () => {
  ownsDevice.mock.mockImplementation(async () => ({ id: 'device-1', enabled: false }))
  assert.deepEqual(await (await GET(request(undefined, 0), params)).json(), { commands: [] })
  assert.equal(deviceWork.mock.calls[0].arguments[2]?.queued, false)
})

test('mailbox notice commands require a capable daemon so older clients keep receiving stop and input', async () => {
  await GET(request(undefined, 0), params)
  assert.equal(deviceWork.mock.calls[0].arguments[2]?.mailboxNotices, false)
  await GET(request(undefined, 0, '', true), params)
  assert.equal(deviceWork.mock.calls[1].arguments[2]?.mailboxNotices, true)
})
