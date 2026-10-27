import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { SubagentStore } from './subagents'
import { startSuggestion } from './suggestions'
import { claimCloudRun } from '@/lib/computer/claim'
const databaseURL = process.env.COMPUTER_TEST_DATABASE_URL ?? process.env.E2E_DATABASE_URL
if (process.env.REQUIRE_DB === '1' && !databaseURL) throw new Error('Isolated database required')
test('real DB: additive migration, subagent owner isolation and separate thread claims', { skip: !databaseURL }, async () => {
  assert.ok(['localhost', '127.0.0.1'].includes(new URL(databaseURL!).hostname))
  const schema = `subagent_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseURL })
  await admin.query(`CREATE SCHEMA ${schema}`)
  const pool = new Pool({ connectionString: databaseURL, options: `-c search_path=${schema}` })
  const prior = process.env.MIKKA_CLOUD_THREAD_MACHINES
  process.env.MIKKA_CLOUD_THREAD_MACHINES = '1'
  const alice = { userId: 'alice', workspaceId: randomUUID() }
  const bob = { ...alice, userId: 'bob' }
  const stranger = { ...alice, workspaceId: randomUUID() }
  try {
    await pool.query(`CREATE TABLE "user"(id text PRIMARY KEY);INSERT INTO "user" VALUES('alice'),('bob');
      CREATE TABLE agent_runs(id uuid PRIMARY KEY,"userId" text,"agentId" uuid,"deviceId" uuid,status text,"stopRequestedAt" timestamptz,"startedAt" timestamptz,"leaseExpiresAt" timestamptz,"updatedAt" timestamptz);
      CREATE TABLE devices(id uuid PRIMARY KEY,"ownerId" text,kind text,enabled boolean DEFAULT true);
      CREATE TABLE device_repos(id uuid PRIMARY KEY);
      CREATE TABLE suggestions(id uuid PRIMARY KEY);
      CREATE TABLE workspace_computer_policies("workspaceId" uuid PRIMARY KEY,permission text,version integer);
      CREATE TABLE byos_bindings(id uuid PRIMARY KEY,"ownerId" text,"workspaceId" text,"consumerId" text);
      CREATE TABLE byos_native_runs("runId" uuid PRIMARY KEY,"bindingId" uuid);
    `)
    for (const name of ['20261027164501_cloud_computers.sql', '20261027164502_computer_run_bindings.sql']) await pool.query(await readFile(new URL(`../../drizzle/${name}`, import.meta.url), 'utf8'))
    await pool.query('ALTER TABLE cloud_machines ADD COLUMN "deviceId" uuid')
    const migration = await readFile(new URL('../../drizzle/20261027224500_subagents_thread_machines.sql', import.meta.url), 'utf8')
    await pool.query(migration); await pool.query(migration)
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
    const runA = randomUUID(), runB = randomUUID(), deviceA = randomUUID(), deviceB = randomUUID(), botDevice = randomUUID(), agentId = randomUUID(), bindingId = randomUUID()
    for (const device of [deviceA, deviceB, botDevice]) await pool.query('INSERT INTO devices(id,"ownerId",kind) VALUES ($1,\'alice\',\'cloud\')', [device])
    await pool.query('INSERT INTO cloud_machines("workspaceId","ownerId","operationId","deviceId") VALUES ($1,\'alice\',$2,$3)', [alice.workspaceId, randomUUID(), botDevice])
    for (const [runId, deviceId] of [[runA, deviceA], [runB, deviceB]]) {
      await pool.query('INSERT INTO agent_runs(id,"userId","agentId","deviceId",status) VALUES ($1,\'alice\',$2,$3,\'queued\')', [runId, agentId, deviceId])
      await pool.query('INSERT INTO computer_run_bindings("runId","botId","workspaceId","ownerId") VALUES ($1,$2,$3,\'alice\')', [runId, botA, alice.workspaceId])
      await pool.query('INSERT INTO thread_machines("runId","workspaceId","ownerId","botId","sandboxId","snapshotId","operationId",state,"deviceId") VALUES ($1,$2,\'alice\',$3,$4,\'snapshot-owner-alice\',$5,\'running\',$6)', [runId, alice.workspaceId, botA, `sandbox-${runId}`, randomUUID(), deviceId])
    }
    await pool.query('INSERT INTO byos_bindings(id,"ownerId","workspaceId","consumerId") VALUES ($1,\'alice\',$2,$3)', [bindingId, alice.workspaceId, agentId])
    const expires = new Date(Date.now() + 90_000)
    assert.equal(await claimCloudRun(pool, alice, runA, botDevice, expires, bindingId), null, 'Bot worker cannot claim a thread')
    assert.equal(await claimCloudRun(pool, alice, runA, deviceB, expires, bindingId), null, 'another thread cannot claim it')
    assert.equal(await claimCloudRun(pool, bob, runA, deviceA, expires, bindingId), null, 'another owner cannot claim it')
    assert.equal(await claimCloudRun(pool, stranger, runA, deviceA, expires, bindingId), null, 'another workspace cannot claim it')
    assert.equal(await claimCloudRun(pool, alice, runA, deviceA, expires, randomUUID()), null, 'unbound subscription denied')
    await pool.query('INSERT INTO workspace_computer_policies VALUES ($1,\'deny\',1)', [alice.workspaceId])
    assert.equal(await claimCloudRun(pool, alice, runA, deviceA, expires, bindingId), null)
    await pool.query('DELETE FROM workspace_computer_policies')
    assert.equal((await claimCloudRun(pool, alice, runA, deviceA, expires, bindingId))?.display, ':1')
    assert.equal((await claimCloudRun(pool, alice, runB, deviceB, expires, bindingId))?.botId, botA)
    assert.equal(await claimCloudRun(pool, alice, runA, deviceA, expires, bindingId), null, 'one claim only')
  } finally {
    if (prior === undefined) delete process.env.MIKKA_CLOUD_THREAD_MACHINES
    else process.env.MIKKA_CLOUD_THREAD_MACHINES = prior
    await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end()
  }
})
