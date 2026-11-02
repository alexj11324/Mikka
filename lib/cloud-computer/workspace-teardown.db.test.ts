// Deleting a workspace, alone or with the account of the last person in it,
// kills the sandboxes of its Bot computers and thread machines before their
// rows go. E2B is replaced at threadMachineProvider.kill (the owner-key seam).
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { dbUrl, seedAgent, seedRun, seedUser, seedWorkspace } from '../../tests/support/workspace-admin-db'

test('workspace and account deletion kill their machines\' sandboxes and retry a failed kill', { skip: !dbUrl }, async t => {
  const database = new Pool({ connectionString: dbUrl, max: 5 })
  const machines = await import('./thread-machines')
  const general = await import('../workspace-admin/general')
  const jobs = await import('../account/deletion-jobs')
  const { pool: appPool } = await import('../db')
  const { workspacePool } = await import('../workspace-db')
  const realKill = machines.threadMachineProvider.kill
  t.after(async () => { machines.threadMachineProvider.kill = realKill; await Promise.all([database.end(), appPool.end(), workspacePool.end()]) })

  const kills: Array<{ ownerId: string; sandboxId: string; rowPresent: boolean }> = []
  let failing = new Set<string>()
  const gone = new Set<string>()
  machines.threadMachineProvider.kill = async (sandboxId: string, ownerId: string) => {
    const rows = await database.query('SELECT 1 FROM cloud_machines WHERE "sandboxId"=$1 UNION ALL SELECT 1 FROM thread_machines WHERE "sandboxId"=$1', [sandboxId])
    kills.push({ ownerId, sandboxId, rowPresent: Boolean(rows.rowCount) })
    if (failing.has(sandboxId)) throw new Error('fixture provider unavailable')
    if (gone.has(sandboxId)) throw Object.assign(new Error('fixture sandbox not found'), { status: 404 })
  }
  const device = async (ownerId: string, workspaceId: string) => {
    const id = randomUUID()
    await database.query('INSERT INTO devices(id,"ownerId",name,kind) VALUES($1,$2,\'Cloud\',\'cloud\')', [id, ownerId])
    await database.query('INSERT INTO device_tokens(id,"userId",name,"tokenHash","boundDeviceId","boundWorkspaceId","expiresAt") VALUES($1,$2,\'fixture\',$3,$4,$5,now()+interval \'1 day\')', [randomUUID(), ownerId, randomUUID(), id, workspaceId])
    return id
  }
  /** A Bot computer with a running run on it, and a thread machine with its own run. */
  const seedMachines = async (ownerId: string, workspaceId: string) => {
    const agent = await seedAgent(database, ownerId)
    const computerDevice = await device(ownerId, workspaceId), computer = `fixture-computer-${randomUUID()}`
    await database.query('INSERT INTO cloud_machines("workspaceId","ownerId","deviceId","sandboxId","operationId",state,"runtimeReady") VALUES($1,$2,$3,$4,$5,\'running\',true)', [workspaceId, ownerId, computerDevice, computer, randomUUID()])
    const botRun = await seedRun(database, { userId: ownerId, agentId: agent, status: 'running' })
    await database.query('UPDATE agent_runs SET "deviceId"=$2 WHERE id=$1', [botRun, computerDevice])
    const threadDevice = await device(ownerId, workspaceId), thread = `fixture-thread-${randomUUID()}`
    const threadRun = await seedRun(database, { userId: ownerId, agentId: agent, status: 'running' })
    await database.query('INSERT INTO thread_machines("runId","workspaceId","ownerId","sandboxId","snapshotId","operationId",state,"deviceId") VALUES($1,$2,$3,$4,\'snapshot-fixture\',$5,\'running\',$6)', [threadRun, workspaceId, ownerId, thread, randomUUID(), threadDevice])
    return { computer, thread, devices: [computerDevice, threadDevice], runs: [botRun, threadRun] }
  }
  const fenced = async (seeded: Awaited<ReturnType<typeof seedMachines>>) => {
    const tokens = (await database.query('SELECT "revokedAt" FROM device_tokens WHERE "boundDeviceId"=ANY($1::uuid[])', [seeded.devices])).rows
    const devices = (await database.query('SELECT "removedAt" FROM devices WHERE id=ANY($1::uuid[])', [seeded.devices])).rows
    const runs = (await database.query('SELECT status FROM agent_runs WHERE id=ANY($1::uuid[])', [seeded.runs])).rows
    return tokens.every(row => row.revokedAt) && devices.every(row => row.removedAt) && runs.every(row => row.status === 'stopped')
  }
  const retries = async (sandboxIds: string[]) => (await database.query<{ sandboxId: string }>('SELECT "sandboxId" FROM sandbox_kill_retries WHERE "sandboxId"=ANY($1::text[]) ORDER BY 1', [sandboxIds])).rows.map(row => row.sandboxId)

  await t.test('删除工作区 kills every member\'s Bot computer and thread machine first; a failed kill is retried by the cron sweep', async () => {
    kills.length = 0
    const admin = await seedUser(database, 'teardown-admin'), member = await seedUser(database, 'teardown-member')
    const name = `Doomed ${randomUUID().slice(0, 6)}`
    const ws = await seedWorkspace(database, admin, [{ userId: admin, role: 'admin' }, { userId: member, role: 'member' }], name)
    const other = await seedWorkspace(database, admin, [{ userId: admin, role: 'admin' }, { userId: member, role: 'member' }])
    const own = await seedMachines(admin, ws.id), theirs = await seedMachines(member, ws.id), kept = await seedMachines(member, other.id)
    failing = new Set([theirs.thread])

    await general.deleteWorkspaceData(admin, ws.id, name)

    assert.deepEqual(kills.map(row => row.sandboxId).sort(), [own.computer, own.thread, theirs.computer, theirs.thread].sort(), 'only the deleted workspace\'s sandboxes are killed')
    assert.ok(kills.every(row => row.rowPresent), 'each kill happens while its machine row still exists')
    assert.deepEqual(Object.fromEntries(kills.map(row => [row.sandboxId, row.ownerId])), { [own.computer]: admin, [own.thread]: admin, [theirs.computer]: member, [theirs.thread]: member }, 'each sandbox is killed on its owner\'s key')
    assert.equal((await database.query('SELECT count(*)::int n FROM mikka_workspaces WHERE id=$1', [ws.id])).rows[0].n, 0, 'a failed kill does not stop the deletion')
    assert.equal((await database.query('SELECT count(*)::int n FROM cloud_machines WHERE "workspaceId"=$1', [ws.id])).rows[0].n, 0)
    assert.equal((await database.query('SELECT count(*)::int n FROM thread_machines WHERE "workspaceId"=$1', [ws.id])).rows[0].n, 0)
    assert.ok(await fenced(own) && await fenced(theirs), 'runs stop, worker credentials are revoked and devices removed')
    assert.equal(await fenced(kept), false, 'the other workspace keeps its machines running')
    assert.equal((await database.query('SELECT count(*)::int n FROM device_tokens WHERE "boundDeviceId"=ANY($1::uuid[]) AND "revokedAt" IS NULL', [kept.devices])).rows[0].n, 2)
    assert.deepEqual(await retries([own.computer, own.thread, theirs.computer, theirs.thread]), [theirs.thread], 'only the failed kill waits for a retry')
    assert.deepEqual((await database.query('SELECT * FROM sandbox_kill_retries WHERE "sandboxId"=$1', [theirs.thread])).rows.map(row => Object.keys(row).sort()), [['attempts', 'createdAt', 'lastAttemptAt', 'ownerId', 'sandboxId']], 'the retry row holds no key or credential')

    const { retrySandboxKills } = await import('./workspace-teardown')
    kills.length = 0
    assert.deepEqual(await retrySandboxKills(database), { killed: 0, pending: 1 }, 'still failing: the row stays')
    failing = new Set()
    assert.deepEqual(await retrySandboxKills(database), { killed: 1, pending: 0 })
    assert.deepEqual(kills.map(row => [row.ownerId, row.sandboxId]), [[member, theirs.thread], [member, theirs.thread]])
    assert.deepEqual(await retries([theirs.thread]), [])
    // A sandbox E2B no longer has counts as killed.
    const missing = `fixture-gone-${randomUUID()}`
    gone.add(missing)
    await database.query('INSERT INTO sandbox_kill_retries("sandboxId","ownerId") VALUES($1,$2)', [missing, member])
    assert.deepEqual(await retrySandboxKills(database, { ownerId: member }), { killed: 1, pending: 0 })
    assert.deepEqual(await retries([missing]), [])
  })

  await t.test('account deletion kills the machines left in its solo workspaces, never a shared workspace\'s, and retries a failed kill', async () => {
    kills.length = 0
    const subject = await seedUser(database, 'teardown-subject'), former = await seedUser(database, 'teardown-former'), peer = await seedUser(database, 'teardown-peer')
    // A member removed earlier left their Bot computer and thread machine behind (removeMember keeps them).
    const solo = await seedWorkspace(database, subject, [{ userId: subject, role: 'admin' }])
    const shared = await seedWorkspace(database, peer, [{ userId: peer, role: 'admin' }, { userId: subject, role: 'member' }])
    const left = await seedMachines(former, solo.id), peers = await seedMachines(peer, shared.id)
    // A kill an earlier workspace deletion could not finish, on the subject's own key.
    const ownPending = `fixture-own-pending-${randomUUID()}`
    await database.query('INSERT INTO sandbox_kill_retries("sandboxId","ownerId") VALUES($1,$2)', [ownPending, subject])
    failing = new Set([left.computer, ownPending])
    const ended: string[] = []
    const { cleanupAccountRuntimes } = await import('../account/runtime-cleanup')
    const options = {
      mainPool: database, workspacePool: database,
      // The person's own machines are cleaned by the existing owner-scoped step; its provider calls are fixtures here.
      externalCleanup: (owner: string, target: Pool) => cleanupAccountRuntimes(owner, target, async (_db, _actor, runId) => { ended.push(runId) }, async () => []),
    }
    const requested = await jobs.requestAccountDeletion(subject, `${subject}@example.invalid`, randomUUID(), options)
    assert.ok(requested.ok)
    if (!requested.ok) return

    const blocked = await jobs.resumeAccountDeletion(requested.id, options)
    assert.equal(blocked.stage, 'external_pending', 'a kill only the subject\'s key can do holds the deletion while that key exists')
    assert.deepEqual(blocked.blockedReasons, ['cloud_sandbox_kill_pending'])
    assert.deepEqual(kills.map(row => row.sandboxId), [ownPending])
    failing = new Set([left.computer])
    kills.length = 0

    const done = await jobs.resumeAccountDeletion(requested.id, options)
    assert.equal(done.stage, 'completed', 'a failed kill in a solo workspace does not stop the deletion')
    assert.deepEqual(kills.map(row => row.sandboxId).sort(), [ownPending, left.computer, left.thread].sort(), 'the shared workspace\'s machines are not killed')
    assert.ok(kills.filter(row => row.sandboxId !== ownPending).every(row => row.rowPresent && row.ownerId === former))
    assert.ok(await fenced(left))
    assert.equal(await fenced(peers), false)
    assert.equal((await database.query('SELECT count(*)::int n FROM cloud_machines WHERE "workspaceId"=$1', [solo.id])).rows[0].n, 0)
    assert.equal((await database.query('SELECT count(*)::int n FROM cloud_machines WHERE "workspaceId"=$1', [shared.id])).rows[0].n, 1)
    assert.deepEqual(await retries([left.computer, left.thread, ownPending]), [left.computer])

    const { retrySandboxKills } = await import('./workspace-teardown')
    failing = new Set()
    assert.deepEqual(await retrySandboxKills(database, { ownerId: former }), { killed: 1, pending: 0 })
    assert.deepEqual(await retries([left.computer]), [])
  })
})
