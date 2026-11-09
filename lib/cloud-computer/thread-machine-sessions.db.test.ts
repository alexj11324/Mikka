import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { Pool } from 'pg'
import { disposableDatabase } from '../../tests/helpers/e2e-target.mjs'
import { isolatedPostgresURL } from '../../tests/helpers/isolated-postgres.mjs'
import { readFactoryComputerSessions, recordCancelledThreadSessionEnd, recordThreadMaintenanceSession } from './thread-machine-sessions'
import { observePoolCommits } from '../db/commit-effects'

const url = process.env.E2E_DATABASE_URL
if (process.env.REQUIRE_DB === '1') assert.ok(url, 'REQUIRE_DB needs an isolated PostgreSQL database')
if (url) assert.ok(disposableDatabase(process.env, url), 'loopback *_e2e databases only')

test('real PG: VM intervals follow confirmed lifecycle and stay inside the Factory scope', { skip: !url, timeout: 120_000 }, async t => {
  const connectionString = await isolatedPostgresURL(url!)
  const admin = new Pool({ connectionString, max: 1 })
  const schema = `machine_sessions_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 4 })
  observePoolCommits(pool)
  const owner = 'session-owner', otherOwner = 'other-owner'
  const workspace = randomUUID(), otherWorkspace = randomUUID(), bot = randomUUID(), chatBot = randomUUID(), foreignBot = randomUUID()
  const task = { id: randomUUID(), userId: owner, issueId: randomUUID() }
  const migration = await readFile(new URL('../../drizzle/20261109010001_thread_machine_sessions.sql', import.meta.url), 'utf8')
  try {
    // The migration under test runs in a separate schema with the actual
    // parent-column types, unique VM custody and FK cascade semantics.
    await pool.query(`CREATE TABLE "user" (id text PRIMARY KEY);
      CREATE TABLE bots (id uuid PRIMARY KEY,"ownerId" text,"workspaceId" uuid);
      CREATE TABLE agent_runs (id uuid PRIMARY KEY,"userId" text,"issueId" uuid,"botId" uuid,"agentDefinition" jsonb DEFAULT '{}',"workspaceId" uuid);
      CREATE TABLE factory_tasks (id uuid PRIMARY KEY,"userId" text,"issueId" uuid,"botId" uuid,"workspaceId" uuid);
      CREATE TABLE factory_attempts (id uuid PRIMARY KEY,"taskId" uuid,"runId" uuid UNIQUE);
      CREATE TABLE computer_run_bindings ("runId" uuid PRIMARY KEY,"ownerId" text,"workspaceId" uuid,"botId" uuid);
      CREATE TABLE thread_machines ("runId" uuid PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
        "ownerId" text REFERENCES "user"(id) ON DELETE CASCADE,"workspaceId" uuid NOT NULL,"botId" uuid,
        "sandboxId" text UNIQUE,state text,"runningSince" timestamptz,"createdAt" timestamptz DEFAULT now(),
        "endedAt" timestamptz,"lifecycleAt" timestamptz,lifecycle jsonb NOT NULL DEFAULT '{}',"operationId" uuid NOT NULL DEFAULT gen_random_uuid(),
        "workerLeaseId" uuid,"workerLeaseUntil" timestamptz,epoch integer NOT NULL DEFAULT 1);`)
    await pool.query('INSERT INTO "user" VALUES ($1),($2)', [owner, otherOwner])
    await pool.query('INSERT INTO bots VALUES ($1,$2,$3),($4,$2,$3),($5,$2,$6)', [bot, owner, workspace, chatBot, foreignBot, otherWorkspace])
    await pool.query('INSERT INTO factory_tasks VALUES ($1,$2,$3,$4,$5)', [task.id, owner, task.issueId, chatBot, workspace])
    const run = async (options: { linked?: boolean; state?: string; sandbox?: string | null; start?: string | null } = {}) => {
      const id = randomUUID()
      await pool.query('INSERT INTO agent_runs VALUES ($1,$2,$3,$4,$5,$6)', [id, owner, task.issueId, bot,
        JSON.stringify({ executionIdentity: { workspaceId: workspace } }), workspace])
      await pool.query('INSERT INTO computer_run_bindings VALUES ($1,$2,$3,$4)', [id, owner, workspace, bot])
      if (options.linked !== false) await pool.query('INSERT INTO factory_attempts VALUES ($1,$2,$3)', [randomUUID(), task.id, id])
      await pool.query(`INSERT INTO thread_machines ("runId","ownerId","workspaceId","botId",state,"sandboxId","runningSince")
        VALUES ($1,$2,$3,$4,$5,$6,$7)`, [id, owner, workspace, bot, options.state ?? 'starting', options.sandbox ?? null, options.start ?? null])
      return id
    }
    const intervals = async (id: string) => (await pool.query('SELECT * FROM thread_machine_sessions WHERE "runId"=$1 ORDER BY "startedAt",id', [id])).rows
    const visible = async (id: string) => (await readFactoryComputerSessions(pool, task)).filter(row => row.runId === id)

    const known = await run({ state: 'running', sandbox: 'legacy-running', start: '2026-11-08T00:01:02.345Z' })
    const resuming = await run({ state: 'paused', sandbox: 'legacy-resuming', start: '2026-11-08T00:02:03.456Z' })
    const unknown = await run({ state: 'paused', sandbox: 'legacy-paused' })
    await pool.query(migration)
    await t.test('backfill uses only the retained runningSince and is idempotent', async () => {
      assert.equal((await intervals(known))[0].startedAt.toISOString(), '2026-11-08T00:01:02.345Z')
      assert.equal((await intervals(known))[0].source, 'running_since_backfill')
      assert.equal((await intervals(known))[0].endedAt, null)
      assert.equal((await intervals(resuming))[0].startedAt.toISOString(), '2026-11-08T00:02:03.456Z', 'confirmed resume is running before registration updates custody state')
      assert.equal((await intervals(resuming))[0].source, 'running_since_backfill')
      assert.deepEqual(await intervals(unknown), [], 'createdAt is not invented as a VM start')
      await pool.query(migration)
      assert.equal((await intervals(known)).length, 1)
      assert.equal((await intervals(resuming)).length, 1)
    })

    await t.test('create intent has no session; confirmed create, pause and resume produce distinct intervals', async () => {
      const id = await run()
      assert.deepEqual(await intervals(id), [])
      await pool.query(`UPDATE thread_machines SET "sandboxId"='vm-lifecycle',"runningSince"=clock_timestamp() WHERE "runId"=$1`, [id])
      const first = (await intervals(id))[0]
      assert.equal(first.reason, null)
      assert.equal(first.source, 'running_since')
      await pool.query(`UPDATE thread_machines SET state='running',lifecycle='{"phase":"created"}' WHERE "runId"=$1`, [id])
      await Promise.all([1, 2].map(() => pool.query(`UPDATE thread_machines SET lifecycle=lifecycle||'{"phase":"active"}' WHERE "runId"=$1`, [id])))
      assert.equal((await intervals(id)).length, 1, 'registration/heartbeats cannot duplicate allocation')
      await pool.query(`UPDATE thread_machines SET lifecycle='{"phase":"pause_requested"}' WHERE "runId"=$1`, [id])
      assert.equal((await intervals(id))[0].endedAt, null, 'a pause request is not a pause acknowledgement')
      await pool.query(`UPDATE thread_machines SET state='paused',"runningSince"=NULL,lifecycle='{"phase":"paused"}' WHERE "runId"=$1`, [id])
      assert.equal((await intervals(id))[0].reason, 'paused')
      await pool.query(`UPDATE thread_machines SET lifecycle='{"phase":"resume_requested"}' WHERE "runId"=$1`, [id])
      assert.equal((await intervals(id)).length, 1, 'a resume request is not running time')
      await pool.query(`UPDATE thread_machines SET state='running',"runningSince"=clock_timestamp(),lifecycle='{"phase":"resumed"}' WHERE "runId"=$1`, [id])
      const current = await intervals(id)
      assert.equal(current.length, 2)
      assert.notEqual(current[0].id, current[1].id)
      assert.ok(current[0].endedAt <= current[1].startedAt)
      assert.equal(current[1].endedAt, null)
      const output = await visible(id)
      assert.equal(output.length, 2)
      assert.deepEqual(Object.keys(output[0]).sort(), ['endedAt', 'id', 'reason', 'runId', 'source', 'startedAt'])
    })

    await t.test('confirmed resume starts before registration and stays open through custody or registration failure', async () => {
      for (const registrationState of ['running', 'error']) {
        const id = await run({ state: 'paused', sandbox: `vm-resume-${registrationState}` })
        assert.deepEqual(await intervals(id), [])
        await pool.query(`UPDATE thread_machines SET lifecycle='{"phase":"resume_requested"}' WHERE "runId"=$1`, [id])
        assert.deepEqual(await intervals(id), [], 'resume intent is not confirmation')
        // recordThreadSandbox persists provider-confirmed connect before the
        // worker registers; the existing paused custody state stays intact.
        const { rows: [confirmed] } = await pool.query(`UPDATE thread_machines SET "runningSince"=clock_timestamp()
          WHERE "runId"=$1 RETURNING state,"runningSince"`, [id])
        assert.equal(confirmed.state, 'paused')
        const first = (await intervals(id))[0]
        assert.ok(first, 'confirmed connect starts a session before worker registration')
        assert.equal(first.startedAt.getTime(), confirmed.runningSince.getTime())
        assert.equal(first.source, 'running_since')
        await pool.query(`UPDATE thread_machines SET lifecycle='{"phase":"resume_requested","failures":1}' WHERE "runId"=$1`, [id])
        assert.equal((await intervals(id))[0].endedAt, null, 'paused custody with runningSince is not a pause acknowledgement')
        await pool.query('UPDATE thread_machines SET state=$2 WHERE "runId"=$1', [id, registrationState])
        assert.equal((await intervals(id)).length, 1)
        assert.equal((await intervals(id))[0].endedAt, null, 'registration failure does not stop the actual VM')
        await pool.query(`UPDATE thread_machines SET state='paused',"runningSince"=NULL,lifecycle='{"phase":"paused"}' WHERE "runId"=$1`, [id])
        assert.equal((await intervals(id))[0].reason, 'paused')
        assert.ok((await intervals(id))[0].endedAt >= first.startedAt)
      }
    })

    await t.test('session starts wait on the parent run before locking its machine', async () => {
      const { recordThreadSandbox, recordCancelledSandbox } = await import('./thread-machines')
      for (const kind of ['create','cancelled','maintenance'] as const) {
        const sandboxId = `lock-order-${kind}`, leaseId = randomUUID()
        const id = await run({ state:kind==='cancelled' ? 'ended' : kind==='maintenance' ? 'paused' : 'starting',
          sandbox:kind==='maintenance' ? sandboxId : null })
        const operationId = (await pool.query(`UPDATE thread_machines SET "workerLeaseId"=$2,"workerLeaseUntil"=now()+interval '3 minutes'
          WHERE "runId"=$1 RETURNING "operationId"`,[id,leaseId])).rows[0].operationId
        const first = await pool.connect(), writer = await pool.connect()
        let pending: Promise<{ value?: boolean; error?: unknown }> | undefined
        try {
          const writerPid = (await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
          const firstPid = (await first.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
          await writer.query("SET statement_timeout='5s'")
          await first.query('BEGIN')
          await first.query('SELECT id FROM agent_runs WHERE id=$1 FOR UPDATE',[id])
          const operation = kind==='create' ? recordThreadSandbox(writer,id,sandboxId,leaseId)
            : kind==='cancelled' ? recordCancelledSandbox(writer,id,sandboxId,operationId)
            : recordThreadMaintenanceSession(writer,{runId:id,ownerId:owner,workspaceId:workspace,sandboxId,operationId},leaseId,'running')
          pending = operation.then(value=>({value}),error=>({error}))
          // Observe the actual PG lock wait before checking the machine. A
          // simple sleep could pass before the writer reaches its statement.
          const deadline = Date.now()+2_000
          let blocked = false
          while (!blocked && Date.now()<deadline) {
            blocked = (await pool.query('SELECT $1::int=ANY(pg_blocking_pids($2::int)) AS blocked',[firstPid,writerPid])).rows[0].blocked
            if (!blocked) await new Promise(resolve=>setTimeout(resolve,10))
          }
          assert.equal(blocked,true,`${kind}: writer must be waiting on the held parent run`)
          // The former machine→FK-run order fails here with 55P03 and would
          // deadlock if this normal run→machine caller waited instead.
          await first.query('SELECT "runId" FROM thread_machines WHERE "runId"=$1 FOR UPDATE NOWAIT',[id])
          await first.query('COMMIT')
          const outcome = await pending
          if (outcome.error) throw outcome.error
          assert.equal(outcome.value,true)
          assert.equal((await intervals(id)).length,1)
        } finally {
          await first.query('ROLLBACK')
          await pending
          await writer.query('RESET statement_timeout')
          first.release(); writer.release()
        }
      }
    })

    await t.test('retirement intent and failed kill retain the interval until provider acknowledgement', async () => {
      const id = await run({ state: 'running', sandbox: 'vm-retire', start: new Date().toISOString() })
      await pool.query(`UPDATE thread_machines SET state='ended',"endedAt"=now(),"runningSince"=NULL,lifecycle='{"phase":"retire_requested"}' WHERE "runId"=$1`, [id])
      assert.equal((await intervals(id))[0].endedAt, null)
      await pool.query(`UPDATE thread_machines SET lifecycle='{"phase":"retire_failed"}' WHERE "runId"=$1`, [id])
      assert.equal((await intervals(id))[0].endedAt, null)
      await pool.query(`UPDATE thread_machines SET "sandboxId"=NULL,lifecycle='{"phase":"retired"}' WHERE "runId"=$1`, [id])
      const ended = (await intervals(id))[0]
      assert.equal(ended.reason, 'retired')
      assert.ok(ended.endedAt >= ended.startedAt)
      await pool.query(`UPDATE thread_machines SET "sandboxId"=NULL,lifecycle='{"phase":"retired"}' WHERE "runId"=$1`, [id])
      assert.equal((await intervals(id))[0].endedAt.getTime(), ended.endedAt.getTime(), 'kill retry does not move the historical end')
    })

    await t.test('late cancelled creation records an observation and closes only after cleanup', async () => {
      const id = await run({ state: 'ended' })
      await pool.query(`UPDATE thread_machines SET "sandboxId"='late-created' WHERE "runId"=$1`, [id])
      assert.equal((await intervals(id))[0].source, 'observed')
      assert.equal((await intervals(id))[0].endedAt, null)
      const operationId = (await pool.query('SELECT "operationId" FROM thread_machines WHERE "runId"=$1', [id])).rows[0].operationId
      const scope = { runId: id, ownerId: owner, workspaceId: workspace, sandboxId: 'late-created', operationId }
      assert.equal(await recordCancelledThreadSessionEnd(pool, { ...scope, operationId: randomUUID() }), false)
      assert.equal((await intervals(id))[0].endedAt, null, 'a stale cleanup operation cannot close a newer VM')
      assert.equal(await recordCancelledThreadSessionEnd(pool, scope), true)
      const ended = (await intervals(id))[0].endedAt
      assert.equal(await recordCancelledThreadSessionEnd(pool, scope), false, 'ack replay preserves its first recorded end')
      assert.equal((await pool.query('SELECT "sandboxId" FROM thread_machines WHERE "runId"=$1', [id])).rows[0].sandboxId, 'late-created', 'the existing cleanup owner still owns its row')
      await pool.query(`UPDATE thread_machines SET "sandboxId"=NULL,lifecycle='{"phase":"retired"}' WHERE "runId"=$1`, [id])
      assert.equal((await intervals(id))[0].reason, 'retired')
      assert.equal((await intervals(id))[0].endedAt.getTime(), ended.getTime())
    })

    await t.test('maintenance observations preserve paused custody, fence the lease and roll back atomically', async () => {
      const id = await run({ state: 'paused', sandbox: 'vm-maintenance' }), leaseId = randomUUID()
      const operationId = (await pool.query('SELECT "operationId" FROM thread_machines WHERE "runId"=$1', [id])).rows[0].operationId
      const scope = { runId: id, ownerId: owner, workspaceId: workspace, sandboxId: 'vm-maintenance', operationId }
      await pool.query(`UPDATE thread_machines SET "workerLeaseId"=$2,"workerLeaseUntil"=now()+interval '3 minutes' WHERE "runId"=$1`, [id,leaseId])
      for (const wrong of [{ ...scope, ownerId: otherOwner }, { ...scope, workspaceId: otherWorkspace },
        { ...scope, sandboxId: 'foreign-vm' }, { ...scope, operationId: randomUUID() }]) {
        assert.equal(await recordThreadMaintenanceSession(pool,wrong,leaseId,'running'), false)
      }
      assert.equal(await recordThreadMaintenanceSession(pool,scope,randomUUID(),'running'), false)
      assert.deepEqual(await intervals(id), [])
      const tx = await pool.connect()
      try {
        await tx.query('BEGIN')
        assert.equal(await recordThreadMaintenanceSession(tx,scope,leaseId,'running'), true)
        assert.deepEqual(await intervals(id), [], 'uncommitted observation is invisible to another connection')
        await tx.query('ROLLBACK')
        assert.deepEqual(await intervals(id), [])
        assert.equal(await recordThreadMaintenanceSession(pool,scope,leaseId,'running'), true)
        assert.equal(await recordThreadMaintenanceSession(pool,scope,leaseId,'running'), true)
        assert.equal((await intervals(id)).length, 1, 'duplicate confirmed start keeps one open interval')
        assert.equal((await intervals(id))[0].source, 'observed')
        assert.deepEqual((await pool.query('SELECT state,"runningSince" FROM thread_machines WHERE "runId"=$1', [id])).rows[0], { state: 'paused', runningSince: null })
        await tx.query('BEGIN')
        await recordThreadMaintenanceSession(tx,scope,leaseId,'paused')
        await tx.query('ROLLBACK')
        assert.equal((await intervals(id))[0].endedAt, null, 'a rolled-back pause does not fabricate an end')
        assert.equal(await recordThreadMaintenanceSession(pool,scope,randomUUID(),'paused'), false)
        assert.equal((await intervals(id))[0].endedAt, null)
        await pool.query(`UPDATE thread_machines SET "workerLeaseUntil"=now()-interval '1 second' WHERE "runId"=$1`, [id])
        assert.equal(await recordThreadMaintenanceSession(pool,scope,leaseId,'paused'), false)
        await pool.query(`UPDATE thread_machines SET "workerLeaseUntil"=now()+interval '3 minutes' WHERE "runId"=$1`, [id])
        await pool.query(`UPDATE thread_machine_sessions SET source='running_since' WHERE "runId"=$1`, [id])
        assert.equal(await recordThreadMaintenanceSession(pool,scope,leaseId,'paused'), true, 'a proven pause closes every same-VM source')
        const first = (await intervals(id))[0]
        assert.equal(first.reason,'paused')
        assert.ok(first.endedAt >= first.startedAt)
        await recordThreadMaintenanceSession(pool,scope,leaseId,'running')
        const history = await intervals(id)
        assert.equal(history.length,2)
        assert.equal(history[1].source,'observed')
        assert.equal(history[1].endedAt,null)
        assert.ok(history[1].startedAt >= first.endedAt)
      } finally { await tx.query('ROLLBACK'); tx.release() }
    })

    await t.test('confirmed missing closes an uncertain maintenance interval atomically with the fenced observation', async () => {
      const id = await run({ state: 'paused', sandbox: 'vm-maintenance-missing' }), leaseId = randomUUID(), receipt = randomUUID()
      const operationId = (await pool.query('SELECT "operationId" FROM thread_machines WHERE "runId"=$1', [id])).rows[0].operationId
      await pool.query(`UPDATE thread_machines SET "workerLeaseId"=$2,"workerLeaseUntil"=now()+interval '3 minutes' WHERE "runId"=$1`, [id,leaseId])
      await recordThreadMaintenanceSession(pool,{ runId:id,ownerId:owner,workspaceId:workspace,sandboxId:'vm-maintenance-missing',operationId },leaseId,'running')
      await pool.query(`UPDATE thread_machines SET state='error',"workerLeaseUntil"=now()-interval '1 second',
        lifecycle=jsonb_build_object('reconcileId',$2::text) WHERE "runId"=$1`, [id,receipt])
      assert.equal((await intervals(id))[0].endedAt,null,'error without provider evidence does not close the maintenance interval')
      const missing = (tx: Pick<Pool, 'query'>, claim: string) => tx.query(`UPDATE thread_machines SET state='error',"runningSince"=NULL,
        lifecycle=lifecycle||jsonb_build_object('providerMissingReceipt',$4::text)
        WHERE "runId"=$1 AND epoch=$2 AND "sandboxId"=$3 AND lifecycle->>'reconcileId'=$4 AND state<>'ended'
          AND "ownerId"=$5 AND "workspaceId"=$6`, [id,1,'vm-maintenance-missing',claim,owner,workspace])
      assert.equal((await missing(pool,randomUUID())).rowCount,0)
      assert.equal((await intervals(id))[0].endedAt,null,'a stale reconcile claim cannot close the interval')
      const tx = await pool.connect()
      try {
        await tx.query('BEGIN')
        assert.equal((await missing(tx,receipt)).rowCount,1)
        assert.equal((await tx.query('SELECT reason FROM thread_machine_sessions WHERE "runId"=$1',[id])).rows[0].reason,'provider_missing')
        assert.equal((await intervals(id))[0].endedAt,null,'another connection cannot observe an uncommitted missing receipt')
        await tx.query('ROLLBACK')
        assert.equal((await intervals(id))[0].endedAt,null)
      } finally { tx.release() }
      await missing(pool,receipt)
      const closed = (await intervals(id))[0]
      assert.equal(closed.reason,'provider_missing')
      assert.ok(closed.endedAt >= closed.startedAt)
    })

    await t.test('provider disappearance and re-rental keep both allocation records', async () => {
      const id = await run({ state: 'running', sandbox: 'vm-lost', start: new Date().toISOString() })
      await pool.query(`UPDATE thread_machines SET state='error',"runningSince"=NULL WHERE "runId"=$1`, [id])
      assert.equal((await intervals(id))[0].reason, 'provider_missing')
      await pool.query(`UPDATE thread_machines SET "sandboxId"=NULL,state='starting' WHERE "runId"=$1`, [id])
      await pool.query(`UPDATE thread_machines SET "sandboxId"='vm-replacement',"runningSince"=clock_timestamp() WHERE "runId"=$1`, [id])
      const history = await intervals(id)
      assert.equal(history.length, 2)
      assert.equal(history[0].sandboxId, 'vm-lost')
      assert.equal(history[1].sandboxId, 'vm-replacement')
      assert.equal(history[1].endedAt, null)
    })

    await t.test('custody handoff keeps the prior run and does not count a paused adoption as running', async () => {
      const prior = await run({ state: 'running', sandbox: 'vm-handoff', start: new Date().toISOString() })
      const next = await run()
      const tx = await pool.connect()
      try {
        await tx.query('BEGIN')
        await tx.query(`UPDATE thread_machines SET state='ended',"sandboxId"=NULL,"runningSince"=NULL,lifecycle='{"phase":"transferred"}' WHERE "runId"=$1`, [prior])
        await tx.query(`UPDATE thread_machines SET state='paused',"sandboxId"='vm-handoff' WHERE "runId"=$1`, [next])
        await tx.query('COMMIT')
      } finally { tx.release() }
      assert.equal((await intervals(prior))[0].reason, 'transferred')
      assert.deepEqual(await intervals(next), [])
      assert.equal((await visible(prior)).length, 1, 'old custody row may clear the VM without deleting history')
      await pool.query(`UPDATE thread_machines SET state='running',"runningSince"=clock_timestamp() WHERE "runId"=$1`, [next])
      assert.equal((await visible(next)).length, 1)
    })

    await t.test('a running handoff shares one exact boundary even after an older transaction start', async () => {
      const prior = await run({ state:'running',sandbox:'vm-running-handoff',start:new Date().toISOString() }), next = await run()
      const tx = await pool.connect()
      try {
        await tx.query('BEGIN')
        await tx.query('SELECT pg_sleep(0.01)')
        const { rows: [transfer] } = await tx.query(`UPDATE thread_machines SET state='ended',"sandboxId"=NULL,"runningSince"=NULL,
          lifecycle=lifecycle||jsonb_build_object('phase','transferred','transferredAt',GREATEST(clock_timestamp(),"runningSince"))
          WHERE "runId"=$1 RETURNING lifecycle->>'transferredAt' AS "transferredAt"`, [prior])
        assert.equal((await tx.query('SELECT $1::timestamptz>transaction_timestamp() AS newer',[transfer.transferredAt])).rows[0].newer,true)
        await tx.query(`UPDATE thread_machines SET state='running',"sandboxId"='vm-running-handoff',"runningSince"=$2::timestamptz WHERE "runId"=$1`,[next,transfer.transferredAt])
        await tx.query('COMMIT')
      } finally { await tx.query('ROLLBACK'); tx.release() }
      const { rows: [boundary] } = await pool.query(`SELECT prior."endedAt"=next."startedAt" AS exact,
        prior."endedAt">=prior."startedAt" AS ordered,prior.reason FROM thread_machine_sessions prior,thread_machine_sessions next
        WHERE prior."runId"=$1 AND next."runId"=$2`,[prior,next])
      assert.deepEqual(boundary,{exact:true,ordered:true,reason:'transferred'})
    })

    await t.test('lifecycle writes and their history roll back together', async () => {
      const id = await run({ state: 'running', sandbox: 'vm-rollback', start: new Date().toISOString() })
      const tx = await pool.connect()
      try {
        await tx.query('BEGIN')
        await tx.query(`UPDATE thread_machines SET state='paused',"runningSince"=NULL WHERE "runId"=$1`, [id])
        assert.equal((await tx.query('SELECT reason FROM thread_machine_sessions WHERE "runId"=$1', [id])).rows[0].reason, 'paused')
        assert.equal((await intervals(id))[0].endedAt, null, 'another connection cannot observe an uncommitted close')
        await tx.query('ROLLBACK')
      } finally { tx.release() }
      assert.equal((await intervals(id))[0].endedAt, null)
    })

    await t.test('task, owner, issue, workspace and runtime Bot bindings all constrain reads', async () => {
      const id = await run({ state: 'running', sandbox: 'vm-scoped', start: new Date().toISOString() })
      const unlinked = await run({ linked: false, state: 'running', sandbox: 'vm-unlinked', start: new Date().toISOString() })
      assert.equal((await visible(id)).length, 1, 'chat Bot and runtime Bot may differ in the same owned workspace')
      await pool.query('UPDATE agent_runs SET "botId"=NULL WHERE id=$1', [id])
      assert.equal((await visible(id)).length, 1, 'legacy runs use the verified binding and same-workspace source Bot')
      await pool.query('UPDATE factory_tasks SET "botId"=$2 WHERE id=$1', [task.id, foreignBot])
      assert.equal((await visible(id)).length, 0, 'a missing historical run Bot cannot bridge two workspaces')
      await pool.query('UPDATE factory_tasks SET "botId"=$2 WHERE id=$1', [task.id, chatBot])
      await pool.query('UPDATE agent_runs SET "botId"=$2 WHERE id=$1', [id, foreignBot])
      assert.equal((await visible(id)).length, 0)
      await pool.query('UPDATE agent_runs SET "botId"=$2 WHERE id=$1', [id, bot])
      assert.equal((await visible(unlinked)).length, 0)
      assert.deepEqual(await readFactoryComputerSessions(pool, { ...task, userId: otherOwner }), [])
      assert.deepEqual(await readFactoryComputerSessions(pool, { ...task, issueId: randomUUID() }), [])
      assert.deepEqual(await readFactoryComputerSessions(pool, { ...task, id: randomUUID() }), [])
      await pool.query('UPDATE computer_run_bindings SET "workspaceId"=$2 WHERE "runId"=$1', [id, otherWorkspace])
      assert.equal((await visible(id)).length, 0)
      await pool.query('UPDATE computer_run_bindings SET "workspaceId"=$2,"botId"=$3 WHERE "runId"=$1', [id, workspace, foreignBot])
      assert.equal((await visible(id)).length, 0)
      await pool.query('UPDATE computer_run_bindings SET "botId"=$2 WHERE "runId"=$1', [id, bot])
      await pool.query('UPDATE agent_runs SET "agentDefinition"=$2 WHERE id=$1', [id, JSON.stringify({ executionIdentity: { workspaceId: otherWorkspace } })])
      assert.equal((await visible(id)).length, 0)
      await pool.query('UPDATE agent_runs SET "agentDefinition"=$2,"issueId"=$3 WHERE id=$1', [id, JSON.stringify({ executionIdentity: { workspaceId: workspace } }), randomUUID()])
      assert.equal((await visible(id)).length, 0)
      await pool.query('UPDATE agent_runs SET "issueId"=$2 WHERE id=$1', [id, task.issueId])
      await pool.query('UPDATE thread_machine_sessions SET "ownerId"=$2 WHERE "runId"=$1', [id, otherOwner])
      assert.equal((await visible(id)).length, 0)
    })

    await t.test('botless historical custody cannot bridge a different or unresolved persisted run tenant', async () => {
      const id = await run({ state:'running',sandbox:'vm-legacy-tenant',start:new Date().toISOString() })
      try {
        await pool.query('UPDATE factory_tasks SET "botId"=NULL WHERE id=$1',[task.id])
        await pool.query('UPDATE agent_runs SET "botId"=NULL,"agentDefinition"=\'{}\' WHERE id=$1',[id])
        assert.equal((await visible(id)).length,1)
        await pool.query('UPDATE computer_run_bindings SET "workspaceId"=$2,"botId"=$3 WHERE "runId"=$1',[id,otherWorkspace,foreignBot])
        await pool.query('UPDATE thread_machine_sessions SET "workspaceId"=$2,"botId"=$3 WHERE "runId"=$1',[id,otherWorkspace,foreignBot])
        assert.equal((await visible(id)).length,0,'matching legacy custody in B does not belong to the persisted A run/task')
        await pool.query('UPDATE computer_run_bindings SET "workspaceId"=$2,"botId"=$3 WHERE "runId"=$1',[id,workspace,bot])
        await pool.query('UPDATE thread_machine_sessions SET "workspaceId"=$2,"botId"=$3 WHERE "runId"=$1',[id,workspace,bot])
        assert.equal((await visible(id)).length,1)
        await pool.query('UPDATE agent_runs SET "workspaceId"=NULL WHERE id=$1',[id])
        assert.equal((await visible(id)).length,0,'unresolved run history remains quarantined')
        await pool.query('UPDATE agent_runs SET "workspaceId"=$2 WHERE id=$1',[id,workspace])
        await pool.query('UPDATE factory_tasks SET "workspaceId"=NULL WHERE id=$1',[task.id])
        assert.equal((await visible(id)).length,0,'unresolved task history remains quarantined')
      } finally {
        await pool.query('UPDATE factory_tasks SET "workspaceId"=$2,"botId"=$3 WHERE id=$1',[task.id,workspace,chatBot])
      }
    })

    await t.test('a startup error keeps a running VM; confirmed missing replacement closes it', async () => {
      const id = await run({ state: 'running', sandbox: 'vm-startup-error', start: new Date().toISOString() })
      await pool.query(`UPDATE thread_machines SET state='error' WHERE "runId"=$1`, [id])
      assert.equal((await intervals(id))[0].endedAt, null, 'an application error does not prove the provider stopped')
      await pool.query(`UPDATE thread_machines SET "sandboxId"=NULL,"runningSince"=NULL,state='starting' WHERE "runId"=$1`, [id])
      assert.equal((await intervals(id))[0].reason, 'provider_missing')
      await pool.query(`UPDATE thread_machines SET "sandboxId"='vm-fresh',"runningSince"=clock_timestamp() WHERE "runId"=$1`, [id])
      assert.equal((await intervals(id)).length, 2)
    })

    await t.test('run deletion cascades session history and the table refuses invalid end ordering', async () => {
      const id = await run({ state: 'running', sandbox: 'vm-delete', start: new Date().toISOString() })
      await assert.rejects(pool.query(`UPDATE thread_machine_sessions SET "endedAt"="startedAt"-interval '1 second',reason='retired' WHERE "runId"=$1`, [id]),
        (error: unknown) => (error as { code?: string }).code === '23514')
      await pool.query('DELETE FROM agent_runs WHERE id=$1', [id])
      assert.deepEqual(await intervals(id), [])
    })
  } finally {
    await pool.end()
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
    await admin.end()
  }
})
