// Real PostgreSQL, preference selection, cloud queue, provider completion and
// task-machine admission. Only model catalogue IO, E2B provisioning and the
// external lifecycle launch are fixtures. No paid provider or cloud is called;
// worker snapshots are created by the ordinary queue and never edited here.
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mock, test } from 'node:test'
import { emptyRunReport } from '@mikka/protocol/run'
import { normalizeRepository } from '@mikka/protocol/repository'
import type { OrderEntry } from '../lib/model-order-plan'
import { dbUrl, seedBot, seedIssue, seedProjectTasks, seedUser, seedWorkspace } from './support/workspace-admin-db'
import { fakeThreadMachines } from './support/thread-machine-fake'

test('cloud provider recovery preserves scope and uses fresh task machines without waking its parent', { skip: !dbUrl }, async t => {
  const names = ['WORKSPACE_SECRETS_KEY', 'MIKKA_BYOS_ENABLED', 'MIKKA_CLOUD_COMPUTER_TASKS', 'MIKKA_FACTORY_ROUTING_ENABLED', 'MIKKA_FACTORY_LIFECYCLE_ENABLED', 'NEXT_PUBLIC_POSTHOG_KEY'] as const
  const saved = new Map(names.map(name => [name, process.env[name]]))
  process.env.WORKSPACE_SECRETS_KEY = randomBytes(32).toString('hex')
  process.env.MIKKA_BYOS_ENABLED = '1'
  process.env.MIKKA_CLOUD_COMPUTER_TASKS = '1'
  process.env.MIKKA_FACTORY_ROUTING_ENABLED = '0'
  process.env.MIKKA_FACTORY_LIFECYCLE_ENABLED = '0'
  delete process.env.NEXT_PUBLIC_POSTHOG_KEY
  let networkAttempts = 0
  t.mock.method(globalThis, 'fetch', async () => { networkAttempts++; throw new Error('Unexpected network request in cloud provider fixture') })
  const next = await import('next/server')
  mock.module('next/server', { namedExports: { NextRequest: next.NextRequest, NextResponse: next.NextResponse, after: () => {} } })
  const lifecycleStarts: { actor: { userId: string; workspaceId: string }; previousRunId: string | null; runId: string; providerContinuation: boolean }[] = []
  mock.module('workflow/api', { namedExports: { start: async (_workflow: unknown, args: [{ userId: string; workspaceId: string }, string | null, string, boolean]) => {
    lifecycleStarts.push({ actor: args[0], previousRunId: args[1], runId: args[2], providerContinuation: args[3] })
    return { runId: 'synthetic-lifecycle' }
  } } })

  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: dbUrl, max: 4 })
  const { pool: appPool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  const workers = ['claude_code', 'codex'].map(harness => ({ harness, installed: true, subscriptionBroker: true, toolApproval: true }))
  const machines = await fakeThreadMachines(pool, workers)
  const { threadMachineProvider, ensureThreadMachine, threadMachineAction } = await import('../lib/cloud-computer/thread-machines')
  const { botRuntimeProvisioner, ensureBotCloudRuntime } = await import('../lib/computer/auto-runtime')
  const { chooseCloudRunModel } = await import('../lib/computer/run-model')
  const { queueCloudRun } = await import('../lib/computer/queue-run')
  const { ensureDeviceRepository } = await import('../lib/device-repositories')
  const { persistRunCompletion } = await import('../lib/run-publications')
  const { providerContinuationMatches, recoverProviderFailure, launchProviderContinuation } = await import('../lib/run-provider-fallback')
  const { handoffFactoryCloudStage } = await import('../lib/factory/cloud-stage-handoff')
  const { factoryAutomaticRuntime } = await import('../lib/factory/automatic-dispatch')
  const { withDeviceDatabaseAuthority, DeviceAuthorityRevoked } = await import('../lib/db/device-scope')
  const { resolveModelDispatch } = await import('../lib/model-dispatch')
  const { setE2BKey } = await import('../lib/secrets/e2b')
  const keys = await import('../lib/model-api-keys')
  const order = await import('../lib/model-order')
  const { entryKey } = await import('../lib/model-order-plan')
  const resources = await import('../lib/project-resources/store')
  const users: string[] = [], workspaces: string[] = []
  const provisions = new Map<string, number>()
  const realProvision = botRuntimeProvisioner.provision
  type Placement = { userId: string; botId: string; issueId: string; agentId: string; deviceId: string; deviceRepoId: string }
  const launchPlacements = new Map<string, Placement>()
  const createFixtureMachine = threadMachineProvider.create
  // Observe the committed queue at the existing E2B creation boundary, before
  // ensureThreadMachine relocates it to its dedicated task device.
  threadMachineProvider.create = async (template, operationId, metadata, ownerId) => {
    const { rows: [placement] } = await pool.query<Placement>('SELECT "userId","botId","issueId","agentId","deviceId","deviceRepoId" FROM agent_runs WHERE id=$1 AND "userId"=$2', [metadata.runId, ownerId])
    assert.ok(placement)
    launchPlacements.set(metadata.runId, placement)
    return createFixtureMachine(template, operationId, metadata, ownerId)
  }
  // Registration is the real metadata-only implementation. Count calls so a
  // sleeping parent cannot silently trigger another registration or wake.
  botRuntimeProvisioner.provision = async (database, actor, botId) => {
    provisions.set(botId, (provisions.get(botId) ?? 0) + 1)
    await realProvision(database, actor, botId)
  }
  t.after(async () => {
    botRuntimeProvisioner.provision = realProvision
    machines.restore()
    try {
      await pool.query('DELETE FROM coordinator_events WHERE "userId"=ANY($1)', [users])
      await pool.query('DELETE FROM thread_machines WHERE "ownerId"=ANY($1)', [users])
      await pool.query('DELETE FROM computer_run_bindings WHERE "ownerId"=ANY($1)', [users])
      await pool.query('DELETE FROM run_publications WHERE "userId"=ANY($1)', [users])
      await pool.query('UPDATE agent_runs SET "retryOf"=NULL WHERE "userId"=ANY($1)', [users])
      await pool.query('DELETE FROM agent_runs WHERE "userId"=ANY($1)', [users])
      await pool.query('DELETE FROM model_order_entries WHERE "ownerId"=ANY($1)', [users])
      await pool.query('DELETE FROM model_order_settings WHERE "ownerId"=ANY($1)', [users])
      await pool.query('DELETE FROM model_api_keys WHERE "ownerId"=ANY($1)', [users])
      await pool.query('DELETE FROM bot_cloud_runtimes WHERE "ownerId"=ANY($1)', [users])
      await pool.query('DELETE FROM bot_desktops WHERE "ownerId"=ANY($1)', [users])
      await pool.query('DELETE FROM cloud_machines WHERE "ownerId"=ANY($1)', [users])
      await pool.query('DELETE FROM device_tokens WHERE "userId"=ANY($1)', [users])
      await pool.query('DELETE FROM agents WHERE "userId"=ANY($1)', [users])
      await pool.query('DELETE FROM device_repos WHERE "userId"=ANY($1)', [users])
      await pool.query('DELETE FROM devices WHERE "ownerId"=ANY($1)', [users])
      await pool.query('DELETE FROM issues WHERE "userId"=ANY($1)', [users])
      await pool.query('DELETE FROM bots WHERE "ownerId"=ANY($1)', [users])
      await pool.query('DELETE FROM user_e2b_keys WHERE "userId"=ANY($1)', [users])
      await workspacePool.query('DELETE FROM workspace_project_repositories WHERE "workspaceId"=ANY($1)', [workspaces])
      await workspacePool.query('DELETE FROM workspace_projects WHERE "workspaceId"=ANY($1)', [workspaces])
      await workspacePool.query('DELETE FROM workspace_environments WHERE "workspaceId"=ANY($1)', [workspaces])
      await pool.query('DELETE FROM mikka_workspace_members WHERE "workspaceId"=ANY($1)', [workspaces])
      await pool.query('DELETE FROM mikka_workspaces WHERE id=ANY($1)', [workspaces])
      await pool.query('DELETE FROM "user" WHERE id=ANY($1)', [users])
    } finally {
      for (const name of names) { const value = saved.get(name); if (value === undefined) delete process.env[name]; else process.env[name] = value }
      await Promise.all([pool.end(), appPool.end(), workspacePool.end()])
    }
  })

  const runtime = async (botId: string, harness: string) => (await pool.query<{ agentId: string; deviceId: string; repoId: string }>(`
    SELECT rt."agentId",a."deviceId",rt."repoId" FROM bot_cloud_runtimes rt JOIN agents a ON a.id=rt."agentId"
    WHERE rt."botId"=$1 AND rt.harness=$2`, [botId, harness])).rows[0]
  const parentSnapshot = async (actor: { userId: string; workspaceId: string }) => (await pool.query(
    'SELECT to_jsonb(m) AS machine,to_jsonb(d) AS device FROM cloud_machines m JOIN devices d ON d.id=m."deviceId" WHERE m."ownerId"=$1 AND m."workspaceId"=$2',
    [actor.userId, actor.workspaceId])).rows[0]
  const row = async (runId: string) => (await pool.query('SELECT * FROM agent_runs WHERE id=$1', [runId])).rows[0]
  const children = async (runId: string) => (await pool.query('SELECT * FROM agent_runs WHERE "retryOf"=$1', [runId])).rows
  const fixture = async (label: string, withEnvironment = false) => {
    const userId = await seedUser(pool, label)
    users.push(userId)
    const workspace = await seedWorkspace(pool, userId, [{ userId, role: 'admin' }])
    workspaces.push(workspace.id)
    const actor = { userId, workspaceId: workspace.id }
    const botId = await seedBot(pool, workspace.id, userId), issueId = await seedIssue(pool, userId, workspace.id)
    const scope = { ownerId: userId, workspaceId: workspace.id, botId }
    await setE2BKey(userId, workspace.id, { apiKey: `e2b-fixture-${randomUUID()}` }, { verify: async () => ({ ok: true }) })
    const addKey = (provider: 'anthropic' | 'openai', model: string) => keys.addApiKey(pool, userId,
      { provider, apiKey: `sk-fixture-${randomUUID()}` }, { fetch: (async () => Response.json({ data: [{ id: model }] })) as typeof fetch })
    const first = await addKey('anthropic', 'fixture-claude-a'), second = await addKey('openai', 'fixture-codex-b')
    const entries = [{ harness: 'claude_code', model: 'fixture-claude-a', source: { kind: 'api_key', keyId: first.id } },
      { harness: 'codex', model: 'fixture-codex-b', source: { kind: 'api_key', keyId: second.id } }] satisfies Omit<OrderEntry, 'id'>[]
    await order.changeOrder(pool, scope, { kind: 'location', location: 'cloud' })
    await order.changeOrder(pool, scope, { kind: 'add', entries })
    const stored = (await order.readOrder(pool, scope)).entries
    await order.changeOrder(pool, scope, { kind: 'reorder', ids: entries.map(entry => stored.find(candidate => entryKey(candidate) === entryKey(entry))!.id) })
    const parent = await ensureBotCloudRuntime(pool, actor, botId, { harness: 'claude_code' })
    assert.ok(parent)
    const originalRuntime = await runtime(botId, 'claude_code')
    const remote = `https://github.com/mikka-ci/cloud-fallback-${randomUUID()}.git`
    const repository = await ensureDeviceRepository(userId, originalRuntime.deviceId, remote)
    const environmentConfiguration = { runtime: 'cloud' as const, variables: { FALLBACK_MODE: 'original' } }
    let environment: { id: string; revision: number } | undefined
    if (withEnvironment) {
      environment = await resources.saveEnvironment(userId, { workspaceId: workspace.id, name: 'Cloud fallback environment', configuration: environmentConfiguration })
      const projectId = randomUUID()
      await pool.query(`INSERT INTO workspace_projects(id,"userId","workspaceId",name,summary,description,status,priority,lead,team,"startDate","targetDate","issueIds",revision)
        VALUES($1,$2,$3,'Cloud fallback resource','','','planned','none','','','','','[]',1)`, [projectId, userId, workspace.id])
      await seedProjectTasks(pool, projectId, [issueId])
      await resources.saveProjectResources(userId, { workspaceId: workspace.id, projectId, revision: 1,
        repositories: [{ repositoryKey: normalizeRepository(remote).key, environmentId: environment.id, isPrimary: true }],
        environmentIds: [environment.id], defaultEnvironmentId: environment.id })
    }
    const selected = await chooseCloudRunModel(pool, scope, parent.agentId, 'claude_code', undefined, 'task')
    assert.ok(!('error' in selected), JSON.stringify(selected))
    const { runId } = await queueCloudRun(pool, actor, { botId, issueId, agentId: parent.agentId, deviceRepoId: repository.id,
      title: 'Inspect the existing repository', body: 'Read-only provider recovery fixture.', readOnly: true, ...selected })
    await machines.start(actor, runId)
    await pool.query(`UPDATE agent_runs SET status='running',"sessionId"=$2,"worktreePath"=$3,
      "startedAt"=now(),"leaseExpiresAt"=now()+interval '5 minutes' WHERE id=$1`, [runId, `fixture-session-${runId}`, `/tmp/cloud-fallback-${runId}`])
    const admitted = await row(runId)
    assert.equal(admitted.agentDefinition.modelDispatch.mode, 'preference')
    assert.equal(admitted.agentDefinition.modelDispatch.location, 'cloud')
    assert.equal(admitted.agentDefinition.apiKey.keyId, first.id)
    assert.equal(admitted.agentDefinition.readOnly, true)
    assert.equal(admitted.agentDefinition.allowLocalRecovery, undefined)
    // A usable local alternative makes staying in cloud a meaningful fence.
    const localDeviceId = randomUUID()
    await pool.query(`INSERT INTO devices (id,"ownerId",name,kind,enabled,harnesses,"lastSeenAt")
      VALUES ($1,$2,'Available local fixture','local',true,$3,now())`, [localDeviceId, userId, JSON.stringify([workers[1]])])
    await pool.query(`INSERT INTO agents (id,"userId","deviceId",harness,name) VALUES ($1,$2,$3,'codex','Local fixture')`, [randomUUID(), userId, localDeviceId])
    const local = await resolveModelDispatch(pool, scope, undefined, 'local')
    assert.ok(local.kind === 'device' && local.deviceId === localDeviceId && local.model === entries[1].model)
    const priorTarget = await runtime(botId, 'codex')
    await pool.query(`UPDATE cloud_machines SET state='sleeping' WHERE "ownerId"=$1 AND "workspaceId"=$2`, [userId, workspace.id])
    // Changing the default for new tasks cannot move this frozen cloud task.
    await order.changeOrder(pool, scope, { kind: 'location', location: 'local' })
    return { actor, scope, botId, issueId, runId, admitted, priorTarget, remote: repository.remoteUrl, first, second, localDeviceId, environment, environmentConfiguration }
  }
  const complete = (actor: { userId: string }, runId: string) => persistRunCompletion(actor.userId, runId, {
    stopReason: 'provider_failure', report: { ...emptyRunReport('Synthetic terminal provider payment failure.'),
      providerFailure: { kind: 'balance', retryable: false, status: 402, code: 'payment_required' } },
  })

  for (const change of ['environment', 'repository'] as const) await t.test(`${change} withdrawal preserves terminal completion and stops provider recovery before runtime preparation, including replay`, async () => {
    const f = await fixture(`provider-cloud-resource-${change}`, true)
    const { issueRunToken } = await import('../lib/mcp/worker')
    await issueRunToken({ id: f.runId, userId: f.actor.userId })
    const tokens = async () => (await pool.query('SELECT id,"revokedAt" FROM run_tokens WHERE "runId"=$1 ORDER BY id', [f.runId])).rows
    const beforeTokens = await tokens()
    assert.equal(beforeTokens.length, 1); assert.equal(beforeTokens[0].revokedAt, null)
    const beforeMachineIds = (await pool.query('SELECT "runId" FROM thread_machines WHERE "ownerId"=$1 ORDER BY "runId"', [f.actor.userId])).rows
    const beforeParent = await parentSnapshot(f.actor), beforeLaunches = lifecycleStarts.length, beforePlacements = launchPlacements.size
    if (change === 'environment') {
      await resources.saveEnvironment(f.actor.userId, { workspaceId: f.actor.workspaceId, ...f.environment!, name: 'Changed after the source started',
        configuration: { ...f.environmentConfiguration, variables: { FALLBACK_MODE: 'updated' } } })
    } else {
      await resources.saveWorkspaceRepositoryPolicy(f.actor.userId, { workspaceId: f.actor.workspaceId, revision: 0, mode: 'restricted', repositoryKeys: [] })
    }
    // Call through to the real preparation entry point if reached. A count
    // supplements the real Run/token/VM rows below; it cannot fake admission.
    const dispatchRuntime = await import('../lib/computer/dispatch-runtime')
    let preparationCalls = 0
    const observed = mock.module(new URL('../lib/computer/dispatch-runtime.ts', import.meta.url).href, { namedExports: {
      ...dispatchRuntime,
      prepareBotCloudTaskRuntime: async (...args: Parameters<typeof dispatchRuntime.prepareBotCloudTaskRuntime>) => {
        preparationCalls++
        return dispatchRuntime.prepareBotCloudTaskRuntime(...args)
      },
    } })
    try {
      await complete(f.actor, f.runId)
      const original = await row(f.runId)
      assert.equal(original.status, 'failed'); assert.equal(original.stopReason, 'provider_failure')
      assert.ok(original.finishedAt)
      assert.deepEqual(original.report.providerFailure, { kind: 'balance', retryable: false, status: 402, code: 'payment_required' })
      assert.deepEqual(original.agentDefinition, f.admitted.agentDefinition)
      assert.equal(original.report.modelFallback.state, 'stopped')
      assert.deepEqual(original.report.modelFallback.reasons, [{ choice: original.report.modelFallback.from,
        reason: change === 'environment' ? 'projectEnvironmentUnavailable' : 'projectRepositoryDenied' }])
      assert.deepEqual(await children(f.runId), [])
      const revoked = await tokens()
      assert.deepEqual(revoked.map(token => token.id), beforeTokens.map(token => token.id))
      assert.ok(revoked.every(token => token.revokedAt), 'the original completion still revokes its worker tokens')
      const events = (await pool.query('SELECT * FROM coordinator_events WHERE "runId"=$1 ORDER BY id', [f.runId])).rows
      assert.ok(events.some(event => event.payload.modelFallback?.state === 'stopped'))
      assert.equal(preparationCalls, 0)
      await complete(f.actor, f.runId)
      assert.equal(await recoverProviderFailure(pool, f.actor.userId, f.runId), null)
      assert.deepEqual(await row(f.runId), original, 'a replay cannot replace the terminal report or its stopped recovery receipt')
      assert.deepEqual(await tokens(), revoked)
      assert.deepEqual((await pool.query('SELECT * FROM coordinator_events WHERE "runId"=$1 ORDER BY id', [f.runId])).rows, events)
      assert.deepEqual(await children(f.runId), [])
      assert.deepEqual((await pool.query('SELECT "runId" FROM thread_machines WHERE "ownerId"=$1 ORDER BY "runId"', [f.actor.userId])).rows, beforeMachineIds)
      assert.deepEqual(await parentSnapshot(f.actor), beforeParent)
      assert.equal(lifecycleStarts.length, beforeLaunches); assert.equal(launchPlacements.size, beforePlacements)
      assert.equal(provisions.get(f.botId), 1)
      assert.equal(preparationCalls, 0, 'stopped recovery does not select or prepare another runtime on replay')
      assert.equal(networkAttempts, 0)
    } finally { observed.restore() }
  })

  for (const change of ['environment', 'repository'] as const) await t.test(`${change} withdrawal after a committed switch refuses replay, handoff and direct machine wake without changing history`, async () => {
    const f = await fixture(`provider-cloud-late-resource-${change}`, true)
    const { issueRunToken } = await import('../lib/mcp/worker')
    await issueRunToken({ id: f.runId, userId: f.actor.userId })
    await complete(f.actor, f.runId)
    const [child] = await children(f.runId), original = await row(f.runId)
    assert.ok(child)
    assert.equal(original.report.modelFallback.state, 'switched')
    assert.equal(original.report.modelFallback.retryRunId, child.id)
    assert.equal(child.status, 'queued')
    assert.deepEqual(child.agentDefinition.projectExecution, f.admitted.agentDefinition.projectExecution)
    const continuation = await recoverProviderFailure(pool, f.actor.userId, f.runId)
    assert.ok(continuation)
    const snapshot = async () => ({
      runs: (await pool.query('SELECT * FROM agent_runs WHERE "userId"=$1 ORDER BY id', [f.actor.userId])).rows,
      machines: (await pool.query('SELECT * FROM thread_machines WHERE "ownerId"=$1 ORDER BY "runId"', [f.actor.userId])).rows,
      tokens: (await pool.query('SELECT id,"runId","revokedAt" FROM run_tokens WHERE "userId"=$1 ORDER BY id', [f.actor.userId])).rows,
      devices: (await pool.query('SELECT id,"boundDeviceId","revokedAt","lastUsedAt" FROM device_tokens WHERE "userId"=$1 ORDER BY id', [f.actor.userId])).rows,
      events: (await pool.query('SELECT * FROM coordinator_events WHERE "userId"=$1 ORDER BY id', [f.actor.userId])).rows,
      parent: await parentSnapshot(f.actor),
    })
    const before = await snapshot(), beforeLaunches = lifecycleStarts.length, beforePlacements = launchPlacements.size
    assert.equal(before.tokens.length, 1); assert.ok(before.tokens[0].revokedAt)
    // Completion already performs the ordinary immediate launch when the
    // durable lifecycle is disabled. Revocation must preserve that committed
    // machine as well as refuse every subsequent launch or custody change.
    assert.equal(before.machines.filter(machine => machine.runId === child.id).length, 1)
    if (change === 'environment') {
      await resources.saveEnvironment(f.actor.userId, { workspaceId: f.actor.workspaceId, ...f.environment!, name: 'Changed before durable handoff',
        configuration: { ...f.environmentConfiguration, variables: { FALLBACK_MODE: 'updated' } } })
    } else {
      await resources.saveWorkspaceRepositoryPolicy(f.actor.userId, { workspaceId: f.actor.workspaceId, revision: 0, mode: 'restricted', repositoryKeys: [] })
    }
    const code = change === 'environment' ? 'projectEnvironmentUnavailable' : 'projectRepositoryDenied'
    const refused = (error: unknown) => error instanceof Error && 'code' in error && error.code === code
    // These observations call through: any mistaken custody/VM operation is
    // real and is also caught by the persisted snapshots below.
    const realPark = factoryAutomaticRuntime.park, realStart = factoryAutomaticRuntime.start, realConnect = threadMachineProvider.connect
    const park = mock.method(factoryAutomaticRuntime, 'park', (...args: Parameters<typeof realPark>) => realPark(...args))
    const start = mock.method(factoryAutomaticRuntime, 'start', (...args: Parameters<typeof realStart>) => realStart(...args))
    const connect = mock.method(threadMachineProvider, 'connect', (...args: Parameters<typeof realConnect>) => realConnect(...args))
    try {
      assert.equal(await recoverProviderFailure(pool, f.actor.userId, f.runId), null)
      await launchProviderContinuation(f.actor.userId, continuation)
      assert.equal(await handoffFactoryCloudStage(pool, f.actor, f.runId, child.id, true), false)
      assert.equal(park.mock.callCount(), 0); assert.equal(start.mock.callCount(), 0)
      await assert.rejects(ensureThreadMachine(pool, f.actor, child.id), refused)
      const { startThreadMachine } = await import('../lib/run-leases')
      assert.deepEqual(await startThreadMachine(f.actor, child.id), { state: 'unavailable', reason: 'project_resources' })
      // Resume/refresh call ensure directly rather than startThreadMachine.
      // The already retained source must not connect or change its timer.
      for (const action of ['resume', 'refresh_runtime'] as const)
        await assert.rejects(threadMachineAction(pool, f.actor, f.runId, action), refused)
      assert.equal(connect.mock.callCount(), 0)
      await assert.rejects(ensureThreadMachine(pool, { ...f.actor, userId: 'foreign' }, child.id),
        error => error instanceof Error && 'status' in error && error.status === 404 && error.message === 'Thread unavailable')
      await assert.rejects(ensureThreadMachine(pool, f.actor, randomUUID()),
        error => error instanceof Error && 'status' in error && error.status === 404 && error.message === 'Thread unavailable')
      assert.deepEqual(await snapshot(), before, 'resource refusal preserves both historical Run rows, the receipt, tokens and VM custody')
      assert.equal(lifecycleStarts.length, beforeLaunches); assert.equal(launchPlacements.size, beforePlacements)
      assert.equal(provisions.get(f.botId), 1); assert.equal(networkAttempts, 0)
    } finally { park.mock.restore(); start.mock.restore(); connect.mock.restore() }
  })

  for (const operation of ['wake', 'handoff'] as const) await t.test(`${operation} rechecks an APP placement change after resource preflight without timer, park or token effects`, async () => {
    const f = await fixture(`provider-cloud-placement-${operation}`, true)
    await complete(f.actor, f.runId)
    const [child] = await children(f.runId)
    assert.ok(child)
    const changed = await ensureDeviceRepository(f.actor.userId, child.deviceId,
      `https://github.com/mikka-ci/unbound-placement-${randomUUID()}.git`)
    // Completion has already launched the committed child. An overdue timer
    // on that actual machine makes an unintended finally write observable.
    assert.equal((await pool.query(`UPDATE thread_machines SET "lifecycleAt"=now()-interval '1 hour'
      WHERE "runId"=$1 AND "workspaceId"=$2 AND "ownerId"=$3`,
    [child.id, f.actor.workspaceId, f.actor.userId])).rowCount, 1)
    const snapshot = async () => ({
      runs: (await pool.query('SELECT * FROM agent_runs WHERE "userId"=$1 ORDER BY id', [f.actor.userId])).rows,
      machines: (await pool.query('SELECT * FROM thread_machines WHERE "ownerId"=$1 ORDER BY "runId"', [f.actor.userId])).rows,
      tokens: (await pool.query('SELECT * FROM device_tokens WHERE "userId"=$1 ORDER BY id', [f.actor.userId])).rows,
      events: (await pool.query('SELECT * FROM coordinator_events WHERE "userId"=$1 ORDER BY id', [f.actor.userId])).rows,
      parent: await parentSnapshot(f.actor),
    })
    let enter!: () => void, release!: () => void, intercepted = false
    const entered = new Promise<void>(resolve => { enter = resolve })
    const proceed = new Promise<void>(resolve => { release = resolve })
    const barrierPool = {
      query: async (sql: string, values: unknown[]) => {
        const result = await pool.query(sql, values)
        if (!intercepted && sql.startsWith('SELECT repo."repoPath",repo."remoteUrl",device.kind,agent.harness FROM device_repos repo')) {
          assert.deepEqual(values, [child.deviceRepoId, f.actor.userId, child.deviceId, child.agentId])
          intercepted = true
          enter()
          await proceed
        }
        return result
      },
      connect: () => pool.connect(),
    } as unknown as import('pg').Pool
    const realPark = factoryAutomaticRuntime.park, realStart = factoryAutomaticRuntime.start, realConnect = threadMachineProvider.connect
    const park = mock.method(factoryAutomaticRuntime, 'park', (...args: Parameters<typeof realPark>) => realPark(...args))
    const start = mock.method(factoryAutomaticRuntime, 'start', (...args: Parameters<typeof realStart>) => realStart(...args))
    const connect = mock.method(threadMachineProvider, 'connect', (...args: Parameters<typeof realConnect>) => realConnect(...args))
    const beforeLaunches = lifecycleStarts.length, beforePlacements = launchPlacements.size
    const execution = operation === 'wake'
      ? ensureThreadMachine(barrierPool, f.actor, child.id)
      : handoffFactoryCloudStage(barrierPool, f.actor, f.runId, child.id, true)
    try {
      await Promise.race([entered, execution.then(() => assert.fail('resource preflight must reach the controlled barrier'))])
      assert.equal((await pool.query('UPDATE agent_runs SET "deviceRepoId"=$2 WHERE id=$1', [child.id, changed.id])).rowCount, 1)
      const before = await snapshot()
      release()
      if (operation === 'wake') await assert.rejects(execution, { code: 'projectRepositoryDenied' })
      else assert.equal(await execution, false)
      assert.deepEqual(await snapshot(), before, 'only the explicit concurrent placement edit may persist')
      assert.equal(park.mock.callCount(), 0); assert.equal(start.mock.callCount(), 0); assert.equal(connect.mock.callCount(), 0)
      assert.equal(lifecycleStarts.length, beforeLaunches); assert.equal(launchPlacements.size, beforePlacements)
      assert.equal(networkAttempts, 0)
    } finally {
      release()
      await execution.catch(() => undefined)
      park.mock.restore(); start.mock.restore(); connect.mock.restore()
    }
  })

  await t.test('402 crosses harnesses using a fresh task container while its sleeping parent stays unchanged', async () => {
    const f = await fixture('provider-cloud-sleeping')
    const beforeParent = await parentSnapshot(f.actor)
    await complete(f.actor, f.runId)
    const original = await row(f.runId), [queuedChild, ...extra] = await children(f.runId)
    let child = queuedChild
    assert.ok(child, 'real completion and queue must create the cloud continuation')
    assert.equal(extra.length, 0)
    assert.equal(original.report.modelFallback.state, 'switched')
    assert.equal(original.report.modelFallback.retryRunId, child.id)
    assert.deepEqual(original.agentDefinition, f.admitted.agentDefinition, 'the failed run retains its frozen snapshot')
    assert.equal(child.agentDefinition.harness, 'codex')
    assert.deepEqual(child.agentDefinition.apiKey, { keyId: f.second.id, model: 'fixture-codex-b' })
    assert.equal(child.agentDefinition.readOnly, true)
    assert.equal(child.agentDefinition.modelDispatch.mode, 'preference')
    assert.equal(child.agentDefinition.modelDispatch.location, 'cloud')
    assert.equal(providerContinuationMatches(original, child), true)
    for (const field of ['userId', 'botId', 'issueId', 'attempt', 'kind', 'baseBranch']) assert.equal(child[field], original[field], field)
    for (const field of ['requester', 'botId', 'botOwner', 'executionPrincipal', 'workspaceId', 'outputOwner', 'personalResourcePolicy'])
      assert.deepEqual(child.agentDefinition.executionIdentity[field], original.agentDefinition.executionIdentity[field], field)
    assert.deepEqual(child.agentDefinition.executionIdentity.billingAccount.runtime, original.agentDefinition.executionIdentity.billingAccount.runtime)
    assert.equal(child.agentDefinition.executionIdentity.billingAccount.runtime.kind, 'e2b')
    assert.equal(child.agentDefinition.executionIdentity.billingAccount.model.ownerId, f.actor.userId)
    assert.equal(child.status, 'queued')
    assert.equal(launchPlacements.has(child.id), false, 'the completed worker request only commits a durable handoff')
    assert.deepEqual(lifecycleStarts.filter(item => item.runId === child.id), [{ actor: f.actor, previousRunId: f.runId, runId: child.id, providerContinuation: true }])
    assert.equal(await handoffFactoryCloudStage(pool, f.actor, f.runId, child.id, true), true)
    child = await row(child.id)

    const moved = await runtime(f.botId, 'codex')
    assert.deepEqual(moved, f.priorTarget, 'sleeping parent execution identities stay unchanged')
    assert.deepEqual(await parentSnapshot(f.actor), beforeParent, 'no parent VM state, lease, heartbeat or capabilities change')
    const queued = launchPlacements.get(child.id)
    assert.ok(queued, 'the durable host step must launch the actual task machine')
    assert.deepEqual([queued.userId, queued.botId, queued.issueId, queued.agentId, queued.deviceId], [f.actor.userId, f.botId, f.issueId, moved.agentId, moved.deviceId])
    const queuedRepo = (await pool.query('SELECT "deviceId","userId","remoteUrl" FROM device_repos WHERE id=$1', [queued.deviceRepoId])).rows[0]
    assert.deepEqual(queuedRepo, { deviceId: moved.deviceId, userId: f.actor.userId, remoteUrl: f.remote })
    const machine = (await pool.query(`SELECT m."ownerId",m."workspaceId",m."botId",m."issueId",m."deviceId",m."repoId",m.state,m."snapshotId",d.kind
      FROM thread_machines m JOIN devices d ON d.id=m."deviceId" WHERE m."runId"=$1`, [child.id])).rows[0]
    assert.deepEqual([machine.ownerId, machine.workspaceId, machine.botId, machine.issueId, machine.state, machine.snapshotId, machine.kind],
      [f.actor.userId, f.actor.workspaceId, f.botId, f.issueId, 'running', 'codex', 'cloud'])
    assert.equal(child.deviceId, machine.deviceId)
    assert.equal(child.deviceRepoId, machine.repoId)
    assert.notEqual(child.deviceId, moved.deviceId, 'a task uses its own machine after admission')
    assert.notEqual(child.deviceId, f.admitted.deviceId, 'the new harness receives a fresh task machine')
    assert.notEqual(child.deviceId, f.localDeviceId)
    assert.equal(provisions.get(f.botId), 1, 'the parent is not reprovisioned for provider recovery')
    assert.equal(lifecycleStarts.filter(item => item.runId === child.id).length, 1, 'handoff does not start a second lifecycle')
    assert.equal(networkAttempts, 0)
  })

  await t.test('device-fenced completion hands the retained VM to a host after its old token is revoked', async () => {
    const f = await fixture('provider-cloud-device-fence')
    // Preset providers have one key per owner. Use a distinct provider so this
    // cannot refresh/replace the failed source or erase its health evidence.
    const healthy = await keys.addApiKey(pool, f.actor.userId, { provider: 'deepseek', apiKey: `fixture-${randomUUID()}` },
      { fetch: (async () => Response.json({ data: [{ id: 'fixture-claude-retained' }] })) as typeof fetch })
    await order.changeOrder(pool, f.scope, { kind: 'add', entries: [
      { harness: 'claude_code', model: 'fixture-claude-retained', source: { kind: 'api_key', keyId: healthy.id } },
    ] })
    const entries = (await order.readOrder(pool, f.scope)).entries
    const firstEntry = entries.find(entry => entry.harness === 'claude_code' && entry.model === 'fixture-claude-a' && entry.source.kind === 'api_key' && entry.source.keyId === f.first.id)
    const healthyEntry = entries.find(entry => entry.harness === 'claude_code' && entry.model === 'fixture-claude-retained' && entry.source.kind === 'api_key' && entry.source.keyId === healthy.id)
    assert.ok(firstEntry && healthyEntry)
    assert.notEqual(f.first.id, healthy.id)
    const promoted = new Set([firstEntry.id, healthyEntry.id])
    await order.changeOrder(pool, f.scope, { kind: 'reorder', ids: [
      firstEntry.id, healthyEntry.id, ...entries.filter(entry => !promoted.has(entry.id)).map(entry => entry.id),
    ] })
    const originalMachine = (await pool.query('SELECT * FROM thread_machines WHERE "runId"=$1', [f.runId])).rows[0]
    const token = (await pool.query('SELECT id FROM device_tokens WHERE "boundDeviceId"=$1 AND "revokedAt" IS NULL', [originalMachine.deviceId])).rows[0]
    assert.ok(token)
    const caller = { tokenId: token.id, userId: f.actor.userId }
    await withDeviceDatabaseAuthority(caller, () => complete(f.actor, f.runId))
    const [child] = await children(f.runId)
    assert.equal(child.status, 'queued')
    assert.equal(launchPlacements.has(child.id), false)
    assert.deepEqual(lifecycleStarts.filter(item => item.runId === child.id), [{ actor: f.actor, previousRunId: f.runId, runId: child.id, providerContinuation: true }])

    // The source lifecycle may park as soon as completion is committed. Its
    // real credential revocation must stay effective for the old request.
    await factoryAutomaticRuntime.park(pool, f.actor, f.runId)
    await assert.rejects(withDeviceDatabaseAuthority(caller, () => appPool.query('SELECT 1')), DeviceAuthorityRevoked)
    const unavailable = mock.method(factoryAutomaticRuntime, 'start', async () => ({ state: 'unavailable' as const, reason: 'retained_runtime' as const }))
    try {
      await assert.rejects(handoffFactoryCloudStage(pool, f.actor, f.runId, child.id, true), /Retained task machine unavailable/)
      assert.equal((await row(child.id)).status, 'queued')
      assert.equal((await children(f.runId)).length, 1)
    } finally { unavailable.mock.restore() }
    assert.equal(await handoffFactoryCloudStage(pool, f.actor, f.runId, child.id, true), true)
    const retained = (await pool.query('SELECT * FROM thread_machines WHERE "runId"=$1', [child.id])).rows[0]
    assert.equal(retained.sandboxId, originalMachine.sandboxId)
    assert.equal(retained.deviceId, originalMachine.deviceId)
    assert.equal(retained.state, 'running')
    assert.equal(launchPlacements.has(child.id), false, 'the next model retains this task VM')
    assert.equal((await children(f.runId)).length, 1)

    // A lost step response may be delivered again after a worker claims. It
    // keeps that live lease and credential, without another park/bootstrap.
    await pool.query(`UPDATE agent_runs SET status='running',"leaseExpiresAt"=now()+interval '5 minutes' WHERE id=$1`, [child.id])
    const park = mock.method(factoryAutomaticRuntime, 'park', async () => { throw new Error('live worker must not be parked') })
    const start = mock.method(factoryAutomaticRuntime, 'start', async () => { throw new Error('live worker must not be restarted') })
    try {
      assert.equal(await handoffFactoryCloudStage(pool, f.actor, f.runId, child.id, true), true)
      assert.equal(park.mock.callCount(), 0)
      assert.equal(start.mock.callCount(), 0)
      assert.equal(await recoverProviderFailure(pool, f.actor.userId, f.runId), null)
    } finally { park.mock.restore(); start.mock.restore() }
    assert.equal(networkAttempts, 0)
  })

  await t.test('concurrent durable handoffs preserve the first new VM provisioning lease', async () => {
    const f = await fixture('provider-cloud-concurrent-launch')
    await complete(f.actor, f.runId)
    const [child] = await children(f.runId)
    let entered!: () => void, release!: () => void
    const creating = new Promise<void>(resolve => { entered = resolve })
    const held = new Promise<void>(resolve => { release = resolve })
    const realCreate = threadMachineProvider.create
    const create = mock.method(threadMachineProvider, 'create', async (...args: Parameters<typeof realCreate>) => {
      entered()
      await held
      return realCreate(...args)
    })
    const first = handoffFactoryCloudStage(pool, f.actor, f.runId, child.id, true)
    try {
      await Promise.race([creating, first.then(() => { throw new Error('first handoff ended before provisioning') })])
      const lease = (await pool.query('SELECT "workerLeaseId","workerLeaseUntil" FROM thread_machines WHERE "runId"=$1', [child.id])).rows[0]
      assert.ok(lease.workerLeaseId)
      await assert.rejects(handoffFactoryCloudStage(pool, f.actor, f.runId, child.id, true), /Thread provisioning in progress/)
      assert.equal((await row(child.id)).status, 'queued')
      assert.deepEqual((await pool.query('SELECT "workerLeaseId","workerLeaseUntil" FROM thread_machines WHERE "runId"=$1', [child.id])).rows[0], lease)
      release()
      assert.equal(await first, true)
      assert.equal(create.mock.callCount(), 1)
      assert.equal((await pool.query('SELECT state FROM thread_machines WHERE "runId"=$1', [child.id])).rows[0].state, 'running')
      assert.equal((await children(f.runId)).length, 1)
    } finally { release(); await first.catch(() => undefined); create.mock.restore() }
    assert.equal(networkAttempts, 0)
  })

  await t.test('durable provider handoff rejects stopped, terminal, foreign and changed receipts before touching a VM', async () => {
    const f = await fixture('provider-cloud-handoff-guards')
    await complete(f.actor, f.runId)
    const [child] = await children(f.runId), original = await row(f.runId)
    const park = mock.method(factoryAutomaticRuntime, 'park', async () => { throw new Error('unowned handoff must not park') })
    const start = mock.method(factoryAutomaticRuntime, 'start', async () => { throw new Error('unowned handoff must not start') })
    const handoff = () => handoffFactoryCloudStage(pool, f.actor, f.runId, child.id, true)
    try {
      assert.equal(await handoffFactoryCloudStage(pool, { ...f.actor, userId: 'foreign' }, f.runId, child.id, true), false)
      assert.equal(await handoffFactoryCloudStage(pool, { ...f.actor, workspaceId: randomUUID() }, f.runId, child.id, true), false)
      assert.equal(await handoffFactoryCloudStage(pool, f.actor, null, child.id, true), false)
      assert.equal(await handoffFactoryCloudStage(pool, f.actor, f.runId, child.id), false, 'non-Factory runs require provider authorization')
      for (const runId of [f.runId, child.id]) {
        await pool.query('UPDATE agent_runs SET "stopRequestedAt"=now() WHERE id=$1', [runId])
        assert.equal(await handoff(), false)
        assert.equal(await recoverProviderFailure(pool, f.actor.userId, f.runId), null)
        await pool.query('UPDATE agent_runs SET "stopRequestedAt"=NULL WHERE id=$1', [runId])
      }
      await pool.query(`UPDATE agent_runs SET status='failed' WHERE id=$1`, [child.id])
      assert.equal(await handoff(), false)
      assert.equal(await recoverProviderFailure(pool, f.actor.userId, f.runId), null)
      await pool.query(`UPDATE agent_runs SET status='queued' WHERE id=$1`, [child.id])
      await pool.query(`UPDATE agent_runs SET report=jsonb_set(report,'{modelFallback,nextDefinitionDigest}','"changed"') WHERE id=$1`, [f.runId])
      assert.equal(await handoff(), false)
      assert.equal(await recoverProviderFailure(pool, f.actor.userId, f.runId), null)
      await pool.query('UPDATE agent_runs SET report=$2 WHERE id=$1', [f.runId, JSON.stringify(original.report)])
      await pool.query(`UPDATE issues SET status='canceled' WHERE id=$1`, [f.issueId])
      assert.equal(await handoff(), false)
      assert.equal(park.mock.callCount(), 0)
      assert.equal(start.mock.callCount(), 0)
    } finally { park.mock.restore(); start.mock.restore() }
  })

  await t.test('disabled cloud execution identity cannot move a frozen cloud task onto its available local device', async () => {

    const f = await fixture('provider-cloud-refused')
    await pool.query('UPDATE devices SET enabled=false WHERE id=$1 AND "ownerId"=$2', [f.priorTarget.deviceId, f.actor.userId])
    const beforeParent = await parentSnapshot(f.actor)
    await complete(f.actor, f.runId)
    const original = await row(f.runId)
    assert.equal(original.report.modelFallback.state, 'blocked')
    assert.equal(original.agentDefinition.modelDispatch.location, 'cloud')
    assert.equal(original.report.modelFallback.reasons.find((entry: { choice: { model: string } }) => entry.choice.model === 'fixture-codex-b')?.reason, 'noDevice')
    assert.deepEqual(await children(f.runId), [])
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM agent_runs WHERE "userId"=$1 AND "deviceId"=$2', [f.actor.userId, f.localDeviceId])).rows[0].count, 0)
    assert.equal(provisions.get(f.botId), 2, 'the real registration rejects the disabled identity')
    assert.deepEqual(await parentSnapshot(f.actor), beforeParent, 'refusal cannot rewrite disabled parent metadata')
    assert.equal(networkAttempts, 0)
  })

  await t.test('a later cloud task skips the remembered 402 within its selected Agent and freezes the healthy source', async () => {
    const f = await fixture('provider-cloud-next-task')
    await complete(f.actor, f.runId)
    assert.equal((await row(f.runId)).report.modelFallback.state, 'switched')
    const next = await keys.addApiKey(pool, f.actor.userId, { provider: 'deepseek', apiKey: `fixture-${randomUUID()}` },
      { fetch: (async () => Response.json({ data: [{ id: 'fixture-claude-next' }] })) as typeof fetch })
    assert.notEqual(next.id, f.first.id, 'the healthy source cannot refresh the remembered failed key')
    await order.changeOrder(pool, f.scope, { kind: 'add', entries: [
      { harness: 'claude_code', model: 'fixture-claude-next', source: { kind: 'api_key', keyId: next.id } },
    ] })
    // The healthy Codex preference is before this Claude Code preference. It
    // cannot replace an Agent already chosen for a task or independent check.
    const current = await runtime(f.botId, 'claude_code')
    const selected = await chooseCloudRunModel(pool, f.scope, current.agentId, 'claude_code')
    assert.ok(!('error' in selected), JSON.stringify(selected))
    assert.equal(selected.model, 'fixture-claude-next')
    assert.equal(selected.apiKeyId, next.id)
    assert.equal(selected.modelDispatch?.mode, 'preference')
    assert.equal(selected.modelDispatch?.location, 'cloud')
    const issueId = await seedIssue(pool, f.actor.userId, f.actor.workspaceId)
    const queued = await queueCloudRun(pool, f.actor, { botId: f.botId, issueId, agentId: current.agentId,
      deviceRepoId: current.repoId, title: 'Read a small fixture file', body: 'Read-only follow-up task.', readOnly: true, ...selected })
    const frozen = await row(queued.runId)
    assert.equal(frozen.agentDefinition.harness, 'claude_code')
    assert.deepEqual(frozen.agentDefinition.apiKey, { keyId: next.id, model: 'fixture-claude-next' })
    assert.equal(frozen.agentDefinition.modelDispatch.mode, 'preference')
    assert.equal(frozen.agentDefinition.executionIdentity.workspaceId, f.actor.workspaceId)
    assert.equal(frozen.agentDefinition.executionIdentity.executionPrincipal, f.actor.userId)
    assert.equal(frozen.agentDefinition.executionIdentity.billingAccount.model.ownerId, f.actor.userId)
    assert.deepEqual(await chooseCloudRunModel(pool, f.scope, current.agentId, 'claude_code', 'fixture-claude-a'),
      { error: 'machineUnavailable', reason: 'pickedUnavailable' }, 'an explicitly selected failed model is still refused')
    assert.equal(networkAttempts, 0)
  })
})
