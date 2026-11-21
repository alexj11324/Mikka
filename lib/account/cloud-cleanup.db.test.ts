import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { dbUrl, seedAgent, seedRun, seedUser, seedWorkspace } from '../../tests/support/workspace-admin-db'
import { cleanupOwnedCloudMachines, type AccountCloudProvider } from './cloud-cleanup'
import { acquireAccountDeletionLock } from './deletion-lock'

test('deletion lease authorizes guarded cloud cleanup but a setting alone does not', { skip: !dbUrl }, async t => {
  const database = new Pool({ connectionString: dbUrl, max: 5 }); t.after(() => database.end())
  const owner = await seedUser(database, 'guarded-cloud'), agent = await seedAgent(database, owner), job = randomUUID(), sandbox = `fixture-guarded-${randomUUID()}`
  const workspaces = []
  for (const running of [false, true]) {
    const ws = await seedWorkspace(database, owner, [{ userId: owner, role: 'admin' }]), device = randomUUID()
    await database.query(`INSERT INTO devices(id,"ownerId",name,kind) VALUES($1,$2,'Cloud','cloud')`, [device, owner])
    await database.query(`INSERT INTO cloud_machines("workspaceId","ownerId","deviceId","operationId",state,"sandboxId") VALUES($1,$2,$3,$4,$5,$6)`, [ws.id, owner, device, randomUUID(), running ? 'running' : 'error', running ? sandbox : null])
    const run = running ? await seedRun(database, { userId: owner, agentId: agent, workspaceId: ws.id, status: 'running' }) : null
    if (run) await database.query('UPDATE agent_runs SET "deviceId"=$2 WHERE id=$1', [run, device])
    await database.query(`INSERT INTO device_tokens(id,"userId",name,"tokenHash","boundDeviceId","boundWorkspaceId","expiresAt") VALUES($1,$2,'fixture',$3,$4,$5,now()+interval '1 day')`, [randomUUID(), owner, randomUUID(), device, ws.id])
    workspaces.push({ ...ws, device, run })
  }
  await database.query(`INSERT INTO account_deletion_jobs(id,"subjectUserId","subjectEmailHash",stage,plan) VALUES($1,$2,repeat('0',64),'external_pending',$3)`, [job, owner, JSON.stringify({ solo: workspaces.map(ws => ws.id) })])
  await database.query('INSERT INTO account_deletion_guards("subjectId","jobId") VALUES($1,$2)', [owner, job])
  for (const ws of workspaces) await database.query('INSERT INTO account_deletion_workspace_guards("workspaceId","jobId") VALUES($1,$2)', [ws.id, job])
  const lease = await acquireAccountDeletionLock(database, job); t.after(() => lease.close())
  const child = await database.connect()
  try {
    await child.query('BEGIN')
    await child.query("SELECT set_config('mikka.account_cloud_cleanup_grant',$1,true)", [randomUUID()])
    await assert.rejects(child.query(`UPDATE cloud_machines SET state='error' WHERE "workspaceId"=$1`, [workspaces[0].id]), { code: '55000', message: 'account_deletion_pending' })
  } finally { await child.query('ROLLBACK'); child.release() }
  const kills: string[] = []
  const runtime: AccountCloudProvider = { kill: async (_ws, id) => { kills.push(id) }, endRuns: async () => {}, snapshots: async () => [], deleteSnapshot: async () => {} }
  assert.deepEqual(await cleanupOwnedCloudMachines(owner, database, runtime, { id: job, client: lease.client }), [])
  assert.deepEqual(kills, [sandbox])
  assert.equal((await database.query('SELECT status FROM agent_runs WHERE id=$1', [workspaces[1].run])).rows[0].status, 'stopped')
  for (const ws of workspaces) assert.ok((await database.query('SELECT "revokedAt" FROM device_tokens WHERE "boundDeviceId"=$1', [ws.device])).rows[0].revokedAt)
})

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
  // A task machine's filesystem snapshot is owner-created; its `snapshotId` is
  // only the template/image name and must never be deleted as a snapshot.
  const filesystemSnapshot = `fixture-filesystem-${randomUUID()}`, threadRun = await seedRun(database, { userId: owner, agentId: ownAgent, status: 'succeeded' })
  await database.query(`INSERT INTO thread_machines("runId","workspaceId","ownerId","snapshotId","operationId",state,"filesystemSnapshotId","snapshotState")
    VALUES($1,$2,$3,'codex',$4,'paused',$5,'ready')`, [threadRun, ws.id, owner, randomUUID(), filesystemSnapshot])
  const kills: string[] = [], deleted: string[] = [], ended: string[][] = []
  let fail = true
  const runtime: AccountCloudProvider = {
    async endRuns(userId, ids) { assert.equal(userId, owner); ended.push(ids) },
    async kill(workspaceId, sandboxId) { assert.equal(workspaceId, ws.id); assert.equal(sandboxId, ownSandbox); kills.push(sandboxId); if (fail) throw new Error('unavailable') },
    async snapshots(workspaceId, sandboxId) { assert.equal(workspaceId, ws.id); assert.equal(sandboxId, ownSandbox); return [ownSnapshot, historical] },
    async deleteSnapshot(workspaceId, id) { assert.equal(workspaceId, ws.id); deleted.push(id) },
  }
  const blockerErrors: Record<string, string> = {}
  assert.deepEqual(await cleanupOwnedCloudMachines(owner, database, runtime, undefined, blockerErrors), ['cloud_runtime_cleanup_required'])
  assert.deepEqual(blockerErrors, { cloud_runtime_cleanup_required: 'Error' })
  assert.equal((await database.query('SELECT status FROM agent_runs WHERE id=$1', [ownRun])).rows[0].status, 'stopped')
  assert.equal((await database.query('SELECT status FROM agent_runs WHERE id=$1', [peerRun])).rows[0].status, 'running')
  assert.ok((await database.query('SELECT "revokedAt" FROM device_tokens WHERE "boundDeviceId"=$1', [ownerDevice])).rows[0].revokedAt)
  assert.equal((await database.query('SELECT "revokedAt" FROM device_tokens WHERE "boundDeviceId"=$1', [peerDevice])).rows[0].revokedAt, null)
  assert.equal((await database.query('SELECT "sandboxId" FROM cloud_machines WHERE "workspaceId"=$1 AND "ownerId"=$2', [ws.id, owner])).rows[0].sandboxId, ownSandbox, 'failed remote cleanup retains its mapping')
  assert.deepEqual(deleted.sort(), [ownSnapshot, historical, filesystemSnapshot].sort())
  assert.ok(!deleted.includes('codex'), 'a template snapshotId is not a provider snapshot')
  fail = false
  assert.deepEqual(await cleanupOwnedCloudMachines(owner, database, runtime), [])
  assert.deepEqual(kills, [ownSandbox, ownSandbox]); assert.deepEqual(ended[0], [ownRun])
  assert.equal((await database.query('SELECT state FROM cloud_machines WHERE "workspaceId"=$1 AND "ownerId"=$2', [ws.id, peer])).rows[0].state, 'running')
  const inventoryErrors: Record<string, string> = {}, snapshotErrors: Record<string, string> = {}
  assert.deepEqual(await cleanupOwnedCloudMachines(owner, database, { ...runtime, snapshots: async () => { throw Object.assign(new Error('inventory unavailable'), { code: 'inventory_failed' }) } }, undefined, inventoryErrors), ['cloud_snapshot_inventory_pending'])
  assert.deepEqual(inventoryErrors, { cloud_snapshot_inventory_pending: 'Error:inventory_failed' })
  assert.deepEqual(await cleanupOwnedCloudMachines(owner, database, { ...runtime, deleteSnapshot: async () => { throw new Error('delete unavailable') } }, undefined, snapshotErrors), ['cloud_snapshot_cleanup_required'])
  assert.deepEqual(snapshotErrors, { cloud_snapshot_cleanup_required: 'Error' })
  const pendingWs = await seedWorkspace(database, owner, [{ userId: owner, role: 'admin' }])
  await database.query('INSERT INTO cloud_machines("workspaceId","ownerId","operationId","provisionLeaseId","provisionLeaseUntil") VALUES($1,$2,$3,$4,now()-interval \'1 minute\')', [pendingWs.id, owner, randomUUID(), randomUUID()])
  assert.deepEqual(await cleanupOwnedCloudMachines(owner, database, runtime), ['cloud_provision_cleanup_pending'], 'elapsed lease time cannot prove that an external allocation is absent')
})
