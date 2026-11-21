import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import type { SubscriptionWorkerClient } from '../../packages/daemon/src/subscription-worker-client'
import { SubscriptionRepository } from '@/lib/subscription-repository'
import { dbUrl, seedAgent, seedRun, seedUser, seedWorkspace } from '../../tests/support/workspace-admin-db'
import { cleanupAccountSubscriptions, type SubscriptionCleanupFactory } from './subscription-cleanup'
import { cleanupAccountRuntimes } from './runtime-cleanup'
import { cleanupAccountBilling } from './billing-cleanup'
import { cleanupAccountConnections } from './external-cleanup'
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
    let acknowledgeCustody = false
    let workerError = true
    const factory: SubscriptionCleanupFactory = async () => ({ repository,
      worker: scope => ({ call: async (method: string) => {
        if (workerError) throw Object.assign(new Error('private provider body'), { name: 'WorkerRefusal', code: 'metadata_unavailable' })
        assert.equal(scope.ownerId, owner); assert.equal(scope.connectionId, ownConnection)
        calls.push(method)
        if (method === 'disconnect') await database.query('UPDATE byos_connections SET state=\'disconnected\',epoch=epoch+1,"secretName"=NULL,"secretDigest"=NULL,"providerSubject"=NULL WHERE id=$1 AND "ownerId"=$2', [scope.connectionId, scope.ownerId])
        if (method === 'cleanup' && acknowledgeCustody) await database.query('UPDATE byos_secret_artifacts SET "deletedAt"=now() WHERE "connectionId"=$1 AND "ownerId"=$2', [scope.connectionId, scope.ownerId])
        return {}
      } } as unknown as SubscriptionWorkerClient),
      status: async (userId, id) => { const row = await repository.connection(userId, id); return { id, provider: row.provider, state: row.state, revision: Number(row.epoch), cleanup: { pending: acknowledgeCustody ? 0 : 1, failed: 0, providerRevocation: 'not_implemented' as const, uncertainCreates: 0 } } },
    })
    assert.deepEqual(await cleanupAccountSubscriptions(owner, database, factory), { blockedReasons: ['subscription_cleanup_failed'], warnings: [], blockerErrors: { subscription_cleanup_failed: 'WorkerRefusal:metadata_unavailable' } })
    workerError = false
    const options = { mainPool: database, workspacePool: database, externalCleanup: async (subject: string, target: Pool) => cleanupAccountSubscriptions(subject, target, factory) }
    const requested = await requestAccountDeletion(owner, `${owner}@example.invalid`, randomUUID(), options)
    assert.ok(requested.ok)
    const job = await resumeAccountDeletion(requested.id, options)
    assert.equal(job.stage, 'external_pending'); assert.deepEqual(job.blockedReasons, ['subscription_custody_cleanup_required'])
    assert.deepEqual(calls, ['disconnect', 'cleanup'])
    const own = (await database.query('SELECT state,"removedAt" FROM byos_connections WHERE id=$1', [ownConnection])).rows[0]
    assert.equal(own.state, 'disconnected'); assert.equal(own.removedAt, null)
    assert.equal((await database.query('SELECT state FROM byos_connections WHERE id=$1', [peerConnection])).rows[0].state, 'connected')
    assert.equal((await database.query('SELECT count(*)::int n FROM "user" WHERE id=$1', [owner])).rows[0].n, 1)
    calls.length = 0; acknowledgeCustody = true
    const completed = await resumeAccountDeletion(requested.id, options)
    assert.equal(completed.stage, 'completed')
    assert.deepEqual(completed.warnings, ['subscription_upstream_revocation_not_supported_revoke_at_provider'])
    assert.deepEqual(calls, ['cleanup'], 'retry does not start a second disconnect revision')
    assert.equal((await database.query('SELECT count(*)::int n FROM "user" WHERE id=$1', [owner])).rows[0].n, 0)
    assert.equal((await database.query('SELECT state FROM byos_connections WHERE id=$1', [peerConnection])).rows[0].state, 'connected')
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
    }, async () => ['cloud_runtime_cleanup_required', 'cloud_snapshot_cleanup_required'])
    assert.deepEqual(calls.sort(), [ownRun, pending].sort())
    assert.deepEqual(blocked.sort(), ['cloud_thread_cleanup_pending', 'cloud_runtime_cleanup_required', 'cloud_snapshot_cleanup_required'].sort())
    assert.equal((await database.query('SELECT state FROM thread_machines WHERE "runId"=$1', [peerRun])).rows[0].state, 'running')
    assert.equal((await database.query('SELECT "sandboxId" FROM cloud_machines WHERE "workspaceId"=$1 AND "ownerId"=$2', [workspace.id, subject])).rows[0].sandboxId, botSandbox)
  })
  await t.test('a live plan is cancelled while its workspace row still exists, and a cancel that cannot be confirmed aborts the deletion', async () => {
    // Stripe is the only party that can stop the charge, and the Customer Portal that could
    // cancel it goes with the workspace. Shared tenants keep the plan they pay for themselves.
    const subject = await seedUser(database, 'cleanup-billing'), workspace = await seedWorkspace(database, subject, [{ userId: subject, role: 'admin' }])
    const teamOwner = await seedUser(database, 'cleanup-billing-team'), shared = await seedWorkspace(database, teamOwner, [{ userId: teamOwner, role: 'admin' }, { userId: subject, role: 'member' }])
    // Provider ids are unique per run: workspace_billing rows outlive the workspace row they bill.
    const providerId = (prefix: 'cus' | 'sub') => `${prefix}_${randomUUID().replaceAll('-', '')}`
    const soloCustomer = providerId('cus'), soloSubscription = providerId('sub'), teamCustomer = providerId('cus'), teamSubscription = providerId('sub')
    await database.query(`INSERT INTO workspace_billing("workspaceId","stripeCustomerId","stripeSubscriptionId",plan,status) VALUES
      ($1,$2,$3,'pro','active'),($4,$5,$6,'pro','active')`, [workspace.id, soloCustomer, soloSubscription, shared.id, teamCustomer, teamSubscription])
    const provider = (outcome: 'canceled' | 'refused') => {
      const seen: Array<{ method: string; url: string; ownWorkspacePresent: boolean }> = []
      const fetchImpl = (async (url: string, init: RequestInit) => {
        const method = init.method ?? 'GET'
        // Ordering evidence: the workspace row must still be readable when Stripe is asked.
        const ownWorkspacePresent = (await database.query('SELECT count(*)::int n FROM mikka_workspaces WHERE id=$1', [workspace.id])).rows[0].n === 1
        seen.push({ method, url, ownWorkspacePresent })
        if (method === 'GET') {
          const customer = new URL(url).searchParams.get('customer')
          const id = customer === soloCustomer ? soloSubscription : customer === teamCustomer ? teamSubscription : null
          return new Response(JSON.stringify({ has_more: false, data: id ? [{ id, customer, status: 'active' }] : [] }))
        }
        if (outcome === 'refused') return new Response('{"error":{"message":"card detail"}}', { status: 402 })
        return new Response(JSON.stringify({ id: new URL(url).pathname.split('/').at(-1), customer: soloCustomer, status: 'canceled' }))
      }) as unknown as typeof fetch
      return { seen, fetchImpl }
    }
    const env = { MIKKA_EDITION: 'cloud', STRIPE_SECRET_KEY: 'fixture' }
    const requested = await requestAccountDeletion(subject, `${subject}@example.invalid`, randomUUID(), { mainPool: database, workspacePool: database })
    assert.ok(requested.ok)
    if (!requested.ok) return
    const plan = (await database.query<{ plan: { solo: string[]; shared: string[] } }>('SELECT plan FROM account_deletion_jobs WHERE id=$1', [requested.id])).rows[0].plan
    assert.deepEqual(plan.solo, [workspace.id]); assert.deepEqual(plan.shared, [shared.id])
    const attempt = (outcome: 'canceled' | 'refused') => {
      const { seen, fetchImpl } = provider(outcome)
      return { seen, options: { mainPool: database, workspacePool: database,
        externalCleanup: async () => cleanupAccountBilling(database, { soloWorkspaceIds: plan.solo, fetchImpl, env }) } }
    }
    const refused = attempt('refused'), held = await resumeAccountDeletion(requested.id, refused.options)
    assert.equal(held.stage, 'external_pending'); assert.deepEqual(held.blockedReasons, ['billing_subscription_cancel_failed'])
    assert.deepEqual(refused.seen.map(call => call.method), ['GET', 'DELETE'])
    // The failed cancel disclosed no provider detail and removed nothing local.
    assert.equal((await database.query('SELECT count(*)::int n FROM "user" WHERE id=$1', [subject])).rows[0].n, 1)
    assert.equal((await database.query('SELECT count(*)::int n FROM mikka_workspaces WHERE id=$1', [workspace.id])).rows[0].n, 1)
    const allowed = attempt('canceled'), completed = await resumeAccountDeletion(requested.id, allowed.options)
    assert.equal(completed.stage, 'completed'); assert.deepEqual(completed.warnings, [])
    assert.equal((await database.query('SELECT count(*)::int n FROM "user" WHERE id=$1', [subject])).rows[0].n, 0)
    assert.equal((await database.query('SELECT count(*)::int n FROM mikka_workspaces WHERE id=$1', [workspace.id])).rows[0].n, 0)
    const cancelled = allowed.seen.filter(call => call.method === 'DELETE')
    assert.deepEqual(cancelled.map(call => call.url), [`https://api.stripe.com/v1/subscriptions/${soloSubscription}`])
    assert.equal(cancelled[0].ownWorkspacePresent, true, 'the plan is cancelled before its workspace row is deleted')
    assert.equal(allowed.seen.some(call => call.url.includes(teamCustomer)), false, 'a shared tenant keeps its own plan')
  })
  await t.test('an account without billing never reaches the provider; one with a customer but no reachable provider holds the account', async () => {
    const env = { MIKKA_EDITION: 'cloud', STRIPE_SECRET_KEY: 'fixture' }
    const free = await seedUser(database, 'cleanup-billing-free'), freeWorkspace = await seedWorkspace(database, free, [{ userId: free, role: 'admin' }])
    const untouched: string[] = []
    const spy = (async (url: string) => { untouched.push(url); return new Response('{}') }) as unknown as typeof fetch
    assert.deepEqual(await cleanupAccountBilling(database, { soloWorkspaceIds: [freeWorkspace.id], fetchImpl: spy, env }), { blockedReasons: [], warnings: [] })
    assert.deepEqual(untouched, [], 'no customer means no network call')
    // The default adapter must include billing; with no provider configured it holds the
    // account exactly like composio_not_configured, instead of deleting a plan it cannot stop.
    const paid = await seedUser(database, 'cleanup-billing-unconfigured'), paidWorkspace = await seedWorkspace(database, paid, [{ userId: paid, role: 'admin' }])
    await database.query('INSERT INTO workspace_billing("workspaceId","stripeCustomerId","stripeSubscriptionId",plan,status) VALUES($1,$2,$3,\'pro\',\'active\')',
      [paidWorkspace.id, `cus_${randomUUID().replaceAll('-', '')}`, `sub_${randomUUID().replaceAll('-', '')}`])
    const edition = process.env.MIKKA_EDITION, key = process.env.STRIPE_SECRET_KEY
    delete process.env.MIKKA_EDITION; delete process.env.STRIPE_SECRET_KEY
    try {
      assert.deepEqual(await cleanupAccountConnections(paid, database, undefined, [paidWorkspace.id]), { blockedReasons: ['billing_provider_not_configured'], warnings: [] })
    } finally {
      if (edition === undefined) delete process.env.MIKKA_EDITION; else process.env.MIKKA_EDITION = edition
      if (key === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = key
    }
  })
})
