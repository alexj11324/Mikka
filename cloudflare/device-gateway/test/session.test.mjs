import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { after, beforeEach, mock, test } from 'node:test'

// The actual DeviceSession with only the Cloudflare storage/socket boundaries
// and the application's report endpoint replaced, on a controlled clock.
// runtime.test.mjs covers the same reports through real workerd.
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'cloudflare:workers') return { shortCircuit: true, url: 'data:text/javascript,export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env } }' }
  if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
    const url = new URL(specifier, context.parentURL)
    if (!existsSync(url) && existsSync(new URL(url.href + '.ts'))) return next(url.href + '.ts', context)
  }
  return next(specifier, context)
} })
const { DeviceSession } = await import('../src/session.ts')
const { deviceGatewayTicket } = await import('../../../lib/device-gateway-ticket.ts')
const { DEVICE_GATEWAY_UPDATE_REQUIRED_CODE, DEVICE_SESSION_CLOSE_GRACE_MS } = await import('../src/session-report.ts')

const secret = 'isolated-session-test-secret'
const base = 'https://app.fixture.invalid/mikka/v1/internal/device-sessions'
const deviceId = '20000000-0000-4000-8000-000000000002'
const SOCKET_ID = /^[A-Za-z0-9_-]{8,64}$/
let now, answers, reports
const OriginalResponse = globalThis.Response, originalPair = globalThis.WebSocketPair, originalAutoResponse = globalThis.WebSocketRequestResponsePair, originalFetch = globalThis.fetch
class Socket {
  readyState = WebSocket.OPEN
  attachment = null
  closes = []
  send() {}
  close(code, reason) { this.closes.push({ code, reason }); this.readyState = WebSocket.CLOSED }
  serializeAttachment(value) { this.attachment = structuredClone(value) }
  deserializeAttachment() { return structuredClone(this.attachment) }
}
globalThis.WebSocketPair = class { constructor() { return { 0: new Socket(), 1: new Socket() } } }
globalThis.WebSocketRequestResponsePair = class {}
globalThis.Response = class extends OriginalResponse {
  constructor(body, init) {
    super(body, init?.status === 101 ? { ...init, status: 200 } : init)
    if (init?.status === 101) Object.defineProperty(this, 'status', { value: 101 })
    this.webSocket = init?.webSocket
  }
}
beforeEach(() => {
  now = 1_800_000_000_000; answers = []; reports = []
  mock.method(Date, 'now', () => now)
  // Each report takes the next scripted answer; 204 once the script runs out.
  globalThis.fetch = async (url, init) => {
    reports.push({ url: String(url), method: init.method, authorization: init.headers.authorization, body: JSON.parse(init.body) })
    const answer = answers.shift() ?? 204
    if (answer instanceof Error) throw answer
    return new OriginalResponse(null, { status: answer })
  }
})
after(() => { mock.restoreAll(); Object.assign(globalThis, { Response: OriginalResponse, WebSocketPair: originalPair, WebSocketRequestResponsePair: originalAutoResponse, fetch: originalFetch }) })

function fixture(env = { GATEWAY_PUSH_SECRET: secret, DEVICE_SESSION_REPORT_URL: base }) {
  const values = new Map(), sockets = [], pongs = new Map()
  const storage = { alarmAt: null, alarmsSet: 0,
    get: async key => structuredClone(values.get(key)), put: async (key, value) => { values.set(key, structuredClone(value)) },
    delete: async key => values.delete(key), setAlarm: async at => { storage.alarmAt = at; storage.alarmsSet++ }, deleteAlarm: async () => { storage.alarmAt = null },
  }
  const ctx = { storage, ready: null, sockets, pongs,
    blockConcurrencyWhile: run => { ctx.ready = run() }, setWebSocketAutoResponse: () => {},
    acceptWebSocket: socket => { sockets.push(socket) }, getWebSockets: () => sockets.filter(socket => socket.readyState === WebSocket.OPEN),
    getWebSocketAutoResponseTimestamp: socket => pongs.has(socket) ? new Date(pongs.get(socket)) : null,
  }
  const entry = { ctx, values, storage, session: new DeviceSession(ctx, env) }
  entry.restart = async () => { entry.session = new DeviceSession(ctx, env); await ctx.ready }
  entry.open = async (path = `/v1/devices/${deviceId}/socket`) => {
    await ctx.ready
    const ticket = deviceGatewayTicket(deviceId, secret, now)
    await entry.session.fetch(new Request(`https://fixture.invalid${path}`, { headers: { upgrade: 'websocket', 'sec-websocket-protocol': ticket.protocol } }))
    return sockets.at(-1)
  }
  entry.close = async (socket, code = 1000) => { socket.readyState = WebSocket.CLOSED; await entry.session.webSocketClose(socket, code, 'fixture') }
  /** Runs the alarm only when it is due, as the runtime would. */
  entry.alarm = async () => {
    if (storage.alarmAt === null || storage.alarmAt > now) return false
    storage.alarmAt = null
    await entry.session.alarm()
    return true
  }
  return entry
}
const sent = () => reports.map(({ body }) => body)

test('an opened device socket gets a socket id and reports connected at its open time; nothing stays scheduled', async () => {
  const f = fixture()
  const socket = await f.open()
  const { socketId } = socket.attachment.device
  assert.match(socketId, SOCKET_ID)
  assert.equal(socket.attachment.device.id, deviceId)
  assert.equal(reports.length, 0, 'the upgrade does not wait for the application')
  assert.equal(f.storage.alarmAt, now + 1)
  now += 1; assert.equal(await f.alarm(), true)
  assert.deepEqual(reports, [{ url: `${base}/${deviceId}`, method: 'POST', authorization: `Bearer ${secret}`,
    body: { state: 'connected', at: new Date(now - 1).toISOString(), socketId } }])
  assert.equal(f.storage.alarmAt, null, 'an idle device with nothing pending has no alarm')
  assert.deepEqual(f.values.get('session-v1').reports, [])
})

test('a socket replaced by a newer one (4000) never reports disconnected', async () => {
  const f = fixture()
  const first = await f.open()
  now += 1; await f.alarm()
  now += 5_000
  const second = await f.open()
  assert.deepEqual(first.closes, [{ code: 4000, reason: 'replaced' }])
  await f.close(first, 4000)
  now += 1; await f.alarm()
  now += DEVICE_SESSION_CLOSE_GRACE_MS * 2; await f.alarm()
  assert.deepEqual(sent().map(report => [report.state, report.socketId]), [
    ['connected', first.attachment.device.socketId], ['connected', second.attachment.device.socketId]])
  assert.equal(f.storage.alarmAt, null)
})

test('a closed socket reports disconnected at its close time once the 30s grace has passed', async () => {
  const f = fixture()
  const socket = await f.open()
  now += 1; await f.alarm()
  now += 60_000
  const closedAt = now
  await f.close(socket, 1006)
  assert.equal(f.storage.alarmAt, closedAt + DEVICE_SESSION_CLOSE_GRACE_MS)
  now += DEVICE_SESSION_CLOSE_GRACE_MS - 1; assert.equal(await f.alarm(), false)
  assert.equal(reports.length, 1)
  now += 1; await f.alarm()
  assert.deepEqual(sent()[1], { state: 'disconnected', at: new Date(closedAt).toISOString(), socketId: socket.attachment.device.socketId })
  assert.equal(f.storage.alarmAt, null)
  // A socket error followed by the close callback is one close.
  const again = await f.open(); now += 1; await f.alarm()
  await f.session.webSocketError(again); await f.close(again)
  now += DEVICE_SESSION_CLOSE_GRACE_MS; await f.alarm()
  assert.deepEqual(sent().map(report => report.state), ['connected', 'disconnected', 'connected', 'disconnected'])
})

test('a reconnect within the grace sends no disconnect for the closed socket', async () => {
  const f = fixture()
  const first = await f.open()
  now += 1; await f.alarm()
  await f.close(first, 1006)
  now += 10_000
  const second = await f.open()
  now += 1; await f.alarm()
  now += DEVICE_SESSION_CLOSE_GRACE_MS; await f.alarm()
  assert.deepEqual(sent().map(report => [report.state, report.socketId]), [
    ['connected', first.attachment.device.socketId], ['connected', second.attachment.device.socketId]])
  assert.equal(f.storage.alarmAt, null)
})

test('reports are retried with backoff until 2xx, in order, and survive hibernation', async () => {
  const f = fixture()
  answers = [503, new Error('fixture network down'), 429, 408]
  const socket = await f.open()
  now += 1; await f.alarm()
  assert.equal(f.storage.alarmAt, now + 1_000)
  await f.close(socket, 1006)
  const closedAt = now
  await f.restart() // hibernation: the object is rebuilt from storage
  for (const wait of [1_000, 2_000, 4_000]) {
    now += wait; assert.equal(await f.alarm(), true)
  }
  assert.equal(f.storage.alarmAt, now + 8_000)
  assert.deepEqual(sent().map(report => report.state), ['connected', 'connected', 'connected', 'connected'],
    'the disconnect waits behind its undelivered connect')
  now = closedAt + DEVICE_SESSION_CLOSE_GRACE_MS; await f.alarm()
  assert.deepEqual(sent().map(report => report.state), ['connected', 'connected', 'connected', 'connected', 'connected', 'disconnected'])
  assert.equal(new Set(sent().map(report => report.socketId)).size, 1)
  assert.equal(f.storage.alarmAt, null)
  assert.equal(f.values.has('session-v1'), true)
  assert.deepEqual(f.values.get('session-v1').reports, [])
})

test('a refused report (4xx other than 408/429) is dropped and the next one is sent', async () => {
  const f = fixture()
  answers = [400]
  const socket = await f.open()
  await f.close(socket, 1000)
  now += 1; await f.alarm()
  assert.deepEqual(sent().map(report => report.state), ['connected'])
  now += DEVICE_SESSION_CLOSE_GRACE_MS; await f.alarm()
  assert.deepEqual(sent().map(report => report.state), ['connected', 'disconnected'])
  assert.equal(f.storage.alarmAt, null)
})

test('status is online only while a device socket is open and connected or pinged within 40s', async () => {
  const f = fixture()
  const socket = await f.open()
  const openedAt = now
  now += 39_999; assert.equal((await f.session.status()).online, true)
  now += 1; assert.deepEqual(await f.session.status(), { online: false, lastSeenAt: new Date(openedAt).toISOString() })
  f.ctx.pongs.set(socket, now)
  assert.deepEqual(await f.session.status(), { online: true, lastSeenAt: new Date(now).toISOString() })
  await f.close(socket)
  assert.deepEqual(await f.session.status(), { online: false, lastSeenAt: null })
})

test('a device socket is never closed with 4001, which is reserved for update-required', async () => {
  const f = fixture()
  const socket = await f.open()
  now += 600_000 // long past the connect ticket's expiry
  await f.session.notifyLive([{ kind: 'thread', id: deviceId }])
  await f.session.revokeLive()
  await f.session.notify()
  assert.deepEqual(socket.closes, [])
  assert.equal(socket.readyState, WebSocket.OPEN)
  const next = await f.open()
  assert.deepEqual(socket.closes.map(close => close.code), [4000])
  assert.notEqual(DEVICE_GATEWAY_UPDATE_REQUIRED_CODE, 4000)
  assert.deepEqual(next.closes, [])
})

test('without a report URL the gateway stores and schedules nothing for a device', async () => {
  const f = fixture({ GATEWAY_PUSH_SECRET: secret })
  const socket = await f.open()
  await f.close(socket)
  assert.equal(f.storage.alarmsSet, 0)
  assert.equal(f.values.has('session-v1'), false)
  assert.equal(reports.length, 0)
})
