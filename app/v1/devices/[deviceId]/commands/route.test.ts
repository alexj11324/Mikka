import assert from 'node:assert/strict'
import { after, before, beforeEach, mock, test } from 'node:test'
import type { RequestLogEntry } from '../../../../../lib/request-log'
import { MAILBOX_NOTICE_HEADER } from '@mikka/protocol/device'

// Keep the real wait helper while replacing database-backed route operations.
mock.module(new URL('../../../../../lib/db/index.ts', import.meta.url).href, {
  namedExports: { db: {}, pool: {} },
})
const pendingDeviceCommands = mock.fn(async (_id: string, _completed: string[]) => [{ id: 'update-command', kind: 'update' }])
mock.module(new URL('../../../../../lib/device-management.ts', import.meta.url).href, { namedExports: { pendingDeviceCommands } })
const deviceUpdateNotice = mock.fn(async () => ({ id: 'update-command', kind: 'update' as const }))
let actual: typeof import('../../../../../lib/device-link')
const authenticateDevice = mock.fn(async () => ({ userId: 'owner', tokenId: 'token' }) as object | null)
const ownsDevice = mock.fn(async () => ({ id: 'device-1', enabled: true }) as object | null)
type Work = { commands: unknown[]; queuedRuns: string[] }
type Check = { work: boolean; deviceCommand: { id: string; kind: 'redetect' | 'restart' | 'update' | 'uninstall' } | null }
const deviceMayHaveWork = mock.fn(async (_deviceId: string, _skip: readonly string[], _options?: { mailboxNotices?: boolean; queued?: boolean; skipDeviceCommands?: readonly string[] }): Promise<Check> => ({ work: true, deviceCommand: null }))
const deviceWork = mock.fn(async (_deviceId: string, _skip: readonly string[], _options?: { mailboxNotices?: boolean; queued?: boolean }): Promise<Work> => ({ commands: [], queuedRuns: [] }))
type Versions = { min: string; latest?: string }
let releases: Versions | undefined
const daemonVersions = mock.fn(async (): Promise<Versions> => releases ?? { min: '0.0.299' })
const cachedDaemonVersions = mock.fn((): Versions | undefined => releases)
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
  const { newerDaemonRelease, daemonRequestTooOld } = await import('../../../../../lib/daemon-release')
  mock.module(new URL('../../../../../lib/daemon-release.ts', import.meta.url).href, {
    namedExports: { daemonVersions, cachedDaemonVersions, newerDaemonRelease, daemonRequestTooOld },
  })
  mock.module(new URL('../../../../../lib/device-link.ts', import.meta.url).href, {
    namedExports: { authenticateDevice, deviceMayHaveWork, deviceUpdateNotice, deviceWork, ownsDevice, sleep, waitSeconds: actual.waitSeconds },
  })
  GET = (await import('./route')).GET
})
after(() => mock.restoreAll())
beforeEach(() => {
  authenticateDevice.mock.resetCalls()
  authenticateDevice.mock.mockImplementation(async () => ({ userId: 'owner', tokenId: 'token' }))
  ownsDevice.mock.resetCalls()
  ownsDevice.mock.mockImplementation(async () => ({ id: 'device-1', enabled: true }))
  deviceMayHaveWork.mock.resetCalls()
  deviceMayHaveWork.mock.mockImplementation(async () => ({ work: true, deviceCommand: null }))
  releases = undefined
  daemonVersions.mock.resetCalls()
  cachedDaemonVersions.mock.resetCalls()
  deviceWork.mock.resetCalls()
  deviceWork.mock.mockImplementation(async () => ({ commands: [], queuedRuns: [] }))
  deviceUpdateNotice.mock.resetCalls()
  deviceUpdateNotice.mock.mockImplementation(async () => ({ id: 'update-command', kind: 'update' as const }))
  sleep.mock.resetCalls()
  sleep.mock.mockImplementation(actual.sleep)
  logs.length = 0
})

function request(signal?: AbortSignal, wait = 25, skip = '', mailboxNotices = false, updates = '') {
  return new Request(`https://preview.example.test/mikka/v1/devices/device-1/commands?wait=${wait}${skip ? `&skip=${skip}` : ''}${updates}`, { signal,
    headers: { 'x-mikka-client-version': '0.0.375', ...(mailboxNotices ? { [MAILBOX_NOTICE_HEADER]: '1' } : {}) } })
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

test('an idle check that finds nothing never runs the full read, and the poll still ends empty at its deadline', async () => {
  deviceMayHaveWork.mock.mockImplementation(async () => ({ work: false, deviceCommand: null }))
  sleep.mock.mockImplementation(async () => {})
  assert.deepEqual(await (await GET(request(undefined, 0), params)).json(), { commands: [] })
  assert.equal(deviceMayHaveWork.mock.callCount(), 1)
  assert.deepEqual(deviceMayHaveWork.mock.calls[0].arguments, ['device-1', [], { mailboxNotices: false, queued: true }])
  assert.equal(deviceWork.mock.callCount(), 0)
  assert.equal(logs[0].outcome, 'empty')
})

const COMMAND = { id: '6f1c2b8e-2a8e-4c39-9d1a-3b5d7c9e1f20', kind: 'update' as const }

test('a daemon that reads releases from the poll gets one as soon as the server knows a newer one than it has', async () => {
  releases = { min: '0.0.299', latest: '0.0.401' }
  deviceMayHaveWork.mock.mockImplementation(async () => ({ work: false, deviceCommand: null }))
  const started = Date.now()
  assert.deepEqual(await (await GET(request(undefined, 25, '', false, '&daemonLatest=0.0.400'), params)).json(), { commands: [], daemonVersions: releases })
  assert.ok(Date.now() - started < 1_000, 'no wait for the deadline or a heartbeat')
  assert.equal(sleep.mock.callCount(), 0)
  assert.equal(logs[0].outcome, 'work')
})

test('a release published while the poll waits ends it at the next idle check, with no extra database read', async () => {
  releases = { min: '0.0.299', latest: '0.0.400' }
  deviceMayHaveWork.mock.mockImplementation(async () => ({ work: false, deviceCommand: null }))
  let checks = 0
  sleep.mock.mockImplementation(async () => { if (++checks === 3) releases = { min: '0.0.299', latest: '0.0.401' } })
  assert.deepEqual(await (await GET(request(undefined, 25, '', false, '&daemonLatest=0.0.400'), params)).json(), { commands: [], daemonVersions: { min: '0.0.299', latest: '0.0.401' } })
  assert.equal(sleep.mock.callCount(), 3)
  // The db module is mocked as {}: any other query would throw. One statement per check, as without releases.
  assert.equal(deviceMayHaveWork.mock.callCount(), 4)
  assert.equal(deviceWork.mock.callCount(), 0)
  assert.equal(daemonVersions.mock.callCount(), 1, 'the release cache is awaited once per poll, then only peeked')
})

test('a release the daemon already knows (it is busy or backing off) does not end the poll early, and still rides along', async () => {
  releases = { min: '0.0.299', latest: '0.0.401' }
  deviceMayHaveWork.mock.mockImplementation(async () => ({ work: false, deviceCommand: null }))
  let now = Date.now()
  const clock = mock.method(Date, 'now', () => now)
  sleep.mock.mockImplementation(async (ms: number) => { now += ms })
  try {
    assert.deepEqual(await (await GET(request(undefined, 25, '', false, '&daemonLatest=0.0.401'), params)).json(), { commands: [], daemonVersions: releases })
  } finally { clock.mock.restore() }
  assert.equal(sleep.mock.callCount(), 13, 'waited the whole 25 s, checking every 2 s')
  assert.equal(logs[0].outcome, 'empty')
})

test('an older daemon gets no releases or device commands from the poll and never ends it early for them', async () => {
  releases = { min: '0.0.299', latest: '0.0.401' }
  deviceMayHaveWork.mock.mockImplementation(async () => ({ work: false, deviceCommand: null }))
  assert.deepEqual(await (await GET(request(undefined, 0), params)).json(), { commands: [] })
  assert.equal(deviceMayHaveWork.mock.calls[0].arguments[2]?.skipDeviceCommands, undefined, 'device commands are not looked for')
  assert.equal(daemonVersions.mock.callCount(), 0)
})

test('a person\'s update reaches the device at the next idle check of its poll', async () => {
  let checks = 0
  deviceMayHaveWork.mock.mockImplementation(async () => ({ work: false, deviceCommand: ++checks >= 2 ? COMMAND : null }))
  sleep.mock.mockImplementation(async () => {})
  const held = '0b9d4f6e-7a1c-4e2b-8f3d-5c6a7b8c9d0e'
  assert.deepEqual(await (await GET(request(undefined, 25, '', false, `&daemonLatest=0.0.400&skipDeviceCommands=${held},not-a-uuid`), params)).json(), { commands: [], deviceCommands: [COMMAND], daemonVersions: { min: '0.0.299' } })
  assert.equal(sleep.mock.callCount(), 1)
  assert.deepEqual(deviceMayHaveWork.mock.calls[0].arguments[2]?.skipDeviceCommands, [held, 'not-a-uuid'], 'commands the daemon holds are left out')
  assert.equal(deviceWork.mock.callCount(), 0, 'no run work: the full read is skipped')
  assert.equal(logs[0].outcome, 'work')
})


test('obsolete daemon commands poll serves upgrade metadata without reading business work', async () => {
  const req = new Request(request(undefined, 0), { headers: { 'x-mikka-client-version': '0.0.329' } })
  const response = await GET(req, params)
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.deepEqual(body.commands, [])
  assert.equal(body.queuedRuns, undefined)
  assert.deepEqual(body.deviceCommands, [{ id: 'update-command', kind: 'update' }])
  assert.equal(deviceMayHaveWork.mock.callCount(), 0)
  assert.equal(deviceWork.mock.callCount(), 0)
  assert.equal(pendingDeviceCommands.mock.callCount(), 0, 'an idle upgrade check does not lock the device row')
  assert.equal(deviceUpdateNotice.mock.callCount(), 1)
})
