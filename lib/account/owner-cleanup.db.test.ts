import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import type { SubscriptionWorkerClient } from '../../packages/daemon/src/subscription-worker-client'
import { SubscriptionRepository } from '@/lib/subscription-repository'
import { dbUrl, seedAgent, seedRun, seedUser, seedWorkspace } from '../../tests/support/workspace-admin-db'
import { cleanupAccountSubscriptions, type SubscriptionCleanupFactory } from './subscription-cleanup'
import { cleanupAccountRuntimes } from './runtime-cleanup'
import { requestAccountDeletion, resumeAccountDeletion } from './deletion-jobs'

test('account cleanup calls only owner-scoped adapters and retains unresolved external mappings', { skip: !dbUrl }, async t => {
  const database = new Pool({ connectionString: dbUrl, max: 5 })
  t.after(() => database.end())
  const owner = await seedUser(database, 'cleanup-owner'), peer = await seedUser(database, 'cleanup-peer'), ws = await seedWorkspace(database, owner, [{ userId: owner, role: 'admin' }, { userId: peer, role: 'admin' }])
  await t.test('BYOS disconnect/cleanup uses the established scoped worker and never mistakes custody cleanup for upstream revocation', async () => {
    const ownConnection = randomUUID(), peerConnection = randomUUID(), secret = `fixture-artifact-${randomUUID()}`
    for (const [id, user] of [[ownConnection, owner], [peerConnection, peer]]) await database.query(`INSERT INTO byos_connections(id,"ownerId","workspaceId",provider,state,"credentialVersion","secretName","secretDigest","providerSubject") VALUES($1,$2,$3,'codex','connected',1,$4,$5,'fixture-provider-subject')`, [id, user, ws.id, `${secret}-${user}`, '0'.repeat(64)])
    await database.query('INSERT INTO byos_secret_artifacts(name,"connectionId","ownerId","workspaceId",provider,kind,"notBefore","publishedAt","createStarted","createSettled") VALUES($1,$2,$3,$4,\'codex\',\'grant\',now(),now(),true,true)', [`${secret}-${owner}`, ownConnection, owner, ws.id])
    const repository = new SubscriptionRepository(database), calls: string[] = []
    const factory: SubscriptionCleanupFactory = async () => ({ repository,
      worker: scope => ({ call: async (method: string) => {
        assert.equal(scope.ownerId, owner); assert.equal(scope.connectionId, ownConnection)
        calls.push(method)
        if (method === 'disconnect') await database.query('UPDATE byos_connections SET state=\'disconnected\',epoch=epoch+1,"secretName"=NULL,"secretDigest"=NULL,"providerSubject"=NULL WHERE id=$1 AND "ownerId"=$2', [scope.connectionId, scope.ownerId])
        if (method === 'cleanup') await database.query('UPDATE byos_secret_artifacts SET "deletedAt"=now() WHERE "connectionId"=$1 AND "ownerId"=$2', [scope.connectionId, scope.ownerId])
        return {}
      } } as unknown as SubscriptionWorkerClient),
      status: async (userId, id) => { const row = await repository.connection(userId, id); return { id, provider: row.provider, state: row.state, revision: Number(row.epoch), cleanup: { pending: 0, failed: 0, providerRevocation: 'not_implemented' as const, uncertainCreates: 0 } } },
    })
    const options = { mainPool: database, workspacePool: database, externalCleanup: async (subject: string, target: Pool) => cleanupAccountSubscriptions(subject, target, factory) }
    const requested = await requestAccountDeletion(owner, `${owner}@example.invalid`, randomUUID(), options)
    assert.ok(requested.ok)
    const job = await resumeAccountDeletion(requested.id, options)
    assert.equal(job.stage, 'external_pending'); assert.deepEqual(job.blockedReasons, ['subscription_provider_revocation_unavailable'])
    assert.deepEqual(calls, ['disconnect', 'cleanup'])
    const own = (await database.query('SELECT state,"removedAt" FROM byos_connections WHERE id=$1', [ownConnection])).rows[0]
    assert.equal(own.state, 'disconnected'); assert.equal(own.removedAt, null)
    assert.equal((await database.query('SELECT state FROM byos_connections WHERE id=$1', [peerConnection])).rows[0].state, 'connected')
    assert.equal((await database.query('SELECT count(*)::int n FROM "user" WHERE id=$1', [owner])).rows[0].n, 1)
    calls.length = 0
    assert.deepEqual(await cleanupAccountSubscriptions(owner, database, factory), ['subscription_provider_revocation_unavailable'])
    assert.deepEqual(calls, ['cleanup'], 'retry preserves mapping and does not start a second disconnect revision')
  })
  await t.test('dedicated thread teardown excludes peers; pending creation and shared Bot/snapshot custody remain explicit', async () => {
    // A separate owner is necessary: the prior subject is correctly write-fenced by its pending deletion.
    const subject = await seedUser(database, 'cleanup-thread-owner'), workspace = await seedWorkspace(database, subject, [{ userId: subject, role: 'admin' }])
    const ownAgent = await seedAgent(database, subject), peerAgent = await seedAgent(database, peer)
    const ownRun = await seedRun(database, { userId: subject, agentId: ownAgent }), pending = await seedRun(database, { userId: subject, agentId: ownAgent }), peerRun = await seedRun(database, { userId: peer, agentId: peerAgent })
    for (const [run, user, sandbox, state] of [[ownRun, subject, `fixture-owned-${ownRun}`, 'running'], [pending, subject, null, 'ended'], [peerRun, peer, `fixture-peer-${peerRun}`, 'running']]) {
      await database.query('INSERT INTO thread_machines("runId","workspaceId","ownerId","sandboxId","snapshotId","operationId",state,"workerLeaseUntil") VALUES($1,$2,$3,$4,\'fixture-snapshot\',$5,$6,$7)', [run, workspace.id, user, sandbox, randomUUID(), state, run === pending ? new Date(Date.now() + 60_000) : null])
    }
    const botSandbox = `fixture-bot-${subject}`
    await database.query('INSERT INTO cloud_machines("workspaceId","ownerId","sandboxId","operationId") VALUES($1,$2,$4,$3)', [workspace.id, subject, randomUUID(), botSandbox])
    await database.query('INSERT INTO workspace_snapshots("workspaceId","ownerId","sourceRevision","lockDigest","snapshotId") VALUES($1,$2,\'fixture-revision\',\'fixture-lock\',\'fixture-snapshot\')', [workspace.id, subject])
    const calls: string[] = []
    const blocked = await cleanupAccountRuntimes(subject, database, async (_pool, actor, runId) => {
      assert.deepEqual(actor, { userId: subject, workspaceId: workspace.id }); calls.push(runId)
      if (runId === pending) throw new Error('Thread creation cleanup pending')
      await database.query('UPDATE thread_machines SET state=\'ended\' WHERE "runId"=$1 AND "ownerId"=$2', [runId, actor.userId])
    })
    assert.deepEqual(calls.sort(), [ownRun, pending].sort())
    assert.deepEqual(blocked.sort(), ['cloud_thread_cleanup_pending', 'cloud_runtime_cleanup_required', 'cloud_snapshot_cleanup_required'].sort())
    assert.equal((await database.query('SELECT state FROM thread_machines WHERE "runId"=$1', [peerRun])).rows[0].state, 'running')
    assert.equal((await database.query('SELECT "sandboxId" FROM cloud_machines WHERE "workspaceId"=$1 AND "ownerId"=$2', [workspace.id, subject])).rows[0].sandboxId, botSandbox)
  })
})
