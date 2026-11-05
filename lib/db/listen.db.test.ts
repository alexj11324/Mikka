import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, test } from 'node:test'
import { Pool } from 'pg'
import { COORDINATOR_LEASE_CHANNEL, nextNotification, notifyChannel, openListener } from './listen'

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
