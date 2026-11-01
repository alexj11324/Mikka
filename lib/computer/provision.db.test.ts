import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { ensureCloudMachine } from './provision'

const databaseURL = process.env.COMPUTER_TEST_DATABASE_URL ?? process.env.E2E_DATABASE_URL
if (process.env.REQUIRE_DB === '1' && !databaseURL) throw new Error('Computer database test URL required')

class Gone extends Error {}
const CURRENT = 'a'.repeat(40), OLD = 'b'.repeat(40)

test('real PostgreSQL: a gone or out-of-date machine is replaced, unless a run lives on it', { skip: !databaseURL }, async () => {
  assert.ok(['127.0.0.1', 'localhost'].includes(new URL(databaseURL!).hostname))
  const schema = `provision_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseURL })
  await admin.query(`CREATE SCHEMA ${schema}`)
  const pool = new Pool({ connectionString: databaseURL, options: `-c search_path=${schema}` })
  const previous = process.env.MIKKA_CLOUD_WORKER_SHA
  process.env.MIKKA_CLOUD_WORKER_SHA = CURRENT
  try {
    await pool.query(`CREATE TABLE cloud_machines ("workspaceId" uuid NOT NULL, "ownerId" text NOT NULL, "sandboxId" text UNIQUE, "operationId" uuid NOT NULL,
      "runtimeReady" boolean NOT NULL DEFAULT false, state text NOT NULL DEFAULT 'sleeping', "lastActiveAt" timestamptz NOT NULL DEFAULT now(),
      "deviceId" uuid, "provisionLeaseId" uuid, "provisionLeaseUntil" timestamptz, PRIMARY KEY ("workspaceId","ownerId"));
      CREATE TABLE agent_runs (id uuid PRIMARY KEY, "userId" text NOT NULL, status text NOT NULL, "deviceId" uuid);
      CREATE TABLE computer_run_bindings ("runId" uuid PRIMARY KEY, "workspaceId" uuid NOT NULL, "ownerId" text NOT NULL);
      CREATE TABLE thread_machines ("runId" uuid PRIMARY KEY)`)

    const setup = async (sandboxId: string, deviceId: string | null = null) => {
      const actor = { userId: 'alice', workspaceId: randomUUID() }
      await pool.query('INSERT INTO cloud_machines ("workspaceId","ownerId","sandboxId","operationId","runtimeReady",state,"deviceId") VALUES ($1,$2,$3,$4,true,\'running\',$5)', [actor.workspaceId, actor.userId, sandboxId, randomUUID(), deviceId])
      return actor
    }
    const machine = async (actor: { workspaceId: string }) => (await pool.query('SELECT * FROM cloud_machines WHERE "workspaceId"=$1', [actor.workspaceId])).rows[0]
    const runtime = (shas: Record<string, string>, gone: string[] = []) => {
      const calls = { created: [] as string[], killed: [] as string[], installed: 0 }
      return { calls, runtime: {
        async connectComputer(_w: string, id: string) { if (gone.includes(id)) throw new Gone(); return { sandboxId: id } },
        async createComputer(_w: string, operationId: string) { calls.created.push(operationId); shas[`new-${operationId}`] = CURRENT; return { sandboxId: `new-${operationId}` } },
        async installComputerRuntime() { calls.installed++ },
        computerGone: (error: unknown) => error instanceof Gone,
        async computerWorkerSha(sandbox: { sandboxId: string }) { return shas[sandbox.sandboxId] },
        async killComputer(_w: string, id: string) { calls.killed.push(id) },
      } as never }
    }

    // Killed at E2B (or expired while paused): a new machine on a new operation id.
    const goneActor = await setup('gone-box')
    const before = (await machine(goneActor)).operationId
    const gone = runtime({}, ['gone-box'])
    const replaced = await ensureCloudMachine(pool, goneActor, gone.runtime)
    assert.equal(gone.calls.created.length, 1)
    assert.notEqual(gone.calls.created[0], before)
    assert.deepEqual(gone.calls.killed, [])
    assert.equal(gone.calls.installed, 1)
    assert.equal((await machine(goneActor)).sandboxId, replaced?.sandboxId)
    assert.equal((await machine(goneActor)).state, 'running')

    // Built from an older worker and idle: killed, then rebuilt on the current template.
    const staleActor = await setup('old-box')
    const stale = runtime({ 'old-box': OLD })
    const fresh = await ensureCloudMachine(pool, staleActor, stale.runtime)
    assert.deepEqual(stale.calls.killed, ['old-box'])
    assert.equal(stale.calls.created.length, 1)
    assert.equal((await machine(staleActor)).sandboxId, fresh?.sandboxId)

    // Up to date: kept as it is.
    const currentActor = await setup('current-box')
    const current = runtime({ 'current-box': CURRENT })
    assert.equal((await ensureCloudMachine(pool, currentActor, current.runtime))?.sandboxId, 'current-box')
    assert.deepEqual([current.calls.created, current.calls.killed], [[], []])

    // Out of date but a run is live on its worker: kept until the run ends.
    const deviceId = randomUUID()
    const busyActor = await setup('busy-box', deviceId)
    await pool.query('INSERT INTO agent_runs VALUES ($1,$2,\'running\',$3)', [randomUUID(), busyActor.userId, deviceId])
    const busy = runtime({ 'busy-box': OLD })
    assert.equal((await ensureCloudMachine(pool, busyActor, busy.runtime))?.sandboxId, 'busy-box')
    assert.deepEqual([busy.calls.created, busy.calls.killed], [[], []])

    // A bound computer run counts too; a finished one does not.
    const boundActor = await setup('bound-box')
    const runId = randomUUID()
    await pool.query('INSERT INTO agent_runs VALUES ($1,$2,\'waiting_input\',NULL)', [runId, boundActor.userId])
    await pool.query('INSERT INTO computer_run_bindings VALUES ($1,$2,$3)', [runId, boundActor.workspaceId, boundActor.userId])
    const bound = runtime({ 'bound-box': OLD })
    assert.equal((await ensureCloudMachine(pool, boundActor, bound.runtime))?.sandboxId, 'bound-box')
    await pool.query('UPDATE agent_runs SET status=\'done\' WHERE id=$1', [runId])
    const after = runtime({ 'bound-box': OLD })
    assert.notEqual((await ensureCloudMachine(pool, boundActor, after.runtime))?.sandboxId, 'bound-box')
    assert.deepEqual(after.calls.killed, ['bound-box'])
  } finally {
    if (previous === undefined) delete process.env.MIKKA_CLOUD_WORKER_SHA
    else process.env.MIKKA_CLOUD_WORKER_SHA = previous
    await pool.end()
    await admin.query(`DROP SCHEMA ${schema} CASCADE`)
    await admin.end()
  }
})
