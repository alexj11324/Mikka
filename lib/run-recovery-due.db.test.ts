import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { isE2eTarget } from '../tests/helpers/e2e-target.mjs'
import { nextRunRecoveryDue, runRecoveryDueSweeps } from './run-recovery-due'

// #1212 D: run recovery no longer gets a minute sweep. The run-recovery due
// timer (workflows/due-timer, loop.test.ts) sleeps until nextRunRecoveryDue and
// then runs every recovery job. Each case writes one kind of work and checks the
// due time is the exact moment its sweep would select it. The tables are copied
// into a private schema, so the minimum is this test's alone.
const target = process.env.E2E_DATABASE_URL
const valid = isE2eTarget(target) && target === process.env.MIKKA_DATABASE_URL && target === process.env.DATABASE_URL
if (process.env.REQUIRE_DB === '1' && !valid) throw new Error('Run recovery tests require matching isolated loopback _e2e URLs')

const TABLES = ['agent_runs', 'devices', 'cloud_machines', 'thread_machines', 'coding_review_sessions', 'issues', 'sandbox_kill_retries', 'group_turns',
  'group_task_bindings', 'factory_tasks', 'factory_attempts', 'factory_events', 'factory_deliverable_acceptances', 'factory_candidates', 'factory_merges']

test('run-recovery due times match what each sweep selects', { skip: !valid }, async t => {
  const schema = `run_recovery_due_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: target, max: 1 })
  await admin.query(`CREATE SCHEMA ${schema}`)
  for (const table of TABLES) await admin.query(`CREATE TABLE ${schema}.${table} (LIKE public.${table} INCLUDING DEFAULTS)`)
  const pool = new Pool({ connectionString: target, options: `-c search_path=${schema}`, max: 2 })
  t.after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end() })
  const due = (factoryLifecycle = true) => nextRunRecoveryDue(pool, { factoryLifecycle })
  const dbNow = async () => (await pool.query<{ now: Date }>('SELECT now() AS now')).rows[0].now.getTime()
  const clear = async () => { for (const table of TABLES) await pool.query(`DELETE FROM ${table}`) }
  const near = (actual: number | null, expected: number, slack = 2_000) => {
    assert.ok(actual !== null, 'something is due')
    assert.ok(Math.abs(actual - expected) <= slack, `${new Date(actual).toISOString()} ≈ ${new Date(expected).toISOString()}`)
  }
  const run = async (values: Record<string, unknown>) => {
    const columns = { id: randomUUID(), userId: 'owner', agentId: randomUUID(), kind: 'local', ...values }
    await pool.query(`INSERT INTO agent_runs (${Object.keys(columns).map(key => `"${key}"`).join(',')}) VALUES (${Object.keys(columns).map((_, i) => `$${i + 1}`).join(',')})`, Object.values(columns))
    return columns.id
  }

  await t.test('an idle database has nothing due, so no timer runs', async () => {
    assert.equal(await due(), null)
  })

  await t.test('a review lease wakes at expiry and a revoked lease at its close retry with Factory disabled', async () => {
    const id = randomUUID()
    const expires = new Date(await dbNow() + 60_000)
    await pool.query(`INSERT INTO coding_review_sessions
      (id,kind,"taskId","runId","ownerId","workspaceId","deviceId","repoId","deviceTokenId","bindingId","sandboxId",
       "machineEpoch","machineOperationId","credentialKind","credentialId","expiresAt")
      VALUES ($1,'terminal',$1,$1,'owner',$1,$1,$1,$1,$2,'fixture',0,$1,'session','credential',$3)`, [id, 'a'.repeat(64), expires])
    assert.deepEqual(await runRecoveryDueSweeps(pool, { factoryLifecycle: false }), { next: expires.getTime(), due: new Set() })
    const retry = new Date(await dbNow() - 1_000)
    await pool.query(`UPDATE coding_review_sessions SET "revokedAt"=$2,reason='run_control',"retryAt"=$2 WHERE id=$1`, [id, retry])
    assert.deepEqual(await runRecoveryDueSweeps(pool, { factoryLifecycle: false }), { next: retry.getTime(), due: new Set(['reviewSessions']) })
    await clear()
  })

  await t.test('a leased run is due one millisecond after its lease (the sweep selects leaseExpiresAt < now)', async () => {
    const lease = new Date(Date.now() + 90_000)
    await run({ status: 'running', leaseExpiresAt: lease })
    assert.equal(await due(), lease.getTime() + 1)
    await run({ status: 'running', leaseExpiresAt: new Date(lease.getTime() - 30_000) })
    assert.equal(await due(), lease.getTime() - 30_000 + 1, 'the earliest lease wins')
    await run({ status: 'succeeded', outcome: 'resolved', leaseExpiresAt: null, finishedAt: new Date() })
    assert.equal(await due(), lease.getTime() - 30_000 + 1, 'a judged, finished run adds nothing')
    await clear()
  })

  await t.test('an ended, unjudged run is due now; an unanswered try after as long as it waited, at least an hour', async () => {
    await run({ status: 'failed', finishedAt: new Date() })
    near(await due(), await dbNow())
    await clear()
    const tried = new Date(Date.now() - 10 * 60_000)
    await run({ status: 'failed', finishedAt: new Date(Date.now() - 20 * 60_000), outcomeAt: tried })
    assert.equal(await due(), tried.getTime() + 60 * 60_000 + 1)
    await run({ status: 'failed', finishedAt: new Date(Date.now() - 8 * 24 * 60 * 60_000) })
    assert.equal(await due(), tried.getTime() + 60 * 60_000 + 1, 'runs past the 7-day window are left alone')
    await clear()
    // #1371: a run the judge never answers backs off instead of being asked every hour for a week.
    const finished = new Date(Date.now() - 3 * 24 * 60 * 60_000), lastTry = new Date(Date.now() - 2 * 60 * 60_000)
    await run({ status: 'succeeded', finishedAt: finished, outcomeAt: lastTry })
    assert.equal(await due(), lastTry.getTime() + (lastTry.getTime() - finished.getTime()) + 1)
    await clear()
  })

  await t.test('a queued retry is due when its device stops being seen, then re-checked each minute', async () => {
    const device = randomUUID(), seen = new Date(Date.now() - 20_000)
    await pool.query(`INSERT INTO devices (id,"ownerId",name,"lastSeenAt") VALUES ($1,'owner','Device',$2)`, [device, seen])
    await run({ status: 'queued', retryOf: randomUUID(), deviceId: device })
    assert.equal(await due(), seen.getTime() + 60_000 + 1)
    await pool.query(`UPDATE devices SET "lastSeenAt"=now()-interval '5 minutes'`)
    near(await due(), await dbNow() + 60_000)
    await clear()
  })

  await t.test('a failed sandbox kill is retried a minute after its last attempt', async () => {
    const attempted = new Date(Date.now() - 15_000)
    await pool.query(`INSERT INTO sandbox_kill_retries ("sandboxId","ownerId","lastAttemptAt") VALUES ('sbx','owner',$1)`, [attempted])
    assert.equal(await due(), attempted.getTime() + 60_000)
    await clear()
  })

  await t.test('a pending group judgment is due at nextDecisionAt; a queued turn within the minute', async () => {
    const at = new Date(Date.now() + 240_000)
    await pool.query(`INSERT INTO group_turns ("messageId","conversationId","userId",status,error,"nextDecisionAt") VALUES ($1,$2,'owner','failed','group_judgment_pending',$3)`, [randomUUID(), randomUUID(), at])
    assert.equal(await due(), at.getTime())
    await pool.query(`INSERT INTO group_turns ("messageId","conversationId","userId") VALUES ($1,$2,'owner')`, [randomUUID(), randomUUID()])
    near(await due(), await dbNow() + 60_000)
    await clear()
  })

  await t.test('a running machine is checked with E2B once idle for an hour, then every 10 minutes', async () => {
    const active = new Date(Date.now() - 10 * 60_000)
    await pool.query(`INSERT INTO cloud_machines ("workspaceId","ownerId","operationId",state,"sandboxId","lastActiveAt") VALUES ($1,'owner',$2,'running','sbx',$3)`, [randomUUID(), randomUUID(), active])
    assert.equal(await due(), active.getTime() + 60 * 60_000 + 1)
    await pool.query(`UPDATE cloud_machines SET "lastActiveAt"=now()-interval '2 hours'`)
    near(await due(), await dbNow() + 10 * 60_000)
    await pool.query(`UPDATE cloud_machines SET state='sleeping'`)
    assert.equal(await due(), null, 'a sleeping machine needs no check')
    await clear()
  })

  await t.test('a retained task machine has a deadline and task close wakes running or paused machines', async () => {
    const issue = randomUUID()
    const runId = await run({ status: 'succeeded', outcome: 'resolved' })
    const retention = new Date(Date.now()+7*24*60*60_000)
    await pool.query(`INSERT INTO issues (id,"userId",title,content,status,priority) VALUES ($1,'owner','Task','{}','todo','none')`, [issue])
    await pool.query(`INSERT INTO thread_machines ("runId","ownerId","workspaceId","issueId",state,"sandboxId","snapshotId","operationId",lifecycle,"lifecycleAt")
      VALUES ($1,'owner',$2,$3,'paused','retained','snapshot',$4,'{"observedStatus":"succeeded","observedStop":false,"observedClosed":false}',$5)`, [runId, randomUUID(), issue, randomUUID(), retention])
    assert.equal(await due(), retention.getTime(), 'paused retention remains owned after the per-run monitor exits')
    await pool.query(`UPDATE issues SET status='done'`)
    near(await due(), await dbNow())
    await pool.query(`UPDATE thread_machines SET state='running'`)
    near(await due(), await dbNow(), 2000)
    await clear()
  })

  await t.test('semantic run changes wake machine recovery; heartbeats preserve the exact deadline', async () => {
    const runId = await run({ status: 'queued' }), at = new Date(Date.now()+90_000)
    await pool.query(`INSERT INTO thread_machines ("runId","ownerId","workspaceId",state,"sandboxId","snapshotId","operationId",lifecycle,"lifecycleAt")
      VALUES ($1,'owner',$2,'running','live','snapshot',$3,'{"observedStatus":"queued","observedStop":false,"observedClosed":false}',$4)`, [runId, randomUUID(), randomUUID(), at])
    assert.equal(await due(), at.getTime())
    await pool.query(`UPDATE agent_runs SET "updatedAt"=now()`)
    assert.equal(await due(), at.getTime(), 'activity timestamps do not trigger a new maintenance loop')
    await pool.query(`UPDATE agent_runs SET "stopRequestedAt"=now()`)
    near(await due(), await dbNow())
    await pool.query(`UPDATE agent_runs SET status='stopped',outcome='resolved'; UPDATE thread_machines SET state='ended',
      lifecycle='{"observedStatus":"stopped","observedStop":true,"observedClosed":false,"phase":"retire_failed"}'`)
    assert.equal(await due(), at.getTime(), 'an ended row still owns its unacknowledged provider kill')
    await pool.query(`UPDATE thread_machines SET "sandboxId"=NULL,"lifecycleAt"=NULL`)
    assert.equal(await due(), null, 'a confirmed retirement releases the timer')
    await pool.query(`UPDATE thread_machines SET "workerLeaseId"=$1,"lifecycleAt"=$2`, [randomUUID(), at])
    assert.equal(await due(), at.getTime(), 'a legacy creation token without an expiry still requires reconciliation')
    await clear()
  })

  await t.test('a Factory task is due a minute after its last write, or at its watchdog nextAt; nothing with the switch off', async () => {
    const task = randomUUID(), attempt = randomUUID(), updated = new Date(Date.now() - 10_000)
    await pool.query(`INSERT INTO factory_attempts (id,"taskId",stage,ordinal,position,status,reason) VALUES ($1,$2,'execute',1,1,'running','fixture')`, [attempt, task])
    await pool.query(`INSERT INTO factory_tasks (id,"userId","issueId","sourceEventId",route,"attemptId",status,stage,reason,"updatedAt") VALUES ($1,'owner',$2,$3,'{}',$4,'running','execute','fixture',$5)`, [task, randomUUID(), randomUUID(), attempt, updated])
    assert.equal(await due(), updated.getTime() + 60_000 + 1)
    assert.equal(await due(false), null)
    const nextAt = new Date(Date.now() + 5 * 60_000)
    await pool.query(`INSERT INTO factory_events ("taskId","eventId",request,result) VALUES ($1,$2,$3,$4)`,
      [task, randomUUID(), { kind: 'task_watchdog', attemptId: attempt }, { nextAt: nextAt.toISOString() }])
    assert.equal(await due(), nextAt.getTime())
    await clear()
  })

  await t.test('a pass runs only the sweeps due now (#1371)', async () => {
    assert.deepEqual(await runRecoveryDueSweeps(pool, { factoryLifecycle: true }), { next: null, due: new Set() })
    const lease = new Date(Date.now() + 90_000)
    await run({ status: 'running', leaseExpiresAt: lease })
    assert.deepEqual(await runRecoveryDueSweeps(pool, { factoryLifecycle: true }), { next: lease.getTime() + 1, due: new Set() }, 'future work runs nothing yet')
    await run({ status: 'failed', finishedAt: new Date() })
    await pool.query(`INSERT INTO sandbox_kill_retries ("sandboxId","ownerId","lastAttemptAt") VALUES ('sbx','owner',now()-interval '2 minutes')`)
    const { next, due: sweeps } = await runRecoveryDueSweeps(pool, { factoryLifecycle: true })
    assert.deepEqual([...sweeps].sort(), ['outcomes', 'sandboxKills'])
    assert.ok(next !== null && next <= await dbNow())
    await clear()
  })
})
