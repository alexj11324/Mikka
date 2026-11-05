import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { isE2eTarget } from '../tests/helpers/e2e-target.mjs'
import { reconcileDue } from './reconcile-due'

// #1371: the one safety-net check. It is true for a job only when that job has
// work already due that its own wake or timer did not pick up, and false on an
// idle database. Tables are copied into a private schema so the answer is this test's.
const target = process.env.E2E_DATABASE_URL
const valid = isE2eTarget(target) && target === process.env.MIKKA_DATABASE_URL && target === process.env.DATABASE_URL
if (process.env.REQUIRE_DB === '1' && !valid) throw new Error('Reconcile tests require matching isolated loopback _e2e URLs')

const TABLES = ['coordinator_events', 'coordinator_sessions', 'user_schedules', 'schedule_occurrences', 'agent_runs', 'devices', 'cloud_machines',
  'thread_machines', 'issues', 'sandbox_kill_retries', 'group_turns', 'group_task_bindings', 'factory_tasks', 'factory_attempts', 'factory_events',
  'factory_deliverable_acceptances', 'factory_candidates', 'factory_merges']

test('the safety-net check names exactly the jobs with work already due', { skip: !valid }, async t => {
  const schema = `reconcile_due_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: target, max: 1 })
  await admin.query(`CREATE SCHEMA ${schema}`)
  for (const table of TABLES) await admin.query(`CREATE TABLE ${schema}.${table} (LIKE public.${table} INCLUDING DEFAULTS)`)
  const pool = new Pool({ connectionString: target, options: `-c search_path=${schema}`, max: 2 })
  t.after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end() })
  const due = () => reconcileDue(pool, { factoryLifecycle: true })
  const none = { wakes: false, schedules: false, recovery: false }
  const clear = async () => { for (const table of TABLES) await pool.query(`DELETE FROM ${table}`) }
  const event = (values: string) => pool.query(`INSERT INTO coordinator_events (id,"userId","botId",kind,"dedupeKey",payload,"nextWakeAt","wakeLeaseUntil",tier,"deliveredAt") VALUES ($1,'owner',$2,'user_message',$3,'{}',${values})`, [randomUUID(), randomUUID(), randomUUID()])

  await t.test('idle: nothing is due, so the sweep does nothing else', async () => {
    assert.deepEqual(await due(), none)
  })

  await t.test('a pending wake whose start was lost is due; one leased, delivered, background or in the future is not', async () => {
    await event(`now()+interval '1 minute',NULL,NULL,NULL`)
    await event(`now()-interval '1 minute',now()+interval '1 minute',NULL,NULL`)
    await event(`now()-interval '1 minute',NULL,NULL,now()`)
    await event(`now()-interval '1 minute',NULL,'background',NULL`)
    assert.deepEqual(await due(), none)
    await event(`now()-interval '1 minute',now()-interval '1 second',NULL,NULL`)
    assert.deepEqual(await due(), { ...none, wakes: true })
    await clear()
  })

  await t.test('a turn holding a chat lease is checked for an interrupted run', async () => {
    await pool.query(`INSERT INTO coordinator_sessions ("userId","botId","leaseHolder","leaseUntil") VALUES ('owner',$1,'wrun_fixture',now()+interval '5 minutes')`, [randomUUID()])
    assert.deepEqual(await due(), { ...none, wakes: true })
    await clear()
  })

  await t.test('schedule work is due at or after its time, not before', async () => {
    const insert = (at: string) => pool.query(`INSERT INTO user_schedules (id,owner_id,source_event_id,request_id,definition,request_definition,status,next_at) VALUES ($1,'owner',$2,$3,'{}','{}','active',${at})`, [randomUUID(), randomUUID(), randomUUID()])
    await insert(`now()+interval '10 minutes'`)
    assert.deepEqual(await due(), none)
    await insert(`now()-interval '1 second'`)
    assert.deepEqual(await due(), { ...none, schedules: true })
    await clear()
  })

  await t.test('run recovery is due for an expired lease, not for a live one', async () => {
    const run = (lease: string) => pool.query(`INSERT INTO agent_runs (id,"userId","agentId",kind,status,"leaseExpiresAt") VALUES ($1,'owner',$2,'local','running',${lease})`, [randomUUID(), randomUUID()])
    await run(`now()+interval '5 minutes'`)
    assert.deepEqual(await due(), none)
    await run(`now()-interval '1 second'`)
    assert.deepEqual(await due(), { ...none, recovery: true })
    await clear()
  })
})
