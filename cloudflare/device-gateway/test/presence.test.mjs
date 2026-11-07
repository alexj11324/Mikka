import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { after, beforeEach, mock, test } from 'node:test'

// Execute the actual DeviceSession with only the Cloudflare storage/socket/RPC
// boundaries replaced. The real workerd upgrade and 90s alarm are also covered
// by runtime.test.mjs; this clock makes the lifecycle races deterministic.
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'cloudflare:workers') return { shortCircuit: true, url: 'data:text/javascript,export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env } }' }
  if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
    const url = new URL(specifier, context.parentURL)
    if (!existsSync(url) && existsSync(new URL(url.href + '.ts'))) return next(url.href + '.ts', context)
  }
  return next(specifier, context)
} })
const { DeviceSession } = await import('../src/session.ts')
const { devicePresenceGrant } = await import('../../../lib/device-presence-grant.ts')
const { deviceGatewayTicket } = await import('../../../lib/device-gateway-ticket.ts')
const { liveChannelId } = await import('../../../lib/live/scope.ts')
const { PRESENCE_MAX_DEVICE_WATCHES } = await import('../../../lib/live/presence.ts')

const secret = 'isolated-presence-test-secret'
const home = '10000000-0000-4000-8000-000000000001'
const deviceId = '20000000-0000-4000-8000-000000000001'
const scope = { ownerId: 'owner', workspaceId: home }
const channel = liveChannelId(scope)
let now
const OriginalResponse = globalThis.Response, originalPair = globalThis.WebSocketPair, originalAutoResponse = globalThis.WebSocketRequestResponsePair
class Socket {
  readyState = WebSocket.OPEN
  attachment = null
  messages = []
  send(message) { if (this.readyState !== WebSocket.OPEN) throw Error('fixture socket closed'); this.messages.push(JSON.parse(message)) }
  close() { this.readyState = WebSocket.CLOSED }
  serializeAttachment(value) { assert.ok(JSON.stringify(value).length < 2048); this.attachment = structuredClone(value) }
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
beforeEach(() => { now = 1_800_000_000_000; mock.method(Date, 'now', () => now) })
after(() => { mock.restoreAll(); globalThis.Response = OriginalResponse; globalThis.WebSocketPair = originalPair; globalThis.WebSocketRequestResponsePair = originalAutoResponse })

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const keys = socket => socket.messages.filter(message => message.kind)
const acks = socket => socket.messages.filter(message => message.type === 'presence_ack')
const expectedKeys = [{ kind: 'device_list', id: home }, { kind: 'thread_list', id: home }]

function fixture() {
  const objects = new Map(), calls = []
  let beforeWatch = async () => {}
  const get = name => {
    if (objects.has(name)) return objects.get(name)
    const values = new Map(), sockets = [], pongs = new Map()
    const storage = { alarmAt: null, alarmsSet: 0,
      get: async key => structuredClone(values.get(key)), put: async (key, value) => { values.set(key, structuredClone(value)) },
      delete: async key => values.delete(key), setAlarm: async at => { storage.alarmAt = at; storage.alarmsSet++ }, deleteAlarm: async () => { storage.alarmAt = null },
    }
    const ctx = { storage, ready: null, sockets, pongs,
      blockConcurrencyWhile: run => { ctx.ready = run() }, setWebSocketAutoResponse: () => {},
      acceptWebSocket: socket => { sockets.push(socket) }, getWebSockets: () => sockets,
      getWebSocketAutoResponseTimestamp: socket => pongs.has(socket) ? new Date(pongs.get(socket)) : null,
    }
    const entry = { ctx, values, session: new DeviceSession(ctx, env), stub: null }
    entry.stub = Object.fromEntries(['fetch', 'status', 'notify', 'notifyLive', 'watchPresence', 'unwatchPresence', 'presenceChanged', 'alarm', 'webSocketMessage', 'webSocketClose'].map(method => [method, async (...args) => {
      await ctx.ready
      calls.push({ name, method })
      if (method === 'watchPresence') await beforeWatch(name, args[0])
      return entry.session[method](...args)
    }]))
    objects.set(name, entry)
    return entry
  }
  const env = { GATEWAY_PUSH_SECRET: secret, DEVICE_SESSION: { getByName: name => get(name).stub } }
  const open = async (name, query = '', expiry = now + 300_000) => {
    const entry = get(name)
    const path = name.startsWith('live:') ? `/v1/live/${name.slice(5)}/socket` : `/v1/devices/${name}/socket`
    const ticket = deviceGatewayTicket(name, secret, expiry - 300_000)
    await entry.stub.fetch(new Request(`https://fixture.invalid${path}${query}`, { headers: { upgrade: 'websocket', 'sec-websocket-protocol': ticket.protocol } }))
    return { ...entry, socket: entry.ctx.sockets.at(-1) }
  }
  return { get, open, objects, calls, setBeforeWatch: fn => { beforeWatch = fn } }
}
const watch = (live, devices, id = 'p1', proof = devicePresenceGrant(scope, devices, secret, now)) => live.stub.webSocketMessage(live.socket, JSON.stringify({ type: 'presence_watch', id, token: proof.token }))
const unwatch = (live, id = 'p1') => live.stub.webSocketMessage(live.socket, JSON.stringify({ type: 'presence_unwatch', id }))
const close = live => live.stub.webSocketClose(live.socket, 1000, 'fixture complete')

test('unobserved device and live sockets schedule no alarm, including connect, lapse and reconnect', async () => {
  const f = fixture(), device = await f.open(deviceId), live = await f.open(`live:${channel}`, '?revisions=1&presence=1')
  assert.equal(live.socket.messages[0].version, 2)
  assert.equal(Object.keys(live.socket.messages[0]).length, 4)
  assert.deepEqual(live.socket.messages[1], { type: 'presence_ready', version: 1 })
  now += 90_000
  assert.equal((await device.stub.status()).online, false)
  await close(device); await f.open(deviceId)
  assert.equal(device.ctx.storage.alarmsSet, 0)
  assert.equal(live.ctx.storage.alarmsSet, 0)
  assert.equal(device.ctx.storage.alarmAt, null)
  assert.deepEqual(keys(live.socket), [])
})

test('active tabs receive one home fanout on connect, disconnect and reconnect; other owners receive none', async () => {
  const f = fixture(), first = await f.open(`live:${channel}`, '?presence=1'), second = await f.open(`live:${channel}`, '?presence=1')
  const peer = await f.open(`live:${liveChannelId({ ...scope, ownerId: 'peer' })}`, '?presence=1')
  await watch(first, [[deviceId, false, 0]])
  await watch(second, [[deviceId, false, 0]])
  assert.equal(acks(first.socket).length, 1); assert.deepEqual(keys(first.socket), [])
  const device = await f.open(deviceId)
  assert.deepEqual(keys(first.socket), expectedKeys)
  assert.deepEqual(keys(second.socket), expectedKeys)
  assert.equal(f.calls.filter(call => call.method === 'presenceChanged').length, 1, 'one RPC per owner/home, not one per tab')
  await close(device)
  assert.deepEqual(keys(first.socket).slice(2), expectedKeys)
  await f.open(deviceId)
  assert.deepEqual(keys(first.socket).slice(4), expectedKeys)
  assert.deepEqual(keys(peer.socket), [])
  await unwatch(first)
  assert.notEqual(device.ctx.storage.alarmAt, null, 'the second real observer still needs expiry')
  await unwatch(second)
  assert.equal(device.ctx.storage.alarmAt, null)
  assert.equal(first.ctx.storage.alarmAt, null)
  assert.equal(device.values.has('presence-v1'), false)
})

test('90s silence expires naturally; auto-pong on the same open socket recovers only while watched', async () => {
  const f = fixture(), device = await f.open(deviceId), live = await f.open(`live:${channel}`, '?presence=1')
  await watch(live, [[deviceId, true, 0]])
  assert.equal(device.ctx.storage.alarmAt, now + 90_000)
  now += 90_000
  await device.stub.alarm()
  assert.equal((await device.stub.status()).online, false)
  assert.deepEqual(keys(live.socket), expectedKeys)
  assert.equal(device.socket.readyState, WebSocket.OPEN)
  assert.equal(device.ctx.storage.alarmAt, now + 60_000)
  now += 30_000; device.ctx.pongs.set(device.socket, now)
  now += 30_000; await device.stub.alarm()
  assert.equal((await device.stub.status()).online, true)
  assert.deepEqual(keys(live.socket).slice(2), expectedKeys)
  await close(live)
  assert.equal(device.ctx.storage.alarmAt, null)
})

test('healthy auto-pongs move the observed expiry without sending keys or waking unobserved devices', async () => {
  const f = fixture(), device = await f.open(deviceId), live = await f.open(`live:${channel}`, '?presence=1')
  await watch(live, [[deviceId, true, 0]])
  now += 30_000; device.ctx.pongs.set(device.socket, now)
  now += 30_000; device.ctx.pongs.set(device.socket, now)
  now += 30_000; await device.stub.alarm()
  assert.deepEqual(keys(live.socket), [])
  assert.equal(device.ctx.storage.alarmAt, now + 60_000)
  await unwatch(live)
  assert.equal(device.ctx.storage.alarmAt, null)
})

test('read → watch race catches a device that went offline after the authorized read', async () => {
  const f = fixture(), device = await f.open(deviceId), live = await f.open(`live:${channel}`, '?presence=1')
  const observed = (await device.stub.status()).online
  const proof = devicePresenceGrant(scope, [[deviceId, observed, 0]], secret, now)
  await close(device)
  await watch(live, [], 'p1', proof)
  assert.deepEqual(keys(live.socket), expectedKeys)
  assert.equal(acks(live.socket).length, 1)
  assert.ok(live.socket.messages.findIndex(message => message.kind) < live.socket.messages.findIndex(message => message.type === 'presence_ack'))
})

test('legacy heartbeat coverage survives a gateway disconnect until its existing deadline', async () => {
  const f = fixture(), live = await f.open(`live:${channel}`, '?presence=1'), device = f.get(deviceId)
  await watch(live, [[deviceId, true, now + 60_000]])
  assert.deepEqual(keys(live.socket), [])
  assert.equal(device.ctx.storage.alarmAt, now + 60_000)
  now += 60_000; await device.stub.alarm()
  assert.deepEqual(keys(live.socket), expectedKeys)
  assert.equal(device.ctx.storage.alarmAt, acks(live.socket)[0].expiresAt, 'no open socket needs a recovery check')
})

for (const action of ['close', 'unwatch']) test(`${action} during pending registration cannot leave an observer or acknowledge stale coverage`, async () => {
  const f = fixture(), live = await f.open(`live:${channel}`, '?presence=1')
  const entered = deferred(), release = deferred()
  f.setBeforeWatch(async () => { entered.resolve(); await release.promise })
  const pending = watch(live, [[deviceId, false, 0]])
  await entered.promise
  if (action === 'close') await close(live)
  else await unwatch(live)
  release.resolve(); await pending
  assert.equal(acks(live.socket).length, 0)
  assert.equal(f.get(deviceId).ctx.storage.alarmAt, null)
  assert.equal(f.get(deviceId).values.has('presence-v1'), false)
  assert.equal(live.ctx.storage.alarmAt, null)
})

test('an immediate unwatch also wins before the first registration await returns', async () => {
  const f = fixture(), live = await f.open(`live:${channel}`, '?presence=1')
  const pending = watch(live, [[deviceId, false, 0]])
  await unwatch(live); await pending
  assert.equal(acks(live.socket).length, 0)
  assert.equal(live.ctx.storage.alarmAt, null)
  assert.equal(f.objects.has(deviceId), false)
})

test('expiry and hibernation preserve cleanup without renewing the grant or reading application data', async () => {
  const f = fixture(), live = await f.open(`live:${channel}`, '?presence=1', now + 600_000), device = await f.open(deviceId)
  await watch(live, [[deviceId, true, 0]])
  const expiry = acks(live.socket)[0].expiresAt
  f.get(deviceId).session = new DeviceSession(device.ctx, { GATEWAY_PUSH_SECRET: secret, DEVICE_SESSION: { getByName: name => f.get(name).stub } })
  await device.ctx.ready
  now += 90_000; await device.stub.alarm()
  assert.deepEqual(keys(live.socket), expectedKeys, 'hibernation retains the registered observer and its previous state')
  now = expiry
  await live.stub.alarm()
  assert.equal(live.socket.messages.at(-1).type, 'presence_unavailable')
  assert.equal(live.ctx.storage.alarmAt, null)
  assert.equal(f.get(deviceId).ctx.storage.alarmAt, null)
  assert.equal(f.get(deviceId).values.has('presence-v1'), false)
})

test('old sockets, foreign grants, malformed frames and partial device rejection never acknowledge coverage', async () => {
  const f = fixture(), old = await f.open(`live:${channel}`), live = await f.open(`live:${channel}`, '?presence=1')
  await watch(old, [[deviceId, false, 0]])
  assert.equal(old.socket.messages.length, 1)
  assert.equal(Object.keys(old.socket.messages[0]).length, 3)
  const foreign = devicePresenceGrant({ ...scope, ownerId: 'peer' }, [[deviceId, false, 0]], secret, now)
  await watch(live, [], 'foreign', foreign)
  await live.stub.webSocketMessage(live.socket, JSON.stringify({ type: 'presence_watch', id: 'large', token: 'x'.repeat(2048) }))
  assert.equal(f.objects.has(deviceId), false)
  const other = '20000000-0000-4000-8000-000000000002'
  f.setBeforeWatch(async name => { if (name === other) throw Error('fixture device unavailable') })
  await watch(live, [[deviceId, false, 0], [other, false, 0]], 'partial')
  assert.equal(acks(live.socket).length, 0)
  assert.equal(live.socket.messages.at(-1).type, 'presence_unavailable')
  assert.equal(f.get(deviceId).ctx.storage.alarmAt, null)
  assert.equal(live.ctx.storage.alarmAt, null)
})

test('device observer limit refuses coverage without disturbing existing watches', async () => {
  const f = fixture(), device = await f.open(deviceId)
  for (let i = 0; i < PRESENCE_MAX_DEVICE_WATCHES; i++) assert.equal((await device.stub.watchPresence({ observer: `fixture-${i}`, channel, home, expiresAt: now + 300_000, heartbeatUntil: 0, online: true })).accepted, true)
  assert.equal((await device.stub.watchPresence({ observer: 'one-too-many', channel, home, expiresAt: now + 300_000, heartbeatUntil: 0, online: true })).accepted, false)
  assert.equal(device.values.get('presence-v1').device.length, PRESENCE_MAX_DEVICE_WATCHES)
})

test('a socket cannot grow unbounded watches, and unwatch frees its actual registration', async () => {
  const f = fixture(), live = await f.open(`live:${channel}`, '?presence=1')
  for (let i = 0; i < 8; i++) await watch(live, [[deviceId, false, 0]], `p${i}`)
  await watch(live, [[deviceId, false, 0]], 'p8')
  assert.equal(acks(live.socket).length, 8)
  assert.deepEqual(live.socket.messages.at(-1), { type: 'presence_unavailable', id: 'p8' })
  await unwatch(live, 'p0'); await watch(live, [[deviceId, false, 0]], 'p8')
  assert.equal(acks(live.socket).length, 9)
  assert.equal(f.get(deviceId).values.get('presence-v1').device.length, 8)
  await close(live)
  assert.equal(f.get(deviceId).ctx.storage.alarmAt, null)
})

test('failed fanout retries only the key delivery and clears an obsolete retry after reconnect', async () => {
  const f = fixture(), device = await f.open(deviceId), live = await f.open(`live:${channel}`, '?presence=1')
  await watch(live, [[deviceId, true, 0]])
  const deliver = live.stub.presenceChanged
  live.stub.presenceChanged = async () => { throw Error('fixture RPC unavailable') }
  await close(device)
  assert.equal(device.ctx.storage.alarmAt, now + 30_000)
  now += 10_000; await f.open(deviceId)
  assert.equal(device.ctx.storage.alarmAt, now + 90_000, 'a reverted state cannot leave a past retry causing an alarm loop')
  live.stub.presenceChanged = deliver
  await close(live)
  assert.equal(device.ctx.storage.alarmAt, null)
})
