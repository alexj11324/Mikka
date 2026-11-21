import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { type TestContext } from 'node:test'
import { DEVICE_GATEWAY_UPDATE_REQUIRED_CODE, DEVICE_SESSION_CLOSE_GRACE_MS, deviceSessionReportSchema, type DeviceSessionReport } from '@mikka/protocol/device'
import { GatewayHub, type GatewayBus, type GatewayMessage, type GatewayPeer, type GatewaySocket } from './hub'

const device = 'c1663280-005f-4715-b8da-c82dba74c31d'
const flush = () => new Promise<void>(resolve => setImmediate(resolve))
const daemon = (): GatewaySocket => ({ kind: 'device', key: device, revisions: false, expiresAt: Date.now() + 60_000 })

/** Replicas on one ordered bus; claims are echoed to their publisher, as PostgreSQL does. */
function mesh(count: number) {
  const nodes = Array.from({ length: count }, () => ({ id: randomUUID(), receive: undefined as ((message: GatewayMessage, source?: string) => void) | undefined, lost: undefined as (() => void) | undefined }))
  const buses: GatewayBus[] = nodes.map((node, index) => ({
    async publish(message) { for (const [other, target] of nodes.entries()) if (other !== index || message.type === 'claim') target.receive?.(message, node.id) },
    subscribe(receive, lost) { node.receive = receive; node.lost = lost; return () => { node.receive = undefined; node.lost = undefined } },
  }))
  return { buses, lose: (index: number) => nodes[index]!.lost?.() }
}

function peer() {
  const messages: string[] = [], closes: number[] = []
  const socket: GatewayPeer = { id: randomUUID(), send: value => { messages.push(value) }, close: code => { closes.push(code) } }
  return { socket, messages, closes }
}

/** Two replicas sharing one application; `answers` scripts failures before success. */
function setup(t: TestContext, count = 2) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_800_000_000_000 })
  const reports: Array<{ deviceId: string; report: DeviceSessionReport; replica: number }> = []
  const answers: Error[] = []
  const network = mesh(count)
  const hubs = network.buses.map((bus, replica) => new GatewayHub(bus, Date.now, 'secret', undefined, {
    report: async (deviceId, report) => {
      const failure = answers.shift()
      if (failure) throw failure
      deviceSessionReportSchema.parse(report)
      reports.push({ deviceId, report, replica })
      return { applied: true }
    },
  }))
  t.after(() => { for (const hub of hubs) hub.stop() })
  const tick = async (ms: number) => { t.mock.timers.tick(ms); await flush(); await flush() }
  return { hubs, reports, answers, network, tick, states: () => reports.map(({ report, replica }) => [report.state, replica]) }
}

test('the replica holding a claimed device socket reports connected at its open time, once', async t => {
  const { hubs, reports, tick } = setup(t)
  const openedAt = Date.now(), first = peer()
  await hubs[1]!.open(first.socket, daemon()); await flush()
  assert.equal(reports.length, 1)
  assert.equal(reports[0]!.replica, 1)
  assert.equal(reports[0]!.deviceId, device)
  assert.deepEqual({ ...reports[0]!.report, socketId: 'x' }, { state: 'connected', at: new Date(openedAt).toISOString(), socketId: 'x' })
  assert.match(reports[0]!.report.socketId, /^[A-Za-z0-9_-]{8,64}$/)
  await tick(DEVICE_SESSION_CLOSE_GRACE_MS * 2)
  assert.equal(reports.length, 1)
})

test('a socket replaced by a newer one on another replica never reports disconnected', async t => {
  const { hubs, reports, tick, states } = setup(t)
  const first = peer(), second = peer()
  await hubs[0]!.open(first.socket, daemon()); await flush()
  await tick(5_000)
  await hubs[1]!.open(second.socket, daemon()); await flush()
  assert.deepEqual(first.closes, [4000])
  hubs[0]!.close(first.socket)
  await tick(DEVICE_SESSION_CLOSE_GRACE_MS * 2)
  assert.deepEqual(states(), [['connected', 0], ['connected', 1]])
  assert.notEqual(reports[0]!.report.socketId, reports[1]!.report.socketId)
})

test('a closed socket reports disconnected at its close time after the 30s grace', async t => {
  const { hubs, reports, tick, states } = setup(t)
  const socket = peer()
  await hubs[0]!.open(socket.socket, daemon()); await flush()
  await tick(60_000)
  const closedAt = Date.now()
  hubs[0]!.close(socket.socket)
  await tick(DEVICE_SESSION_CLOSE_GRACE_MS - 1)
  assert.deepEqual(states(), [['connected', 0]])
  await tick(1)
  assert.deepEqual(states(), [['connected', 0], ['disconnected', 0]])
  assert.deepEqual(reports[1]!.report, { state: 'disconnected', at: new Date(closedAt).toISOString(), socketId: reports[0]!.report.socketId })
})

test('a reconnect within the grace, on any replica, sends no disconnect for the closed socket', async t => {
  for (const replica of [0, 1]) {
    const { hubs, tick, states } = setup(t)
    const first = peer(), second = peer()
    await hubs[0]!.open(first.socket, daemon()); await flush()
    hubs[0]!.close(first.socket)
    await tick(10_000)
    await hubs[replica]!.open(second.socket, daemon()); await flush()
    await tick(DEVICE_SESSION_CLOSE_GRACE_MS * 2)
    assert.deepEqual(states(), [['connected', 0], ['connected', replica]])
    for (const hub of hubs) hub.stop()
    t.mock.timers.reset()
  }
})

test('a failed report is retried with backoff until it is applied, keeping the device\'s order', async t => {
  const { hubs, answers, tick, states } = setup(t)
  answers.push(new Error('database unavailable'), new Error('database unavailable'), new Error('database unavailable'))
  const socket = peer()
  await hubs[0]!.open(socket.socket, daemon()); await flush()
  hubs[0]!.close(socket.socket)
  await tick(1_000); await tick(2_000)
  assert.deepEqual(states(), [])
  await tick(4_000)
  assert.deepEqual(states(), [['connected', 0]])
  await tick(DEVICE_SESSION_CLOSE_GRACE_MS)
  assert.deepEqual(states(), [['connected', 0], ['disconnected', 0]])
})

test('status is online only while the socket is open and connected or pinged within 40s', async t => {
  const { hubs, tick } = setup(t)
  const socket = peer()
  await hubs[0]!.open(socket.socket, daemon()); await flush()
  // An offline answer waits out the one-second cross-replica reply window.
  const status = async (hub: GatewayHub) => { const pending = hub.status(device); await tick(1_000); return pending }
  await tick(39_999)
  assert.equal((await hubs[1]!.status(device)).online, true)
  await tick(1)
  assert.equal((await status(hubs[0]!)).online, false)
  hubs[0]!.message(socket.socket, 'ping')
  assert.equal(socket.messages.at(-1), 'pong')
  assert.deepEqual(await hubs[0]!.status(device), { online: true, lastSeenAt: new Date(Date.now()).toISOString() })
  hubs[0]!.close(socket.socket)
  assert.deepEqual(await status(hubs[1]!), { online: false, lastSeenAt: null })
})

test('a device socket is never closed with 4001, which is reserved for update-required', async t => {
  const { hubs, tick } = setup(t)
  const socket = peer()
  await hubs[0]!.open(socket.socket, { ...daemon(), expiresAt: Date.now() + 1, sessionId: undefined }); await flush()
  await tick(120_000) // ticket long expired, silence long passed
  hubs[0]!.message(socket.socket, 'ping')
  await hubs[1]!.revokeLive(device)
  await hubs[1]!.live(device, [{ kind: 'thread', id: device }])
  await hubs[1]!.work(device)
  assert.deepEqual(socket.closes, [])
  assert.equal(socket.messages.at(-1), 'work')
  const next = peer()
  await hubs[1]!.open(next.socket, daemon()); await flush()
  assert.deepEqual(socket.closes, [4000])
  assert.equal(DEVICE_GATEWAY_UPDATE_REQUIRED_CODE, 4001)
})

test('a stopping replica reports nothing more; after a lost LISTEN its closes are still reported after the grace', async t => {
  const { hubs, network, tick, states } = setup(t)
  const lost = peer(), stopped = peer()
  await hubs[0]!.open(lost.socket, daemon()); await flush()
  network.lose(0)
  assert.deepEqual(lost.closes, [1012])
  await tick(DEVICE_SESSION_CLOSE_GRACE_MS)
  assert.deepEqual(states(), [['connected', 0], ['disconnected', 0]])
  await hubs[1]!.open(stopped.socket, daemon()); await flush()
  hubs[1]!.stop()
  await tick(DEVICE_SESSION_CLOSE_GRACE_MS * 2)
  assert.deepEqual(states(), [['connected', 0], ['disconnected', 0], ['connected', 1]])
})
