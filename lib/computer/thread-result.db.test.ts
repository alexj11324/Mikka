import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { preserveThreadResult } from './thread-result'
import type * as provider from './e2b-provider'

const databaseURL = process.env.COMPUTER_TEST_DATABASE_URL
if (process.env.REQUIRE_DB === '1' && !databaseURL) throw new Error('Computer database test URL required')

test('preserves an older thread after a worker upgrade, while checking the new staging image', { skip: !databaseURL }, async () => {
  assert.ok(['127.0.0.1', 'localhost'].includes(new URL(databaseURL!).hostname))
  const schema = `result_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseURL }); await admin.query(`CREATE SCHEMA ${schema}`)
  const pool = new Pool({ connectionString: databaseURL, options: `-c search_path=${schema}` })
  const runId = randomUUID(), actor = { userId: 'alice', workspaceId: randomUUID() }
  const previous = process.env.MIKKA_CLOUD_WORKER_SHA
  const oldSha = 'a'.repeat(40), newSha = 'b'.repeat(40)
  let sourceSha = oldSha, stageSha = newSha, snapshots = 0
  const source = { files: { read: async (path: string) => path.endsWith('worker-source-sha') ? sourceSha : new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1])); c.close() } }) },
    commands: { run: async (command: string) => ({ stdout: command.startsWith('umask') ? 'yes' : '' }) } }
  const stage = { files: { read: async () => stageSha, write: async () => {} }, commands: { run: async () => ({ stdout: '' }) }, kill: async () => {} }
  const runtime = { connectComputer: async () => source, createWorkspaceSnapshotStage: async () => stage,
    createWorkspaceSnapshot: async () => { snapshots++; return { snapshotId: 'preserved' } }, deleteWorkspaceSnapshot: async () => {} } as unknown as typeof provider
  try {
    await pool.query(`CREATE TABLE agent_runs (id uuid PRIMARY KEY,"userId" text,status text,"startedAt" timestamptz,"worktreePath" text);
      CREATE TABLE thread_machines ("runId" uuid PRIMARY KEY,"workspaceId" uuid,"ownerId" text,"sandboxId" text,"resultSnapshotId" text)`)
    await pool.query('INSERT INTO agent_runs VALUES ($1,$2,$3,now(),NULL)', [runId, actor.userId, 'succeeded'])
    await pool.query('INSERT INTO thread_machines VALUES ($1,$2,$3,$4,NULL)', [runId, actor.workspaceId, actor.userId, 'old-sandbox'])
    process.env.MIKKA_CLOUD_WORKER_SHA = newSha
    stageSha = oldSha
    await assert.rejects(preserveThreadResult(pool, actor, runId, runtime), /version mismatch/)
    assert.equal(snapshots, 0)
    stageSha = newSha; sourceSha = 'invalid'
    await assert.rejects(preserveThreadResult(pool, actor, runId, runtime), /version unavailable/)
    sourceSha = oldSha
    assert.equal(await preserveThreadResult(pool, actor, runId, runtime), 'preserved')
    assert.equal(await preserveThreadResult(pool, actor, runId, runtime), 'preserved')
    assert.equal(snapshots, 1)
    assert.equal(await preserveThreadResult(pool, { ...actor, userId: 'bob' }, runId, runtime), null)
  } finally {
    if (previous === undefined) delete process.env.MIKKA_CLOUD_WORKER_SHA; else process.env.MIKKA_CLOUD_WORKER_SHA = previous
    await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end()
  }
})
