// Run from the repository root with Node 24 --import tsx. This creates one
// retained synthetic event in a disposable loopback PostgreSQL database.
import assert from 'node:assert/strict'
import { Pool } from 'pg'
import { CoordinatorInbox, wakeFixture, isolatedInboxOptions } from '../../../lib/coordinator/wake-test-helpers.ts'
const url = process.env.WAKE_REVIEW_TEST_DATABASE_URL
if (!url || new URL(url).hostname !== '127.0.0.1' || !new URL(url).pathname.endsWith('_176') ||
    ['VERCEL', 'AI_GATEWAY_API_KEY', 'DECISION_GATEWAY_API_KEY', 'OPENAI_API_KEY', 'COMPOSIO_API_KEY'].some(k => process.env[k]))
  throw new Error('isolated keyless review database only')
const pool = new Pool({ connectionString: url }), members = new Pool({ connectionString: url })
try {
  const f = await wakeFixture(pool)
  const point = (await pool.query(`UPDATE coordinator_events
    SET wake_next_at=date_trunc('milliseconds',clock_timestamp())+interval '500 microseconds'
    WHERE id=$1 RETURNING wake_next_at,wake_next_at::text AS precise`, [f.eventId])).rows[0]
  const clock = () => point.wake_next_at
  const inbox = new CoordinatorInbox(pool, isolatedInboxOptions(pool, members, clock))
  const before = await inbox.claim(f.owner)
  assert.equal(before, null)
  const attempts = (await pool.query('SELECT wake_attempts FROM coordinator_events WHERE id=$1', [f.eventId])).rows[0].wake_attempts
  assert.equal(attempts, 0)
  await pool.query("UPDATE coordinator_events SET wake_next_at=$2::timestamptz-interval '1 second' WHERE id=$1", [f.eventId, clock()])
  const after = await inbox.claim(f.owner)
  assert.ok(after && 'delivery' in after)
  console.log(JSON.stringify({ evidence: 'real PG precision and actual claim/membership; injected JS millisecond clock',
    eventId: f.eventId, pgTimestamp: point.precise, jsClock: clock().toISOString(),
    beforeClaim: before, attemptsBefore: attempts, afterClaim: true, productionCodeChanged: false }))
  const g = await wakeFixture(pool)
  let now = new Date()
  const retries = new CoordinatorInbox(pool, isolatedInboxOptions(pool, members, () => now))
  const sweeps = []
  for (let i = 0; i < 6; i++) {
    const stamp = (await pool.query(`UPDATE coordinator_events
      SET wake_next_at=date_trunc('milliseconds',clock_timestamp())+interval '500 microseconds'
      WHERE id=$1 RETURNING wake_next_at,wake_next_at::text AS precise`, [g.eventId])).rows[0]
    // Precisely control four due and two premature sweeps instead of relying
    // on machine speed. Both outcomes occur at the original fixture boundary.
    now = new Date(stamp.wake_next_at.getTime() + (i < 4 ? 1 : 0))
    const claim = await retries.claim(g.owner)
    if (claim && 'delivery' in claim) await retries.deliveryFailed(g.owner, claim.delivery)
    sweeps.push({ due: i < 4, claimed: Boolean(claim), pgTimestamp: stamp.precise, jsClock: now.toISOString() })
  }
  const premature = (await pool.query('SELECT wake_attempts FROM coordinator_events WHERE id=$1', [g.eventId])).rows[0]
  assert.equal(premature.wake_attempts, 4)
  now = new Date(now.getTime() + 1000)
  const fifth = await retries.claim(g.owner)
  assert.ok(fifth && 'delivery' in fifth)
  await retries.deliveryFailed(g.owner, fifth.delivery)
  const terminal = (await pool.query('SELECT wake_attempts,wake_status,wake_error FROM coordinator_events WHERE id=$1', [g.eventId])).rows[0]
  assert.equal(terminal.wake_attempts, 5)
  assert.equal(terminal.wake_status, 'failed')
  assert.equal(terminal.wake_error, 'wakeRetriesExhausted')
  console.log(JSON.stringify({ evidence: 'controlled six-sweep PG reproduction; four due, two premature at precision boundary',
    eventId: g.eventId, sweeps, attemptsAfterSix: premature.wake_attempts, originalAssertionExpected: 5, terminalAfterActualFifth: terminal }))
} finally {
  await pool.end()
  await members.end()
}
