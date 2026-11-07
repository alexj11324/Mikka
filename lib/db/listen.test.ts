import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test, { mock } from 'node:test'
import type { PoolConfig } from 'pg'

const flush = async () => { for (let n = 0; n < 16; n++) await Promise.resolve() }
let holdConnect = false, failListen = false
class Client extends EventEmitter {
  queries: string[] = []
  releases = 0
  async query(sql: string) { this.queries.push(sql); if (failListen) throw new Error('fixture LISTEN failure'); return { rows: [] } }
  release() { this.releases++ }
}
class FakePool extends EventEmitter {
  static all: FakePool[] = []
  client = new Client()
  ends = 0
  continueConnect?: () => void
  constructor(readonly options: PoolConfig) { super(); FakePool.all.push(this) }
  async connect() { if (holdConnect) await new Promise<void>(resolve => { this.continueConnect = resolve }); return this.client }
  async end() { this.ends++ }
}
mock.module('pg', { namedExports: { Pool: FakePool } })
const { subscribeShared, MCP_REPLY_CHANNEL, DEVICE_WORK_CHANNEL } = await import('./listen')
const database = (id: string) => ({ options: { connectionString: `postgresql://localhost/${id}_e2e` } })

test('MCP targets with identical options share one session and keepalive only affects that channel', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const target = database('same_target'), before = FakePool.all.length
  const [app, workspace] = await Promise.all([
    subscribeShared(target, MCP_REPLY_CHANNEL, ['bot:mine']),
    subscribeShared(target, MCP_REPLY_CHANNEL, ['member:mine']),
  ])
  assert.ok(app && workspace)
  assert.equal(FakePool.all.length, before + 1)
  const pool = FakePool.all.at(-1)!
  assert.deepEqual(pool.client.queries, [`LISTEN ${MCP_REPLY_CHANNEL}`])
  assert.equal(pool.options.keepAlive, true)
  assert.equal(pool.options.keepAliveInitialDelayMillis, 5_000)
  assert.equal(pool.options.query_timeout, 5_000)
  assert.equal(pool.options.connectionTimeoutMillis, 5_000)
  app.close(); workspace.close()
  t.mock.timers.tick(10_000); await flush()
  assert.equal(pool.client.releases, 1); assert.equal(pool.ends, 1)
  const device = await subscribeShared(database('unchanged_device'), DEVICE_WORK_CHANNEL, ['device'])
  const legacy = FakePool.all.at(-1)!
  assert.equal(legacy.options.keepAlive, undefined)
  assert.equal(legacy.options.query_timeout, undefined)
  device?.close(); t.mock.timers.tick(10_000); await flush()
})

test('abort during a pending connect leaves promptly and the late ready session becomes idle', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  holdConnect = true
  const controller = new AbortController()
  const pending = subscribeShared(database('abort_connect'), MCP_REPLY_CHANNEL, ['bot:mine'], controller.signal)
  const pool = FakePool.all.at(-1)!
  try {
    controller.abort()
    assert.equal(await pending, null)
    pool.continueConnect!(); await flush()
    t.mock.timers.tick(10_000); await flush()
    assert.equal(pool.client.releases, 1); assert.equal(pool.ends, 1)
  } finally { holdConnect = false }
})

test('an already aborted subscription opens no pool', async () => {
  const controller = new AbortController(), before = FakePool.all.length
  controller.abort()
  assert.equal(await subscribeShared(database('already_aborted'), MCP_REPLY_CHANNEL, ['bot:mine'], controller.signal), null)
  assert.equal(FakePool.all.length, before)
})

test('failed LISTEN returns unavailable and closes its actual client', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  failListen = true
  try {
    assert.equal(await subscribeShared(database('failed_listen'), MCP_REPLY_CHANNEL, ['bot:mine']), null)
    const pool = FakePool.all.at(-1)!
    assert.equal(pool.client.releases, 1); assert.equal(pool.ends, 1)
    t.mock.timers.tick(10_000); await flush()
    assert.equal(pool.ends, 1)
  } finally { failListen = false }
})

test('actual shared notification/loss latch wakes its key and not another subscriber', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const target = database('loss_latch')
  const mine = await subscribeShared(target, MCP_REPLY_CHANNEL, ['bot:mine'])
  const peer = await subscribeShared(target, MCP_REPLY_CHANNEL, ['bot:peer'])
  assert.ok(mine && peer)
  const pool = FakePool.all.at(-1)!
  let mineWoke = false, peerWoke = false
  mine.reset(); peer.reset()
  const first = mine.next(90_000).then(() => { mineWoke = true })
  const other = peer.next(90_000).then(() => { peerWoke = true })
  pool.client.emit('notification', { channel: MCP_REPLY_CHANNEL, payload: 'bot:mine' })
  await first
  assert.equal(mineWoke, true); assert.equal(peerWoke, false)
  pool.client.emit('error', new Error('controlled connection loss'))
  await other; await flush()
  assert.equal(peerWoke, true)
  assert.equal(mine.lost, true); assert.equal(peer.lost, true)
  mine.close(); peer.close(); t.mock.timers.tick(10_000); await flush()
  assert.equal(pool.client.releases, 1)
})
