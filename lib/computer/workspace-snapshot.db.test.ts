import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { prepareWorkspaceSnapshot, collectRetiredSnapshots } from './workspace-snapshot'
import { provisionCloudThread } from './provision-thread'
import type * as provider from './e2b-provider'

const databaseURL = process.env.COMPUTER_TEST_DATABASE_URL
if (process.env.REQUIRE_DB === '1' && !databaseURL) throw new Error('Computer database test URL required')

test('workspace snapshots serialize refresh, seed the right run and retain versions used by live threads', { skip: !databaseURL }, async () => {
  assert.ok(['127.0.0.1', 'localhost'].includes(new URL(databaseURL!).hostname))
  const schema = `snapshot_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseURL }); await admin.query(`CREATE SCHEMA ${schema}`)
  const pool = new Pool({ connectionString: databaseURL, options: `-c search_path=${schema}` })
  const actor = { userId: 'alice', workspaceId: randomUUID() }, botId = randomUUID(), agentId = randomUUID(), repoId = randomUUID()
  const runs = [randomUUID(), randomUUID(), randomUUID()]
  const sha = 'a'.repeat(40)
  let archiveHash = 'b'.repeat(64), builds = 0, threadCreates = 0
  const deleted: string[] = []
  const source = { files: { read: async (path: string) => path.endsWith('worker-source-sha') ? sha : new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])); controller.close() } }) },
    commands: { run: async (command: string) => ({ stdout: command.startsWith('umask') ? archiveHash : '' }) } }
  const stage = { files: { read: async () => sha, write: async () => {} }, commands: { run: async () => ({ stdout: '' }) }, kill: async () => {} }
  let handoff: { deviceId: string } | undefined
  const thread = { sandboxId: 'thread-sandbox', files: { read: async () => sha, write: async (_path: string, value: string) => { handoff = JSON.parse(value) } }, commands: { run: async (command: string) => {
    if (command.includes('bin/cloud-worker.ts')) {
      assert.ok(handoff)
      const notPinned = await pool.query('SELECT 1 FROM agent_runs WHERE "deviceId"=$1', [handoff.deviceId])
      assert.equal(notPinned.rowCount, 0, 'a worker cannot claim a run before it is ready')
      await pool.query('UPDATE devices SET "lastSeenAt"=now() WHERE id=$1', [handoff.deviceId])
      await pool.query('UPDATE device_tokens SET "lastUsedAt"=now() WHERE "boundDeviceId"=$1 AND "revokedAt" IS NULL', [handoff.deviceId])
    }
    return { stdout: '' }
  } } }
  const runtime = { connectComputer: async (id: string) => id === 'thread-sandbox' ? thread : source,
    createWorkspaceSnapshotStage: async () => { builds++; return stage },
    createWorkspaceSnapshot: async () => ({ snapshotId: `snapshot-${builds}` }), deleteWorkspaceSnapshot: async (id: string) => { deleted.push(id) },
    ensureHostedRunnerImage: async () => {},
    threadMachineProvider: { create: async () => { threadCreates++; return { sandboxId: 'thread-sandbox' } }, resume: async () => {}, pause: async () => {}, kill: async () => {} },
  } as unknown as typeof provider
  const oldSha = process.env.MIKKA_CLOUD_WORKER_SHA, oldUrl = process.env.MIKKA_CLOUD_WORKER_URL
  try {
    await pool.query(`CREATE TABLE "user" (id text PRIMARY KEY); INSERT INTO "user" VALUES ('alice'),('bob');
      CREATE TABLE bots (id uuid,"workspaceId" uuid,"ownerId" text,UNIQUE(id,"workspaceId","ownerId"));
      CREATE TABLE agent_runs (id uuid PRIMARY KEY,"userId" text,"agentId" uuid,status text,"stopRequestedAt" timestamptz,"startedAt" timestamptz,"deviceId" uuid,"deviceRepoId" uuid,"updatedAt" timestamptz);
      CREATE TABLE computer_run_bindings ("runId" uuid PRIMARY KEY,"botId" uuid,"workspaceId" uuid,"ownerId" text);
      CREATE TABLE devices (id uuid PRIMARY KEY,"ownerId" text,name text,kind text,enabled boolean NOT NULL DEFAULT true,"lastSeenAt" timestamptz);
      CREATE TABLE device_tokens (id uuid PRIMARY KEY,"userId" text,name text,"tokenHash" text,"boundDeviceId" uuid,"boundWorkspaceId" uuid,"expiresAt" timestamptz,"revokedAt" timestamptz,"lastUsedAt" timestamptz);
      CREATE TABLE cloud_machines ("workspaceId" uuid,"ownerId" text,"sandboxId" text,state text);
      CREATE TABLE workspace_computer_policies ("workspaceId" uuid,permission text);
      CREATE TABLE bot_cloud_runtimes ("botId" uuid,"workspaceId" uuid,"ownerId" text,"agentId" uuid,"repoId" uuid);
      CREATE TABLE device_repos (id uuid PRIMARY KEY,"userId" text,"deviceId" uuid,"repoPath" text,"baseBranch" text,"remoteUrl" text,"verifyCommand" text,UNIQUE("deviceId","repoPath"))`)
    await pool.query(await readFile(new URL('../../drizzle/20261027180000_thread_machines_and_bot_subagents.sql', import.meta.url), 'utf8'))
    await pool.query(await readFile(new URL('../../drizzle/20261027180002_thread_worker_leases.sql', import.meta.url), 'utf8'))
    await pool.query(await readFile(new URL('../../drizzle/20261027180003_workspace_snapshot_versions.sql', import.meta.url), 'utf8'))
    await pool.query('INSERT INTO bots VALUES ($1,$2,$3)', [botId, actor.workspaceId, actor.userId])
    await pool.query('INSERT INTO cloud_machines VALUES ($1,$2,$3,$4)', [actor.workspaceId, actor.userId, 'source-sandbox', 'running'])
    await pool.query('INSERT INTO device_repos (id,"userId","repoPath","baseBranch") VALUES ($1,$2,$3,$4)', [repoId, actor.userId, `/home/mikka-runner/.mikka/bot-workspaces/${botId}`, 'main'])
    await pool.query('INSERT INTO bot_cloud_runtimes VALUES ($1,$2,$3,$4,$5)', [botId, actor.workspaceId, actor.userId, agentId, repoId])
    for (const runId of runs) {
      await pool.query('INSERT INTO agent_runs (id,"userId","agentId",status) VALUES ($1,$2,$3,$4)', [runId, actor.userId, agentId, 'queued'])
      await pool.query('INSERT INTO computer_run_bindings VALUES ($1,$2,$3,$4)', [runId, botId, actor.workspaceId, actor.userId])
    }
    await assert.rejects(prepareWorkspaceSnapshot(pool, { ...actor, userId: 'bob' }, runs[0], botId, sha, runtime), /unavailable/)
    await pool.query('INSERT INTO workspace_computer_policies VALUES ($1,$2)', [actor.workspaceId, 'deny'])
    await assert.rejects(prepareWorkspaceSnapshot(pool, actor, runs[0], botId, sha, runtime), /unavailable/)
    assert.equal(builds, 0)
    await pool.query('DELETE FROM workspace_computer_policies WHERE "workspaceId"=$1', [actor.workspaceId])
    assert.deepEqual(await Promise.all(runs.slice(0, 2).map(run => prepareWorkspaceSnapshot(pool, actor, run, botId, sha, runtime))), ['snapshot-1', 'snapshot-1'])
    assert.equal(builds, 1)
    archiveHash = 'c'.repeat(64)
    assert.equal(await prepareWorkspaceSnapshot(pool, actor, runs[2], botId, sha, runtime), 'snapshot-2')
    await collectRetiredSnapshots(pool, actor, runtime); assert.deepEqual(deleted, [])
    await pool.query('UPDATE thread_machines SET state=$2 WHERE "runId"=ANY($1::uuid[])', [runs.slice(0, 2), 'ended'])
    await collectRetiredSnapshots(pool, actor, runtime); assert.deepEqual(deleted, ['snapshot-1'])
    assert.equal((await pool.query('SELECT "snapshotId" FROM thread_machines WHERE "runId"=$1', [runs[2]])).rows[0].snapshotId, 'snapshot-2')
    const run4 = randomUUID()
    await pool.query('INSERT INTO agent_runs (id,"userId","agentId",status) VALUES ($1,$2,$3,$4)', [run4, actor.userId, agentId, 'queued'])
    await pool.query('INSERT INTO computer_run_bindings VALUES ($1,$2,$3,$4)', [run4, botId, actor.workspaceId, actor.userId])
    process.env.MIKKA_CLOUD_WORKER_SHA = sha; process.env.MIKKA_CLOUD_WORKER_URL = 'https://mikka.example'
    const assignments = await Promise.all([provisionCloudThread(pool, actor, run4, botId, runtime), provisionCloudThread(pool, actor, run4, botId, runtime)])
    assert.deepEqual(assignments[0], assignments[1]); assert.equal(threadCreates, 1)
    const assigned = (await pool.query(`SELECT r."deviceId",repo."repoPath" FROM agent_runs r JOIN device_repos repo ON repo.id=r."deviceRepoId" WHERE r.id=$1`, [run4])).rows[0]
    assert.equal(assigned.deviceId, assignments[0].deviceId); assert.equal(assigned.repoPath, '/workspace')
  } finally {
    if (oldSha === undefined) delete process.env.MIKKA_CLOUD_WORKER_SHA; else process.env.MIKKA_CLOUD_WORKER_SHA = oldSha
    if (oldUrl === undefined) delete process.env.MIKKA_CLOUD_WORKER_URL; else process.env.MIKKA_CLOUD_WORKER_URL = oldUrl
    await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end()
  }
})
