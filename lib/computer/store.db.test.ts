import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { ComputerStore } from './store'
import { bindComputerRun } from './run-binding'
import { claimCloudRun, claimLocalRun } from './claim'
import { syncComputerReviews, decideComputerReview } from './reviews'
import { provisionCloudDevice } from './cloud-device'
import { claimWorkerLease, renewWorkerLease, releaseWorkerLease } from './worker-lease'
import { startCloudWorker } from './cloud-worker'
import { ComputerBroker } from '../../packages/daemon/src/computer/broker.mjs'
import { applyWebComputerDecisions, webComputerSnapshots } from '../../packages/daemon/src/computer/web-review'
import type * as provider from './e2b-provider'

const databaseURL = process.env.COMPUTER_TEST_DATABASE_URL ?? process.env.E2E_DATABASE_URL
if (process.env.REQUIRE_DB === '1' && !databaseURL) throw new Error('Computer database test URL required')
test('real PostgreSQL: allocation, owner boundary, control generations and recovery', { skip: !databaseURL }, async () => {
  const schema = `computer_${randomUUID().replaceAll('-', '')}`
  assert.ok(['127.0.0.1', 'localhost'].includes(new URL(databaseURL!).hostname))
  const admin = new Pool({ connectionString: databaseURL })
  await admin.query(`CREATE SCHEMA ${schema}`)
  const pool = new Pool({ connectionString: databaseURL, options: `-c search_path=${schema}` })
  let created = 0, failSync = false, failStart = false, epoch = 0
  const runtime = {
    async createComputer() { created++; return { sandboxId: 'sandbox-test' } },
    async connectComputer() { return { sandboxId: 'sandbox-test' } },
    async computerState() { return 'sleeping' },
    async installComputerRuntime() {}, async startDesktop() { if (failStart) throw new Error('start response lost') },
    async syncDesktopLease(_sandbox: unknown, lease: { epoch: number }) { epoch = lease.epoch; if (failSync) throw new Error('transport failed') },
    async viewerGrant() { return { url: 'wss://test.invalid', expiresAt: new Date().toISOString() } },
  } as unknown as typeof provider
  const actor = { userId: 'alice', workspaceId: randomUUID() }
  const bob = { ...actor, userId: 'bob' }
  const otherWorkspace = { ...actor, workspaceId: randomUUID() }
  try {
    await pool.query('CREATE TABLE "user" (id text PRIMARY KEY); INSERT INTO "user" VALUES (\'alice\'),(\'bob\')')
    const migration = await readFile(new URL('../../drizzle/20261026235901_cloud_computers.sql', import.meta.url), 'utf8')
    await pool.query(migration); await pool.query(migration)
    await pool.query('CREATE TABLE agent_runs (id uuid PRIMARY KEY, "userId" text NOT NULL, "agentId" uuid, status text NOT NULL, "deviceId" uuid, "startedAt" timestamptz, "leaseExpiresAt" timestamptz, "updatedAt" timestamptz, "stopRequestedAt" timestamptz)')
    const bindingMigration = await readFile(new URL('../../drizzle/20261027000000_computer_run_bindings.sql', import.meta.url), 'utf8')
    await pool.query(bindingMigration); await pool.query(bindingMigration)
    await pool.query('CREATE TABLE devices (id uuid PRIMARY KEY, "ownerId" text NOT NULL, name text NOT NULL DEFAULT \'test\', enabled boolean NOT NULL DEFAULT true, "lastSeenAt" timestamptz); CREATE TABLE device_tokens (id uuid PRIMARY KEY, "userId" text NOT NULL, name text NOT NULL, "tokenHash" text NOT NULL, "lastUsedAt" timestamptz, "revokedAt" timestamptz)')
    const scopeMigration = await readFile(new URL('../../drizzle/20261027000300_cloud_device_scope.sql', import.meta.url), 'utf8')
    await pool.query(scopeMigration); await pool.query(scopeMigration)
    const workerLeaseMigration = await readFile(new URL('../../drizzle/20261027000400_cloud_worker_leases.sql', import.meta.url), 'utf8')
    await pool.query(workerLeaseMigration); await pool.query(workerLeaseMigration)
    const reviewMigration = await readFile(new URL('../../drizzle/20261027000200_local_computer_reviews.sql', import.meta.url), 'utf8')
    await pool.query(reviewMigration); await pool.query(reviewMigration)
    const runApprovalMigration = await readFile(new URL('../../drizzle/20261027000500_computer_run_approvals.sql', import.meta.url), 'utf8')
    await pool.query(runApprovalMigration); await pool.query(runApprovalMigration)
    await pool.query('CREATE TABLE byos_bindings (id uuid PRIMARY KEY, "ownerId" text, "workspaceId" text, "consumerId" text); CREATE TABLE byos_native_runs ("runId" uuid PRIMARY KEY REFERENCES agent_runs(id), "bindingId" uuid NOT NULL REFERENCES byos_bindings(id))')
    const store = new ComputerStore(pool, runtime)
    const bot = await store.createBot(actor, 'Desktop')
    assert.deepEqual(await store.state(actor, bot.id), { machine: 'sleeping', control: 'idle' })
    await assert.rejects(store.state(bob, bot.id), { status: 404 })
    await assert.rejects(store.operate(otherWorkspace, bot.id, 'wake'), { status: 404 })
    await Promise.all([store.operate(actor, bot.id, 'wake'), store.operate(actor, bot.id, 'wake')])
    assert.equal(created, 1)
    const leaseA = randomUUID(), leaseB = randomUUID()
    const leaseClaims = await Promise.all([claimWorkerLease(pool, actor, 'sandbox-test', leaseA), claimWorkerLease(pool, actor, 'sandbox-test', leaseB)])
    assert.equal(leaseClaims.filter(Boolean).length, 1)
    const leaseWinner = leaseClaims[0] ? leaseA : leaseB, leaseLoser = leaseClaims[0] ? leaseB : leaseA
    assert.equal(await renewWorkerLease(pool, actor, leaseLoser), false)
    await releaseWorkerLease(pool, actor, leaseLoser)
    assert.equal(await claimWorkerLease(pool, actor, 'sandbox-test', leaseLoser), false)
    await assert.rejects(provisionCloudDevice(pool, actor, new Date(Date.now() + 60000), leaseLoser), /not found/)
    assert.equal(await renewWorkerLease(pool, actor, leaseWinner), true)
    await pool.query('UPDATE cloud_machines SET "workerLeaseUntil"=now()-interval \'1 second\' WHERE "workspaceId"=$1', [actor.workspaceId])
    assert.equal(await renewWorkerLease(pool, actor, leaseWinner), false)
    await assert.rejects(provisionCloudDevice(pool, actor, new Date(Date.now() + 60000), leaseWinner), /not found/)
    assert.equal(await claimWorkerLease(pool, actor, 'sandbox-test', leaseLoser), true)
    await releaseWorkerLease(pool, actor, leaseWinner)
    assert.equal(await claimWorkerLease(pool, actor, 'sandbox-test', leaseWinner), false)
    await releaseWorkerLease(pool, actor, leaseLoser)
    let handoff: { deviceId: string; credential: string } | undefined
    const sha = 'a'.repeat(40)
    const sandbox = { sandboxId: 'sandbox-test', files: {
      read: async () => sha,
      write: async (_path: string, data: string) => { handoff = JSON.parse(data) },
    }, commands: { run: async (command: string) => {
      assert.ok(!command.includes('orv_'), 'credential must not enter a shell command')
      if (command.includes('bin/cloud-worker.ts')) {
        assert.ok(handoff)
        await pool.query('UPDATE devices SET "lastSeenAt"=now() WHERE id=$1', [handoff.deviceId])
        await pool.query('UPDATE device_tokens SET "lastUsedAt"=now() WHERE "tokenHash"=$1', [createHash('sha256').update(handoff.credential).digest('hex')])
      }
    } } } as unknown as import('e2b').Sandbox
    const workerRuntime = { ...runtime, ensureHostedRunnerImage: async () => {} } as typeof provider
    await assert.rejects(startCloudWorker(pool, bob, sandbox, 'https://mikka.example/mikka', sha, workerRuntime), /busy or unavailable/)
    await assert.rejects(startCloudWorker(pool, actor, sandbox, 'https://mikka.example/mikka', 'b'.repeat(40), workerRuntime), /version mismatch/)
    const worker = await startCloudWorker(pool, actor, sandbox, 'https://mikka.example/mikka', sha, workerRuntime)
    assert.equal(worker.deviceId, handoff!.deviceId)
    assert.equal((await pool.query('SELECT "workerLeaseId" FROM cloud_machines WHERE "workspaceId"=$1', [actor.workspaceId])).rows[0].workerLeaseId, null)
    const tokenCount = Number((await pool.query('SELECT count(*) FROM device_tokens WHERE "boundDeviceId"=$1', [worker.deviceId])).rows[0].count)
    assert.equal((await startCloudWorker(pool, actor, sandbox, 'https://mikka.example/mikka', sha, workerRuntime)).deviceId, worker.deviceId)
    assert.equal(Number((await pool.query('SELECT count(*) FROM device_tokens WHERE "boundDeviceId"=$1', [worker.deviceId])).rows[0].count), tokenCount, 'healthy worker is reused without rotating its token')
    await assert.rejects(provisionCloudDevice(pool, bob, new Date(Date.now() + 60000)), /not found/)
    await assert.rejects(provisionCloudDevice(pool, actor, new Date(Date.now() - 1)), /expiry/)
    const firstCredential = await provisionCloudDevice(pool, actor, new Date(Date.now() + 60000))
    const rotatedCredential = await provisionCloudDevice(pool, actor, new Date(Date.now() + 120000))
    assert.equal(rotatedCredential.deviceId, firstCredential.deviceId)
    assert.notEqual(rotatedCredential.token, firstCredential.token)
    const credentials = await pool.query('SELECT "tokenHash","revokedAt" FROM device_tokens WHERE "boundDeviceId"=$1 ORDER BY "expiresAt"', [firstCredential.deviceId])
    assert.equal(credentials.rows[0].tokenHash, createHash('sha256').update(firstCredential.token).digest('hex'))
    assert.ok(credentials.rows[0].revokedAt)
    assert.equal(credentials.rows[1].revokedAt, null)
    const bobBot = await store.createBot(bob, 'Other owner')
    const cloudRun = randomUUID(), consumer = randomUUID(), cloudSubscription = randomUUID(), wrongSubscription = randomUUID()
    await pool.query('INSERT INTO agent_runs (id,"userId","agentId",status,"deviceId") VALUES ($1,$2,$3,$4,$5)', [cloudRun, actor.userId, consumer, 'queued', worker.deviceId])
    await bindComputerRun(pool, actor, cloudRun, bot.id)
    await pool.query('INSERT INTO byos_bindings (id,"ownerId","workspaceId","consumerId") VALUES ($1,$2,$3,$4),($5,$6,$3,$4)', [cloudSubscription, actor.userId, actor.workspaceId, consumer, wrongSubscription, bob.userId])
    const deadline = new Date(Date.now() + 30000)
    assert.equal(await claimCloudRun(pool, otherWorkspace, cloudRun, worker.deviceId, deadline, cloudSubscription), null)
    assert.equal(await claimCloudRun(pool, actor, cloudRun, worker.deviceId, deadline, wrongSubscription), null)
    assert.equal(await claimCloudRun(pool, actor, cloudRun, randomUUID(), deadline, cloudSubscription), null)
    await pool.query('UPDATE devices SET enabled=false WHERE id=$1', [worker.deviceId])
    assert.equal(await claimCloudRun(pool, actor, cloudRun, worker.deviceId, deadline, cloudSubscription), null)
    await pool.query('UPDATE devices SET enabled=true WHERE id=$1', [worker.deviceId])
    const cloudClaims = await Promise.all([claimCloudRun(pool, actor, cloudRun, worker.deviceId, deadline, cloudSubscription), claimCloudRun(pool, actor, cloudRun, worker.deviceId, deadline, cloudSubscription)])
    assert.equal(cloudClaims.filter(Boolean).length, 1)
    assert.deepEqual(cloudClaims.find(Boolean), { botId: bot.id, ownerId: actor.userId, display: ':1' })
    const runId = randomUUID()
    await pool.query('INSERT INTO agent_runs (id,"userId",status) VALUES ($1,$2,$3)', [runId, actor.userId, 'queued'])
    await assert.rejects(bindComputerRun(pool, bob, runId, bobBot.id), { status: 404 })
    await assert.rejects(bindComputerRun(pool, otherWorkspace, runId, bot.id), { status: 404 })
    await assert.rejects(bindComputerRun(pool, actor, runId, bobBot.id), { status: 404 })
    await bindComputerRun(pool, actor, runId, bot.id)
    const deviceId = randomUUID()
    await pool.query('INSERT INTO devices (id,"ownerId") VALUES ($1,$2)', [deviceId, actor.userId])
    await pool.query('UPDATE agent_runs SET "deviceId"=$2 WHERE id=$1', [runId, deviceId])
    assert.equal(await claimLocalRun(pool, runId, deviceId, new Date(Date.now() + 30000)), 'cloud-required')
    assert.equal((await pool.query('SELECT status FROM agent_runs WHERE id=$1', [runId])).rows[0].status, 'queued')
    await bindComputerRun(pool, actor, runId, bot.id)
    const secondRunId = randomUUID()
    await pool.query('INSERT INTO agent_runs (id,"userId",status) VALUES ($1,$2,$3)', [secondRunId, actor.userId, 'queued'])
    await bindComputerRun(pool, actor, secondRunId, bot.id)
    const bindings = await pool.query('SELECT "botId" FROM computer_run_bindings WHERE "runId" IN ($1,$2)', [runId, secondRunId])
    assert.equal(bindings.rowCount, 2)
    assert.ok(bindings.rows.every(row => row.botId === bot.id), 'multiple runs share the same Bot desktop')
    const another = await store.createBot(actor, 'Another bot')
    await assert.rejects(bindComputerRun(pool, actor, runId, another.id), { status: 409 })
    const localRun = randomUUID()
    await pool.query('INSERT INTO agent_runs (id,"userId",status,"deviceId") VALUES ($1,$2,$3,$4)', [localRun, actor.userId, 'queued', deviceId])
    const localClaims = await Promise.all([claimLocalRun(pool, localRun, deviceId, new Date(Date.now() + 30000)), claimLocalRun(pool, localRun, deviceId, new Date(Date.now() + 30000))])
    assert.deepEqual(localClaims.sort(), ['claimed', 'unavailable'])
    const subscriptionRun = randomUUID(), bindingId = randomUUID()
    await pool.query('INSERT INTO agent_runs (id,"userId",status,"deviceId") VALUES ($1,$2,$3,$4)', [subscriptionRun, actor.userId, 'queued', deviceId])
    await assert.rejects(claimLocalRun(pool, subscriptionRun, deviceId, new Date(Date.now() + 30000), bindingId), { code: '23503' })
    assert.equal((await pool.query('SELECT status FROM agent_runs WHERE id=$1', [subscriptionRun])).rows[0].status, 'queued', 'failed subscription binding cannot claim the run')
    await pool.query('INSERT INTO byos_bindings(id) VALUES ($1)', [bindingId])
    assert.equal(await claimLocalRun(pool, subscriptionRun, deviceId, new Date(Date.now() + 30000), bindingId), 'claimed')
    assert.equal((await pool.query('SELECT "bindingId" FROM byos_native_runs WHERE "runId"=$1', [subscriptionRun])).rows[0].bindingId, bindingId)
    await pool.query('UPDATE agent_runs SET status=$2,"leaseExpiresAt"=now()+interval \'5 minutes\' WHERE id=$1', [runId, 'running'])
    const reviewValue = { id: randomUUID(), runId, target: 'f'.repeat(64), display: ':1', call: { name: 'click' as const, arguments: { x: 3, y: 4 } }, expiresAt: Date.now() + 120000 }
    const review = { ...reviewValue, digest: createHash('sha256').update(JSON.stringify(reviewValue)).digest('hex') }
    await assert.rejects(syncComputerReviews(pool, deviceId, bob.userId, [review]))
    await assert.rejects(syncComputerReviews(pool, deviceId, actor.userId, [{ ...review, display: ':2' }]))
    assert.deepEqual(await syncComputerReviews(pool, deviceId, actor.userId, [review]), [])
    const visible = await store.state(actor, bot.id)
    assert.equal(visible.pendingApproval?.digest, review.digest)
    assert.deepEqual(visible.pendingApproval?.action, { tool: 'click', x: 3, y: 4 })
    assert.equal((await store.state(actor, another.id)).pendingApproval, undefined)
    assert.equal(await decideComputerReview(pool, otherWorkspace, review.id, review.digest, true), false)
    assert.equal(await decideComputerReview(pool, actor, review.id, '0'.repeat(64), true), false)
    assert.equal(await decideComputerReview(pool, actor, review.id, review.digest, true), true)
    assert.equal((await store.state(actor, bot.id)).pendingApproval, undefined)
    assert.equal(await decideComputerReview(pool, actor, review.id, review.digest, true), false)
    assert.deepEqual(await syncComputerReviews(pool, deviceId, actor.userId, [review]), [{ id: review.id, digest: review.digest, approve: true }])
    let executions = 0
    const broker = new ComputerBroker({ socketPath: `/tmp/unused-computer-${randomUUID()}`,
      driver: { installed: true, version: 'fixture', path: '/fake', fingerprint: 'f'.repeat(64) }, permitted: id => id === runId,
      execute: async (_, call, display) => { executions++; assert.equal(display, ':1'); return call },
    })
    try {
      const grant = broker.spec(runId, 'ask', { display: ':1' })!
      const pending = broker.request(grant.token, { name: 'click', arguments: { x: 7, y: 8 } })
      const snapshots = webComputerSnapshots(broker)
      assert.deepEqual(await syncComputerReviews(pool, deviceId, actor.userId, snapshots), [])
      const request = (await store.state(actor, bot.id)).pendingApproval!
      assert.equal(request.id, snapshots[0].id)
      assert.equal(executions, 0)
      assert.equal(await decideComputerReview(pool, actor, request.id, request.digest, true), true)
      await applyWebComputerDecisions(broker, await syncComputerReviews(pool, deviceId, actor.userId, snapshots))
      assert.deepEqual(await pending, { name: 'click', arguments: { x: 7, y: 8 } })
      assert.equal(executions, 1)
      await applyWebComputerDecisions(broker, await syncComputerReviews(pool, deviceId, actor.userId, snapshots))
      assert.equal(executions, 1, 'replayed decisions cannot execute again')
    } finally { await broker.close() }
    const makeReview = (currentRun: string, x: number) => {
      const value = { id: randomUUID(), runId: currentRun, target: 'f'.repeat(64), display: ':1', call: { name: 'click' as const, arguments: { x, y: 4 } }, expiresAt: Date.now() + 120000 }
      return { ...value, digest: createHash('sha256').update(JSON.stringify(value)).digest('hex') }
    }
    const grantReview = makeReview(runId, 10)
    assert.deepEqual(await syncComputerReviews(pool, deviceId, actor.userId, [grantReview]), [])
    assert.equal(await decideComputerReview(pool, otherWorkspace, grantReview.id, grantReview.digest, true, 'run'), false)
    assert.equal(await decideComputerReview(pool, actor, grantReview.id, grantReview.digest, false, 'run'), false)
    assert.equal(await decideComputerReview(pool, actor, grantReview.id, grantReview.digest, true, 'run'), true)
    const laterReview = makeReview(runId, 11)
    assert.deepEqual(await syncComputerReviews(pool, deviceId, actor.userId, [laterReview]), [{ id: laterReview.id, digest: laterReview.digest, approve: true }])
    await pool.query('UPDATE agent_runs SET status=$2,"deviceId"=$3,"leaseExpiresAt"=now()+interval \'5 minutes\' WHERE id=$1', [secondRunId, 'running', deviceId])
    const otherRunReview = makeReview(secondRunId, 12)
    assert.deepEqual(await syncComputerReviews(pool, deviceId, actor.userId, [otherRunReview]), [], 'a different run on the same Bot needs its own approval')
    await pool.query('UPDATE agent_runs SET "leaseExpiresAt"=now()-interval \'1 second\' WHERE id=$1', [runId])
    await assert.rejects(syncComputerReviews(pool, deviceId, actor.userId, [makeReview(runId, 13)]), /Run or desktop unavailable/)
    await pool.query('UPDATE agent_runs SET "leaseExpiresAt"=now()+interval \'5 minutes\' WHERE id=$1', [runId])
    await pool.query('UPDATE agent_runs SET "stopRequestedAt"=now() WHERE id=$1', [runId])
    await assert.rejects(syncComputerReviews(pool, deviceId, actor.userId, [review]))
    const startedId = randomUUID()
    await pool.query('INSERT INTO agent_runs (id,"userId",status) VALUES ($1,$2,$3)', [startedId, actor.userId, 'running'])
    await assert.rejects(bindComputerRun(pool, actor, startedId, bot.id), { status: 409 })
    await assert.rejects(pool.query('INSERT INTO computer_run_bindings ("runId","botId","workspaceId","ownerId") VALUES ($1,$2,$3,$4)', [startedId, bobBot.id, actor.workspaceId, actor.userId]), { code: '23503' })
    await assert.rejects(store.operate(bob, bobBot.id, 'wake'), { status: 409 })
    await assert.rejects(store.operate(actor, bot.id, 'viewer', 'control'), { status: 403 })
    assert.equal((await pool.query('SELECT state FROM cloud_machines WHERE "workspaceId"=$1', [actor.workspaceId])).rows[0].state, 'running', 'denied control must not mark a working machine as failed')
    await store.operate(actor, bot.id, 'takeover')
    const taken = epoch
    assert.equal((await store.state(actor, bot.id)).control, 'user')
    await store.operate(actor, bot.id, 'handback')
    assert.ok(epoch > taken)
    failSync = true
    await assert.rejects(store.operate(actor, bot.id, 'takeover'))
    const failedEpoch = epoch
    const restarted = new ComputerStore(pool, runtime)
    failSync = false
    await restarted.operate(actor, bot.id, 'handback')
    assert.ok(epoch > failedEpoch, 'failed synchronization cannot reuse an old generation')
    assert.equal((await restarted.state(actor, bot.id)).machine, 'sleeping', 'provider pause is reflected')
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM bot_desktops')).rows[0].n, 1)
    const interrupted = await store.createBot(actor, 'Interrupted start')
    failStart = true
    await assert.rejects(store.operate(actor, interrupted.id, 'wake'))
    failStart = false
    const later = await store.createBot(actor, 'Later bot')
    await store.operate(actor, later.id, 'wake')
    const displays = (await pool.query('SELECT display FROM bot_desktops ORDER BY display')).rows.map(row => row.display)
    assert.deepEqual(displays, [1, 2, 3], 'uncertain start keeps its binding rather than leaking its desktop to a later bot')
  } finally {
    await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end()
  }
})
