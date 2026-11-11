import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { bindFixtureWorkspaceDatabase, createFixtureWorkspaceTables } from '../../tests/helpers/workspace-database'
import { seedFixtureWorkspace } from '../../tests/helpers/task-workspace'
import { observePoolCommits } from '@/lib/db/commit-effects'
import { isE2eTarget } from '../../tests/helpers/e2e-target.mjs'
import { SubagentStore } from './subagents'
import { wakeTokens, wakeTransport } from '@/lib/workflow-wake'
import { setTimeout as delay } from 'node:timers/promises'
import { startSuggestion } from './suggestions'
import { nativeRunBinding } from '@/lib/computer/native-run-binding'
import { claimCloudRun } from '@/lib/computer/claim'
import { recordCancelledSandbox, recordThreadSandbox, threadMachineAction } from './thread-machines'
const databaseURL = process.env.COMPUTER_TEST_DATABASE_URL ?? process.env.E2E_DATABASE_URL
if (process.env.REQUIRE_DB === '1' && !databaseURL) throw new Error('Isolated database required')
// This suite runs DROP SCHEMA ... CASCADE, so the full target is checked before any
// connection, not just the hostname. Legacy CI names (computer_test, subagent_test)
// stay accepted until the workflow follow-up renames them to *_e2e.
function isolatedTarget(value: string) {
  if (isE2eTarget(value)) return true
  if (value !== value.trim() || value.includes('?') || value.includes('#')) return false
  try {
    const u = new URL(value)
    return ['postgres:', 'postgresql:'].includes(u.protocol) && ['localhost', '127.0.0.1'].includes(u.hostname)
      && ['/computer_test', '/subagent_test'].includes(u.pathname)
  } catch { return false }
}
if (databaseURL && !isolatedTarget(databaseURL)) throw new Error('backend DB test requires a loopback *_e2e (or legacy computer_test/subagent_test) database without URL options')
test('real DB: additive migration, subagent owner isolation and separate thread claims', { skip: !databaseURL }, async () => {
  assert.ok(isolatedTarget(databaseURL!))
  const schema = `subagent_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseURL })
  await admin.query(`CREATE SCHEMA ${schema}`)
  const pool = new Pool({ connectionString: databaseURL, options: `-c search_path=${schema}` })
  const closeWorkspace = await bindFixtureWorkspaceDatabase(pool)
  // Like the app's pool (lib/db/request-scope.ts): wakes and live notices run after COMMIT.
  observePoolCommits(pool)
  const alice = { userId: 'alice', workspaceId: randomUUID() }
  const bob = { ...alice, userId: 'bob' }
  const stranger = { ...alice, workspaceId: randomUUID() }
  try {
    await createFixtureWorkspaceTables(pool)
    await seedFixtureWorkspace(pool, alice.userId, 'team', alice.workspaceId)
    await seedFixtureWorkspace(pool, stranger.userId, 'team', stranger.workspaceId)
    await pool.query(`INSERT INTO mikka_workspace_members ("workspaceId","userId",name,email,role,status) VALUES ($1,'bob','Bob','bob@example.invalid','member','active')`, [alice.workspaceId])
    await pool.query(`CREATE TABLE "user"(id text PRIMARY KEY);INSERT INTO "user" VALUES('alice'),('bob');
      CREATE TABLE agent_runs(id uuid PRIMARY KEY,"userId" text,"agentId" uuid,"deviceId" uuid,"botId" uuid,"agentDefinition" jsonb,"workspaceId" uuid,status text,report jsonb,"stopRequestedAt" timestamptz,"finishedAt" timestamptz,"startedAt" timestamptz,"leaseExpiresAt" timestamptz,"updatedAt" timestamptz);
      CREATE TABLE agents(id uuid PRIMARY KEY,"userId" text NOT NULL,harness text NOT NULL);
      CREATE TABLE devices(id uuid PRIMARY KEY,"ownerId" text,kind text,enabled boolean DEFAULT true,"removedAt" timestamptz);
      CREATE TABLE device_tokens("boundDeviceId" uuid,"revokedAt" timestamptz);
      CREATE TABLE device_repos(id uuid PRIMARY KEY);
      CREATE TABLE suggestions(id uuid PRIMARY KEY,"botId" uuid);
      CREATE TABLE workspace_computer_policies("workspaceId" uuid PRIMARY KEY,permission text,version integer);
      CREATE TABLE workspace_subscription_shares("ownerId" text,"workspaceId" uuid,"allowOthers" boolean NOT NULL DEFAULT false,PRIMARY KEY("ownerId","workspaceId"));
      CREATE TABLE workspace_personal_policies("workspaceId" uuid PRIMARY KEY,subscriptions boolean NOT NULL DEFAULT true);
      CREATE TABLE byos_connections(id uuid PRIMARY KEY,"ownerId" text,"workspaceId" text,provider text,state text,epoch bigint, paused boolean NOT NULL DEFAULT false);
      CREATE TABLE byos_bindings(id uuid PRIMARY KEY,"ownerId" text,"workspaceId" text,"consumerId" text,"connectionId" uuid,"connectionRevision" bigint,route text,"modelId" text,"createdAt" timestamptz DEFAULT now());
      CREATE TABLE byos_native_runs("runId" uuid PRIMARY KEY,"bindingId" uuid);
    `)
    for (const name of ['20261027164501_cloud_computers.sql', '20261027164502_computer_run_bindings.sql']) await pool.query(await readFile(new URL(`../../drizzle/${name}`, import.meta.url), 'utf8'))
    await pool.query('ALTER TABLE cloud_machines ADD COLUMN "deviceId" uuid')
    const migration = await readFile(new URL('../../drizzle/20261029011635_subagents_thread_machines.sql', import.meta.url), 'utf8')
    await pool.query(migration); await pool.query(migration)
    const computeMigration = await readFile(new URL('../../drizzle/20261029213935_thread_machine_compute_seconds.sql', import.meta.url), 'utf8')
    await pool.query(computeMigration); await pool.query(computeMigration)
    const lifecycleMigration = await readFile(new URL('../../drizzle/20261107120000_thread_machine_lifecycle.sql', import.meta.url), 'utf8')
    await pool.query(lifecycleMigration); await pool.query(lifecycleMigration)
    // The snapshot migration's columns; this fixture applies only the history it exercises.
    await pool.query(`ALTER TABLE thread_machines ADD COLUMN "filesystemSnapshotId" text, ADD COLUMN "snapshotOperationId" uuid,
      ADD COLUMN "snapshotTakenAt" timestamptz, ADD COLUMN "snapshotState" text NOT NULL DEFAULT 'none', ADD COLUMN "restoreStartedAt" timestamptz`)
    await pool.query(`ALTER TABLE suggestions ADD COLUMN "userId" text, ADD COLUMN shown boolean DEFAULT true, ADD COLUMN "dismissedAt" timestamptz, ADD COLUMN source text, ADD COLUMN actor text, ADD COLUMN url text, ADD COLUMN title text, ADD COLUMN action text, ADD COLUMN "actionTitle" text;
      CREATE TABLE coordinator_messages(id uuid PRIMARY KEY,"userId" text,"botId" uuid,position integer,message jsonb,UNIQUE NULLS NOT DISTINCT("userId","botId",position));
      CREATE TABLE coordinator_events(id uuid PRIMARY KEY,"userId" text,"botId" uuid,kind text,"dedupeKey" text UNIQUE,payload jsonb);
    `)
    const suggestionId = randomUUID()
    await pool.query(`INSERT INTO suggestions(id,"userId",source,actor,url,title,action,"actionTitle") VALUES ($1,'alice','github','account-a','https://example.invalid/source','Review backend change','review','Review the backend change before Friday')`, [suggestionId])
    const clicks = await Promise.all([startSuggestion(pool, alice, suggestionId), startSuggestion(pool, alice, suggestionId)])
    assert.ok(clicks.every(result => result.state === 'starting'))
    assert.equal(Number((await pool.query('SELECT count(*) AS n FROM suggestion_executions')).rows[0].n), 1)
    const chat = (await pool.query('SELECT * FROM coordinator_messages ORDER BY position')).rows
    assert.equal(chat.length, 2, 'one visible card followed by one complete instruction')
    assert.equal(chat[0].botId, null, 'the Coordinator is the null Bot chat, never the first created Bot')
    assert.equal(chat[0].message.content, 'Review the backend change before Friday')
    assert.match(chat[1].message.content, /Account owner: alice/)
    assert.match(chat[1].message.content, /Source: github/)
    assert.match(chat[1].message.content, /Stop and ask for confirmation before any irreversible operation/)
    assert.equal(Number((await pool.query('SELECT count(*) AS n FROM coordinator_events')).rows[0].n), 1)
    await assert.rejects(startSuggestion(pool, bob, suggestionId), { status: 404 })
    await assert.rejects(startSuggestion(pool, stranger, suggestionId), { status: 404 })
    const additional = [randomUUID(), randomUUID()]
    for (const id of additional) await pool.query(`INSERT INTO suggestions(id,"userId",source,title,action) VALUES ($1,'alice','mail','Another source','read')`, [id])
    await Promise.all(additional.map(id => startSuggestion(pool, alice, id)))
    assert.equal(new Set((await pool.query('SELECT position FROM coordinator_messages')).rows.map(row => row.position)).size, 6, 'concurrent distinct clicks serialize chat positions')
    const store = new SubagentStore(pool)
    const botA = randomUUID(), botB = randomUUID()
    await pool.query('INSERT INTO bots(id,"workspaceId","ownerId",name) VALUES ($1,$2,\'alice\',\'A\'),($3,$2,\'bob\',\'B\')', [botA, alice.workspaceId, botB])
    const task = await store.create(alice, botA, 'Read public docs')
    assert.equal(task.status, 'queued')
    await assert.rejects(store.get(bob, botA, task.id), { status: 404 })
    await assert.rejects(store.get(stranger, botA, task.id), { status: 404 })
    await assert.rejects(store.create(bob, botA, 'steal'), { status: 404 })
    const own = await store.create(bob, botB, 'Independent task')
    assert.equal((await store.stop(alice, botA, task.id)).status, 'stopped')
    assert.equal((await store.get(bob, botB, own.id)).status, 'queued')
    const events = (await pool.query('SELECT event FROM subagent_events WHERE "ownerId"=$1 AND "workspaceId"=$2', ['alice', alice.workspaceId])).rows
    assert.equal(events.length, 1)
    assert.equal(events[0].event.type, 'data-subagent')
    assert.equal(JSON.stringify(events).includes('targetId'), false)
    // #1212: a task's workflow waits on its row instead of a 30 s tick. A change from
    // outside (a stop) wakes it; an ended task wakes the owner's queued ones; the
    // task's own workflow (wakeSelf: false) does not wake itself.
    const woken: string[] = []
    wakeTransport.resume = async token => { woken.push(token) }
    try {
      const first = await store.create(alice, botA, 'Wake check, first')
      const queued = await store.create(alice, botA, 'Wake check, queued behind it')
      await store.stop(alice, botA, first.id)
      await delay(50)
      assert.ok(woken.includes(wakeTokens.subagent(first.id)), 'the stopped task\'s workflow is woken to report at once')
      assert.ok(woken.includes(wakeTokens.subagent(queued.id)), 'a freed slot wakes the owner\'s queued task')
      assert.ok(!woken.includes(wakeTokens.subagent(own.id)), 'another owner\'s task is left alone')
      woken.length = 0
      await new SubagentStore(pool, { wakeSelf: false }).stop(alice, botA, queued.id)
      await delay(50)
      assert.ok(!woken.includes(wakeTokens.subagent(queued.id)), 'the task\'s own workflow re-reads without a wake')
    } finally { wakeTransport.resume = undefined }
    const runA = randomUUID(), runB = randomUUID(), deviceA = randomUUID(), deviceB = randomUUID(), botDevice = randomUUID(), agentId = randomUUID(), bindingId = randomUUID()
    await pool.query(`INSERT INTO agents(id,"userId",harness) VALUES ($1,'alice','codex')`, [agentId])
    for (const device of [deviceA, deviceB, botDevice]) await pool.query('INSERT INTO devices(id,"ownerId",kind) VALUES ($1,\'alice\',\'cloud\')', [device])
    const cancelledRun = randomUUID(), cancelledDevice = randomUUID(), lease = randomUUID(), operation = randomUUID()
    await pool.query('INSERT INTO devices(id,"ownerId",kind) VALUES ($1,\'alice\',\'cloud\')', [cancelledDevice])
    await pool.query('INSERT INTO agent_runs(id,"userId",status,"workspaceId") VALUES ($1,\'alice\',\'queued\',$2)', [cancelledRun, alice.workspaceId])
    await pool.query('INSERT INTO thread_machines("runId","workspaceId","ownerId","botId","snapshotId","operationId",state,"deviceId","workerLeaseId") VALUES ($1,$2,\'alice\',$3,\'snapshot\',$4,\'starting\',$5,$6)', [cancelledRun, alice.workspaceId, botA, operation, cancelledDevice, lease])
    await pool.query('INSERT INTO device_tokens("boundDeviceId") VALUES ($1)', [cancelledDevice])
    await assert.rejects(threadMachineAction(pool, alice, cancelledRun, 'end'), { status: 409 }, 'do not report cleanup complete while create is in flight')
    await assert.rejects(threadMachineAction(pool, alice, cancelledRun, 'end'), { status: 409 }, 'a retry must remain pending')
    assert.equal(await recordThreadSandbox(pool, cancelledRun, 'late-sandbox', lease), false, 'late provider completion must not regain an ended lease')
    const ended = (await pool.query('SELECT state,"sandboxId","workerLeaseId" FROM thread_machines WHERE "runId"=$1', [cancelledRun])).rows[0]
    assert.deepEqual(ended, { state: 'ended', sandboxId: null, workerLeaseId: null })
    assert.ok((await pool.query('SELECT "revokedAt" FROM device_tokens WHERE "boundDeviceId"=$1', [cancelledDevice])).rows[0].revokedAt)
    // An ended machine's device leaves every list and dispatch for good; other devices stay.
    assert.ok((await pool.query('SELECT "removedAt" FROM devices WHERE id=$1', [cancelledDevice])).rows[0].removedAt, 'ended thread device is retired')
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM devices WHERE "removedAt" IS NOT NULL')).rows[0].n, 1, 'no other device is retired')
    assert.equal(await recordCancelledSandbox(pool, cancelledRun, 'late-sandbox', operation), true, 'late resource remains discoverable for cleanup retry')
    await pool.query('INSERT INTO cloud_machines("workspaceId","ownerId","operationId","deviceId") VALUES ($1,\'alice\',$2,$3)', [alice.workspaceId, randomUUID(), botDevice])
    for (const [runId, deviceId] of [[runA, deviceA], [runB, deviceB]]) {
      await pool.query('INSERT INTO agent_runs(id,"userId","agentId","deviceId",status,"workspaceId") VALUES ($1,\'alice\',$2,$3,\'queued\',$4)', [runId, agentId, deviceId, alice.workspaceId])
      await pool.query('INSERT INTO computer_run_bindings("runId","botId","workspaceId","ownerId") VALUES ($1,$2,$3,\'alice\')', [runId, botA, alice.workspaceId])
      await pool.query('INSERT INTO thread_machines("runId","workspaceId","ownerId","botId","sandboxId","snapshotId","operationId",state,"deviceId") VALUES ($1,$2,\'alice\',$3,$4,\'snapshot-owner-alice\',$5,\'running\',$6)', [runId, alice.workspaceId, botA, `sandbox-${runId}`, randomUUID(), deviceId])
    }
    await pool.query('INSERT INTO byos_bindings(id,"ownerId","workspaceId","consumerId") VALUES ($1,\'alice\',$2,$3)', [bindingId, alice.workspaceId, agentId])
    const connectionId = randomUUID()
    await pool.query(`INSERT INTO byos_connections(id,"ownerId","workspaceId",provider,state,epoch) VALUES ($1,'alice',$2,'codex','connected',1)`, [connectionId, alice.workspaceId])
    await pool.query(`UPDATE byos_bindings SET "connectionId"=$2,"connectionRevision"=1,route='codex_cli',"modelId"='fixture-model' WHERE id=$1`, [bindingId, connectionId])
    assert.equal((await nativeRunBinding(pool, 'alice', agentId, 'codex', alice.workspaceId))?.id, bindingId)
    assert.equal((await nativeRunBinding(pool, 'alice', agentId, 'codex', alice.workspaceId, bindingId))?.id, bindingId)
    assert.equal(await nativeRunBinding(pool, 'alice', randomUUID(), 'codex', alice.workspaceId, bindingId), null, 'pinned binding must belong to the agent')
    assert.equal(await nativeRunBinding(pool, 'alice', agentId, 'claude_code', alice.workspaceId, bindingId), null, 'pinned route must match the harness')
    assert.equal(await nativeRunBinding(pool, 'bob', agentId, 'codex', alice.workspaceId), null)
    assert.equal(await nativeRunBinding(pool, 'alice', agentId, 'codex', stranger.workspaceId), null)
    assert.equal(await nativeRunBinding(pool, 'alice', agentId, 'claude_code', alice.workspaceId), null)
    await pool.query('UPDATE byos_connections SET epoch=2 WHERE id=$1', [connectionId])
    assert.equal(await nativeRunBinding(pool, 'alice', agentId, 'codex', alice.workspaceId), null)
    await pool.query("UPDATE byos_connections SET epoch=1,state='disconnected' WHERE id=$1", [connectionId])
    assert.equal(await nativeRunBinding(pool, 'alice', agentId, 'codex', alice.workspaceId), null)
    await pool.query("UPDATE byos_connections SET state='connected' WHERE id=$1", [connectionId])
    const expires = new Date(Date.now() + 90_000)
    assert.equal(await claimCloudRun(pool, alice, runA, botDevice, expires, bindingId), null, 'Bot worker cannot claim a thread')
    assert.equal(await claimCloudRun(pool, alice, runA, deviceB, expires, bindingId), null, 'another thread cannot claim it')
    assert.equal(await claimCloudRun(pool, bob, runA, deviceA, expires, bindingId), null, 'another owner cannot claim it')
    assert.equal(await claimCloudRun(pool, stranger, runA, deviceA, expires, bindingId), null, 'another workspace cannot claim it')
    assert.equal(await claimCloudRun(pool, alice, runA, deviceA, expires, randomUUID()), null, 'unbound subscription denied')
    await pool.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2', [alice.workspaceId, alice.userId])
    try {
      assert.equal(await claimCloudRun(pool, alice, runA, deviceA, expires, bindingId), null, 'membership revocation denies a correctly bound cloud run')
      assert.equal((await pool.query('SELECT status FROM agent_runs WHERE id=$1', [runA])).rows[0].status, 'queued')
      assert.equal((await pool.query('SELECT 1 FROM byos_native_runs WHERE "runId"=$1', [runA])).rowCount, 0)
    } finally { await pool.query('UPDATE mikka_workspace_members SET status=\'active\' WHERE "workspaceId"=$1 AND "userId"=$2', [alice.workspaceId, alice.userId]) }
    await pool.query('INSERT INTO workspace_computer_policies VALUES ($1,\'deny\',1)', [alice.workspaceId])
    assert.equal(await claimCloudRun(pool, alice, runA, deviceA, expires, bindingId), null)
    await pool.query('DELETE FROM workspace_computer_policies')
    assert.equal((await claimCloudRun(pool, alice, runA, deviceA, expires, bindingId))?.display, ':1')
    assert.equal((await claimCloudRun(pool, alice, runB, deviceB, expires, bindingId))?.botId, botA)
    assert.equal(await claimCloudRun(pool, alice, runA, deviceA, expires, bindingId), null, 'one claim only')
  } finally {
    await closeWorkspace(); await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end()
  }
})
