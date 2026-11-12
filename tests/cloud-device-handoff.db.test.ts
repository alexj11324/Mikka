import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'
import { mock, test } from 'node:test'
import { Pool } from 'pg'
import { observePoolCommits } from '../lib/db/commit-effects'
import { orderMigrations } from '../scripts/migration-order.mjs'
import { isE2eTarget, E2E_DB_RULE } from './helpers/e2e-target.mjs'
import { dropTestDatabase } from './support/drop-test-database'
import { fakeThreadMachines } from './support/thread-machine-fake'
import { sealSecret, userE2bKeyAad } from '../lib/secrets/crypto'
import { seedRunProjectResources } from './helpers/run-project-resources'

const url = process.env.E2E_DATABASE_URL
if (url) assert.ok(isE2eTarget(url), E2E_DB_RULE)
else if (process.env.REQUIRE_DB === '1') assert.fail('REQUIRE_DB=1 needs an isolated E2E_DATABASE_URL')

test('admitted Cloud tasks park their real binding before normal local recovery', { skip: !url, timeout: 180_000 }, async t => {
  const admin = new Pool({ connectionString: url, max: 1 })
  const database = `cloud_handoff_${randomUUID().replaceAll('-', '')}_e2e`
  await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`)
  const target = new URL(url!); target.pathname = `/${database}`
  const pool = new Pool({ connectionString: target.toString(), max: 8 })
  observePoolCommits(pool)
  let appPool: Pool | undefined, workspacePool: Pool | undefined
  let machines: Awaited<ReturnType<typeof fakeThreadMachines>> | undefined
  const scoped = { MIKKA_DATABASE_URL: target.toString(), DATABASE_URL: target.toString(),
    MIKKA_DATABASE_URL_UNPOOLED: target.toString(), DATABASE_URL_UNPOOLED: target.toString(), WORKSPACE_SECRETS_KEY: randomBytes(32).toString('hex') }
  const previous = Object.fromEntries(Object.keys(scoped).map(name => [name, process.env[name]]))
  Object.assign(process.env, scoped)
  try {
    const directory = new URL('../drizzle/', import.meta.url)
    for (const migration of orderMigrations((await readdir(directory)).filter(name => name.endsWith('.sql')))) await pool.query(await readFile(new URL(migration, directory), 'utf8'))
    const next = await import('next/server')
    mock.module('next/server', { namedExports: { ...next, after() {} } })
    const workflow = await import('workflow/api')
    let cloudWorkflows = 0
    mock.module('workflow/api', { namedExports: { ...workflow, start: async () => { cloudWorkflows++; return { runId: 'synthetic-workflow' } } } })
    const { queueFactoryCloudRun } = await import('../lib/factory/queue-cloud')
    const { createExecutionClaim } = await import('../lib/factory/execution-claim')
    const { issueRunToken, verifyRunToken } = await import('../lib/mcp/worker')
    const { apiKeyForRun } = await import('../lib/model-api-keys')
    appPool = (await import('../lib/db')).pool; workspacePool = (await import('../lib/workspace-db')).workspacePool
    const harnesses = [{ harness: 'codex', installed: true, toolApproval: true, subscriptionBroker: true, modelSlots: [{ slot: 'gpt-5', model: 'gpt-5', name: 'gpt-5' }] }]
    machines = await fakeThreadMachines(pool, harnesses)
    const actual = await import('../lib/cloud-computer/thread-machines')
    let pause: (id: string) => Promise<void> = async () => { throw new Error('Unexpected provider pause') }
    // Only the provider pause/log IO is controlled. Real machine locks, SQL,
    // revocation, normal admission, Factory adoption and claim remain active.
    mock.module('../lib/cloud-computer/thread-machines.ts', { namedExports: { ...actual,
      parkThreadMachine: (db: Parameters<typeof actual.parkThreadMachine>[0], actor: Parameters<typeof actual.parkThreadMachine>[1], runId: string, _pause: unknown, _tail: unknown, existing?: import('pg').PoolClient) =>
        actual.parkThreadMachine(db, actor, runId, id => pause(id), async () => null, existing),
    } })
    const { reclaimLostRuns, latestCheckpoint } = await import('../lib/run-leases')

    async function fixture(destination?: 'cloud', automatic = true, projectResources = false) {
      const id = randomUUID(), userId = `cloud-handoff-${id}`, workspaceId = randomUUID(), botId = randomUUID(), issueId = randomUUID()
      const parentDevice = randomUUID(), agentId = randomUUID(), repoId = randomUUID(), keyId = randomUUID(), deviceB = randomUUID(), agentB = randomUUID()
      const remoteKey = `v2/github.com/mikka-ci/cloud-handoff-${id}`, remoteUrl = `https://github.com/mikka-ci/cloud-handoff-${id}.git`
      await pool.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$1,$2,true,now(),now())', [userId, `${userId}@example.invalid`])
      await pool.query('INSERT INTO issue_prefixes("userId",prefix) VALUES($1,\'CHOF\')', [userId])
      await pool.query('INSERT INTO mikka_workspaces(id,"userId",name,kind) VALUES($1,$2,\'Cloud handoff fixture\',\'team\')', [workspaceId, userId])
      await pool.query('INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) VALUES($1,$2,$2,$3,\'admin\',\'active\')', [workspaceId, userId, `${userId}@example.invalid`])
      await pool.query('INSERT INTO bots(id,"ownerId","workspaceId",name) VALUES($1,$2,$3,\'Cloud handoff Bot\')', [botId, userId, workspaceId])
      for (const [device, agent, kind] of [[parentDevice, agentId, 'cloud'], [deviceB, agentB, 'local']]) {
        await pool.query('INSERT INTO devices(id,"ownerId",name,kind,enabled,harnesses,"protocolVersion","lastSeenAt") VALUES($1,$2,$3,$4,true,$5,3,now())', [device, userId, kind, kind, JSON.stringify(harnesses)])
        await pool.query('INSERT INTO agents(id,"userId","deviceId",harness,name) VALUES($1,$2,$3,\'codex\',$4)', [agent, userId, device, kind])
      }
      await pool.query('INSERT INTO device_repos(id,"userId","deviceId","repoPath","remoteUrl","baseBranch") VALUES($1,$2,$3,$4,$5,\'main\')', [repoId, userId, parentDevice, remoteKey, remoteUrl])
      await pool.query('INSERT INTO cloud_machines("workspaceId","ownerId","operationId","sandboxId","deviceId",state,"runtimeReady") VALUES($1,$2,$3,$4,$5,\'running\',true)', [workspaceId, userId, randomUUID(), `synthetic-parent-${id}`, parentDevice])
      await pool.query('INSERT INTO bot_desktops("botId","workspaceId","ownerId",display) VALUES($1,$2,$3,1)', [botId, workspaceId, userId])
      await pool.query('INSERT INTO bot_cloud_runtimes ("botId","ownerId","workspaceId",harness,"agentId","repoId") VALUES ($1,$2,$3,\'codex\',$4,$5)', [botId, userId, workspaceId, agentId, repoId])
      const e2b = sealSecret('synthetic-provider-fixture', userE2bKeyAad(userId))
      await pool.query('INSERT INTO user_e2b_keys("userId",ciphertext,iv,"keyVersion",last4) VALUES($1,$2,$3,$4,\'test\')', [userId, e2b.ciphertext, e2b.iv, e2b.keyVersion])
      const key = sealSecret('synthetic-model-fixture', ['model_api_key', keyId, userId].join('\0'))
      await pool.query('INSERT INTO model_api_keys(id,"ownerId",provider,protocol,ciphertext,iv,"keyVersion",last4,models) VALUES($1,$2,\'openai\',\'openai\',$3,$4,$5,\'test\',\'["gpt-5"]\')', [keyId, userId, key.ciphertext, key.iv, key.keyVersion])
      await pool.query('INSERT INTO issues(id,"userId","workspaceId","ownershipState",title,content,status,priority,scope) VALUES($1,$2,$3,\'bound\',\'Cloud handoff task\',\'{"type":"doc","attrs":{"mikka":{"number":1}},"content":[]}\',\'todo\',\'normal\',\'workspace\')', [issueId, userId, workspaceId])
      const resources = projectResources ? await seedRunProjectResources(pool, { ownerId: userId, workspaceId, issueId,
        repositoryKey: remoteKey, runtime: 'cloud', harness: 'codex' }) : undefined
      const sourceEventId = randomUUID()
      await pool.query('INSERT INTO coordinator_events(id,"userId","botId","issueId",kind,"dedupeKey",payload,"deliveredAt") VALUES($1::uuid,$2,$3,$4,\'user_message\',$1::text,$5,now())', [sourceEventId, userId, botId, issueId,
        JSON.stringify({ text: 'Keep the current goal and receipts.', ...(destination ? { taskDestination: { kind: destination } } : {}) })])
      const actor = { userId, workspaceId }
      const { runId } = await queueFactoryCloudRun(pool, actor, { botId, issueId, agentId, deviceRepoId: repoId, sourceEventId, ...(automatic ? { allowLocalRecovery: true } : {}), title: 'Cloud handoff task', body: 'Keep the current goal and receipts.', model: 'gpt-5', apiKey: { keyId, model: 'gpt-5' }, idempotencyKey: randomUUID() })
      const physical = await machines!.start(actor, runId)
      const now = new Date()
      await pool.query('UPDATE agent_runs SET status=\'running\',"startedAt"=$2,"leaseExpiresAt"=$3,"sessionId"=\'cloud-native-session\' WHERE id=$1', [runId, new Date(now.getTime() - 180_000), new Date(now.getTime() - 1_000)])
      await pool.query('UPDATE devices SET "lastSeenAt"=$2 WHERE id=$1', [physical.deviceId, new Date(now.getTime() - 120_000)])
      await pool.query('INSERT INTO run_checkpoints("runId","baseCommit",patch,files,"updatedAt","userId","takenAt") VALUES($1,$2,$3,1,$4,$5,$4)', [runId, 'a'.repeat(40), gzipSync('diff --git a/current.txt b/current.txt\n'), now, userId])
      const source = (await pool.query('SELECT * FROM agent_runs WHERE id=$1', [runId])).rows[0]
      const task = (await pool.query('SELECT t.* FROM factory_tasks t JOIN factory_attempts a ON a."taskId"=t.id WHERE a."runId"=$1', [runId])).rows[0]
      const machine = (await pool.query('SELECT * FROM thread_machines WHERE "runId"=$1', [runId])).rows[0]
      const { token } = await issueRunToken({ id: runId, userId })
      assert.equal(source.agentDefinition.repositoryAdmission.deviceId, physical.deviceId, 'normal cloud provisioning relocated the admitted receipt')
      assert.notEqual(physical.deviceId, parentDevice)
      return { userId, workspaceId, botId, issueId, runId, deviceB, agentB, keyId, agentId, repoId, source, task, machine, now, token, resources, remoteKey }
    }

    for (const mutation of ['repository', 'environment-revision', 'environment-archive', 'project-archive', 'legacy-environment', 'legacy-branch'] as const)
      await t.test(`lost cloud Run refuses ${mutation} before a child or any VM handoff`, async () => {
        const legacy = mutation.startsWith('legacy-')
        const f = await fixture(undefined, true, !legacy)
        let resources = f.resources
        if (legacy) {
          const definition = structuredClone(f.source.agentDefinition)
          delete definition.projectExecution
          const { workerDefinitionDigest } = await import('../lib/agent-kit/worker-digest')
          definition.definitionDigest = workerDefinitionDigest(definition)
          await pool.query('UPDATE agent_runs SET "agentDefinition"=$2 WHERE id=$1', [f.runId, JSON.stringify(definition)])
          resources = await seedRunProjectResources(pool, { ownerId: f.userId, workspaceId: f.workspaceId, issueId: f.issueId,
            repositoryKey: f.remoteKey, runtime: 'cloud', harness: 'codex', environment: mutation !== 'legacy-branch' })
        }
        if (mutation === 'legacy-branch') await resources!.refuse('branch')
        else if (mutation !== 'legacy-environment') await resources!.refuse(mutation)
        const before = (await pool.query('SELECT "agentDefinition",report,"sessionId" FROM agent_runs WHERE id=$1', [f.runId])).rows[0]
        const checkpoint = await latestCheckpoint(f.runId), beforeWorkflows = cloudWorkflows
        let pauses = 0
        pause = async () => { pauses++ }
        await reclaimLostRuns(f.userId, f.now)
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_runs WHERE "retryOf"=$1', [f.runId])).rows[0].n, 0)
        assert.equal(pauses, 0); assert.equal(cloudWorkflows, beforeWorkflows)
        assert.deepEqual((await pool.query('SELECT * FROM thread_machines WHERE "runId"=$1', [f.runId])).rows[0], f.machine)
        assert.deepEqual((await pool.query('SELECT "agentDefinition",report,"sessionId" FROM agent_runs WHERE id=$1', [f.runId])).rows[0], before)
        assert.deepEqual(await latestCheckpoint(f.runId), checkpoint)
        assert.equal((await pool.query('SELECT status FROM agent_runs WHERE id=$1', [f.runId])).rows[0].status, 'failed',
          'the expired source may record its legal terminal fact without authorizing another execution')
      })

    await t.test('Cloud→B confirms one provider pause before exposing one fresh local receipt, then adopts the same current epoch', async () => {
      const f = await fixture()
      assert.equal(f.source.agentDefinition.allowLocalRecovery, true)
      const beforeWorkflows = cloudWorkflows
      let pauses = 0
      pause = async id => {
        assert.equal(id, f.machine.sandboxId); pauses++
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_runs WHERE "retryOf"=$1', [f.runId])).rows[0].n, 0, 'B cannot claim before the provider confirms the cloud is paused')
      }
      await Promise.all(Array.from({ length: 3 }, () => reclaimLostRuns(f.userId, f.now)))
      const children = (await pool.query('SELECT * FROM agent_runs WHERE "retryOf"=$1', [f.runId])).rows
      assert.equal(children.length, 1)
      const child = children[0]
      assert.equal(child.deviceId, f.deviceB, 'the actual source must be handed to local B, not another cloud child')
      assert.equal(child.agentId, f.agentB)
      assert.equal(child.attempt, 2)
      assert.equal(pauses, 1)
      assert.equal(cloudWorkflows, beforeWorkflows)
      assert.equal(child.agentDefinition.repositoryAdmission.deviceId, f.deviceB)
      assert.equal(child.agentDefinition.repositoryAdmission.agentId, f.agentB)
      assert.equal(child.agentDefinition.repositoryAdmission.targetBranch, f.source.agentDefinition.repositoryAdmission.targetBranch)
      assert.deepEqual(child.agentDefinition.executionIdentity.billingAccount.model, f.source.agentDefinition.executionIdentity.billingAccount.model)
      assert.equal(child.agentDefinition.executionIdentity.billingAccount.runtime.ownerId, f.userId)
      assert.equal(child.agentDefinition.executionIdentity.billingAccount.runtime.kind, 'local_device')
      assert.equal(child.agentDefinition.executionIdentity.outputOwner, f.userId)
      assert.equal(child.agentDefinition.definitionDigest, f.source.agentDefinition.definitionDigest)
      assert.equal(child.sessionId, null, 'a native session is not transferred across machines')
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM computer_run_bindings WHERE "runId"=$1', [child.id])).rows[0].n, 0)
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM thread_machines WHERE "runId"=$1', [child.id])).rows[0].n, 0)
      assert.equal((await pool.query('SELECT state FROM thread_machines WHERE "runId"=$1', [f.runId])).rows[0].state, 'paused')
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM device_tokens WHERE "boundDeviceId"=$1 AND "revokedAt" IS NULL', [f.source.deviceId])).rows[0].n, 0)
      assert.equal(await verifyRunToken(new Request('http://127.0.0.1/mikka/api/mcp'), f.token), undefined)
      const current = (await pool.query('SELECT t.*,a."runId",a.output FROM factory_tasks t JOIN factory_attempts a ON a.id=t."attemptId" WHERE t.id=$1', [f.task.id])).rows[0]
      assert.equal(current.runId, child.id)
      assert.equal(current.sourceEventId, f.task.sourceEventId)
      assert.equal(current.output.requestEpoch, f.task.sourceEventId)
      assert.match(child.prompt, /Host task handoff/)
      assert.ok(child.prompt.includes(f.task.sourceEventId))
      assert.equal((await latestCheckpoint(child.retryOf))?.baseCommit, 'a'.repeat(40))
      assert.equal((await apiKeyForRun(pool, child.id, f.keyId, 'codex')).ownerId, f.userId)
      const claim = createExecutionClaim(pool, async () => true)
      assert.equal((await claim(f.userId, f.deviceB, child.id, new Date(Date.now() + 90_000).toISOString())).length, 1)
      await reclaimLostRuns(f.userId, f.now)
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_runs WHERE "retryOf"=$1', [f.runId])).rows[0].n, 1)
      assert.equal(pauses, 1)
    })

    await t.test('a refused provider pause commits no local child and blocks the current Task without repeated attempts', async () => {
      const f = await fixture()
      let pauses = 0
      pause = async () => { pauses++; throw new Error('503 synthetic provider pause refused') }
      await reclaimLostRuns(f.userId, f.now)
      assert.equal(pauses, 1)
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_runs WHERE "retryOf"=$1', [f.runId])).rows[0].n, 0)
      assert.equal((await pool.query('SELECT state FROM thread_machines WHERE "runId"=$1', [f.runId])).rows[0].state, 'running', 'failed provider IO is not recorded as a successful park')
      const current = (await pool.query('SELECT status FROM factory_tasks WHERE id=$1', [f.task.id])).rows[0]
      assert.equal(current.status, 'blocked')
      await reclaimLostRuns(f.userId, f.now)
      assert.equal(pauses, 1)
    })

    for (const mutation of ['missing', 'ended', 'wrong-device'] as const) await t.test(`an unproven ${mutation} cloud machine cannot bypass the stop boundary`, async () => {
      const f = await fixture()
      let pauses = 0
      pause = async () => { pauses++ }
      if (mutation === 'missing') await pool.query('DELETE FROM thread_machines WHERE "runId"=$1', [f.runId])
      else if (mutation === 'ended') await pool.query('UPDATE thread_machines SET state=\'ended\',"endedAt"=now() WHERE "runId"=$1', [f.runId])
      else await pool.query('UPDATE thread_machines SET "deviceId"=$2 WHERE "runId"=$1', [f.runId, f.deviceB])
      await reclaimLostRuns(f.userId, f.now)
      assert.equal(pauses, 0)
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_runs WHERE "retryOf"=$1', [f.runId])).rows[0].n, 0)
      assert.equal((await pool.query('SELECT status FROM factory_tasks WHERE id=$1', [f.task.id])).rows[0].status, 'blocked')
    })
    for (const mode of ['explicit', 'legacy'] as const) await t.test(`${mode} Cloud placement keeps the existing cloud retry without acquiring a local recovery grant`, async () => {
      const f = await fixture(mode === 'explicit' ? 'cloud' : undefined, mode !== 'legacy')
      assert.equal(f.source.agentDefinition.allowLocalRecovery, undefined)
      let pauses = 0
      pause = async () => { pauses++ }
      await reclaimLostRuns(f.userId, f.now)
      assert.equal(pauses, 0, 'the provider is not changed for a forbidden destination')
      const children = (await pool.query('SELECT r.*,d.kind AS "deviceKind" FROM agent_runs r JOIN devices d ON d.id=r."deviceId" WHERE r."retryOf"=$1', [f.runId])).rows
      assert.equal(children.length, 1)
      assert.notEqual(children[0].deviceId, f.deviceB)
      assert.equal(children[0].deviceKind, 'cloud')
      assert.equal(children[0].agentDefinition.allowLocalRecovery, undefined)
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM computer_run_bindings WHERE "runId"=$1', [children[0].id])).rows[0].n, 1)
      if (mode === 'explicit') assert.deepEqual((await pool.query('SELECT payload->\'taskDestination\' AS destination FROM coordinator_events WHERE id=$1', [f.task.sourceEventId])).rows[0].destination, { kind: 'cloud' })
    })

    await t.test('a replacement cloud generation created while selection waits is never paused by that stale recovery pass', async () => {
      const f = await fixture()
      let pauses = 0
      pause = async () => { pauses++ }
      const held = await pool.connect()
      let recovery: Promise<void> | undefined
      try {
        await held.query('BEGIN')
        await held.query('SELECT id FROM factory_tasks WHERE id=$1 FOR UPDATE', [f.task.id])
        recovery = reclaimLostRuns(f.userId, f.now)
        const deadline = Date.now() + 5_000
        while (!(await pool.query(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%factory_tasks%' AND pid<>pg_backend_pid()`)).rowCount) {
          assert.ok(Date.now() < deadline, 'recovery must reach the current Task lock')
          await new Promise(resolve => setTimeout(resolve, 10))
        }
        await held.query('UPDATE thread_machines SET "operationId"=$2,"sandboxId"=$3 WHERE "runId"=$1', [f.runId, randomUUID(), `replacement-${randomUUID()}`])
        await held.query('COMMIT')
      } finally { await held.query('ROLLBACK'); held.release(); await recovery }
      assert.equal(pauses, 0)
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_runs WHERE "retryOf"=$1', [f.runId])).rows[0].n, 0)
      assert.equal((await pool.query('SELECT status FROM agent_runs WHERE id=$1', [f.runId])).rows[0].status, 'running')
      assert.equal((await pool.query('SELECT state FROM thread_machines WHERE "runId"=$1', [f.runId])).rows[0].state, 'running')
    })

    for (const explicitCloud of [false, true]) await t.test(`a real owner continuation ${explicitCloud ? 'revokes' : 'preserves'} automatic recovery on its new request epoch`, async () => {
      const f = await fixture()
      await pool.query('UPDATE agent_runs SET status=\'succeeded\',"finishedAt"=now(),"leaseExpiresAt"=NULL WHERE id=$1', [f.runId])
      const sourceEventId = randomUUID()
      await pool.query('INSERT INTO coordinator_events(id,"userId","botId","issueId",kind,"dedupeKey",payload,"deliveredAt") VALUES($1::uuid,$2,$3,$4,\'user_message\',$1::text,$5,now())', [sourceEventId, f.userId, f.botId, f.issueId,
        JSON.stringify({ text: 'Continue under the latest owner request.', source: 'thread_continuation', previousRunId: f.runId, ...(explicitCloud ? { taskDestination: { kind: 'cloud' } } : {}) })])
      const input = { botId: f.botId, issueId: f.issueId, agentId: f.agentId, deviceRepoId: f.repoId, sourceEventId, threadRunId: f.runId, allowLocalRecovery: true as const,
        title: 'Cloud handoff task', body: 'Continue under the latest owner request.', model: 'gpt-5', apiKey: { keyId: f.keyId, model: 'gpt-5' }, idempotencyKey: randomUUID() }
      const actor = { userId: f.userId, workspaceId: f.workspaceId }
      const continued = await queueFactoryCloudRun(pool, actor, input)
      const next = (await pool.query('SELECT * FROM agent_runs WHERE id=$1', [continued.runId])).rows[0]
      assert.equal(next.agentDefinition.allowLocalRecovery, explicitCloud ? undefined : true)
      assert.deepEqual(next.agentDefinition.executionIdentity.billingAccount.model, f.source.agentDefinition.executionIdentity.billingAccount.model)
      const current = (await pool.query('SELECT t.id,t."sourceEventId",a.output FROM factory_tasks t JOIN factory_attempts a ON a.id=t."attemptId" WHERE t.id=$1', [f.task.id])).rows[0]
      assert.equal(current.sourceEventId, sourceEventId)
      assert.equal(current.output.requestEpoch, sourceEventId)
      assert.equal((await queueFactoryCloudRun(pool, actor, input)).runId, continued.runId)
      await assert.rejects(queueFactoryCloudRun(pool, actor, { ...input, allowLocalRecovery: undefined }), /factoryReplayMismatch/)
      assert.equal((await pool.query('SELECT "agentDefinition"->\'allowLocalRecovery\' AS permission FROM agent_runs WHERE id=$1', [f.runId])).rows[0].permission, true, 'the historical source snapshot stays immutable')
    })
  } finally {
    machines?.restore(); mock.restoreAll()
    await (await import('../lib/builtin-gateway/runtime')).builtinGateway()?.stop()
    for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value }
    await dropTestDatabase(admin, database, pool, appPool, workspacePool)
    await admin.end()
  }
})
