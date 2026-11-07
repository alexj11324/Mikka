import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { GatewayHub, type GatewayBus, type GatewayMessage, type GatewayPeer, type GatewaySocket } from './hub'
import { builtinGatewayConfig } from './config'
import { gatewayUpgrade } from './request'
import { gatewayMessage } from './postgres'
import { deviceGatewayTicket } from '../device-gateway-ticket'
import { sessionLiveTicket } from '../live/session-ticket'

const channel = 'a'.repeat(64)
const env = { BETTER_AUTH_URL: 'https://self.example', BETTER_AUTH_SECRET: 'isolated-session-fixture-secret' }
const config = builtinGatewayConfig(env)!
const socket = (sessionId: string): GatewaySocket => ({ kind: 'live', key: channel, revisions: true, expiresAt: Date.now() + 60_000, sessionId })

function mesh(count = 3) {
  const listeners = Array.from({ length: count }, () => new Set<(message: GatewayMessage) => void>())
  const buses: GatewayBus[] = listeners.map((local, index) => ({
    subscribe(receive) { local.add(receive); return () => { local.delete(receive) } },
    async publish(message) {
      for (const [other, targets] of listeners.entries()) if (other !== index || message.type === 'claim') {
        for (const receive of targets) receive(message)
      }
    },
  }))
  return buses
}

function peer() {
  const messages: string[] = [], closes: number[] = []
  const value: GatewayPeer = { id: randomUUID(), send: message => messages.push(message), close: code => closes.push(code) }
  return { value, messages, closes }
}

test('built-in live upgrades require the session protocol; native device tickets retain their domain', () => {
  const ticket = sessionLiveTicket(channel, 'session-one', config.secret)
  const request = (protocol: string, path = `/mikka/v1/live/${channel}/socket`) => new Request(`https://self.example${path}`, {
    headers: { host: 'self.example', origin: 'https://webapp.aspectlylabs.com', upgrade: 'websocket', 'sec-websocket-protocol': protocol },
  })
  const accepted = gatewayUpgrade(request(ticket.protocol), env)
  assert.ok(!(accepted instanceof Response))
  assert.equal(accepted.socket.sessionId, 'session-one')
  assert.equal(accepted.socket.expiresAt, ticket.expiresAt)
  assert.equal((gatewayUpgrade(request(ticket.protocol), env, ticket.expiresAt) as Response).status, 401)
  assert.equal((gatewayUpgrade(request(deviceGatewayTicket(`live:${channel}`, config.secret).protocol), env) as Response).status, 401)
  const device = randomUUID(), legacy = deviceGatewayTicket(device, config.secret)
  const native = gatewayUpgrade(request(legacy.protocol, `/mikka/v1/devices/${device}/socket`), env)
  assert.ok(!(native instanceof Response))
  assert.equal(native.socket.kind, 'device')
})

test('session-bound sockets fail closed without a fresh authorizer or with a revoked session', async t => {
  for (const authorize of [undefined, async () => false, async () => { throw new Error('isolated database unavailable') }]) {
    const hub = new GatewayHub(mesh()[0], Date.now, '', authorize)
    t.after(() => hub.stop())
    const browser = peer(), claim = socket('session-one')
    assert.equal(await hub.authorize(claim), false)
    await hub.open(browser.value, claim)
    assert.equal(browser.closes.length, 1)
    assert.deepEqual(browser.messages, [], 'no readiness or application events precede authorization')
  }
})

test('session revocation closes that session on every replica while preserving another session of the same owner', async t => {
  const buses = mesh(), checks: string[] = []
  const authorize = async (sessionId: string) => { checks.push(sessionId); return true }
  const first = new GatewayHub(buses[0], Date.now, '', authorize), second = new GatewayHub(buses[1], Date.now, '', authorize)
  t.after(() => { first.stop(); second.stop() })
  const a = peer(), b = peer(), other = peer()
  await first.open(a.value, socket('session-one'))
  await second.open(b.value, socket('session-one'))
  await second.open(other.value, socket('session-two'))
  const before = checks.length
  first.message(a.value, 'ping'); second.message(other.value, 'ping')
  assert.equal(checks.length, before, 'ordinary socket messages do not query authorization')
  await buses[2].publish({ type: 'session_revoked', sessionId: 'session-one' })
  assert.equal(a.closes.length, 1); assert.equal(b.closes.length, 1)
  assert.equal(other.closes.length, 0)
  const retained = a.messages.length
  await second.live(channel, [{ kind: 'thread', id: randomUUID(), rev: 2 }])
  assert.equal(a.messages.length, retained, 'a revoked peer cannot receive later invalidations')
  assert.equal(JSON.parse(other.messages.at(-1)!).kind, 'thread')
})

test('revocation while open awaits a successful database check cannot resurrect its registered connection', async t => {
  const buses = mesh(), checked = Promise.withResolvers<boolean>()
  const hub = new GatewayHub(buses[0], Date.now, '', async () => checked.promise)
  t.after(() => hub.stop())
  const browser = peer(), opening = hub.open(browser.value, socket('session-one'))
  await buses[1].publish({ type: 'session_revoked', sessionId: 'session-one' })
  assert.equal(browser.closes.length, 1, 'the pending connection is already visible to revocation')
  checked.resolve(true)
  await opening
  assert.deepEqual(browser.messages, [], 'the late successful check cannot publish readiness')
  await hub.live(channel, [{ kind: 'thread', id: randomUUID(), rev: 3 }])
  assert.deepEqual(browser.messages, [])
})

test('the PostgreSQL envelope decoder accepts bounded session identifiers without carrying credentials', () => {
  assert.deepEqual(gatewayMessage({ type: 'session_revoked', sessionId: 'session-one', token: 'must-not-forward' }), { type: 'session_revoked', sessionId: 'session-one' })
  for (const sessionId of ['', null, 1, 'x'.repeat(10_000)]) assert.equal(gatewayMessage({ type: 'session_revoked', sessionId }), null)
})
