import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { bindFixtureWorkspaceDatabase, createFixtureWorkspaceTables } from '../../tests/helpers/workspace-database'
import { seedFixtureWorkspace } from '../../tests/helpers/task-workspace'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { observePoolCommits } from '../db/commit-effects'
import { ComputerStore } from './store'
import { bindComputerRun } from './run-binding'
import { claimCloudRun, claimLocalRun } from './claim'
import { syncComputerReviews, decideComputerReview } from './reviews'
import { provisionCloudDevice, renewCloudDeviceToken } from './cloud-device'
import { claimWorkerLease, renewWorkerLease, releaseWorkerLease } from './worker-lease'
import { startCloudWorker } from './cloud-worker'
import { queueCloudRun } from './queue-run'
import { rebindExecutionDevice } from '../execution-identity'
import { authorizedAccessName } from '../subscription-access-snapshot'
import { ensureBotRuntime } from './bot-runtime'
import { bindBotSubscription } from './bot-subscription'
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
  const closeWorkspace = await bindFixtureWorkspaceDatabase(pool)
  let created = 0, failSync = false, failStart = false, epoch = 0, computerAllowed = true, computerPolicyVersion = 0
  const syncedLeases: { sandboxId: string; policyVersion: number; computerAllowed?: boolean; display: number }[] = []
  const runtime = {
    async createComputer() { created++; return { sandboxId: created === 1 ? 'sandbox-test' : `sandbox-owner-${created}` } },
    async connectComputer(_workspaceId: string, sandboxId: string) { return { sandboxId } },
    async computerState() { return 'sleeping' },
    async installComputerRuntime() {}, async startDesktop() { if (failStart) throw new Error('start response lost') },
    async syncDesktopLease(sandbox: { sandboxId: string }, lease: { epoch: number; computerAllowed?: boolean; policyVersion: number; display: number }) { syncedLeases.push({ sandboxId: sandbox.sandboxId, ...lease }); epoch = lease.epoch; computerAllowed = lease.computerAllowed === true; computerPolicyVersion = lease.policyVersion; if (failSync) throw new Error('transport failed') },
    async viewerGrant() { return { url: 'wss://test.invalid', expiresAt: new Date().toISOString() } },
  } as unknown as typeof provider
  const actor = { userId: 'alice', workspaceId: randomUUID() }
  const bob = { ...actor, userId: 'bob' }
  const otherWorkspace = { ...actor, workspaceId: randomUUID() }
  try {
    await pool.query('CREATE TABLE "user" (id text PRIMARY KEY); INSERT INTO "user" VALUES (\'alice\'),(\'bob\')')
    const migration = await readFile(new URL('../../drizzle/20261027164501_cloud_computers.sql', import.meta.url), 'utf8')
    await pool.query(migration); await pool.query(migration)
    await pool.query('ALTER TABLE bots ADD COLUMN IF NOT EXISTS "archivedAt" timestamptz')
    await createFixtureWorkspaceTables(pool)
    // Replace the helper's empty non-Org link shape with the full production
    // Org schema before any tenant is seeded; keep its real FK/check constraints.
    await pool.query('DROP TABLE mikka_organization_workspaces')
    await pool.query(await readFile(new URL('../../drizzle/20261109035020_organization_governance.sql', import.meta.url), 'utf8'))
    await seedFixtureWorkspace(pool, actor.userId, 'team', actor.workspaceId)
    await seedFixtureWorkspace(pool, actor.userId, 'team', otherWorkspace.workspaceId)
    await pool.query('INSERT INTO mikka_workspace_members ("workspaceId","userId",name,email,role,status) VALUES ($1,$2,$2,\'bob@example.invalid\',\'member\',\'active\')', [actor.workspaceId, bob.userId])
    await pool.query('CREATE TABLE user_e2b_keys ("userId" text PRIMARY KEY); CREATE TABLE workspace_e2b_keys ("createdBy" text)')
    await pool.query('INSERT INTO user_e2b_keys VALUES ($1),($2)', [actor.userId, bob.userId])
    await pool.query('CREATE TABLE agent_runs (id uuid PRIMARY KEY, "userId" text NOT NULL, "issueId" uuid, "agentId" uuid, "botId" uuid REFERENCES bots(id), status text NOT NULL, kind text, prompt text, "baseBranch" text, "deviceRepoId" uuid, "deviceId" uuid, "startedAt" timestamptz, "finishedAt" timestamptz, "leaseExpiresAt" timestamptz, "updatedAt" timestamptz, "stopRequestedAt" timestamptz, "agentDefinition" jsonb, "dispatchFingerprint" text, "promptTaskStart" integer, "promptTaskLength" integer, "workspaceId" uuid)')
    const bindingMigration = await readFile(new URL('../../drizzle/20261027164502_computer_run_bindings.sql', import.meta.url), 'utf8')
    await pool.query(bindingMigration); await pool.query(bindingMigration)
    await pool.query(await readFile(new URL('../../drizzle/20261030234636_run_human_control_pause.sql', import.meta.url), 'utf8'))
    await pool.query(await readFile(new URL('../../drizzle/20261101150000_run_quota_resets_at.sql', import.meta.url), 'utf8'))
    await pool.query('ALTER TABLE agent_runs ADD COLUMN "sessionId" text')
    await pool.query('ALTER TABLE agent_runs ADD COLUMN "machineAuthority" boolean NOT NULL DEFAULT false, ADD COLUMN cli_policy_hierarchy jsonb')
    await pool.query('CREATE TABLE devices (id uuid PRIMARY KEY, "ownerId" text NOT NULL, name text NOT NULL DEFAULT \'test\', "nameLocked" boolean NOT NULL DEFAULT false, enabled boolean NOT NULL DEFAULT true, harnesses jsonb NOT NULL DEFAULT \'[]\', "lastSeenAt" timestamptz); CREATE TABLE device_tokens (id uuid PRIMARY KEY, "userId" text NOT NULL, name text NOT NULL, "tokenHash" text NOT NULL, "lastUsedAt" timestamptz, "revokedAt" timestamptz, "createdAt" timestamptz NOT NULL DEFAULT now())')
    const scopeMigration = await readFile(new URL('../../drizzle/20261027164511_cloud_device_scope.sql', import.meta.url), 'utf8')
    await pool.query(scopeMigration); await pool.query(scopeMigration)
    const workerLeaseMigration = await readFile(new URL('../../drizzle/20261027164512_cloud_worker_leases.sql', import.meta.url), 'utf8')
    await pool.query(workerLeaseMigration); await pool.query(workerLeaseMigration)
    const reviewMigration = await readFile(new URL('../../drizzle/20261027164510_local_computer_reviews.sql', import.meta.url), 'utf8')
    await pool.query(reviewMigration); await pool.query(reviewMigration)
    const runApprovalMigration = await readFile(new URL('../../drizzle/20261027164513_computer_run_approvals.sql', import.meta.url), 'utf8')
    await pool.query(runApprovalMigration); await pool.query(runApprovalMigration)
    await pool.query('CREATE TABLE byos_connections (id uuid PRIMARY KEY, "ownerId" text, "workspaceId" text, state text, epoch bigint, provider text, "removedAt" timestamptz, paused boolean NOT NULL DEFAULT false); CREATE TABLE byos_bindings (id uuid PRIMARY KEY, "ownerId" text, "workspaceId" text, "consumerId" text, "connectionId" uuid, "connectionRevision" bigint, route text, "modelId" text, "createdAt" timestamptz NOT NULL DEFAULT now()); CREATE TABLE byos_native_runs ("runId" uuid PRIMARY KEY REFERENCES agent_runs(id), "bindingId" uuid NOT NULL REFERENCES byos_bindings(id)); CREATE TABLE agents (id uuid PRIMARY KEY, "userId" text NOT NULL, "deviceId" uuid, harness text, name text NOT NULL, instructions text NOT NULL DEFAULT \'\'); CREATE UNIQUE INDEX agent_name_test ON agents ("userId",lower(name)); CREATE TABLE device_repos (id uuid PRIMARY KEY, "userId" text NOT NULL, "deviceId" uuid, "repoPath" text NOT NULL, "remoteUrl" text, "baseBranch" text, UNIQUE ("deviceId","repoPath"))')
    await pool.query('ALTER TABLE byos_connections ADD COLUMN "accessSecretName" text')
    const botRuntimeMigration = await readFile(new URL('../../drizzle/20261027164514_bot_cloud_runtimes.sql', import.meta.url), 'utf8')
    await pool.query(botRuntimeMigration); await pool.query(botRuntimeMigration)
    const policyMigration = await readFile(new URL('../../drizzle/20261027164515_workspace_computer_policy.sql', import.meta.url), 'utf8')
    await pool.query(policyMigration); await pool.query(policyMigration)
    const policyAllowMigration = await readFile(new URL('../../drizzle/20261029010447_workspace_computer_policy_allow.sql', import.meta.url), 'utf8')
    await pool.query(policyAllowMigration); await pool.query(policyAllowMigration)
    const personalPolicyMigration = await readFile(new URL('../../drizzle/20261101020201_workspace_personal_policies.sql', import.meta.url), 'utf8')
    await pool.query(personalPolicyMigration); await pool.query(personalPolicyMigration)
    const policyDefaultAllowMigration = await readFile(new URL('../../drizzle/20261030204751_workspace_computer_policy_default_allow.sql', import.meta.url), 'utf8')
    await pool.query(policyDefaultAllowMigration); await pool.query(policyDefaultAllowMigration)
    await pool.query('CREATE TABLE suggestions (id uuid PRIMARY KEY,"botId" uuid)')
    const threadMigration = await readFile(new URL('../../drizzle/20261029011635_subagents_thread_machines.sql', import.meta.url), 'utf8')
    await pool.query(threadMigration); await pool.query(threadMigration)
    for (const name of ['20261029080000_unattended_browser_runtime.sql','20261029080001_owner_cloud_machines.sql','20261101021000_model_api_keys.sql','20261102120000_model_api_key_models_error.sql','20261102190000_model_api_key_responses_api.sql']) {
      const sql=await readFile(new URL('../../drizzle/'+name,import.meta.url),'utf8')
      await pool.query(sql);await pool.query(sql)
    }
    const store = new ComputerStore(pool, runtime)
    const bot = await store.createBot(actor, 'Desktop')
    async function stateView() {
      const { live, ...view } = await store.state(actor, bot.id)
      assert.equal(live?.workspaceId, actor.workspaceId, 'freshness metadata keeps the authorized workspace')
      return view
    }
    assert.deepEqual(await stateView(), { machine: 'sleeping', control: 'idle' })
    await assert.rejects(store.state(bob, bot.id), { status: 404 })
    await assert.rejects(store.operate(otherWorkspace, bot.id, 'wake'), { status: 404 })
    await pool.query(`INSERT INTO cloud_machines ("workspaceId","ownerId","operationId",state,"provisionLeaseId","provisionLeaseUntil") VALUES ($1,$2,$3,'waking',$4,now()+interval '3 minutes')`, [actor.workspaceId, actor.userId, randomUUID(), randomUUID()])
    assert.deepEqual(await stateView(), { machine: 'waking', control: 'idle' }, 'provisioning is visible before the first desktop exists')
    await assert.rejects(store.operate(actor, bot.id, 'wake'), { status: 409, message: 'Computer provisioning in progress' })
    await pool.query(`UPDATE cloud_machines SET "sandboxId"='sandbox-provisioning' WHERE "workspaceId"=$1 AND "ownerId"=$2`, [actor.workspaceId, actor.userId])
    assert.deepEqual(await stateView(), { machine: 'waking', control: 'idle' }, 'provider state cannot replace an unfinished runtime installation')
    await pool.query(`UPDATE cloud_machines SET state='running' WHERE "workspaceId"=$1 AND "ownerId"=$2`, [actor.workspaceId, actor.userId])
    assert.deepEqual(await stateView(), { machine: 'sleeping', control: 'idle' }, 'an unallocated desktop stays sleeping when its owner machine is already running')
    await pool.query('DELETE FROM cloud_machines WHERE "workspaceId"=$1 AND "ownerId"=$2', [actor.workspaceId, actor.userId])
    await pool.query(`INSERT INTO cloud_machines ("workspaceId","ownerId","operationId",state) VALUES ($1,$2,$3,'waking'),($4,$5,$6,'waking')`, [actor.workspaceId, bob.userId, randomUUID(), otherWorkspace.workspaceId, actor.userId, randomUUID()])
    assert.deepEqual(await stateView(), { machine: 'sleeping', control: 'idle' }, 'another owner or workspace machine is not exposed')
    await pool.query('DELETE FROM cloud_machines')
    const wakes=await Promise.allSettled([store.operate(actor, bot.id, 'wake'), store.operate(actor, bot.id, 'wake')])
    assert.ok(wakes.some(result=>result.status==='fulfilled'))
    for(const result of wakes) if(result.status==='rejected') assert.equal(result.reason.status,409)
    await store.operate(actor,bot.id,'wake')
    assert.equal(created, 1)
    await pool.query(`UPDATE cloud_machines SET state='waking' WHERE "workspaceId"=$1 AND "ownerId"=$2`, [actor.workspaceId, actor.userId])
    assert.deepEqual(await stateView(), { machine: 'waking', control: 'idle' }, 'a resumed desktop stays waking until provisioning completes')
    await pool.query(`UPDATE cloud_machines SET state='running' WHERE "workspaceId"=$1 AND "ownerId"=$2`, [actor.workspaceId, actor.userId])
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
    const workerRuntime = runtime
    await assert.rejects(startCloudWorker(pool, bob, sandbox, 'https://mikka.example/mikka', sha, workerRuntime), /busy or unavailable/)
    await assert.rejects(startCloudWorker(pool, actor, sandbox, 'https://mikka.example/mikka', 'b'.repeat(40), workerRuntime), /worker_version_mismatch/)
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
    const tokenId = (await pool.query('SELECT id FROM device_tokens WHERE "tokenHash"=$1', [createHash('sha256').update(rotatedCredential.token).digest('hex')])).rows[0].id as string
    const renewalActor = { ...actor, deviceId: rotatedCredential.deviceId, tokenId }
    assert.equal(await renewCloudDeviceToken(pool, { ...renewalActor, workspaceId: otherWorkspace.workspaceId }), null)
    assert.equal(await renewCloudDeviceToken(pool, { ...renewalActor, userId: bob.userId }), null)
    const renewals = await Promise.all([renewCloudDeviceToken(pool, renewalActor), renewCloudDeviceToken(pool, renewalActor)])
    assert.equal(renewals.filter(Boolean).length, 1, 'concurrent retries mint at most one replacement in the cooldown')
    const renewed = renewals.find(Boolean)!
    const tokenState = await pool.query('SELECT "revokedAt","expiresAt" FROM device_tokens WHERE "tokenHash"=$1', [createHash('sha256').update(renewed).digest('hex')])
    assert.equal(tokenState.rows[0].revokedAt, null)
    assert.ok(new Date(tokenState.rows[0].expiresAt).getTime() > Date.now() + 23 * 60 * 60_000)
    assert.equal((await pool.query('SELECT "revokedAt" FROM device_tokens WHERE id=$1', [tokenId])).rows[0].revokedAt, null, 'lost renewal responses leave the old token usable until expiry')
    {
      // A device request holds its own token row FOR SHARE (the authority fence) while the heartbeat
      // renews that token: the renewal must not need an exclusive lock on it, or it times out every
      // time and the worker's credential is never renewed. The fence connection sets lock_timeout 5 s;
      // 2 s here keeps the test short.
      await pool.query(`UPDATE device_tokens SET "createdAt"=now()-interval '1 minute' WHERE "boundDeviceId"=$1`, [rotatedCredential.deviceId])
      const fenced = new Pool({ connectionString: databaseURL, max: 2, options: `-c search_path=${schema} -c lock_timeout=2000` })
      const fence = await pool.connect()
      try {
        await fence.query('BEGIN')
        await fence.query('SELECT id FROM device_tokens WHERE id=$1 FOR SHARE', [tokenId])
        const renewedUnderFence = await renewCloudDeviceToken(fenced, renewalActor)
        assert.ok(renewedUnderFence, 'the renewal succeeds while the requesting token is held FOR SHARE')
      } finally { await fence.query('ROLLBACK'); fence.release(); await fenced.end() }
    }
    const bobBot = await store.createBot(bob, 'Other owner')
    await pool.query('UPDATE devices SET harnesses=$2 WHERE id=$1', [worker.deviceId, JSON.stringify([{ harness: 'codex', installed: true, computerBroker: true, subscriptionBroker: true }, { harness: 'claude_code', installed: true, computerBroker: true, subscriptionBroker: true }])])
    let repoSetupCalls = 0
    const botSandbox = { sandboxId: 'sandbox-test', commands: { run: async (_command: string, options: { user: string }) => { assert.equal(options.user, 'user'); repoSetupCalls++ } } } as unknown as import('e2b').Sandbox
    await assert.rejects(ensureBotRuntime(pool, bob, bot.id, botSandbox, worker.deviceId), /unavailable/)
    const setups = await Promise.all([ensureBotRuntime(pool, actor, bot.id, botSandbox, worker.deviceId), ensureBotRuntime(pool, actor, bot.id, botSandbox, worker.deviceId)])
    assert.deepEqual(setups[0], setups[1])
    assert.deepEqual(setups[0].map(row => row.harness), ['claude_code', 'codex'])
    assert.equal(new Set(setups[0].map(row => row.repoId)).size, 1)
    assert.equal(repoSetupCalls, 2, 'repeated setup reuses the Bot working tree')
    // What provisioning leaves (ensureThreadMachine): the run's own thread machine, running on its
    // own cloud device. Every cloud thread runs there; the Bot's computer serves only the Bot.
    const onThreadMachine = async (runId: string) => {
      const deviceId = randomUUID()
      await pool.query(`INSERT INTO devices(id,"ownerId",kind) VALUES ($1,$2,'cloud')`, [deviceId, actor.userId])
      await pool.query(`INSERT INTO thread_machines("runId","workspaceId","ownerId","botId","sandboxId","snapshotId","operationId",state,"deviceId")
        SELECT "runId","workspaceId","ownerId","botId",$2,'snapshot-thread',$3,'running',$4 FROM computer_run_bindings WHERE "runId"=$1
        ON CONFLICT ("runId") DO UPDATE SET "sandboxId"=EXCLUDED."sandboxId",state='running',"deviceId"=EXCLUDED."deviceId"`, [runId, `sandbox-${runId}`, randomUUID(), deviceId])
      const source = (await pool.query('SELECT * FROM agent_runs WHERE id=$1', [runId])).rows[0]
      const definition = await rebindExecutionDevice(pool, source, deviceId, pool)
      await pool.query('UPDATE agent_runs SET "deviceId"=$2,"agentDefinition"=$3 WHERE id=$1', [runId, deviceId, JSON.stringify(definition)])
      return deviceId
    }
    const cloudRun = randomUUID(), consumer = randomUUID(), cloudSubscription = randomUUID(), wrongSubscription = randomUUID()
    await pool.query('INSERT INTO agent_runs (id,"userId","agentId",status,"deviceId","workspaceId") VALUES ($1,$2,$3,$4,$5,$6)', [cloudRun, actor.userId, consumer, 'queued', worker.deviceId, actor.workspaceId])
    await bindComputerRun(pool, actor, cloudRun, bot.id)
    await pool.query('INSERT INTO byos_bindings (id,"ownerId","workspaceId","consumerId") VALUES ($1,$2,$3,$4),($5,$6,$3,$4)', [cloudSubscription, actor.userId, actor.workspaceId, consumer, wrongSubscription, bob.userId])
    const connectionId = randomUUID()
    await pool.query('INSERT INTO byos_connections (id,"ownerId","workspaceId",state,epoch,provider) VALUES ($1,$2,$3,$4,$5,$6)', [connectionId, actor.userId, actor.workspaceId, 'connected', 1, 'codex'])
    // Shared where it was connected, as the migration does for existing subscriptions (decision 2026-10-31-2225).
    await pool.query('INSERT INTO workspace_subscription_shares ("ownerId","workspaceId") VALUES ($1,$2)', [actor.userId, actor.workspaceId])
    await pool.query('UPDATE byos_bindings SET route=$2,"connectionId"=$3,"connectionRevision"=1,"modelId"=$4 WHERE id=$1', [cloudSubscription, 'codex_cli', connectionId, 'fixture-model'])
    const projectionName = `mikka-byos-${randomUUID()}`
    await pool.query('UPDATE byos_connections SET "accessSecretName"=$2 WHERE id=$1', [connectionId, projectionName])
    const credentialScope = { ownerId: actor.userId, workspaceId: actor.workspaceId, connectionId, provider: 'codex' as const }
    const credentialUse = { bindingId: cloudSubscription, consumerId: consumer }
    assert.equal(await authorizedAccessName(pool, credentialScope, credentialUse, 1), projectionName)
    await assert.rejects(authorizedAccessName(pool, { ...credentialScope, ownerId: bob.userId }, credentialUse, 1))
    await assert.rejects(authorizedAccessName(pool, credentialScope, { ...credentialUse, consumerId: randomUUID() }, 1))
    await assert.rejects(authorizedAccessName(pool, credentialScope, credentialUse, 2))
    await assert.rejects(authorizedAccessName(pool, credentialScope, { ...credentialUse, runId: cloudRun }, 1), 'queued or unbound runs cannot read a projection')
    const snapshotRun = randomUUID()
    await pool.query('INSERT INTO agent_runs (id,"userId","agentId",status,"leaseExpiresAt","workspaceId") VALUES ($1,$2,$3,\'running\',now()+interval \'1 minute\',$4)', [snapshotRun, actor.userId, consumer, actor.workspaceId])
    await pool.query('INSERT INTO byos_native_runs ("runId","bindingId") VALUES ($1,$2)', [snapshotRun, cloudSubscription])
    assert.equal(await authorizedAccessName(pool, credentialScope, { ...credentialUse, runId: snapshotRun }, 1), projectionName)
    await pool.query('UPDATE agent_runs SET "stopRequestedAt"=now() WHERE id=$1', [snapshotRun])
    await assert.rejects(authorizedAccessName(pool, credentialScope, { ...credentialUse, runId: snapshotRun }, 1), 'stopped runs cannot read a projection')
    await pool.query('DELETE FROM byos_native_runs WHERE "runId"=$1', [snapshotRun])
    await pool.query('DELETE FROM agent_runs WHERE id=$1', [snapshotRun])
    const botBinding = { botId: bot.id, connectionId, revision: 1, harness: 'codex' as const, modelId: 'fixture-model', idempotencyKey: 'bind-once' }
    await assert.rejects(bindBotSubscription(pool, bob, botBinding), /unavailable/)
    await assert.rejects(bindBotSubscription(pool, otherWorkspace, botBinding), /unavailable/)
    await assert.rejects(bindBotSubscription(pool, actor, { ...botBinding, revision: 2 }), /unavailable/)
    const linked = await Promise.all([bindBotSubscription(pool, actor, botBinding), bindBotSubscription(pool, actor, botBinding)])
    assert.deepEqual(linked[0], linked[1], 'a retried bind selects the same subscription binding')
    await assert.rejects(bindBotSubscription(pool, actor, { ...botBinding, modelId: 'changed-model' }), /unavailable/)
    const managedCodex = setups[0].find(row => row.harness === 'codex')!
    const managedRun = await queueCloudRun(pool, actor, { botId: bot.id, issueId: randomUUID(), agentId: managedCodex.agentId, deviceRepoId: managedCodex.repoId, title: 'Computer task', body: '', model: 'fixture-model' })
    assert.equal((await pool.query('SELECT "botId" FROM computer_run_bindings WHERE "runId"=$1', [managedRun.runId])).rows[0].botId, bot.id)
    assert.equal((await pool.query('SELECT "botId" FROM agent_runs WHERE id=$1', [managedRun.runId])).rows[0].botId, bot.id, 'the cloud thread belongs to its Bot in the product chat')
    const cloudRepo = randomUUID()
    await pool.query('INSERT INTO agents (id,"userId","deviceId",harness,instructions,name) VALUES ($1,$2,$3,$4,$5,$6)', [consumer, actor.userId, worker.deviceId, 'codex', 'Follow the task', 'Fixture'])
    await pool.query('INSERT INTO device_repos (id,"userId","deviceId","baseBranch","repoPath") VALUES ($1,$2,$3,$4,$5)', [cloudRepo, actor.userId, worker.deviceId, 'main', '/tmp/cloud-repo'])
    await pool.query('UPDATE bot_cloud_runtimes SET "agentId"=$2,"repoId"=$3 WHERE "botId"=$1 AND harness=\'codex\'', [bot.id,consumer,cloudRepo])
    const cloudInput = { botId: bot.id, issueId: randomUUID(), agentId: consumer, deviceRepoId: cloudRepo, title: 'Task', body: 'Use the desktop', model: 'fixture-model' }
    // A repository task: its repository has a remote, so it runs on a task machine and the 电脑 policy does not gate it.
    const remoteRepo = randomUUID()
    await pool.query('INSERT INTO device_repos (id,"userId","deviceId","baseBranch","repoPath","remoteUrl") VALUES ($1,$2,$3,$4,$5,$6)', [remoteRepo, actor.userId, worker.deviceId, 'main', 'v2/example.test/octo/repo', 'https://example.test/octo/repo.git'])
    const repositoryInput = { ...cloudInput, issueId: randomUUID(), deviceRepoId: remoteRepo, body: 'Fix the bug' }
    const allowedRepository = await queueCloudRun(pool, actor, repositoryInput)
    assert.equal((await pool.query('SELECT status FROM agent_runs WHERE id=$1', [allowedRepository.runId])).rows[0].status, 'queued', 'an allow workspace queues a repository task')
    await assert.rejects(queueCloudRun(pool, otherWorkspace, cloudInput), { status: 409 })
    await assert.rejects(queueCloudRun(pool, bob, cloudInput), { status: 409 })
    await assert.rejects(queueCloudRun(pool, actor, { ...cloudInput, deviceRepoId: randomUUID() }), { status: 409 })
    await pool.query('UPDATE byos_bindings SET route=$2 WHERE id=$1', [cloudSubscription, 'codex_cpa'])
    await assert.rejects(queueCloudRun(pool, actor, cloudInput), { status: 409 })
    await pool.query('UPDATE byos_bindings SET route=$2 WHERE id=$1', [cloudSubscription, 'codex_cli'])
    await pool.query('UPDATE byos_connections SET state=$2 WHERE id=$1', [connectionId, 'disconnected'])
    await assert.rejects(queueCloudRun(pool, actor, cloudInput), { status: 409 })
    await pool.query('UPDATE byos_connections SET state=$2,epoch=2 WHERE id=$1', [connectionId, 'connected'])
    await assert.rejects(queueCloudRun(pool, actor, cloudInput), { status: 409 })
    await pool.query('UPDATE byos_connections SET epoch=1 WHERE id=$1', [connectionId])
    // No model, or 'auto', fails before anything is written; another model than the subscription's is refused.
    const runCount = async () => Number((await pool.query('SELECT count(*) FROM agent_runs WHERE "userId"=$1', [actor.userId])).rows[0].count)
    const beforeMissing = await runCount()
    for (const model of ['', '  ', 'auto', undefined]) await assert.rejects(queueCloudRun(pool, actor, { ...cloudInput, model: model as string, threadRunId: 'thread-fixture' }), /Run model missing \(run [0-9a-f-]+, thread thread-fixture\)/)
    await assert.rejects(queueCloudRun(pool, actor, { ...cloudInput, model: 'other-model' }), { status: 409 })
    assert.equal(await runCount(), beforeMissing, 'a run without its model writes nothing')
    const queued = await queueCloudRun(pool, actor, cloudInput)
    const queuedBinding = (await pool.query('SELECT b."botId",r.status,r.prompt,r."workspaceId" FROM computer_run_bindings b JOIN agent_runs r ON r.id=b."runId" WHERE r.id=$1', [queued.runId])).rows[0]
    assert.equal(queuedBinding.botId, bot.id)
    assert.equal(queuedBinding.status, 'queued')
    assert.equal(queuedBinding.workspaceId, actor.workspaceId, 'cloud admission persists its validated tenant without relying on a fixture trigger')
    assert.match(queuedBinding.prompt, /Use the desktop/)
    assert.equal(await claimLocalRun(pool, queued.runId, worker.deviceId, new Date(Date.now() + 30000)), 'cloud-required')
    assert.equal((await pool.query('SELECT state FROM thread_machines WHERE "runId"=$1', [queued.runId])).rows[0].state, 'starting', 'enqueue writes the run\'s own thread machine')
    const queuedThread = await onThreadMachine(queued.runId)
    // Holding the Bot's desktop holds only work on that desktop. A repository task on its own task
    // machine (no desktop) and a computer task on its own thread machine's desktop are neither.
    const repositoryThread = await onThreadMachine(allowedRepository.runId)
    assert.deepEqual(await claimCloudRun(pool, actor, allowedRepository.runId, repositoryThread, new Date(Date.now() + 30000), cloudSubscription, undefined, undefined, false), { botId: bot.id, ownerId: actor.userId, display: ':1', policyVersion: 0, permission: 'deny' })
    await pool.query(`UPDATE agent_runs SET status='running' WHERE id=$1`, [allowedRepository.runId])
    await store.operate(actor, bot.id, 'takeover')
    const hold = (await pool.query('SELECT control,"controlledBy","controlUntil",epoch FROM bot_desktops WHERE "botId"=$1', [bot.id])).rows[0]
    assert.equal(hold.control, 'user')
    assert.equal(hold.controlledBy, actor.userId)
    assert.ok(new Date(hold.controlUntil).getTime() > Date.now())
    assert.deepEqual(await claimCloudRun(pool, actor, queued.runId, queuedThread, new Date(Date.now() + 30000), cloudSubscription), { botId: bot.id, ownerId: actor.userId, display: ':1', policyVersion: 0, permission: 'allow' }, 'a computer task on its own thread machine claims while the Bot desktop is held')
    await store.operate(actor, bot.id, 'takeover')
    const threadRuns = async () => (await pool.query('SELECT id,status,"pauseReason","resumeStatus" FROM agent_runs WHERE id=ANY($1::uuid[])', [[allowedRepository.runId, queued.runId]])).rows.sort((a, b) => a.id === allowedRepository.runId ? -1 : b.id === allowedRepository.runId ? 1 : 0).map(({ status, pauseReason, resumeStatus }) => ({ status, pauseReason, resumeStatus }))
    const unpaused = [{ status: 'running', pauseReason: null, resumeStatus: null }, { status: 'preparing', pauseReason: null, resumeStatus: null }]
    assert.deepEqual(await threadRuns(), unpaused, 'a takeover of the Bot desktop pauses no run on its own thread machine')
    // Someone else's live hold still refuses this person's takeover and handback.
    await pool.query(`UPDATE bot_desktops SET "controlledBy"='bob' WHERE "botId"=$1`, [bot.id])
    await assert.rejects(store.operate(actor, bot.id, 'takeover'), { status: 409, message: 'Computer is already controlled' })
    await assert.rejects(store.operate(actor, bot.id, 'handback'), { status: 409, message: 'Control is held by another user' })
    await pool.query(`UPDATE bot_desktops SET "controlledBy"=$2 WHERE "botId"=$1`, [bot.id, actor.userId])
    await store.operate(actor, bot.id, 'handback')
    const released = (await pool.query('SELECT control,"controlledBy","controlUntil",epoch FROM bot_desktops WHERE "botId"=$1', [bot.id])).rows[0]
    assert.deepEqual({ control: released.control, controlledBy: released.controlledBy, controlUntil: released.controlUntil }, { control: 'agent', controlledBy: null, controlUntil: null })
    assert.ok(released.epoch > hold.epoch)
    assert.deepEqual(await threadRuns(), unpaused)
    const idempotent = { ...cloudInput, idempotencyKey: 'durable-tool-call-1' }
    const [first, retry] = await Promise.all([queueCloudRun(pool, actor, idempotent), queueCloudRun(pool, actor, idempotent)])
    assert.equal(first.runId, retry.runId, 'a retried tool call queues exactly one task')
    await assert.rejects(queueCloudRun(pool, actor, { ...idempotent, note: 'changed' }), { status: 409 })
    const deadline = new Date(Date.now() + 30000)
    const cloudThread = await onThreadMachine(cloudRun)
    assert.equal(await claimCloudRun(pool, otherWorkspace, cloudRun, cloudThread, deadline, cloudSubscription), null)
    assert.equal(await claimCloudRun(pool, actor, cloudRun, cloudThread, deadline, wrongSubscription), null)
    assert.equal(await claimCloudRun(pool, actor, cloudRun, randomUUID(), deadline, cloudSubscription), null)
    await pool.query('UPDATE agent_runs SET "deviceId"=$2 WHERE id=$1', [cloudRun, worker.deviceId])
    assert.equal(await claimCloudRun(pool, actor, cloudRun, worker.deviceId, deadline, cloudSubscription), null, 'the Bot\'s computer never claims a thread')
    await pool.query('UPDATE agent_runs SET "deviceId"=$2 WHERE id=$1', [cloudRun, cloudThread])
    await pool.query('UPDATE devices SET enabled=false WHERE id=$1', [cloudThread])
    assert.equal(await claimCloudRun(pool, actor, cloudRun, cloudThread, deadline, cloudSubscription), null)
    await pool.query('UPDATE devices SET enabled=true WHERE id=$1', [cloudThread])
    const cloudClaims = await Promise.all([claimCloudRun(pool, actor, cloudRun, cloudThread, deadline, cloudSubscription), claimCloudRun(pool, actor, cloudRun, cloudThread, deadline, cloudSubscription)])
    assert.equal(cloudClaims.filter(Boolean).length, 1)
    assert.deepEqual(cloudClaims.find(Boolean), { botId: bot.id, ownerId: actor.userId, display: ':1', policyVersion: 0, permission: 'allow' })
    const runId = randomUUID()
    await pool.query('INSERT INTO agent_runs (id,"userId",status,"workspaceId") VALUES ($1,$2,$3,$4)', [runId, actor.userId, 'queued', actor.workspaceId])
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
    await pool.query('INSERT INTO agent_runs (id,"userId",status,"workspaceId") VALUES ($1,$2,$3,$4)', [secondRunId, actor.userId, 'queued', actor.workspaceId])
    await bindComputerRun(pool, actor, secondRunId, bot.id)
    const bindings = await pool.query('SELECT "botId" FROM computer_run_bindings WHERE "runId" IN ($1,$2)', [runId, secondRunId])
    assert.equal(bindings.rowCount, 2)
    assert.ok(bindings.rows.every(row => row.botId === bot.id), 'multiple runs share the same Bot desktop')
    const another = await store.createBot(actor, 'Another bot')
    await assert.rejects(bindComputerRun(pool, actor, runId, another.id), { status: 409 })
    const localRun = randomUUID()
    await pool.query('INSERT INTO agent_runs (id,"userId",status,"deviceId","workspaceId") VALUES ($1,$2,$3,$4,$5)', [localRun, actor.userId, 'queued', deviceId, actor.workspaceId])
    const localClaims = await Promise.all([claimLocalRun(pool, localRun, deviceId, new Date(Date.now() + 30000)), claimLocalRun(pool, localRun, deviceId, new Date(Date.now() + 30000))])
    assert.deepEqual(localClaims.sort(), ['claimed', 'unavailable'])
    const subscriptionRun = randomUUID(), bindingId = randomUUID()
    await pool.query('INSERT INTO agent_runs (id,"userId",status,"deviceId","workspaceId") VALUES ($1,$2,$3,$4,$5)', [subscriptionRun, actor.userId, 'queued', deviceId, actor.workspaceId])
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
    // #1212: the decision pushes the device through its gateway, so the daemon applies it now instead of syncing every second.
    const pushes: string[] = []
    const gateway = createServer((request, response) => { pushes.push(`${request.method} ${request.url}`); response.writeHead(204).end() })
    gateway.listen(0, '127.0.0.1')
    await once(gateway, 'listening')
    const saved = { url: process.env.DEVICE_GATEWAY_URL, secret: process.env.DEVICE_GATEWAY_PUSH_SECRET }
    process.env.DEVICE_GATEWAY_URL = `http://127.0.0.1:${(gateway.address() as { port: number }).port}`
    process.env.DEVICE_GATEWAY_PUSH_SECRET = 'computer-review-test-only'
    // With the gateway configured, live invalidations ride along; they need commit tracking, as the app's pool has.
    observePoolCommits(pool)
    const devicePush = `POST /v1/devices/${deviceId}/push`
    try {
      assert.equal(await decideComputerReview(pool, actor, review.id, review.digest, true), true)
      for (let i = 0; i < 100 && !pushes.includes(devicePush); i++) await new Promise(resolve => setTimeout(resolve, 10))
      assert.equal(pushes.filter(push => push === devicePush).length, 1)
    } finally {
      for (const [name, value] of [['DEVICE_GATEWAY_URL', saved.url], ['DEVICE_GATEWAY_PUSH_SECRET', saved.secret]] as const) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value
      }
      gateway.closeAllConnections()
      await new Promise<void>(resolve => gateway.close(() => resolve()))
    }
    assert.equal((await store.state(actor, bot.id)).pendingApproval, undefined)
    assert.equal(await decideComputerReview(pool, actor, review.id, review.digest, true), false)
    assert.deepEqual(await syncComputerReviews(pool, deviceId, actor.userId, [review]), [{ id: review.id, digest: review.digest, approve: true }])
    let executions = 0
    const broker = new ComputerBroker({ socketPath: `/tmp/unused-computer-${randomUUID()}`,
      driver: { installed: true, version: 'fixture', path: '/fake', fingerprint: 'f'.repeat(64) }, permitted: id => id === runId,
      execute: async (_, call, display) => { executions++; assert.equal(display, ':1'); return call },
    })
    try {
      // Legacy compatibility only: the server no longer issues 'ask' grants
      // (2026-10-30), but a daemon that received one before can still finish.
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
    // No row means allow; storing the default allow is not a transition.
    assert.equal(await store.policy(otherWorkspace.workspaceId), 'allow')
    await store.setPolicy(otherWorkspace.workspaceId, 'allow')
    assert.equal(await store.policy(otherWorkspace.workspaceId), 'allow')
    assert.equal((await pool.query('SELECT version FROM workspace_computer_policies WHERE "workspaceId"=$1', [otherWorkspace.workspaceId])).rows[0].version, 0)
    await store.setPolicy(otherWorkspace.workspaceId, 'deny')
    assert.equal((await pool.query('SELECT version FROM workspace_computer_policies WHERE "workspaceId"=$1', [otherWorkspace.workspaceId])).rows[0].version, 1)
    await assert.rejects(pool.query('UPDATE workspace_computer_policies SET permission=$2 WHERE "workspaceId"=$1', [otherWorkspace.workspaceId, 'ask']), { code: '23514' }, 'per-step approval is no longer a stored choice')
    await store.setPolicy(actor.workspaceId, 'deny')
    assert.equal(await store.policy(actor.workspaceId), 'deny')
    assert.equal(computerAllowed, false, 'workspace denial reaches the actual display guard')
    assert.equal((await pool.query('SELECT "approvedForRun" FROM computer_run_bindings WHERE "runId"=$1', [runId])).rows[0].approvedForRun, false)
    assert.ok((await pool.query('SELECT "stopRequestedAt" FROM agent_runs WHERE id=$1', [runId])).rows[0].stopRequestedAt, 'active cloud threads are stopped')
    const stoppedQueued = (await pool.query('SELECT status,"finishedAt" FROM agent_runs WHERE id=$1', [secondRunId])).rows[0]
    assert.equal(stoppedQueued.status, 'stopped')
    assert.ok(stoppedQueued.finishedAt, 'queued cloud threads end when workspace access is revoked')
    assert.equal(await decideComputerReview(pool, actor, laterReview.id, laterReview.digest, true), false)
    await assert.rejects(syncComputerReviews(pool, deviceId, actor.userId, [makeReview(runId, 20)]), /Run or desktop unavailable/)
    await assert.rejects(queueCloudRun(pool, actor, cloudInput), { status: 409 })
    const deniedRepository = await queueCloudRun(pool, actor, { ...repositoryInput, issueId: randomUUID() })
    assert.equal((await pool.query('SELECT status FROM agent_runs WHERE id=$1', [deniedRepository.runId])).rows[0].status, 'queued', 'a deny workspace still queues a repository task')
    await store.operate(actor, bot.id, 'wake')
    assert.equal(computerAllowed, false, 'waking a denied desktop cannot re-enable the driver')
    // The 电脑 policy binds Agents, not people (#959): under deny the owner still views and takes
    // over the Bot's desktop, and every lease it publishes keeps refusing agent actions.
    assert.ok(await store.operate(actor, bot.id, 'viewer'), 'the owner can view a denied Bot desktop')
    assert.ok(await store.operate(actor, bot.id, 'takeover'), 'the owner can take over a denied Bot desktop')
    const deniedHold = syncedLeases.at(-1) as unknown as { controlledBy: string | null; computerAllowed: boolean }
    assert.deepEqual({ controlledBy: deniedHold.controlledBy, computerAllowed: deniedHold.computerAllowed }, { controlledBy: actor.userId, computerAllowed: false })
    await store.operate(actor, bot.id, 'handback')
    assert.equal(computerAllowed, false, 'handing back under deny leaves agent actions refused')
    await store.setPolicy(actor.workspaceId, 'allow')
    assert.equal(computerAllowed, true)
    assert.equal((await pool.query('SELECT version FROM workspace_computer_policies WHERE "workspaceId"=$1', [actor.workspaceId])).rows[0].version, 2)
    await assert.rejects(syncComputerReviews(pool, deviceId, actor.userId, [makeReview(runId, 21)]), /Run or desktop unavailable/, 're-enabling cannot revive a stopped run')
    // Continue the remaining independent review cases with fresh simulated runs.
    await pool.query('UPDATE agent_runs SET status=$2,"stopRequestedAt"=NULL WHERE id=ANY($1::uuid[])', [[runId, secondRunId], 'running'])
    await pool.query('UPDATE computer_run_bindings SET "approvedForRun"=true WHERE "runId"=$1', [runId])
    const keyValue = { id: randomUUID(), runId, target: 'f'.repeat(64), display: ':1', call: { name: 'press_key' as const, arguments: { key: 'tab', modifiers: ['shift' as const] } }, expiresAt: Date.now() + 120000 }
    const keyReview = { ...keyValue, digest: createHash('sha256').update(JSON.stringify(keyValue)).digest('hex') }
    assert.deepEqual(await syncComputerReviews(pool, deviceId, actor.userId, [keyReview]), [{ id: keyReview.id, digest: keyReview.digest, approve: true }])
    await pool.query('UPDATE agent_runs SET status=$2,"deviceId"=$3,"leaseExpiresAt"=now()+interval \'5 minutes\' WHERE id=$1', [secondRunId, 'running', deviceId])
    const otherRunReview = makeReview(secondRunId, 12)
    assert.deepEqual(await syncComputerReviews(pool, deviceId, actor.userId, [otherRunReview]), [], 'a different run on the same Bot needs its own approval')
    const scrollValue = { id: randomUUID(), runId: secondRunId, target: 'f'.repeat(64), display: ':1', call: { name: 'scroll' as const, arguments: { direction: 'down' as const, amount: 2, x: 10, y: 20 } }, expiresAt: Date.now() + 120000 }
    const scrollReview = { ...scrollValue, digest: createHash('sha256').update(JSON.stringify(scrollValue)).digest('hex') }
    assert.deepEqual(await syncComputerReviews(pool, deviceId, actor.userId, [scrollReview]), [])
    assert.deepEqual((await store.state(actor, bot.id)).pendingApproval?.action, { tool: 'scroll', text: 'down × 2', x: 10, y: 20 })
    assert.equal(await decideComputerReview(pool, actor, scrollReview.id, scrollReview.digest, true), true)
    await pool.query('UPDATE agent_runs SET "leaseExpiresAt"=now()-interval \'1 second\' WHERE id=$1', [runId])
    await assert.rejects(syncComputerReviews(pool, deviceId, actor.userId, [makeReview(runId, 13)]), /Run or desktop unavailable/)
    await pool.query('UPDATE agent_runs SET "leaseExpiresAt"=now()+interval \'5 minutes\' WHERE id=$1', [runId])
    await pool.query('UPDATE agent_runs SET "stopRequestedAt"=now() WHERE id=$1', [runId])
    await assert.rejects(syncComputerReviews(pool, deviceId, actor.userId, [review]))
    const startedId = randomUUID()
    await pool.query('INSERT INTO agent_runs (id,"userId",status,"workspaceId") VALUES ($1,$2,$3,$4)', [startedId, actor.userId, 'running', actor.workspaceId])
    await assert.rejects(bindComputerRun(pool, actor, startedId, bot.id), { status: 409 })
    await assert.rejects(pool.query('INSERT INTO computer_run_bindings ("runId","botId","workspaceId","ownerId") VALUES ($1,$2,$3,$4)', [startedId, bobBot.id, actor.workspaceId, actor.userId]), { code: '23503' })
    await store.operate(bob,bobBot.id,'wake')
    const bobMachine=(await pool.query('SELECT * FROM cloud_machines WHERE "workspaceId"=$1 AND "ownerId"=$2',[bob.workspaceId,bob.userId])).rows[0]
    assert.notEqual(bobMachine.sandboxId,'sandbox-test')
    assert.equal(created,2,'a second account receives a separate machine in the same workspace')
    assert.equal((await pool.query('SELECT display FROM bot_desktops WHERE "botId"=$1',[bobBot.id])).rows[0].display,1)
    await assert.rejects(store.state(actor,bobBot.id),{status:404})
    await assert.rejects(store.operate(bob,bot.id,'viewer'),{status:404})
    await assert.rejects(store.operate(actor, bot.id, 'viewer', 'control'), { status: 403 })
    assert.equal((await pool.query('SELECT state FROM cloud_machines WHERE "workspaceId"=$1', [actor.workspaceId])).rows[0].state, 'running', 'denied control must not mark a working machine as failed')
    await pool.query(`UPDATE agent_runs SET status='running',"sessionId"='same-session',"leaseExpiresAt"=now()+interval '1 hour' WHERE id=$1`, [runId])
    const beforePause = (await pool.query('SELECT "sessionId","leaseExpiresAt" FROM agent_runs WHERE id=$1', [runId])).rows[0]
    await store.operate(actor, bot.id, 'takeover')
    await store.operate(actor, bot.id, 'takeover')
    // No run can be claimed onto the Bot's desktop (claimCloudRun needs the run's own thread
    // machine; claimLocalRun refuses a bound run), so a takeover pauses none, even this bound one.
    assert.deepEqual((await pool.query('SELECT status,"pauseReason","resumeStatus","sessionId","leaseExpiresAt" FROM agent_runs WHERE id=$1', [runId])).rows[0], { status: 'running', pauseReason: null, resumeStatus: null, ...beforePause })
    // A run an earlier takeover paused (before this change) still resumes on handback.
    await pool.query(`UPDATE agent_runs SET "resumeStatus"=status,status='paused',"pauseReason"='human_control' WHERE id=$1`, [runId])
    const taken = epoch
    assert.equal((await store.state(actor, bot.id)).control, 'user')
    // Takeover pauses the bot: the desktop lease names the person, and the
    // trusted lease driver (scripts/e2b/lease-driver.py) refuses every bot
    // action while that hold lasts. Handback clears it under a new epoch.
    const held = syncedLeases.at(-1) as unknown as { controlledBy: string | null; controlUntil: number; computerAllowed: boolean }
    assert.equal(held.controlledBy, actor.userId)
    assert.ok(held.controlUntil > Date.now() / 1000)
    assert.equal(held.computerAllowed, true, 'default allow does not override the takeover hold')
    await store.operate(actor, bot.id, 'handback')
    await store.operate(actor, bot.id, 'handback')
    assert.deepEqual((await pool.query('SELECT status,"pauseReason","resumeStatus","sessionId","leaseExpiresAt" FROM agent_runs WHERE id=$1', [runId])).rows[0], { status: 'running', pauseReason: null, resumeStatus: null, ...beforePause })
    await store.operate(actor, bot.id, 'takeover')
    await pool.query(`UPDATE agent_runs SET status='stopped',"pauseReason"='human_control',"finishedAt"=now() WHERE id=$1`, [runId])
    await store.operate(actor, bot.id, 'handback')
    assert.equal((await pool.query('SELECT status FROM agent_runs WHERE id=$1', [runId])).rows[0].status, 'stopped', 'handback never revives a run that ended while paused')
    assert.ok(epoch > taken)
    assert.equal((syncedLeases.at(-1) as unknown as { controlledBy: string | null }).controlledBy, null)
    failSync = true
    await assert.rejects(store.operate(actor, bot.id, 'takeover'))
    const failedEpoch = epoch
    const restarted = new ComputerStore(pool, runtime)
    failSync = false
    await restarted.operate(actor, bot.id, 'handback')
    assert.ok(epoch > failedEpoch, 'failed synchronization cannot reuse an old generation')
    assert.equal((await restarted.state(actor, bot.id)).machine, 'sleeping', 'provider pause is reflected')
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM bot_desktops')).rows[0].n, 2)
    const interrupted = await store.createBot(actor, 'Interrupted start')
    failStart = true
    await assert.rejects(store.operate(actor, interrupted.id, 'wake'))
    failStart = false
    const later = await store.createBot(actor, 'Later bot')
    await store.operate(actor, later.id, 'wake')
    const displays = (await pool.query(`SELECT display FROM bot_desktops WHERE "ownerId"='alice' ORDER BY display`)).rows.map(row => row.display)
    assert.deepEqual(displays, [1, 2, 3], 'uncertain start keeps its binding rather than leaking its desktop to a later bot')
    await store.setPolicy(actor.workspaceId, 'deny')
    await store.setPolicy(actor.workspaceId, 'allow')
    assert.equal(computerPolicyVersion, 4)
    assert.equal((await pool.query('SELECT "approvedForRun" FROM computer_run_bindings WHERE "runId"=$1', [runId])).rows[0].approvedForRun, false, 'a policy transition revokes old run-scoped approval')
    const allowedRun = randomUUID()
    await pool.query('INSERT INTO agent_runs (id,"userId","agentId",status,"deviceId","workspaceId") VALUES ($1,$2,$3,$4,$5,$6)', [allowedRun, actor.userId, consumer, 'queued', worker.deviceId, actor.workspaceId])
    await bindComputerRun(pool, actor, allowedRun, bot.id)
    assert.deepEqual(await claimCloudRun(pool, actor, allowedRun, await onThreadMachine(allowedRun), new Date(Date.now() + 30000), cloudSubscription), { botId: bot.id, ownerId: actor.userId, display: ':1', policyVersion: 4, permission: 'allow' })
    const directLocal = randomUUID()
    await pool.query(`INSERT INTO agent_runs (id,"userId","botId","deviceId",status,"machineAuthority","leaseExpiresAt","workspaceId")
      VALUES ($1,$2,$3,$4,'running',true,now()+interval '5 minutes',$5)`, [directLocal, actor.userId, bot.id, deviceId, actor.workspaceId])
    await store.setPolicy(actor.workspaceId, 'deny')
    const revokedLocal = (await pool.query('SELECT "stopRequestedAt","leaseExpiresAt"<=now() AS expired FROM agent_runs WHERE id=$1', [directLocal])).rows[0]
    assert.ok(revokedLocal.stopRequestedAt, 'policy revocation stops a direct local runner without a computer_run_binding')
    assert.equal(revokedLocal.expired, true)
    assert.equal(computerPolicyVersion, 5, 'the driver guard fences grants from the previous policy version')
    await store.setPolicy(actor.workspaceId, 'allow')
    assert.equal(computerPolicyVersion, 6)

    // A Bot on :3 can dispatch a dedicated thread on its own :1. Both sync
    // and the owner decision must use the thread binding, never the Bot's X11.
    const threadRun = randomUUID(), threadDevice = randomUUID()
    await pool.query(`INSERT INTO devices(id,"ownerId",kind) VALUES ($1,$2,'cloud')`, [threadDevice, actor.userId])
    await pool.query(`INSERT INTO agent_runs(id,"userId","agentId","deviceId",status,"leaseExpiresAt","workspaceId") VALUES ($1,$2,$3,$4,'running',now()+interval '5 minutes',$5)`, [threadRun, actor.userId, consumer, threadDevice, actor.workspaceId])
    await pool.query(`INSERT INTO computer_run_bindings("runId","botId","workspaceId","ownerId") VALUES ($1,$2,$3,$4)`, [threadRun, later.id, actor.workspaceId, actor.userId])
    await pool.query(`INSERT INTO thread_machines("runId","workspaceId","ownerId","botId","sandboxId","snapshotId","operationId",state,"deviceId") VALUES ($1,$2,$3,$4,'sandbox-thread','snapshot-thread',$5,'running',$6)`, [threadRun, actor.workspaceId, actor.userId, later.id, randomUUID(), threadDevice])
    const threadReview = makeReview(threadRun, 50)
    const { digest: _oldDigest, ...wrongDisplay } = { ...threadReview, display: ':3' }
    await assert.rejects(syncComputerReviews(pool, threadDevice, actor.userId, [{ ...wrongDisplay, digest: createHash('sha256').update(JSON.stringify(wrongDisplay)).digest('hex') }]), /Run or desktop unavailable/)
    await assert.rejects(syncComputerReviews(pool, worker.deviceId, actor.userId, [threadReview]), /Run or desktop unavailable/)
    assert.deepEqual(await syncComputerReviews(pool, threadDevice, actor.userId, [threadReview]), [])
    assert.equal(await decideComputerReview(pool, bob, threadReview.id, threadReview.digest, true), false)
    assert.equal(await decideComputerReview(pool, otherWorkspace, threadReview.id, threadReview.digest, true), false)
    assert.equal(await decideComputerReview(pool, actor, threadReview.id, threadReview.digest, true, 'run'), true)
    assert.deepEqual(await syncComputerReviews(pool, threadDevice, actor.userId, [threadReview]), [{ id: threadReview.id, digest: threadReview.digest, approve: true }])
    const subsequent = makeReview(threadRun, 51)
    assert.deepEqual(await syncComputerReviews(pool, threadDevice, actor.userId, [subsequent]), [{ id: subsequent.id, digest: subsequent.digest, approve: true }])
    const askingAgain = makeReview(threadRun, 52)
    await store.setPolicy(actor.workspaceId, 'deny')
    assert.equal((await pool.query('SELECT "approvedForRun" FROM computer_run_bindings WHERE "runId"=$1', [threadRun])).rows[0].approvedForRun, false)
    const threadLease = syncedLeases.filter(lease => lease.sandboxId === 'sandbox-thread').at(-1)
    assert.equal(threadLease?.policyVersion, 7)
    assert.equal(threadLease?.computerAllowed, false, 'deny reaches the dedicated driver before policy commit')
    assert.equal(threadLease?.display, 1)
    await assert.rejects(syncComputerReviews(pool, threadDevice, actor.userId, [askingAgain]), /Run or desktop unavailable/)
    await store.setPolicy(actor.workspaceId, 'allow')
    assert.equal(syncedLeases.filter(lease => lease.sandboxId === 'sandbox-thread').at(-1)?.policyVersion, 8)
    assert.equal(await decideComputerReview(pool, actor, askingAgain.id, askingAgain.digest, true), false)
  } finally {
    console.log(`Retained computer test schema: ${schema}`)
    await closeWorkspace(); await pool.end(); await admin.end()
  }
})
