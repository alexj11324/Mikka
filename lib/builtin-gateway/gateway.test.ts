import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { GatewayHub, type GatewayBus, type GatewayMessage, type GatewayPeer } from './hub'
import { builtinGatewayConfig, gatewayConfig } from './config'
import { gatewayUpgrade, gatewayRequest } from './request'
import { gatewayMessage } from './postgres'
import { deviceGatewayTicket } from '../device-gateway-ticket'
import { liveChannelId, liveTicket } from '../live/scope'
import { liveReady } from '../live/events'

const device = 'c1663280-005f-4715-b8da-c82dba74c31d'
const scope = { ownerId: 'local-owner', workspaceId: '3dd8b1a7-8c0d-49f4-b78d-989d651e1fa4' }
const channel = liveChannelId(scope)
const env = { BETTER_AUTH_URL: 'https://self.example', BETTER_AUTH_SECRET: 'local-better-auth-secret' }
const config = builtinGatewayConfig(env)!

function buses(count = 2) {
  const receivers: Array<{ receive?: (message: GatewayMessage) => void; lost?: () => void }> = Array.from({ length: count }, () => ({}))
  const messages: GatewayMessage[] = []
  const bus: GatewayBus[] = receivers.map((entry, index) => ({
    async publish(message) { messages.push(message); for (const [i, target] of receivers.entries()) if (i !== index || message.type === 'claim') target.receive?.(message) },
    subscribe(receive, lost) { Object.assign(entry, { receive, lost }); return () => { delete entry.receive; delete entry.lost } },
  }))
  return { bus, messages, lose: (index: number) => receivers[index].lost?.() }
}

function peer() {
  const messages: string[] = [], closes: Array<{ code: number; reason: string }> = []
  const socket: GatewayPeer = { id: randomUUID(), send: value => messages.push(value), close: (code, reason) => closes.push({ code, reason }) }
  return { socket, messages, closes }
}

test('community signs its own base-path sockets and an explicit Worker remains authoritative', () => {
  assert.equal(config.url, 'https://self.example/mikka')
  assert.notEqual(config.secret, env.BETTER_AUTH_SECRET)
  assert.equal(gatewayConfig({ ...env, BETTER_AUTH_URL: 'https://self.example/mikka' }), null)
  assert.deepEqual(gatewayConfig({ ...env, DEVICE_GATEWAY_PUSH_SECRET: 'persisted-installation-key' }), {
    mode: 'builtin', url: 'https://self.example/mikka', secret: 'persisted-installation-key',
  }, 'Docker first boot generates a local gateway key without a Worker URL')
  assert.equal(gatewayConfig({ ...env, MIKKA_EDITION: 'cloud' }), null)
  assert.equal(gatewayConfig({ ...env, VERCEL: '1' }), null)
  assert.equal(gatewayConfig({ ...env, DEVICE_GATEWAY_URL: 'https://worker.example' }), null)
  assert.deepEqual(gatewayConfig({ ...env, DEVICE_GATEWAY_URL: 'https://worker.example/discarded', DEVICE_GATEWAY_PUSH_SECRET: 'worker-secret' }), {
    mode: 'worker', url: 'https://worker.example', secret: 'worker-secret',
  })
  const ticket = liveTicket(scope, config, Date.now(), 'gateway-test-session')
  assert.equal(ticket.url, `wss://self.example/mikka/v1/live/${channel}/socket`)
  assert.equal(ticket.url.includes(ticket.protocol), false)
})

test('upgrade validates channel, ticket domain, expiry and configured host before accepting', () => {
  const ticket = liveTicket(scope, config, Date.now(), 'gateway-test-session')
  const request = (path = `/mikka/v1/live/${channel}/socket`, protocol = ticket.protocol, host = 'self.example') =>
    new Request(`http://${host}${path}`, { headers: { host, upgrade: 'websocket', 'sec-websocket-protocol': `other, ${protocol}` } })
  const accepted = gatewayUpgrade(request(), env)
  assert.ok(!(accepted instanceof Response))
  assert.equal(accepted.protocol, ticket.protocol)
  assert.equal(accepted.socket.expiresAt, ticket.expiresAt)
  for (const bad of [request(undefined, 'mikka-ticket-invalid'), request(undefined, deviceGatewayTicket(device, config.secret).protocol), request(undefined, undefined, 'attacker.example')]) {
    assert.ok(gatewayUpgrade(bad, env) instanceof Response)
  }
  assert.equal((gatewayUpgrade(request(), env, ticket.expiresAt) as Response).status, 401)
  assert.equal((gatewayUpgrade(request(`/mikka/v1/live/${'f'.repeat(64)}/socket`), env) as Response).status, 401)
})

test('two replicas fan out only matching invalidations, keep old wire format and close expired readers', async t => {
  const mesh = buses(), first = new GatewayHub(mesh.bus[0]), second = new GatewayHub(mesh.bus[1])
  t.after(() => { first.stop(); second.stop() })
  const legacy = peer(), revised = peer(), unrelated = peer()
  await first.open(legacy.socket, { kind: 'live', key: channel, revisions: false, expiresAt: Date.now() + 60_000 })
  await second.open(revised.socket, { kind: 'live', key: channel, revisions: true, expiresAt: Date.now() + 60_000 })
  await second.open(unrelated.socket, { kind: 'live', key: 'f'.repeat(64), revisions: true, expiresAt: Date.now() + 60_000 })
  assert.deepEqual(JSON.parse(legacy.messages[0]), liveReady(1))
  assert.deepEqual(JSON.parse(revised.messages[0]), liveReady(2))
  await first.live(channel, [{ kind: 'thread', id: device, rev: 8 }])
  assert.deepEqual(JSON.parse(legacy.messages[1]), { kind: 'thread', id: device })
  assert.deepEqual(JSON.parse(revised.messages[1]), { kind: 'thread', id: device, rev: 8 })
  assert.equal(unrelated.messages.length, 1)
  const expired = peer()
  await first.open(expired.socket, { kind: 'live', key: channel, revisions: true, expiresAt: Date.now() - 1 })
  assert.equal(expired.closes[0].code, 4001)
})

test('device pings stay in memory; cross-node presence and wakes work and a new socket replaces the old one', async t => {
  let now = Date.now()
  const mesh = buses(), first = new GatewayHub(mesh.bus[0], () => now), second = new GatewayHub(mesh.bus[1], () => now)
  t.after(() => { first.stop(); second.stop() })
  const initial = peer()
  await first.open(initial.socket, { kind: 'device', key: device, revisions: false, expiresAt: now + 1 })
  const initialWrites = mesh.messages.length
  now += 1000
  first.message(initial.socket, 'ping')
  assert.equal(initial.messages.at(-1), 'pong', 'device connection outlives its connect ticket')
  assert.equal(mesh.messages.length, initialWrites, 'no database event per heartbeat')
  assert.deepEqual(await second.status(device), { online: true, lastSeenAt: new Date(now).toISOString() })
  await second.work(device)
  assert.equal(initial.messages.at(-1), 'work')
  const replacement = peer()
  await second.open(replacement.socket, { kind: 'device', key: device, revisions: false, expiresAt: now + 1 })
  assert.equal(initial.closes[0].code, 4000)
  mesh.lose(1)
  assert.equal(replacement.closes[0].code, 1012, 'lost LISTEN forces reconnect and a fresh authorized read')
})

test('built-in push/status endpoints require the server bearer and bounded invalidation-only bodies', async t => {
  const mesh = buses(1), hub = new GatewayHub(mesh.bus[0])
  t.after(() => hub.stop())
  const url = `https://self.example/mikka/v1/live/${channel}/push`
  assert.equal((await gatewayRequest(new Request(url, { method: 'POST' }), hub, env)).status, 401)
  const push = (body: unknown) => gatewayRequest(new Request(url, { method: 'POST', headers: { authorization: `Bearer ${config.secret}` }, body: JSON.stringify(body) }), hub, env)
  assert.equal((await push([{ kind: 'thread', id: device, prompt: 'private content' }])).status, 400)
  assert.equal((await push('x'.repeat(2049))).status, 400)
  assert.equal((await push([{ kind: 'thread', id: device }])).status, 204)
  assert.equal(mesh.messages.length, 1)
})

test('simultaneous daemon reconnects converge by notification commit order, not wall clocks', async t => {
  const receivers: Array<(message: GatewayMessage) => void> = [], commits: GatewayMessage[] = []
  const bus = (): GatewayBus => ({
    async publish(message) { commits.push(message) },
    subscribe(receive) { receivers.push(receive); return () => {} },
  })
  const first = new GatewayHub(bus(), () => Date.now() + 10_000), second = new GatewayHub(bus(), () => Date.now() - 10_000)
  t.after(() => { first.stop(); second.stop() })
  const earlier = peer(), later = peer()
  await first.open(earlier.socket, { kind: 'device', key: device, revisions: false, expiresAt: 0 })
  await second.open(later.socket, { kind: 'device', key: device, revisions: false, expiresAt: 0 })
  for (const message of commits) for (const receive of receivers) receive(message)
  assert.equal(earlier.closes[0].code, 4000)
  assert.equal(later.closes.length, 0)
})

test('Postgres envelopes accept only known message types with validated identifiers', () => {
  assert.deepEqual(gatewayMessage({ type: 'work', key: device }), { type: 'work', key: device })
  for (const invalid of [null, [], { type: 'work', key: 'arbitrary' }, { type: 'live', key: channel, events: [{ kind: 'thread', id: device, secret: 'x' }] }, { type: 'token', key: device }]) {
    assert.equal(gatewayMessage(invalid), null)
  }
})

test('opaque live revocation closes only that capability across replicas and rejects a late open result', async t => {
  const mesh = buses(3), secondKey = 'd'.repeat(64)
  const first = new GatewayHub(mesh.bus[0], Date.now, config.secret, async () => true)
  const second = new GatewayHub(mesh.bus[1], Date.now, config.secret, async () => true)
  t.after(() => { first.stop(); second.stop() })
  const a = peer(), b = peer(), personal = peer()
  const socket = { kind: 'live' as const, key: channel, sessionId: 'same-session', revisions: true, expiresAt: Date.now() + 60_000 }
  await first.open(a.socket, socket)
  await second.open(b.socket, socket)
  await second.open(personal.socket, { ...socket, key: secondKey })
  const checked = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const delayed = new GatewayHub(mesh.bus[2], Date.now, config.secret, async () => {
    checked.resolve(); await release.promise; return true
  })
  t.after(() => delayed.stop())
  const late = peer(), opening = delayed.open(late.socket, socket)
  await checked.promise
  const push = (body: unknown, secretHeader = `Bearer ${config.secret}`) => gatewayRequest(new Request(`https://self.example/mikka/v1/live/${channel}/push`, {
    method: 'POST', headers: { authorization: secretHeader }, body: JSON.stringify(body),
  }), second, env)
  try {
    assert.equal((await push({ type: 'live_revoked' }, '')).status, 401)
    assert.equal((await push({ type: 'live_revoked', extra: true })).status, 400)
    const accepted = await push({ type: 'live_revoked' })
    assert.equal(accepted.status, 200)
    assert.deepEqual(await accepted.json(), { revoked: true })
  } finally { release.resolve(); await opening }
  assert.equal(a.closes[0]?.code, 4001)
  assert.equal(b.closes[0]?.code, 4001)
  assert.equal(late.closes[0]?.code, 4001)
  assert.deepEqual(late.messages, [], 'a pre-revocation successful query cannot reopen the channel')
  assert.equal(await second.authorize(socket), false)
  assert.deepEqual(personal.closes, [])
  const before = b.messages.length
  await second.live(channel, [{ kind: 'factory_task', id: device }])
  assert.equal(b.messages.length, before)
  await second.live(secondKey, [{ kind: 'thread', id: device, rev: 12 }])
  assert.deepEqual(JSON.parse(personal.messages.at(-1)!), { kind: 'thread', id: device, rev: 12 })
  assert.deepEqual(gatewayMessage({ type: 'live_revoked', key: channel }), { type: 'live_revoked', key: channel })
  assert.equal(gatewayMessage({ type: 'live_revoked', key: device }), null)
})
