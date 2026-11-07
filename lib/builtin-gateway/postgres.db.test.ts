import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { PostgresGatewayBus } from './postgres'
import { GatewayHub, type GatewayPeer } from './hub'
import { liveChannelId } from '../live/scope'

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

async function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('gateway notification timed out')), 2000) })])
  } finally { clearTimeout(timer) }
}
