import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, test } from 'node:test'
import { Pool } from 'pg'
import { COORDINATOR_LEASE_CHANNEL, DEVICE_WORK_CHANNEL, nextNotification, notifyChannel, openListener, subscribeShared } from './listen'

// The push behind 停止 (#1212): NOTIFY with the writer's transaction, LISTEN on a direct session.
const url = process.env.E2E_DATABASE_URL
const disposable = !!url && ['127.0.0.1', 'localhost'].includes(new URL(url).hostname) && new URL(url).pathname.endsWith('_e2e')
if (process.env.REQUIRE_DB === '1' && !disposable) throw new Error('REQUIRE_DB=1 requires a loopback *_e2e database')
const pool = disposable ? new Pool({ connectionString: url, max: 2 }) : undefined
after(() => pool?.end())

test('PG17: a lease push reaches a listener only on COMMIT, never on ROLLBACK', { skip: !pool }, async () => {
  const listener = await openListener(pool!, COORDINATOR_LEASE_CHANNEL)
  const botId = randomUUID(), other = randomUUID()
  const writer = await pool!.connect()
  try {
    let heard = false
    const off = listener.on(botId, () => { heard = true })
    await writer.query('BEGIN')
    await notifyChannel(writer, COORDINATOR_LEASE_CHANNEL, [botId])
    await writer.query('ROLLBACK')
    await notifyChannel(writer, COORDINATOR_LEASE_CHANNEL, [other])
    await nextNotification(listener, botId, 300)
    assert.equal(heard, false, 'a rolled-back write and another payload wake nobody')

    await writer.query('BEGIN')
    await notifyChannel(writer, COORDINATOR_LEASE_CHANNEL, [botId])
    await nextNotification(listener, botId, 300)
    assert.equal(heard, false, 'nothing is delivered before COMMIT')
    const started = performance.now()
    const woke = nextNotification(listener, botId, 10_000)
    await writer.query('COMMIT')
    await woke
    assert.ok(performance.now() - started < 2_000, 'the committed push wakes the waiter at once, not on its fallback')
    assert.equal(heard, true)
    off()
    // A push that came before the wait is kept until the next fresh read consumes it.
    assert.equal(listener.consume(botId), true)
    assert.equal(listener.consume(botId), false)
  } finally { writer.release(); await listener.close() }
})

test('PG17: device waiters share one LISTEN session; each wakes only for its own keys, and a push during a read is not lost', { skip: !pool }, async () => {
  const device = randomUUID(), other = randomUUID()
  const mine = await subscribeShared(pool!, DEVICE_WORK_CHANNEL, [device, `token:${device}`])
  const theirs = await subscribeShared(pool!, DEVICE_WORK_CHANNEL, [other])
  assert.ok(mine && theirs)
  try {
    const sessions = await pool!.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name='mikka-listen' AND query LIKE 'LISTEN ${DEVICE_WORK_CHANNEL}'`)
    assert.ok(sessions.rows[0].n >= 1)
    // A push that lands while the waiter is reading (before it waits) returns the next wait at once.
    mine.reset()
    await notifyChannel(pool!, DEVICE_WORK_CHANNEL, [device])
    await new Promise(resolve => setTimeout(resolve, 200))
    let started = performance.now()
    assert.equal(await mine.next(10_000), 'notified')
    assert.ok(performance.now() - started < 50, 'heard during the read')
    // reset forgets it: with nothing new, the wait runs to its timer.
    mine.reset()
    started = performance.now()
    assert.equal(await mine.next(300), 'timeout')
    assert.ok(performance.now() - started >= 250, 'no push, so the timer ends the wait')
    // A credential push wakes it; another device's push does not.
    mine.reset(); theirs.reset()
    started = performance.now()
    const woke = mine.next(10_000)
    await notifyChannel(pool!, DEVICE_WORK_CHANNEL, [`token:${device}`])
    assert.equal(await woke, 'notified')
    assert.ok(performance.now() - started < 2_000, 'the committed push wakes the waiter at once')
    started = performance.now()
    assert.equal(await theirs.next(300), 'timeout')
    assert.ok(performance.now() - started >= 250, 'another device sleeps through it')
    assert.equal(mine.lost, false)
  } finally { mine.close(); theirs.close() }
})
