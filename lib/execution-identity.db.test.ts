import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { Pool } from 'pg'
import { orderMigrations } from '../scripts/migration-order.mjs'
import { isE2eTarget, E2E_DB_RULE } from '../tests/helpers/e2e-target.mjs'
import { dropTestDatabase } from '../tests/support/drop-test-database'
import { freezeWorkerDefinition } from './agent-kit/worker'
import { freezeExecutionIdentity, ExecutionIdentityError } from './execution-identity'
import { createExecutionClaim } from './factory/execution-claim'
import { sealSecret } from './secrets/crypto'

const url = process.env.E2E_DATABASE_URL
if (url) assert.ok(isE2eTarget(url), E2E_DB_RULE)
else if (process.env.REQUIRE_DB === '1') assert.fail('REQUIRE_DB=1 needs an isolated E2E_DATABASE_URL')

test('real claim, MCP tools, key disclosure and artifacts enforce the frozen execution identity', { skip: !url, timeout: 180_000 }, async t => {
  const admin = new Pool({ connectionString: url, max: 1 })
  const database = `execution_identity_${randomUUID().replaceAll('-', '')}_e2e`
  await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`)
  const target = new URL(url!); target.pathname = `/${database}`
  const databaseUrl = target.toString()
  const pool = new Pool({ connectionString: databaseUrl, max: 5 })
  let appPool: Pool | undefined, workspacePool: Pool | undefined
  const previous = { MIKKA_DATABASE_URL: process.env.MIKKA_DATABASE_URL, DATABASE_URL: process.env.DATABASE_URL }
  Object.assign(process.env, { MIKKA_DATABASE_URL: databaseUrl, DATABASE_URL: databaseUrl })
  try {
    const directory = new URL('../drizzle/', import.meta.url)
    for (const migration of orderMigrations((await readdir(directory)).filter(name => name.endsWith('.sql')))) await pool.query(await readFile(new URL(migration, directory), 'utf8'))
    await pool.query(await readFile(new URL('20261103220200_execution_identity_provenance.sql', directory), 'utf8'))
    mock.module('next/server', { namedExports: { after() {} } })
    const { issueRunToken, verifyRunToken } = await import('./mcp/worker')
    const { apiKeyForRun } = await import('./model-api-keys')
    const { authorizeRunApp } = await import('./run-app-mcp')
    const { renewRunLeases } = await import('./run-leases')
    const { submitArtifact, readArtifact } = await import('./artifacts/store')
    appPool = (await import('./db')).pool; workspacePool = (await import('./workspace-db')).workspacePool
    const requester = 'requester', other = 'other', resourceOwner = 'resource-owner'
    for (const user of [requester, other, resourceOwner]) await pool.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,$1,$2,true,now(),now())', [user, `${user}@example.invalid`])
    const workspace = randomUUID(), bot = randomUUID(), device = randomUUID(), agent = randomUUID(), issue = randomUUID(), ownKey = randomUUID(), sharedKey = randomUUID(), runId = randomUUID()
    await pool.query('INSERT INTO mikka_workspaces(id,"userId",name) VALUES($1,$2,\'Identity fixture\')', [workspace, requester])
    for (const user of [requester, other, resourceOwner]) await pool.query('INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) VALUES($1,$2,$2,$3,\'member\',\'active\')', [workspace, user, `${user}@example.invalid`])
    await pool.query('INSERT INTO bots(id,"ownerId","workspaceId",name) VALUES($1,$2,$3,\'Identity fixture\')', [bot, requester, workspace])
    await pool.query('INSERT INTO devices(id,"ownerId",name) VALUES($1,$2,\'Identity fixture\')', [device, requester])
    await pool.query('INSERT INTO agents(id,"userId",name,harness,"deviceId") VALUES($1,$2,\'Identity fixture\',\'codex\',$3)', [agent, requester, device])
    await pool.query('INSERT INTO issues(id,"userId","workspaceId",title,content,status,priority) VALUES($1,$2,$3,\'Identity fixture\',\'{"type":"doc","content":[]}\',\'doing\',\'normal\')', [issue, requester, workspace])
    const env = { WORKSPACE_SECRETS_KEY: randomBytes(32).toString('hex') }
    for (const [id, owner] of [[ownKey, requester], [sharedKey, resourceOwner]]) {
      const sealed = sealSecret(`synthetic-${owner}-not-a-real-secret`, ['model_api_key', id, owner].join('\0'), env)
      await pool.query('INSERT INTO model_api_keys(id,"ownerId",provider,protocol,ciphertext,iv,"keyVersion",last4,models) VALUES($1,$2,\'openai\',\'openai\',$3,$4,$5,\'test\',\'["example-model"]\')', [id, owner, sealed.ciphertext, sealed.iv, sealed.keyVersion])
    }
    await pool.query('INSERT INTO model_api_key_shares("keyId","workspaceId") VALUES($1,$2)', [sharedKey, workspace])
    const definition = freezeWorkerDefinition({ harness: 'codex', instructions: '', prompt: 'Task', parent: null, executionId: null, model: 'example-model', apiKey: { keyId: sharedKey, model: 'example-model' } })
    definition.executionIdentity = await freezeExecutionIdentity(pool, { userId: requester, botId: bot, deviceId: device, agentDefinition: definition }, pool)
    await pool.query('INSERT INTO agent_runs(id,"userId","botId","deviceId","agentId","issueId",status,"agentDefinition") VALUES($1,$2,$3,$4,$5,$6,\'queued\',$7)', [runId, requester, bot, device, agent, issue, JSON.stringify(definition)])
    const claim = createExecutionClaim(pool, async () => true)
    const lease = () => new Date(Date.now() + 300_000).toISOString()
    const { token } = await issueRunToken({ id: runId, userId: requester })
    const auth = () => verifyRunToken(new Request('http://127.0.0.1/mikka/api/mcp'), token)
    const reset = () => pool.query('UPDATE agent_runs SET status=\'queued\',"stopRequestedAt"=NULL WHERE id=$1', [runId])

    await t.test('explicitly shared key charges its real owner, while Gmail and runtime retain the requester', async () => {
      assert.equal((await claim(requester, device, runId, lease())).length, 1)
      const credential = await apiKeyForRun(pool, runId, sharedKey, 'codex', env)
      assert.equal(credential.ownerId, resourceOwner)
      const verified = await auth(); assert.ok(verified)
      let appUser = ''
      const scope = await authorizeRunApp(verified, 'gmail', async user => { appUser = user; return ['gmail'] })
      assert.equal(scope?.userId, requester); assert.equal(appUser, requester)
      assert.equal(definition.executionIdentity!.billingAccount.model.ownerId, resourceOwner)
      assert.equal(definition.executionIdentity!.billingAccount.runtime.ownerId, requester)
      await assert.rejects(() => apiKeyForRun(pool, runId, ownKey, 'codex', env), /apiKeyNotFound/)
    })
    await t.test('share withdrawal blocks the next claim, token use and key read even without stop propagation', async () => {
      await reset(); await pool.query('DELETE FROM model_api_key_shares WHERE "keyId"=$1', [sharedKey])
      await assert.rejects(() => claim(requester, device, runId, lease()), ExecutionIdentityError)
      assert.equal(await auth(), undefined)
      await assert.rejects(() => apiKeyForRun(pool, runId, sharedKey, 'codex', env), /apiKeyNotFound/)
      assert.equal((await pool.query('SELECT status FROM agent_runs WHERE id=$1', [runId])).rows[0].status, 'queued')
      await pool.query('INSERT INTO model_api_key_shares("keyId","workspaceId") VALUES($1,$2)', [sharedKey, workspace])
    })
    for (const user of [requester, resourceOwner]) await t.test(`suspending ${user} blocks an existing tool token and dispatch`, async () => {
      await pool.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2', [workspace, user])
      assert.equal(await auth(), undefined)
      await assert.rejects(() => claim(requester, device, runId, lease()), ExecutionIdentityError)
      await pool.query('UPDATE mikka_workspace_members SET status=\'active\' WHERE "workspaceId"=$1 AND "userId"=$2', [workspace, user])
    })
    await t.test('changing the Bot owner or device owner cannot silently transfer a run', async () => {
      await pool.query('UPDATE bots SET "ownerId"=$2 WHERE id=$1', [bot, other]); assert.equal(await auth(), undefined)
      await pool.query('UPDATE bots SET "ownerId"=$2 WHERE id=$1', [bot, requester])
      await pool.query('UPDATE devices SET "ownerId"=$2 WHERE id=$1', [device, other]); assert.equal(await auth(), undefined)
      await pool.query('UPDATE devices SET "ownerId"=$2 WHERE id=$1', [device, requester])
    })
    await t.test('artifact versions retain provenance and remain private to their actual output owner', async () => {
      await claim(requester, device, runId, lease())
      const result = await submitArtifact({ userId: requester, runId, botId: bot, issueId: issue, authorName: 'Codex' }, { title: 'Private result', kind: 'markdown', content: 'Synthetic fixture' })
      assert.ok(!('error' in result)); if ('error' in result) return
      const { rows: [version] } = await pool.query('SELECT "executionIdentity" FROM artifact_versions WHERE "artifactId"=$1', [result.artifactId])
      assert.deepEqual(version.executionIdentity, definition.executionIdentity)
      assert.ok(await readArtifact(requester, result.artifactId))
      assert.equal(await readArtifact(other, result.artifactId), null)
      await assert.rejects(() => submitArtifact({ userId: other, runId, issueId: issue, authorName: 'Codex' }, { title: 'Wrong owner', kind: 'markdown', content: 'Synthetic' }), ExecutionIdentityError)
    })
    await t.test('revoking an in-flight resource cuts the lease and tells the daemon to remove credentials', async () => {
      assert.ok((await renewRunLeases(device, [runId])).leases[runId])
      await pool.query('DELETE FROM model_api_key_shares WHERE "keyId"=$1', [sharedKey])
      const renewed = await renewRunLeases(device, [runId])
      assert.deepEqual(renewed.revoked, [runId]); assert.deepEqual(renewed.leases, {})
      assert.ok((await pool.query('SELECT "stopRequestedAt" FROM agent_runs WHERE id=$1', [runId])).rows[0].stopRequestedAt)
      await pool.query('INSERT INTO model_api_key_shares("keyId","workspaceId") VALUES($1,$2)', [sharedKey, workspace])
      await reset(); await claim(requester, device, runId, lease())
    })
    await t.test('cloud quota continuation freezes parent placement, then rebinds to a new child with the same principal', async t => {
      const { queueCloudRun } = await import('./computer/queue-run')
      const { queueCloudQuotaContinuation } = await import('./run-quota')
      const { claimCloudRun } = await import('./computer/claim')
      const { revalidateExecutionIdentity } = await import('./execution-identity')
      const { fakeThreadMachines } = await import('../tests/support/thread-machine-fake')
      const cloudDevice = randomUUID(), cloudAgent = randomUUID(), cloudRepo = randomUUID(), cloudIssue = randomUUID(), connection = randomUUID(), binding = randomUUID()
      const harnesses = [{ harness: 'codex', installed: true, subscriptionBroker: true, toolApproval: true, models: ['gpt-5'] }]
      await pool.query('INSERT INTO devices(id,"ownerId",name,kind,harnesses) VALUES($1,$2,\'Parent cloud\',\'cloud\',$3)', [cloudDevice, requester, JSON.stringify(harnesses)])
      await pool.query('INSERT INTO agents(id,"userId",name,harness,"deviceId") VALUES($1,$2,\'Cloud quota fixture\',\'codex\',$3)', [cloudAgent, requester, cloudDevice])
      await pool.query('INSERT INTO device_repos(id,"userId","deviceId","repoPath","remoteUrl","baseBranch") VALUES($1,$2,$3,\'v2/github.com/example/identity-quota\',\'https://github.com/example/identity-quota.git\',\'main\')', [cloudRepo, requester, cloudDevice])
      await pool.query('INSERT INTO cloud_machines("workspaceId","ownerId","operationId","sandboxId","deviceId",state,"runtimeReady") VALUES($1,$2,$3,\'synthetic-parent\',$4,\'running\',true)', [workspace, requester, randomUUID(), cloudDevice])
      await pool.query('INSERT INTO bot_desktops("botId","workspaceId","ownerId",display) VALUES($1,$2,$3,1)', [bot, workspace, requester])
      await pool.query('INSERT INTO bot_cloud_runtimes("botId","workspaceId","ownerId",harness,"agentId","repoId") VALUES($1,$2,$3,\'codex\',$4,$5)', [bot, workspace, requester, cloudAgent, cloudRepo])
      await pool.query('INSERT INTO issues(id,"userId","workspaceId",title,content,status,priority) VALUES($1,$2,$3,\'Cloud quota\',\'{"type":"doc","attrs":{"mikka":{"number":1163}},"content":[]}\',\'doing\',\'normal\')', [cloudIssue, requester, workspace])
      await pool.query('INSERT INTO byos_connections(id,"ownerId","workspaceId",provider,state,epoch,"secretName","secretDigest","providerSubject","modelCatalog") VALUES($1,$2,$3,\'codex\',\'connected\',1,\'synthetic\',$4,\'synthetic\',$5)', [connection, requester, workspace, 'a'.repeat(64), JSON.stringify({ revision: '1', models: ['gpt-5'] })])
      await pool.query('INSERT INTO byos_bindings(id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision",route,"modelId") VALUES($1,$2,$3,$4,$5,1,\'codex_cli\',\'gpt-5\')', [binding, requester, workspace, cloudAgent, connection])
      await pool.query('UPDATE model_api_keys SET models=\'["gpt-5"]\' WHERE id=$1', [ownKey])
      // A person can explicitly choose company-paid compute for this one task.
      // Exercise the real queue and repository leases before the legacy E2B key exists.
      await t.test('sponsored selection, run ownership, expiry, stop and revocation', async () => {
        const { readSponsoredTaskGrant, withSponsoredTaskGrant } = await import('./cloud-computer/sponsored-task')
        const taskId = randomUUID(), eventId = randomUUID()
        const actor = { userId: requester, workspaceId: workspace }
        await pool.query(`INSERT INTO issues(id,"userId","workspaceId",title,content,status,priority)
          VALUES($1,$2,$3,'Sponsored fixture','{"type":"doc","content":[]}','doing','normal')`, [taskId, requester, workspace])
        await pool.query(`INSERT INTO coordinator_events(id,"userId","botId","issueId",kind,"dedupeKey",payload,"deliveredAt")
          VALUES($1,$2,$3,$4,'user_message',$5,'{"taskDestination":{"kind":"cloud","provider":"cloudflare"}}',now())`,
        [eventId, requester, bot, taskId, 'sponsored:'+eventId])
        const input = { botId: bot, issueId: taskId, agentId: cloudAgent, deviceRepoId: cloudRepo, sourceEventId: eventId,
          title: 'Sponsored task', body: '', model: 'gpt-5', subscriptionBindingId: binding }
        const oldCohort = process.env.MIKKA_CLOUDFLARE_TASK_WORKSPACES
        const oldToken = process.env.MIKKA_TASK_MACHINE_BRIDGE_TOKEN
        try {
          process.env.MIKKA_TASK_MACHINE_BRIDGE_TOKEN = 'synthetic-test-only'
          process.env.MIKKA_CLOUDFLARE_TASK_WORKSPACES = randomUUID()
          await assert.rejects(() => queueCloudRun(pool, actor, input))
          process.env.MIKKA_CLOUDFLARE_TASK_WORKSPACES = workspace
          const { runId: sponsored } = await queueCloudRun(pool, actor, input)
          const machines = await import('./cloud-computer/thread-machines')
          const originalOrigin = process.env.MIKKA_CLOUD_WORKER_URL
          try {
            process.env.MIKKA_CLOUD_WORKER_URL = 'http://untrusted.invalid'
            let calls = 0
            const provider = { create: async () => {calls++;throw Error('wrong provider')}, connect: async () => {calls++;throw Error('wrong provider')}, kill: async () => {calls++} }
            await assert.rejects(() => machines.ensureThreadMachine(pool, actor, sponsored, provider), /Cloudflare task machine unavailable/)
            assert.equal(calls, 0, 'a failed sponsored preflight never tries a personal E2B key')
          } finally {
            if(originalOrigin === undefined) delete process.env.MIKKA_CLOUD_WORKER_URL
            else process.env.MIKKA_CLOUD_WORKER_URL = originalOrigin
          }
          const op = randomUUID(), leaseId = randomUUID()
          await pool.query(`UPDATE thread_machines SET "operationId"=$2,"workerLeaseId"=$3,"workerLeaseUntil"=now()+interval '4 minutes' WHERE "runId"=$1`, [sponsored, op, leaseId])
          const admitted = await withSponsoredTaskGrant(pool, actor, sponsored, async g=>g)
          assert.equal(admitted.runId, sponsored)
          assert.equal(admitted.taskId, taskId)
          assert.equal(admitted.operationId, op)
          assert.equal(admitted.repositoryKey, 'v2/github.com/example/identity-quota')
          const { run } = await readSponsoredTaskGrant(pool, actor, sponsored)
          assert.equal(run.agentDefinition.executionIdentity?.billingAccount.runtime.kind, 'cloudflare_sponsored')
          assert.equal(run.agentDefinition.executionIdentity?.billingAccount.model.kind, 'subscription')
          for (const scope of [{ ...actor, userId: other }, { ...actor, workspaceId: randomUUID() }]) {
            await assert.rejects(() => readSponsoredTaskGrant(pool, scope, sponsored))
          }
          await assert.rejects(() => readSponsoredTaskGrant(pool, actor, randomUUID()))
          await pool.query(`UPDATE byos_connections SET paused=true WHERE id=$1`, [connection])
          await assert.rejects(() => withSponsoredTaskGrant(pool,actor,sponsored,async()=>assert.fail('revoked subscription reached provider')), ExecutionIdentityError)
          await pool.query(`UPDATE byos_connections SET paused=false WHERE id=$1`, [connection])
          await pool.query(`UPDATE coordinator_events SET "deliveredAt"=null WHERE id=$1`, [eventId])
          await assert.rejects(() => withSponsoredTaskGrant(pool,actor,sponsored,async()=>assert.fail('withdrawn event reached provider')), /unavailable/)
          await pool.query(`UPDATE coordinator_events SET "deliveredAt"=now() WHERE id=$1`, [eventId])
          await pool.query(`UPDATE thread_machines SET "workerLeaseUntil"=now()-interval '1 minute' WHERE "runId"=$1`, [sponsored])
          await assert.rejects(() => readSponsoredTaskGrant(pool, actor, sponsored))
          await pool.query(`UPDATE thread_machines SET "workerLeaseUntil"=now()+interval '1 minute' WHERE "runId"=$1`, [sponsored])
          await pool.query(`UPDATE agent_runs SET "stopRequestedAt"=now() WHERE id=$1`, [sponsored])
          await assert.rejects(() => readSponsoredTaskGrant(pool, actor, sponsored))
        } finally {
          if (oldCohort === undefined) delete process.env.MIKKA_CLOUDFLARE_TASK_WORKSPACES
          else process.env.MIKKA_CLOUDFLARE_TASK_WORKSPACES = oldCohort
          if (oldToken === undefined) delete process.env.MIKKA_TASK_MACHINE_BRIDGE_TOKEN
          else process.env.MIKKA_TASK_MACHINE_BRIDGE_TOKEN = oldToken
        }
      })
      await pool.query('INSERT INTO user_e2b_keys("userId",ciphertext,iv,"keyVersion",last4) VALUES($1,\'synthetic\',\'synthetic\',1,\'test\')', [requester])
      const machines = await fakeThreadMachines(pool, harnesses)
      try {
        const actor = { userId: requester, workspaceId: workspace }
        const source = await queueCloudRun(pool, actor, { botId: bot, issueId: cloudIssue, agentId: cloudAgent, deviceRepoId: cloudRepo, title: 'Cloud quota', body: '', model: 'gpt-5', subscriptionBindingId: binding })
        const scheduled = (await pool.query('SELECT "workspaceId","agentDefinition" FROM agent_runs WHERE id=$1', [source.runId])).rows[0]
        assert.equal(scheduled.workspaceId, workspace)
        assert.equal(scheduled.agentDefinition.subscription?.bindingId, binding)
        assert.equal(scheduled.agentDefinition.apiKey, undefined, 'the quota source starts on its subscribed model, before any API-key continuation')
        const originalChild = await machines.start(actor, source.runId)
        await pool.query('UPDATE agent_runs SET status=\'paused\',"pauseReason"=\'quota_exhausted\',"startedAt"=now(),"leaseExpiresAt"=NULL WHERE id=$1', [source.runId])
        const original = (await pool.query('SELECT * FROM agent_runs WHERE id=$1', [source.runId])).rows[0]
        assert.equal(original.agentDefinition.executionIdentity.resourceBindings[0].id, originalChild.deviceId)
        const nextId = await queueCloudQuotaContinuation(original, { workspaceId: workspace, botId: bot }, { keyId: ownKey, model: 'gpt-5' })
        const queued = (await pool.query('SELECT * FROM agent_runs WHERE id=$1', [nextId])).rows[0]
        assert.equal(queued.deviceId, cloudDevice)
        assert.equal(queued.agentDefinition.executionIdentity.resourceBindings[0].id, cloudDevice)
        assert.equal(queued.agentDefinition.repositoryAdmission.deviceId, cloudDevice)
        assert.equal(queued.agentDefinition.executionIdentity.billingAccount.model.resourceId, ownKey)
        await revalidateExecutionIdentity(pool, queued, pool)
        // An ended old sandbox makes the existing provider path create the next child.
        await pool.query('UPDATE agent_runs SET status=\'failed\',"finishedAt"=now() WHERE id=$1', [source.runId])
        await pool.query('UPDATE thread_machines SET state=\'ended\',"endedAt"=now() WHERE "runId"=$1', [source.runId])
        const nextChild = await machines.start(actor, nextId)
        assert.notEqual(nextChild.deviceId, originalChild.deviceId)
        const moved = (await pool.query('SELECT * FROM agent_runs WHERE id=$1', [nextId])).rows[0]
        assert.equal(moved.agentDefinition.executionIdentity.resourceBindings[0].id, nextChild.deviceId)
        assert.equal(moved.agentDefinition.executionIdentity.requester, requester)
        assert.equal(moved.agentDefinition.executionIdentity.outputOwner, requester)
        await revalidateExecutionIdentity(pool, moved, pool)
        await apiKeyForRun(pool, nextId, ownKey, 'codex', env)
        assert.ok(await claimCloudRun(pool, actor, nextId, nextChild.deviceId, new Date(lease()), null, undefined, undefined, false))
      } finally { machines.restore() }
    })
    await t.test('preexisting runs keep the legacy own-resource path without fabricated history', async () => {
      await pool.query('UPDATE agent_runs SET "agentDefinition"=NULL WHERE id=$1', [runId])
      assert.ok(await auth())
      await assert.rejects(() => apiKeyForRun(pool, runId, sharedKey, 'codex', env), /apiKeyNotFound/)
      assert.equal((await apiKeyForRun(pool, runId, ownKey, 'codex', env)).ownerId, requester)
    })
  } finally {
    mock.restoreAll()
    for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value }
    await dropTestDatabase(admin, database, pool, appPool, workspacePool)
    await admin.end()
  }
})
