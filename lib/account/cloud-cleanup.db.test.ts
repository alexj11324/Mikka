import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { dbUrl, seedAgent, seedRun, seedUser, seedWorkspace } from '../../tests/support/workspace-admin-db'
import { cleanupOwnedCloudMachines, type AccountCloudProvider } from './cloud-cleanup'

test('cloud deletion fences only this owner and requires acknowledged machine/snapshot cleanup', { skip: !dbUrl }, async t => {
  const database = new Pool({ connectionString: dbUrl, max: 5 }); t.after(() => database.end())
  const owner = await seedUser(database, 'cloud-delete-owner'), peer = await seedUser(database, 'cloud-delete-peer'), ws = await seedWorkspace(database, owner, [{ userId: owner, role: 'admin' }, { userId: peer, role: 'admin' }])
  const ownerDevice = randomUUID(), peerDevice = randomUUID(), ownSandbox = `fixture-own-${randomUUID()}`, peerSandbox = `fixture-peer-${randomUUID()}`
  const ownSnapshot = `fixture-snapshot-${randomUUID()}`, historical = `fixture-historical-${randomUUID()}`
  for (const [user, device, sandbox] of [[owner, ownerDevice, ownSandbox], [peer, peerDevice, peerSandbox]]) {
    await database.query('INSERT INTO devices(id,"ownerId",name,kind) VALUES($1,$2,\'Cloud\',\'cloud\')', [device, user])
    await database.query('INSERT INTO cloud_machines("workspaceId","ownerId","deviceId","sandboxId","operationId",state,"runtimeReady") VALUES($1,$2,$3,$4,$5,\'running\',true)', [ws.id, user, device, sandbox, randomUUID()])
    await database.query('INSERT INTO device_tokens(id,"userId",name,"tokenHash","boundDeviceId","boundWorkspaceId","expiresAt") VALUES($1,$2,\'fixture\',$3,$4,$5,now()+interval \'1 day\')', [randomUUID(), user, randomUUID(), device, ws.id])
  }
  const ownAgent = await seedAgent(database, owner), peerAgent = await seedAgent(database, peer)
  const ownRun = await seedRun(database, { userId: owner, agentId: ownAgent, status: 'running' }), peerRun = await seedRun(database, { userId: peer, agentId: peerAgent, status: 'running' })
  await database.query('UPDATE agent_runs SET "deviceId"=$2 WHERE id=$1', [ownRun, ownerDevice]); await database.query('UPDATE agent_runs SET "deviceId"=$2 WHERE id=$1', [peerRun, peerDevice])
  await database.query('INSERT INTO workspace_snapshots("workspaceId","ownerId","sourceRevision","lockDigest","snapshotId") VALUES($1,$2,\'fixture\',\'fixture\',$3)', [ws.id, owner, ownSnapshot])
  const kills: string[] = [], deleted: string[] = [], ended: string[][] = []
  let fail = true
  const runtime: AccountCloudProvider = {
    async endRuns(userId, ids) { assert.equal(userId, owner); ended.push(ids) },
    async kill(workspaceId, sandboxId) { assert.equal(workspaceId, ws.id); assert.equal(sandboxId, ownSandbox); kills.push(sandboxId); if (fail) throw new Error('unavailable') },
    async snapshots(workspaceId, sandboxId) { assert.equal(workspaceId, ws.id); assert.equal(sandboxId, ownSandbox); return [ownSnapshot, historical] },
    async deleteSnapshot(workspaceId, id) { assert.equal(workspaceId, ws.id); deleted.push(id) },
  }
  assert.deepEqual(await cleanupOwnedCloudMachines(owner, database, runtime), ['cloud_runtime_cleanup_required'])
  assert.equal((await database.query('SELECT status FROM agent_runs WHERE id=$1', [ownRun])).rows[0].status, 'stopped')
  assert.equal((await database.query('SELECT status FROM agent_runs WHERE id=$1', [peerRun])).rows[0].status, 'running')
  assert.ok((await database.query('SELECT "revokedAt" FROM device_tokens WHERE "boundDeviceId"=$1', [ownerDevice])).rows[0].revokedAt)
  assert.equal((await database.query('SELECT "revokedAt" FROM device_tokens WHERE "boundDeviceId"=$1', [peerDevice])).rows[0].revokedAt, null)
  assert.equal((await database.query('SELECT "sandboxId" FROM cloud_machines WHERE "workspaceId"=$1 AND "ownerId"=$2', [ws.id, owner])).rows[0].sandboxId, ownSandbox, 'failed remote cleanup retains its mapping')
  assert.deepEqual(deleted.sort(), [ownSnapshot, historical].sort())
  fail = false
  assert.deepEqual(await cleanupOwnedCloudMachines(owner, database, runtime), [])
  assert.deepEqual(kills, [ownSandbox, ownSandbox]); assert.deepEqual(ended[0], [ownRun])
  assert.equal((await database.query('SELECT state FROM cloud_machines WHERE "workspaceId"=$1 AND "ownerId"=$2', [ws.id, peer])).rows[0].state, 'running')
  assert.deepEqual(await cleanupOwnedCloudMachines(owner, database, { ...runtime, snapshots: async () => { throw new Error('inventory unavailable') } }), ['cloud_snapshot_inventory_pending'])
  assert.deepEqual(await cleanupOwnedCloudMachines(owner, database, { ...runtime, deleteSnapshot: async () => { throw new Error('delete unavailable') } }), ['cloud_snapshot_cleanup_required'])
  const pendingWs = await seedWorkspace(database, owner, [{ userId: owner, role: 'admin' }])
  await database.query('INSERT INTO cloud_machines("workspaceId","ownerId","operationId","provisionLeaseId","provisionLeaseUntil") VALUES($1,$2,$3,$4,now()-interval \'1 minute\')', [pendingWs.id, owner, randomUUID(), randomUUID()])
  assert.deepEqual(await cleanupOwnedCloudMachines(owner, database, runtime), ['cloud_provision_cleanup_pending'], 'elapsed lease time cannot prove that an external allocation is absent')
})
