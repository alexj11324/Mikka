import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { ThreadMachines, type ThreadMachineProvider } from './thread-machine'
import { SubagentQueue } from './subagent-queue'

const databaseURL = process.env.COMPUTER_TEST_DATABASE_URL
if (process.env.REQUIRE_DB === '1' && !databaseURL) throw new Error('Computer database test URL required')

test('thread lifecycle serializes creation and respects owner, idle and terminal boundaries', { skip: !databaseURL }, async () => {
  assert.ok(['127.0.0.1', 'localhost'].includes(new URL(databaseURL!).hostname))
  const schema = `thread_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseURL })
  await admin.query(`CREATE SCHEMA ${schema}`)
  const pool = new Pool({ connectionString: databaseURL, options: `-c search_path=${schema}` })
  const actor = { userId: 'alice', workspaceId: randomUUID() }
  const botId = randomUUID(), runId = randomUUID()
  let creates = 0, resumes = 0, pauses = 0, kills = 0, loseCreateResponse = true
  const operationIds: string[] = []
  const provider: ThreadMachineProvider = {
    async create(snapshot, id, operationId) {
      creates++; operationIds.push(operationId)
      assert.equal(snapshot, 'snapshot-fixture'); assert.equal(id, runId)
      if (loseCreateResponse) { loseCreateResponse = false; throw new Error('response lost') }
      return { sandboxId: 'sandbox-fixture' }
    },
    async resume() { resumes++ }, async pause() { pauses++ }, async kill() { kills++ },
  }
  try {
    await pool.query(`CREATE TABLE "user" (id text PRIMARY KEY); INSERT INTO "user" VALUES ('alice'), ('bob');
      CREATE TABLE bots (id uuid, "workspaceId" uuid, "ownerId" text, UNIQUE(id,"workspaceId","ownerId"));
      CREATE TABLE agent_runs (id uuid PRIMARY KEY,"userId" text NOT NULL,status text NOT NULL);
      CREATE TABLE computer_run_bindings ("runId" uuid PRIMARY KEY REFERENCES agent_runs(id),"workspaceId" uuid NOT NULL,"ownerId" text NOT NULL);
      CREATE TABLE devices (id uuid PRIMARY KEY)`)
    const sql = await readFile(new URL('../../drizzle/20261027180000_thread_machines_and_bot_subagents.sql', import.meta.url), 'utf8')
    await pool.query(sql); await pool.query(sql)
    await pool.query('INSERT INTO bots VALUES ($1,$2,$3)', [botId, actor.workspaceId, actor.userId])
    await pool.query('INSERT INTO agent_runs VALUES ($1,$2,$3)', [runId, actor.userId, 'queued'])
    await pool.query('INSERT INTO computer_run_bindings VALUES ($1,$2,$3)', [runId, actor.workspaceId, actor.userId])
    await pool.query('INSERT INTO workspace_snapshots ("workspaceId","ownerId","snapshotId","dependencyFingerprint","sourceRevision") VALUES ($1,$2,$3,$4,$5)', [actor.workspaceId, actor.userId, 'snapshot-fixture', 'fingerprint', 'revision'])
    const machines = new ThreadMachines(pool, provider)
    await assert.rejects(machines.wake({ ...actor, userId: 'bob' }, runId), /unavailable/)
    await assert.rejects(machines.wake(actor, runId), /response lost/)
    assert.deepEqual(await Promise.all([machines.wake(actor, runId), machines.wake(actor, runId)]), ['sandbox-fixture', 'sandbox-fixture'])
    assert.equal(creates, 2); assert.equal(operationIds[0], operationIds[1]); assert.equal(resumes, 1)
    await assert.rejects(machines.pause(actor, runId), /not idle/)
    await assert.rejects(machines.end(actor, runId), /still active/)
    await pool.query('UPDATE agent_runs SET status=$2 WHERE id=$1', [runId, 'waiting_input'])
    await machines.pause(actor, runId); await machines.pause(actor, runId)
    assert.equal(pauses, 1)
    await machines.wake(actor, runId); assert.equal(resumes, 2)
    await pool.query('UPDATE agent_runs SET status=$2 WHERE id=$1', [runId, 'succeeded'])
    await machines.end(actor, runId); await machines.end(actor, runId)
    assert.equal(kills, 1)
    await assert.rejects(machines.wake(actor, runId), /ended/)
    assert.equal((await pool.query('SELECT state FROM thread_machines')).rows[0].state, 'ended')
    await assert.rejects(pool.query('DELETE FROM computer_run_bindings WHERE "runId"=$1', [runId]), { code: '23503' }, 'provider identifiers cannot disappear through a cascade')

    const queue = new SubagentQueue(pool)
    await assert.rejects(queue.enqueue({ ...actor, userId: 'bob' }, botId, 'Open a page'), /unavailable/)
    const tasks = await Promise.all(Array.from({ length: 8 }, (_, i) => queue.enqueue(actor, botId, `Task ${i + 1}`)))
    const claims = await Promise.all(Array.from({ length: 8 }, () => queue.claimNext(actor)))
    assert.equal(claims.filter(Boolean).length, 6)
    const running = claims.find(Boolean)!
    assert.equal(await queue.stop({ ...actor, userId: 'bob' }, botId, running.id), false)
    assert.equal(await queue.stop(actor, botId, running.id), true)
    assert.equal(await queue.claimNext(actor), null, 'stop request keeps a slot until browser cleanup')
    assert.equal((await queue.finish(actor, botId, running.id, 'done'))?.state, 'stopped', 'stop wins a completion race')
    assert.ok(await queue.claimNext(actor))
    const queued = tasks.find(task => !claims.some(claim => claim?.id === task.id) && task.id !== running.id)!
    // Exactly one of the original queued tasks may have been claimed above.
    const remaining = (await pool.query("SELECT id FROM bot_subagents WHERE state='queued' LIMIT 1")).rows[0]
    assert.ok(queued && remaining)
    assert.equal(await queue.stop(actor, botId, remaining.id), true)
    assert.equal((await pool.query('SELECT state FROM bot_subagents WHERE id=$1', [remaining.id])).rows[0].state, 'stopped')
    await assert.rejects(pool.query('DELETE FROM bots WHERE id=$1', [botId]), { code: '23503' }, 'browser records cannot disappear through a Bot cascade')
  } finally {
    await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end()
  }
})
