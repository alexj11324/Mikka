import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Client, type ClientConfig, type QueryResult } from 'pg'
import { PostgresGatewayBus } from './postgres'
import { GatewayHub, type GatewayPeer } from './hub'
import { liveChannelId } from '../live/scope'
import { devicePresenceGrant } from '../device-presence-grant'

const url = process.env.E2E_DATABASE_URL
const disposable = !!url && ['127.0.0.1', 'localhost'].includes(new URL(url).hostname) && new URL(url).pathname.endsWith('_e2e')
if (process.env.REQUIRE_DB === '1' && !disposable) throw new Error('REQUIRE_DB=1 requires a loopback *_e2e database')

test('PG17: two app replicas share live pushes, device wakes/presence and one cron leader', { skip: !disposable }, async t => {
  const firstBus = new PostgresGatewayBus({ connectionString: url }), secondBus = new PostgresGatewayBus({ connectionString: url })
  const first = new GatewayHub(firstBus), second = new GatewayHub(secondBus)
  t.after(async () => { first.stop(); second.stop(); await Promise.all([firstBus.stop(), secondBus.stop()]) })
  await Promise.all([firstBus.ready(), secondBus.ready()])
  const device = randomUUID(), channel = liveChannelId({ ownerId: randomUUID(), workspaceId: randomUUID() })
  let acceptEvent: (value: string) => void = () => {}, acceptWork: (value: string) => void = () => {}
  const live: GatewayPeer = { id: randomUUID(), send: value => acceptEvent(value), close() {} }
  const daemon: GatewayPeer = { id: randomUUID(), send: value => acceptWork(value), close() {} }
  await first.open(live, { kind: 'live', key: channel, revisions: true, expiresAt: Date.now() + 60_000 })
  await first.open(daemon, { kind: 'device', key: device, revisions: false, expiresAt: Date.now() + 60_000 })
  const delivered = new Promise<string>(resolve => { acceptEvent = resolve })
  await second.live(channel, [{ kind: 'thread', id: device, rev: 7 }])
  assert.deepEqual(JSON.parse(await withTimeout(delivered)), { kind: 'thread', id: device, rev: 7 })
  const work = new Promise<string>(resolve => { acceptWork = resolve })
  await second.work(device)
  assert.equal(await withTimeout(work), 'work')
  assert.equal((await second.status(device)).online, true)
  assert.equal(await firstBus.isSchedulerLeader(), true)
  assert.equal(await secondBus.isSchedulerLeader(), false)
  await firstBus.stop()
  assert.equal(await secondBus.isSchedulerLeader(), true, 'a dropped session releases cron leadership')
})

type RecordedClient = { client: Client; options: ClientConfig; statements: string[] }
function recordedBus(after?: (sql: string, result: QueryResult, client: RecordedClient) => Promise<void>) {
  const clients: RecordedClient[] = []
  const bus = new PostgresGatewayBus({ connectionString: url }, options => {
    const client = new Client(options), execute = client.query
    const record = { client, options, statements: [] as string[] }
    // Preserve actual PG execution; record only statement names, never values.
    client.query = ((...args: unknown[]) => {
      const input = args[0]
      const sql = typeof input === 'string' ? input : (input as { text?: string })?.text ?? ''
      record.statements.push(sql)
      const result = Reflect.apply(execute, client, args) as Promise<QueryResult>
      return after ? result.then(async value => { await after(sql, value, record); return value }) : result
    }) as Client['query']
    clients.push(record)
    return client
  })
  return { bus, clients }
}

function observedPeer() {
  const frames: Array<Record<string, unknown>> = [], closed: number[] = []
  const waiting = new Set<(frame: Record<string, unknown>) => void>()
  const peer: GatewayPeer = { id: randomUUID(), send(text) {
    if (text === 'pong' || text === 'work') return
    const frame = JSON.parse(text) as Record<string, unknown>
    frames.push(frame)
    for (const receive of waiting) receive(frame)
  }, close(code) { closed.push(code) } }
  return { peer, frames, closed, next(type: string) {
    const existing = frames.find(frame => frame.type === type)
    if (existing) return Promise.resolve(existing)
    return new Promise<Record<string, unknown>>(resolve => {
      const receive = (frame: Record<string, unknown>) => { if (frame.type === type) { waiting.delete(receive); resolve(frame) } }
      waiting.add(receive)
    })
  } }
}

async function sourceEpoch(bus: PostgresGatewayBus) {
  const key = randomUUID(), connection = randomUUID()
  const source = Promise.withResolvers<string>()
  const unsubscribe = bus.subscribe((message, epoch) => {
    if (message.type === 'claim' && message.key === key && epoch) source.resolve(epoch)
  }, () => source.reject(new Error('isolated source ended before its claim')))
  try {
    await bus.publish({ type: 'claim', key, connection, seen: Date.now() })
    return await withTimeout(source.promise)
  } finally { unsubscribe() }
}

test('PG17: a remote producer session ending revokes an acknowledged presence watch without heartbeat SQL', { skip: !disposable, timeout: 30_000 }, async t => {
  const observer = recordedBus(), producer = recordedBus(), secret = 'isolated-pg-presence-secret'
  const first = new GatewayHub(observer.bus, Date.now, secret), second = new GatewayHub(producer.bus, Date.now, secret)
  t.after(async () => { first.stop(); second.stop(); await Promise.all([observer.bus.stop(), producer.bus.stop()]) })
  await Promise.all([observer.bus.ready(), producer.bus.ready()])
  const scope = { ownerId: randomUUID(), workspaceId: randomUUID() }, device = randomUUID()
  const browser = observedPeer(), daemon = observedPeer(), expiresAt = Date.now() + 60_000
  await first.open(browser.peer, { kind: 'live', key: liveChannelId(scope), revisions: true, presence: true, expiresAt })
  await second.open(daemon.peer, { kind: 'device', key: device, revisions: false, expiresAt })
  const proof = devicePresenceGrant(scope, [[device, true, 0]], secret)!
  await first.message(browser.peer, JSON.stringify({ type: 'presence_watch', id: 'remote', token: proof.token }))
  assert.deepEqual(await withTimeout(browser.next('presence_ack')), { type: 'presence_ack', id: 'remote', expiresAt })
  const watcher = observer.clients.find(record => record.options.application_name?.startsWith('mikka-gateway-watch:'))!
  assert.ok(watcher, 'cross-replica coverage holds a real PG session-lifetime wait')
  const { rows } = await producer.clients[0].client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
  const before = producer.clients[0].statements.length
  for (let index = 0; index < 10; index++) second.message(daemon.peer, 'ping')
  assert.equal(producer.clients[0].statements.length, before, 'ordinary ping/pong performs no SQL')
  const ended = new Promise<void>(resolve => watcher.client.once('end', resolve))
  const loss = browser.next('presence_unavailable')
  const terminated = await observer.clients[0].client.query<{ ended: boolean }>('SELECT pg_terminate_backend($1) AS ended', [rows[0].pid])
  assert.equal(terminated.rows[0].ended, true, 'terminate only the backend created by this isolated test')
  assert.deepEqual(await withTimeout(loss), { type: 'presence_unavailable', id: 'remote' })
  await withTimeout(ended)
  assert.deepEqual(browser.frames.filter(frame => frame.kind), [{ kind: 'device_list', id: scope.workspaceId }, { kind: 'thread_list', id: scope.workspaceId }])
  assert.deepEqual(browser.closed, [], 'only remote presence coverage is lost; the observer live session remains healthy')
})

test('PG17: a shared source waiter stays until its last subscriber and then releases the physical session', { skip: !disposable, timeout: 30_000 }, async t => {
  const producer = recordedBus(), observer = recordedBus()
  t.after(async () => { await Promise.all([producer.bus.stop(), observer.bus.stop()]) })
  await Promise.all([producer.bus.ready(), observer.bus.ready()])
  const source = await sourceEpoch(producer.bus), lost = () => assert.fail('the live source did not end')
  const first = await observer.bus.observe(source, lost), second = await observer.bus.observe(source, lost)
  const watchers = observer.clients.filter(record => record.options.application_name?.startsWith('mikka-gateway-watch:'))
  assert.equal(watchers.length, 1)
  first()
  const { rows } = await observer.clients[0].client.query<{ count: number }>(
    'SELECT count(*)::integer AS count FROM pg_stat_activity WHERE application_name=$1', [watchers[0].options.application_name])
  assert.equal(rows[0].count, 1, 'the repeated callback still owns its distinct second reference')
  const ended = new Promise<void>(resolve => watchers[0].client.once('end', resolve))
  second()
  await withTimeout(ended)
  const remaining = await observer.clients[0].client.query<{ count: number }>(
    'SELECT count(*)::integer AS count FROM pg_stat_activity WHERE application_name=$1', [watchers[0].options.application_name])
  assert.equal(remaining.rows[0].count, 0)
  await observer.bus.observe(source, lost)
  await observer.bus.stop()
  const stopped = await producer.clients[0].client.query<{ count: number }>(
    'SELECT count(*)::integer AS count FROM pg_stat_activity WHERE application_name=$1', [watchers[0].options.application_name])
  assert.equal(stopped.rows[0].count, 0, 'stop also cancels the actual backend before completing cleanup')
})

test('PG17: an observer socket disappearing releases its blocked backend without application polling', { skip: !disposable, timeout: 30_000 }, async t => {
  const sentinel = BigInt.asUintN(63, BigInt(`0x${randomUUID().replaceAll('-', '')}`)).toString()
  const producer = recordedBus(), observer = recordedBus(async (sql, _result, record) => {
    if (sql.startsWith('SET statement_timeout')) {
      // A test-only session lock exposes the server's actual disconnect as an
      // event. It is never a production heartbeat or a sleep/poll substitute.
      await record.client.query('SELECT pg_advisory_lock($1::bigint)', [sentinel])
    }
  })
  t.after(async () => { await Promise.all([producer.bus.stop(), observer.bus.stop()]) })
  await Promise.all([producer.bus.ready(), observer.bus.ready()])
  const source = await sourceEpoch(producer.bus), lost = Promise.withResolvers<void>()
  await observer.bus.observe(source, () => lost.resolve())
  const watcher = observer.clients.find(record => record.options.application_name?.startsWith('mikka-gateway-watch:'))!
  const released = producer.clients[0].client.query('SELECT pg_advisory_lock($1::bigint)', [sentinel])
  // No CancelRequest can repair this already-lost transport. Like a killed
  // observer, it relies on PG's per-session kernel socket check, not the
  // application cleanup callback, to interrupt the blocked server query.
  watcher.client.connection.stream.destroy()
  await withTimeout(lost.promise)
  await withTimeout(released, 5_000)
  const remaining = await producer.clients[0].client.query<{ count: number }>(
    'SELECT count(*)::integer AS count FROM pg_stat_activity WHERE application_name=$1', [watcher.options.application_name])
  assert.equal(remaining.rows[0].count, 0, 'the physical backend disappeared while its producer source stayed alive')
})

test('PG17: source death between try-shared and the blocking wait still signals loss and releases the waiter', { skip: !disposable, timeout: 30_000 }, async t => {
  const producer = recordedBus()
  let pid = 0, crossed = false
  const observer = recordedBus(async (sql, result) => {
    if (!sql.includes('pg_try_advisory_lock_shared') || result.rows[0]?.absent !== false) return
    crossed = true
    const terminated = await observer.clients[0].client.query<{ ended: boolean }>('SELECT pg_terminate_backend($1) AS ended', [pid])
    assert.equal(terminated.rows[0].ended, true)
  })
  t.after(async () => { await Promise.all([producer.bus.stop(), observer.bus.stop()]) })
  await Promise.all([producer.bus.ready(), observer.bus.ready()])
  pid = (await producer.clients[0].client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid
  const source = await sourceEpoch(producer.bus), lost = Promise.withResolvers<void>()
  let lossCount = 0
  const release = await observer.bus.observe(source, () => { lossCount++; lost.resolve() }).catch(() => null)
  assert.equal(crossed, true)
  await withTimeout(lost.promise)
  assert.equal(lossCount, 1)
  release?.()
  await observer.bus.stop()
  const watcher = observer.clients.find(record => record.options.application_name?.startsWith('mikka-gateway-watch:'))!
  assert.ok(watcher.statements.some(sql => sql.includes('pg_advisory_lock_shared')), 'the real blocking acquisition observes the released owner lock')
})

async function withTimeout<T>(promise: Promise<T>, timeoutMs = 2_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('gateway notification timed out')), timeoutMs) })])
  } finally { clearTimeout(timer) }
}
