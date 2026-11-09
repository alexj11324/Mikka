import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { Pool } from 'pg'
import { disposableDatabase } from '../../tests/helpers/e2e-target.mjs'
import { isolatedPostgresURL } from '../../tests/helpers/isolated-postgres.mjs'
import { readFactoryComputerSessions } from './thread-machine-sessions'

const url = process.env.E2E_DATABASE_URL
if (process.env.REQUIRE_DB === '1') assert.ok(url, 'REQUIRE_DB needs an isolated PostgreSQL database')
if (url) assert.ok(disposableDatabase(process.env, url), 'loopback *_e2e databases only')

test('real PG: VM intervals follow confirmed lifecycle and stay inside the Factory scope', { skip: !url, timeout: 120_000 }, async t => {
  const connectionString = await isolatedPostgresURL(url!)
  const admin = new Pool({ connectionString, max: 1 })
  const schema = `machine_sessions_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 4 })
  const owner = 'session-owner', otherOwner = 'other-owner'
  const workspace = randomUUID(), otherWorkspace = randomUUID(), bot = randomUUID(), chatBot = randomUUID(), foreignBot = randomUUID()
  const task = { id: randomUUID(), userId: owner, issueId: randomUUID() }
  const migration = await readFile(new URL('../../drizzle/20261109010001_thread_machine_sessions.sql', import.meta.url), 'utf8')
  try {
    // The migration under test runs in a separate schema with the actual
    // parent-column types, unique VM custody and FK cascade semantics.
    await pool.query(`CREATE TABLE "user" (id text PRIMARY KEY);
      CREATE TABLE bots (id uuid PRIMARY KEY,"ownerId" text,"workspaceId" uuid);
      CREATE TABLE agent_runs (id uuid PRIMARY KEY,"userId" text,"issueId" uuid,"botId" uuid,"agentDefinition" jsonb DEFAULT '{}');
      CREATE TABLE factory_tasks (id uuid PRIMARY KEY,"userId" text,"issueId" uuid,"botId" uuid);
      CREATE TABLE factory_attempts (id uuid PRIMARY KEY,"taskId" uuid,"runId" uuid UNIQUE);
      CREATE TABLE computer_run_bindings ("runId" uuid PRIMARY KEY,"ownerId" text,"workspaceId" uuid,"botId" uuid);
      CREATE TABLE thread_machines ("runId" uuid PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
        "ownerId" text REFERENCES "user"(id) ON DELETE CASCADE,"workspaceId" uuid NOT NULL,"botId" uuid,
        "sandboxId" text UNIQUE,state text,"runningSince" timestamptz,"createdAt" timestamptz DEFAULT now(),
        "endedAt" timestamptz,lifecycle jsonb NOT NULL DEFAULT '{}');`)
    await pool.query('INSERT INTO "user" VALUES ($1),($2)', [owner, otherOwner])
    await pool.query('INSERT INTO bots VALUES ($1,$2,$3),($4,$2,$3),($5,$2,$6)', [bot, owner, workspace, chatBot, foreignBot, otherWorkspace])
    await pool.query('INSERT INTO factory_tasks VALUES ($1,$2,$3,$4)', [task.id, owner, task.issueId, chatBot])
    const run = async (options: { linked?: boolean; state?: string; sandbox?: string | null; start?: string | null } = {}) => {
      const id = randomUUID()
      await pool.query('INSERT INTO agent_runs VALUES ($1,$2,$3,$4,$5)', [id, owner, task.issueId, bot,
        JSON.stringify({ executionIdentity: { workspaceId: workspace } })])
      await pool.query('INSERT INTO computer_run_bindings VALUES ($1,$2,$3,$4)', [id, owner, workspace, bot])
      if (options.linked !== false) await pool.query('INSERT INTO factory_attempts VALUES ($1,$2,$3)', [randomUUID(), task.id, id])
      await pool.query(`INSERT INTO thread_machines ("runId","ownerId","workspaceId","botId",state,"sandboxId","runningSince")
        VALUES ($1,$2,$3,$4,$5,$6,$7)`, [id, owner, workspace, bot, options.state ?? 'starting', options.sandbox ?? null, options.start ?? null])
      return id
    }
    const intervals = async (id: string) => (await pool.query('SELECT * FROM thread_machine_sessions WHERE "runId"=$1 ORDER BY "startedAt",id', [id])).rows
    const visible = async (id: string) => (await readFactoryComputerSessions(pool, task)).filter(row => row.runId === id)

    const known = await run({ state: 'running', sandbox: 'legacy-running', start: '2026-11-08T00:01:02.345Z' })
    const unknown = await run({ state: 'paused', sandbox: 'legacy-paused' })
    await pool.query(migration)
    await t.test('backfill uses only the retained runningSince and is idempotent', async () => {
      assert.equal((await intervals(known))[0].startedAt.toISOString(), '2026-11-08T00:01:02.345Z')
      assert.equal((await intervals(known))[0].source, 'running_since_backfill')
      assert.equal((await intervals(known))[0].endedAt, null)
      assert.deepEqual(await intervals(unknown), [], 'createdAt is not invented as a VM start')
      await pool.query(migration)
      assert.equal((await intervals(known)).length, 1)
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
      await pool.query(`UPDATE thread_machines SET "sandboxId"=NULL,lifecycle='{"phase":"retired"}' WHERE "runId"=$1`, [id])
      assert.equal((await intervals(id))[0].reason, 'retired')
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
