import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { GatewayHub, type GatewayBus, type GatewayMessage, type GatewayPeer } from './hub'
import { devicePresenceGrant } from '../device-presence-grant'
import { liveChannelId, liveTicket } from '../live/scope'
import { liveReady } from '../live/events'
import { builtinGatewayConfig } from './config'
import { gatewayUpgrade } from './request'

const secret = 'isolated-presence-test-secret'
const scope = { ownerId: 'presence-test-owner', workspaceId: randomUUID() }
const channel = liveChannelId(scope)
const device = randomUUID()
const flush = () => new Promise<void>(resolve => setImmediate(resolve))

function peer() {
  const messages: string[] = [], closes: number[] = []
  const socket: GatewayPeer = { id: randomUUID(), send(value) { messages.push(value) }, close(code) { closes.push(code) } }
  return { socket, messages, closes, frames: () => messages.filter(value => value !== 'pong').map(value => JSON.parse(value)) }
}

function mesh(count = 2) {
  const nodes = Array.from({ length: count }, () => ({ id: randomUUID(), alive: true,
    receive: undefined as ((message: GatewayMessage, source?: string) => void) | undefined,
    lost: undefined as (() => void) | undefined, observers: new Set<() => void>() }))
  const messages: GatewayMessage[] = [], held: Array<() => void> = []
  const control = { holdSnapshots: false, holdClaims: false }
  const buses: GatewayBus[] = nodes.map((node, index) => ({
    async publish(message) {
      if (!node.alive) throw new Error('isolated bus is disconnected')
      messages.push(message)
      const deliver = () => {
        for (const [other, target] of nodes.entries()) if (target.alive && (other !== index || message.type === 'claim')) target.receive?.(message, node.id)
      }
      if (control.holdSnapshots && message.type === 'snapshot' || control.holdClaims && message.type === 'claim') held.push(deliver)
      else deliver()
    },
    subscribe(receive, lost) { node.receive = receive; node.lost = lost; return () => { node.receive = undefined; node.lost = undefined } },
    async observe(source, lost, signal) {
      const target = nodes.find(value => value.id === source)
      if (!target?.alive || signal?.aborted) throw new Error('isolated source is absent')
      const listener = () => lost()
      const release = () => { target.observers.delete(listener); signal?.removeEventListener('abort', release) }
      target.observers.add(listener)
      signal?.addEventListener('abort', release, { once: true })
      return release
    },
  }))
  return { buses, nodes, messages, control,
    release() { for (const deliver of held.splice(0)) deliver() },
    lose(index: number) {
      const node = nodes[index]; node.alive = false; node.lost?.()
      const listeners = [...node.observers]
      for (const lost of listeners) lost()
    },
    emit(index: number, message: GatewayMessage) { for (const node of nodes) node.receive?.(message, nodes[index].id) },
  }
}

const live = (expiresAt = Date.now() + 300_000, key = channel) => ({ kind: 'live', key, revisions: true, presence: true, expiresAt } as const)
const daemon = () => ({ kind: 'device', key: device, revisions: false, expiresAt: Date.now() + 60_000 } as const)
const command = (id: string, online: boolean, heartbeatUntil = 0) => JSON.stringify({ type: 'presence_watch', id,
  token: devicePresenceGrant(scope, [[device, online, heartbeatUntil]], secret)!.token })
const invalidations = (value: ReturnType<typeof peer>) => value.frames().filter(frame => frame.kind)

test('presence is explicitly negotiated without changing either legacy ready shape', async t => {
  const network = mesh(), hub = new GatewayHub(network.buses[0], Date.now, secret)
  t.after(() => hub.stop())
  const old = peer(), current = peer()
  await hub.open(old.socket, { ...live(), revisions: false, presence: false })
  await hub.open(current.socket, live())
  assert.deepEqual(old.frames(), [liveReady(1)])
  assert.deepEqual(current.frames(), [liveReady(2), { type: 'presence_ready', version: 1 }])
  await hub.message(old.socket, command('legacy', false))
  assert.equal(old.messages.length, 1)
  const env = { BETTER_AUTH_URL: 'https://self.example', BETTER_AUTH_SECRET: 'isolated-local-auth-secret' }
  const config = builtinGatewayConfig(env)!, ticket = liveTicket(scope, config)
  const accepted = gatewayUpgrade(new Request(`${ticket.url.replace('wss:', 'https:')}?presence=1`, {
    headers: { upgrade: 'websocket', 'sec-websocket-protocol': ticket.protocol },
  }), env)
  assert.ok(!(accepted instanceof Response))
  assert.equal(accepted.socket.presence, true)
})

test('a cross-replica watch catches up the authenticated read, acknowledges its exact expiry and isolates the home keys', async t => {
  const network = mesh(), observer = new GatewayHub(network.buses[0], Date.now, secret), producer = new GatewayHub(network.buses[1], Date.now, secret)
  t.after(() => { observer.stop(); producer.stop() })
  const browser = peer(), unrelated = peer(), devicePeer = peer()
  const expiresAt = Date.now() + 60_000
  await observer.open(browser.socket, live(expiresAt))
  await observer.open(unrelated.socket, live(expiresAt, 'f'.repeat(64)))
  await producer.open(devicePeer.socket, daemon())
  await observer.message(browser.socket, command('owned', false))
  assert.deepEqual(browser.frames().at(-1), { type: 'presence_ack', id: 'owned', expiresAt })
  assert.deepEqual(invalidations(browser), [{ kind: 'device_list', id: scope.workspaceId }, { kind: 'thread_list', id: scope.workspaceId }])
  assert.deepEqual(invalidations(unrelated), [])
  const writes = network.messages.length
  await producer.message(devicePeer.socket, 'ping')
  assert.equal(devicePeer.messages.at(-1), 'pong')
  assert.equal(network.messages.length, writes, 'a healthy ping adds no bus/database query')
  producer.close(devicePeer.socket)
  await flush()
  assert.equal(invalidations(browser).length, 4, 'closing the producer delivers just the two home keys')
})

test('an offline watch observes a future claim and a silent device deadline without polling', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_800_000_000_000 })
  const network = mesh(), observer = new GatewayHub(network.buses[0], Date.now, secret), producer = new GatewayHub(network.buses[1], Date.now, secret)
  t.after(() => { observer.stop(); producer.stop() })
  const browser = peer(), devicePeer = peer()
  await observer.open(browser.socket, live())
  const registered = observer.message(browser.socket, command('later', false))
  await flush(); t.mock.timers.tick(1000); await registered
  assert.equal(browser.frames().at(-1).type, 'presence_ack')
  assert.deepEqual(invalidations(browser), [])
  await producer.open(devicePeer.socket, daemon()); await flush()
  assert.equal(invalidations(browser).length, 2)
  const beforePing = network.messages.length
  t.mock.timers.tick(80_000)
  await producer.message(devicePeer.socket, 'ping')
  assert.equal(network.messages.length, beforePing)
  t.mock.timers.tick(89_999); await flush()
  assert.equal(invalidations(browser).length, 2)
  t.mock.timers.tick(1); await flush()
  assert.equal(invalidations(browser).length, 4)
  assert.equal(network.messages.length, beforePing + 1, 'only the offline edge is published')
  await producer.message(devicePeer.socket, 'ping'); await flush()
  assert.equal(invalidations(browser).length, 6, 'the same stale socket can recover on a real ping')
  assert.equal(network.messages.length, beforePing + 2)
})

test('a legacy heartbeat uses its known deadline once, then the grant expires and releases coverage', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_800_000_000_000 })
  const network = mesh(), hub = new GatewayHub(network.buses[0], Date.now, secret)
  t.after(() => hub.stop())
  const browser = peer(), expiresAt = Date.now() + 60_000
  await hub.open(browser.socket, live(Date.now() + 120_000))
  const proof = devicePresenceGrant(scope, [[device, true, Date.now() + 30_000]], secret, Date.now(), expiresAt)!
  const registered = hub.message(browser.socket, JSON.stringify({ type: 'presence_watch', id: 'legacy', token: proof.token }))
  await flush(); t.mock.timers.tick(1000); await registered
  assert.deepEqual(invalidations(browser), [])
  const writes = network.messages.length
  t.mock.timers.tick(29_000); await flush()
  assert.equal(invalidations(browser).length, 2)
  assert.equal(network.messages.length, writes, 'the deadline reads in-memory state, not the database')
  t.mock.timers.tick(30_000); await flush()
  assert.ok(browser.frames().some(frame => frame.type === 'presence_unavailable' && frame.id === 'legacy'))
  assert.equal(network.nodes.reduce((n, node) => n + node.observers.size, 0), 0)
})

test('unwatch and replacement fence a late registration reply and retain only the new generation', async t => {
  const network = mesh(), hub = new GatewayHub(network.buses[0], Date.now, secret), producer = new GatewayHub(network.buses[1], Date.now, secret)
  t.after(() => { hub.stop(); producer.stop() })
  const browser = peer(), devicePeer = peer()
  await hub.open(browser.socket, live())
  await producer.open(devicePeer.socket, daemon())
  network.control.holdSnapshots = true
  const cancelled = hub.message(browser.socket, command('cancelled', true))
  await flush()
  await hub.message(browser.socket, JSON.stringify({ type: 'presence_unwatch', id: 'cancelled' }))
  network.release(); await cancelled
  assert.equal(browser.frames().some(frame => frame.id === 'cancelled'), false)
  const previous = hub.message(browser.socket, command('replace', true))
  await flush()
  network.control.holdSnapshots = false
  await hub.message(browser.socket, command('replace', true))
  network.release(); await previous
  assert.equal(browser.frames().filter(frame => frame.type === 'presence_ack' && frame.id === 'replace').length, 1)
  assert.equal(network.nodes[1].observers.size, 1)
  hub.close(browser.socket)
  assert.equal(network.nodes[1].observers.size, 0)
})

test('a replacement claim fences the old producer edge and lease loss; the current producer loss revokes coverage', async t => {
  const network = mesh(3), observer = new GatewayHub(network.buses[0], Date.now, secret), first = new GatewayHub(network.buses[1], Date.now, secret), second = new GatewayHub(network.buses[2], Date.now, secret)
  t.after(() => { observer.stop(); first.stop(); second.stop() })
  const browser = peer(), oldDevice = peer(), newDevice = peer()
  await observer.open(browser.socket, live())
  await first.open(oldDevice.socket, daemon())
  await observer.message(browser.socket, command('fenced', true))
  await second.open(newDevice.socket, daemon()); await flush()
  assert.equal(oldDevice.closes[0], 4000)
  assert.equal(network.nodes[1].observers.size, 0)
  assert.equal(network.nodes[2].observers.size, 1)
  network.emit(1, { type: 'device_state', key: device, connection: oldDevice.socket.id, seen: Date.now(), online: false })
  network.lose(1); await flush()
  assert.equal(browser.frames().some(frame => frame.type === 'presence_unavailable'), false)
  assert.equal(invalidations(browser).length, 0)
  network.lose(2); await flush()
  assert.equal(browser.frames().filter(frame => frame.type === 'presence_unavailable' && frame.id === 'fenced').length, 1)
  assert.equal(invalidations(browser).length, 2)
  assert.equal(network.nodes[2].observers.size, 0)
})

test('closing before the ordered claim receipt publishes a fenced terminal edge instead of a ghost online device', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_800_000_000_000 })
  const network = mesh(), observer = new GatewayHub(network.buses[0], Date.now, secret), producer = new GatewayHub(network.buses[1], Date.now, secret)
  t.after(() => { observer.stop(); producer.stop() })
  const browser = peer(), devicePeer = peer()
  await observer.open(browser.socket, live())
  const registered = observer.message(browser.socket, command('pending-claim', true, Date.now() + 90_000))
  await flush(); t.mock.timers.tick(1000); await registered
  assert.equal(browser.frames().at(-1).type, 'presence_ack')
  network.control.holdClaims = true
  await producer.open(devicePeer.socket, daemon())
  producer.close(devicePeer.socket)
  network.control.holdClaims = false
  network.release(); await flush()
  assert.ok(network.messages.some(message => message.type === 'device_state' && message.connection === devicePeer.socket.id && !message.online))
  t.mock.timers.tick(89_000); await flush()
  assert.deepEqual(invalidations(browser), [{ kind: 'device_list', id: scope.workspaceId }, { kind: 'thread_list', id: scope.workspaceId }])
})

test('a failed pong cannot revive the removed producer or publish a second online edge', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_800_000_000_000 })
  const network = mesh(), observer = new GatewayHub(network.buses[0], Date.now, secret), producer = new GatewayHub(network.buses[1], Date.now, secret)
  t.after(() => { observer.stop(); producer.stop() })
  const browser = peer(), devicePeer = peer()
  await observer.open(browser.socket, live())
  await producer.open(devicePeer.socket, daemon())
  await observer.message(browser.socket, command('failed-pong', true, Date.now() + 90_000))
  devicePeer.socket.send = value => { if (value === 'pong') throw new Error('isolated disconnected socket'); devicePeer.messages.push(value) }
  await producer.message(devicePeer.socket, 'ping'); await flush()
  assert.deepEqual(network.messages.flatMap(message => message.type === 'device_state' ? [message.online] : []), [false])
  t.mock.timers.tick(90_000); await flush()
  assert.deepEqual(invalidations(browser), [{ kind: 'device_list', id: scope.workspaceId }, { kind: 'thread_list', id: scope.workspaceId }])
})

test('proofs are channel-bound and watch limits fail explicitly; unwatch releases its slot', async t => {
  const network = mesh(), hub = new GatewayHub(network.buses[0], Date.now, secret), producer = new GatewayHub(network.buses[1], Date.now, secret)
  t.after(() => { hub.stop(); producer.stop() })
  const browser = peer(), devicePeer = peer()
  await hub.open(browser.socket, live())
  await producer.open(devicePeer.socket, daemon())
  const other = devicePresenceGrant({ ...scope, workspaceId: randomUUID() }, [[device, true, 0]], secret)!
  await hub.message(browser.socket, JSON.stringify({ type: 'presence_watch', id: 'wrong-home', token: other.token }))
  assert.deepEqual(browser.frames().at(-1), { type: 'presence_unavailable', id: 'wrong-home' })
  for (let index = 0; index < 8; index++) await hub.message(browser.socket, command(`watch-${index}`, true))
  await hub.message(browser.socket, command('overflow', true))
  assert.deepEqual(browser.frames().at(-1), { type: 'presence_unavailable', id: 'overflow' })
  assert.equal(network.nodes[1].observers.size, 8)
  await hub.message(browser.socket, JSON.stringify({ type: 'presence_unwatch', id: 'watch-0' }))
  await hub.message(browser.socket, command('replacement', true))
  assert.equal(browser.frames().at(-1).type, 'presence_ack')
  assert.equal(network.nodes[1].observers.size, 8)
})
