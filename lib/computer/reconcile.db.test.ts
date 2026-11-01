// Stale Bot computers (cloud_machines) are reconciled with E2B, against a real PostgreSQL.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { dbUrl, seedUser, seedWorkspace } from '../../tests/support/workspace-admin-db'

test('reconcileCloudMachines: a sandbox E2B no longer has stops claiming to run', { skip: !dbUrl }, async t => {
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: dbUrl, max: 2 })
  const { reconcileCloudMachines } = await import('./reconcile')
  const { SandboxNotFoundError } = await import('e2b')
  const { E2BKeyError } = await import('../secrets/flag')
  const owner = await seedUser(pool, 'reconcile')
  t.after(async () => {
    await pool.query('DELETE FROM cloud_machines WHERE "ownerId"=$1', [owner])
    await pool.end()
    await (await import('../db')).pool.end()
  })
  const machine = async (sandboxId: string, lastActive: string, state = 'running') => {
    const ws = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }])
    await pool.query(`INSERT INTO cloud_machines ("workspaceId","ownerId","operationId","sandboxId",state,"runtimeReady","lastActiveAt") VALUES ($1,$2,$3,$4,$5,true,now()-$6::interval)`,
      [ws.id, owner, randomUUID(), sandboxId, state, lastActive])
    return ws.id
  }
  const gone = `gone-${randomUUID()}`, paused = `paused-${randomUUID()}`, live = `live-${randomUUID()}`, fresh = `fresh-${randomUUID()}`, keyless = `key-${randomUUID()}`
  const ids = {
    gone: await machine(gone, '5 days'), paused: await machine(paused, '2 hours'), live: await machine(live, '2 hours'),
    fresh: await machine(fresh, '1 minute'), keyless: await machine(keyless, '2 hours', 'waking'),
  }
  const probed: string[] = []
  const probe = async (_workspaceId: string, sandboxId: string) => {
    probed.push(sandboxId)
    if (sandboxId === gone) throw new SandboxNotFoundError('not found')
    if (sandboxId === keyless) throw new E2BKeyError('e2b_key_missing')
    return sandboxId === paused ? 'sleeping' as const : 'running' as const
  }
  const read = async (workspaceId: string) => (await pool.query('SELECT state,"sandboxId","runtimeReady" FROM cloud_machines WHERE "workspaceId"=$1', [workspaceId])).rows[0]

  assert.equal(await reconcileCloudMachines(pool, probe, 100), 2)
  assert.deepEqual(await read(ids.gone), { state: 'sleeping', sandboxId: null, runtimeReady: false }, 'the next wake creates a new sandbox')
  assert.deepEqual(await read(ids.paused), { state: 'sleeping', sandboxId: paused, runtimeReady: true }, 'a paused sandbox is kept to resume')
  assert.equal((await read(ids.live)).state, 'running')
  assert.equal((await read(ids.keyless)).state, 'waking', 'an unusable key is not proof the sandbox is gone')
  assert.ok(!probed.includes(fresh), 'a machine active in the last hour is not checked')
  assert.equal(await reconcileCloudMachines(pool, probe, 100), 0, 'a second pass changes nothing')
})
