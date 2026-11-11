import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { isE2eTarget } from '../../tests/helpers/e2e-target.mjs'
import { nextScheduleDue, ScheduleStore, SCHEDULE_LEASE_MS, type WorkspaceGuard } from './store'
import type { Actor, Definition } from './contract'

// #1212 D: schedules no longer get a minute sweep. The schedules due timer
// (workflows/due-timer, tested in loop.test.ts) sleeps until nextScheduleDue and
// then runs the same tick. Here, with no sweep at all, that due time is exact for
// every kind of schedule work, and a tick at it does the work on time. The tables
// are copied into a private schema so the global minimum is this test's alone.
const target = process.env.E2E_DATABASE_URL
const valid = isE2eTarget(target) && target === process.env.MIKKA_DATABASE_URL && target === process.env.DATABASE_URL
if (process.env.REQUIRE_DB === '1' && !valid) throw new Error('Schedule tests require matching isolated loopback _e2e URLs')

test('schedules due timer: exact due times, no minute sweep', { skip: !valid }, async t => {
  const schema = `schedule_due_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: target, max: 1 })
  await admin.query(`CREATE SCHEMA ${schema}`)
  for (const table of ['"user"', 'bots', 'coordinator_events', 'coordinator_messages', 'user_schedules', 'schedule_occurrences']) {
    await admin.query(`CREATE TABLE ${schema}.${table} (LIKE public.${table} INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES)`)
  }
  const pool = new Pool({ connectionString: target, options: `-c search_path=${schema}`, max: 4 })
  t.after(async () => {
    await pool.end()
    await admin.query(`DROP SCHEMA ${schema} CASCADE`)
    await admin.end()
  })
  let now = new Date('2030-01-01T00:00:00Z')
  const owner = `schedule-due-${randomUUID()}`, sourceEventId = randomUUID(), workspaceId = randomUUID()
  const actor: Actor = { ownerId: owner, workspaceId, botId: null, sourceEventId }
  const guard: WorkspaceGuard = async (_owner, _workspace, work) => work({ role: 'admin' })
  const store = new ScheduleStore(pool, guard, async () => null, async () => {}, () => true, () => now)
  await pool.query(`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,'Owner',$2,true,now(),now())`, [owner, `${owner}@example.invalid`])
  await pool.query(`INSERT INTO coordinator_events(id,"userId",kind,"dedupeKey",payload,tier) VALUES($1,$2,'user_message',$3,'{"text":"schedule it"}','attention')`, [sourceEventId, owner, `due-source-${sourceEventId}`])
  const def = (timing: Definition['timing'], task: Definition['task'] = { kind: 'reminder', text: 'Due reminder' }): Definition =>
    ({ title: 'Due timer', timezone: 'UTC', timing, task, misfire: 'catch_up_once', maxLatenessMinutes: 60 })
  const create = async (d: Definition) => (await store.command(actor, { action: 'create', requestId: randomUUID(), definition: d }) as { schedule: { id: string; version: number } }).schedule
  const occurrences = async (id: string) => (await pool.query<{ status: string; attempts: number; due_at: Date }>('SELECT status,attempts,due_at FROM schedule_occurrences WHERE schedule_id=$1 ORDER BY due_at', [id])).rows

  await t.test('with nothing scheduled there is no due time, so no timer runs', async () => {
    assert.equal(await nextScheduleDue(pool), null)
  })

  await t.test('a reminder runs at its due time, not a millisecond before, and leaves nothing due', async () => {
    const at = new Date(now.getTime() + 37 * 60_000 + 123)
    const row = await create(def({ kind: 'once', at: at.toISOString() }))
    assert.equal(await nextScheduleDue(pool), at.getTime(), 'the timer sleeps exactly until the slot')
    now = new Date(at.getTime() - 1)
    assert.equal((await store.tick()).materialized, 0)
    assert.deepEqual(await occurrences(row.id), [])
    now = at
    assert.deepEqual(await store.tick(), { materialized: 1, executed: 1, wakeOwners: [] })
    assert.deepEqual((await occurrences(row.id)).map(o => [o.status, o.due_at.getTime()]), [['succeeded', at.getTime()]])
    assert.equal(await nextScheduleDue(pool), null)
  })

  await t.test('a repeating schedule is due again at its next slot; pausing removes it', async () => {
    const start = new Date(now.getTime() + 60_000)
    const row = await create(def({ kind: 'interval', start: start.toISOString(), minutes: 90 }))
    assert.equal(await nextScheduleDue(pool), start.getTime())
    now = start
    await store.tick()
    assert.equal(await nextScheduleDue(pool), start.getTime() + 90 * 60_000)
    await store.command(actor, { action: 'pause', scheduleId: row.id, version: row.version })
    assert.equal(await nextScheduleDue(pool), null)
  })

  await t.test('a scheduled read is due again at its lease, and a failed read at its 30 s retry', async () => {
    const at = new Date(now.getTime() + 60_000)
    const row = await create(def({ kind: 'once', at: at.toISOString() }, { kind: 'agent_read', prompt: 'Read the status', allowedActions: ['get_issue'] }))
    now = at
    const tick = await store.tick()
    assert.deepEqual(tick.wakeOwners, [owner], 'the read waits on the Coordinator')
    const [claimed] = (await pool.query<{ id: string; lease_token: string; lease_until: Date }>(`SELECT id,lease_token,lease_until FROM schedule_occurrences WHERE schedule_id=$1 AND status='running'`, [row.id])).rows
    assert.equal(claimed.lease_until.getTime(), at.getTime() + SCHEDULE_LEASE_MS)
    assert.equal(await nextScheduleDue(pool), claimed.lease_until.getTime(), 'a read whose turn never ends is recovered at its lease')
    now = new Date(at.getTime() + 5_000)
    await store.fail({ id: claimed.id, lease_token: claimed.lease_token }, new Error('scheduledReadFailed'))
    assert.equal(await nextScheduleDue(pool), now.getTime() + 30_000)
    now = new Date(now.getTime() + 30_000)
    await store.tick()
    assert.deepEqual((await occurrences(row.id)).map(o => [o.status, o.attempts]), [['running', 2]], 'retried exactly at its retry time')
  })
})
