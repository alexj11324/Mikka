// Real dispatch metadata, queues, device claim HTTP and native-use authorization. Provider inference
// and E2B are not called: a shared subscription remains owned by its lender throughout the run.
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mock, test, type TestContext } from 'node:test'
import { DAEMON_PROTOCOL_VERSION } from '@mikka/protocol/daemon'
import { REPO_ORIGIN_HEADER } from '@mikka/protocol/device'
import { normalizeRepository } from '@mikka/protocol/repository'
import type { SubscriptionUse } from '@mikka/protocol/subscription'
import { subscriptionModelRoute } from '../lib/model-admission/contract'
import { dbUrl, seedBot, seedIssue, seedUser, seedWorkspace } from './support/workspace-admin-db'
import { fakeThreadMachines } from './support/thread-machine-fake'
import { sealSecret, userE2bKeyAad } from '../lib/secrets/crypto'

test('shared subscriptions reach local and cloud claims with current membership and sharing', { skip: !dbUrl }, async t => {
  const savedKey = process.env.WORKSPACE_SECRETS_KEY
  process.env.WORKSPACE_SECRETS_KEY = randomBytes(32).toString('hex')
  process.env.MIKKA_BYOS_ENABLED = '1'
  process.env.MIKKA_BYOS_VALIDATED_MODEL_ROUTES = 'claude_cpa,codex_cpa'
  delete process.env.MIKKA_CLOUD_COMPUTER_TASKS
  delete process.env.MIKKA_FACTORY_ROUTING_ENABLED
  const next = await import('next/server')
  mock.module('next/server', { namedExports: { NextRequest: next.NextRequest, NextResponse: next.NextResponse, after: () => {} } })
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: dbUrl, max: 5 })
  const { pool: appPool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  const order = await import('../lib/model-order')
  const { bindAgentToConnection, resolveModelDispatch } = await import('../lib/model-dispatch')
  const { queueRun } = await import('../lib/agent-runs')
  const { queueCloudRun } = await import('../lib/computer/queue-run')
  const keys = await import('../lib/model-api-keys')
  const { hashDeviceToken } = await import('../lib/device-link')
  const claimRoute = await import('../app/v1/devices/[deviceId]/runs/[runId]/claim/route')
  const { SubscriptionRepository } = await import('../lib/subscription-repository')
  const { SubscriptionService } = await import('../lib/subscription-service')
  const { authorizeSubscriptionUse, authorizeSubscriptionWorkspace } = await import('../lib/subscription-runtime')
  const repository = new SubscriptionRepository(pool)
  const nativeCalls: Array<{ ownerId: string; operation: string; runId?: string }> = []
  // Only the private provider worker is a fixture. Admission and both membership
  // guards remain the real defaults, so a successful claim alone cannot pass.
  const service = new SubscriptionService(repository, scope => ({ forUse(use: SubscriptionUse) {
    assert.equal(use.ownerId, scope.ownerId)
    return {
      async call(operation: string) {
        nativeCalls.push({ ownerId: scope.ownerId, operation, runId: use.runId })
        if (operation === 'prepare') return {}
        if (operation === 'nativeContext') return { accountId: 'fixture-account', expiresAt: new Date(Date.now() + 60_000).toISOString() }
        throw new Error(`unexpected worker operation: ${operation}`)
      },
      async nativeRequest() {
        nativeCalls.push({ ownerId: scope.ownerId, operation: 'request', runId: use.runId })
        return { contentType: 'text/event-stream', body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('data: fixture-native-response\n\n')); controller.close() } }) }
      },
    }
  } }) as never, { ready: () => true, nativeIsolation: 'verified_runtime' }, undefined, authorizeSubscriptionUse, undefined, authorizeSubscriptionWorkspace)
  // Each daemon reports the fixture model its CLI offers; a subscription model runs only where it was reported.
  const harnesses = ['claude_code', 'codex'].map(harness => ({ harness, installed: true, toolApproval: true, subscriptionBroker: true, models: [harness === 'claude_code' ? 'shared-opus' : 'shared-gpt'] }))
  const threadMachines = await fakeThreadMachines(pool, harnesses)
  const users: string[] = []
  t.after(async () => {
    if (savedKey === undefined) delete process.env.WORKSPACE_SECRETS_KEY; else process.env.WORKSPACE_SECRETS_KEY = savedKey
    threadMachines.restore()
    await pool.query('DELETE FROM model_api_key_runs n USING agent_runs r WHERE r.id=n."runId" AND r."userId"=ANY($1)', [users])
    await pool.query('DELETE FROM byos_native_runs n USING agent_runs r WHERE r.id=n."runId" AND r."userId"=ANY($1)', [users])
    for (const table of ['computer_run_bindings', 'thread_machines']) await pool.query(`DELETE FROM ${table} WHERE "ownerId"=ANY($1)`, [users])
    await pool.query('DELETE FROM agent_runs WHERE "userId"=ANY($1)', [users])
    await pool.query('DELETE FROM model_api_keys WHERE "ownerId"=ANY($1)', [users])
    await pool.query('DELETE FROM user_e2b_keys WHERE "userId"=ANY($1)', [users])
    for (const table of ['byos_bindings', 'byos_connections', 'workspace_subscription_shares', 'bot_cloud_runtimes', 'bot_desktops', 'cloud_machines']) await pool.query(`DELETE FROM ${table} WHERE "ownerId"=ANY($1)`, [users])
    for (const table of ['model_order_entries', 'model_order_settings']) await pool.query(`DELETE FROM ${table} WHERE "ownerId"=ANY($1)`, [users])
    for (const table of ['device_tokens', 'agents', 'device_repos']) await pool.query(`DELETE FROM ${table} WHERE "${table === 'agents' || table === 'device_repos' || table === 'device_tokens' ? 'userId' : 'ownerId'}"=ANY($1)`, [users])
    await pool.query('DELETE FROM devices WHERE "ownerId"=ANY($1)', [users])
    await Promise.all([pool.end(), appPool.end(), workspacePool.end()])
  })
  const seed = async (provider: 'claude' | 'codex', cloud: boolean, withProfile = false) => {
    const ownerId = await seedUser(pool, 'shared-lender'), userId = await seedUser(pool, 'shared-runner')
    users.push(ownerId, userId)
    const workspace = await seedWorkspace(pool, userId, [{ userId, role: 'admin' }, { userId: ownerId, role: 'member' }])
    const workspaceId = workspace.id, botId = await seedBot(pool, workspaceId, userId), issueId = await seedIssue(pool, userId, workspaceId)
    const harness = provider === 'claude' ? 'claude_code' : 'codex', model = provider === 'claude' ? 'shared-opus' : 'shared-gpt'
    const connectionId = randomUUID()
    const quota = { vendor: provider === 'claude' ? 'claude_code' : 'codex', source: 'official', status: 'ok', plan: null, observedAt: new Date().toISOString(), windows: [{ kind: 'five_hour', used: .2, resetsAt: new Date(Date.now() + 3_600_000).toISOString() }] }
    await pool.query(`INSERT INTO byos_connections (id,"ownerId","workspaceId",provider,state,epoch,"secretName","secretDigest","providerSubject",quota,"modelCatalog") VALUES ($1,$2,$3,$4,'connected',1,$5,$6,'synthetic-subject',$7,$8)`, [connectionId, ownerId, workspaceId, provider, `synthetic-${connectionId}`, 'a'.repeat(64), JSON.stringify(quota), JSON.stringify({ revision: '1', models: [model] })])
    await pool.query(`INSERT INTO byos_bindings (id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision",route,"modelId") VALUES ($1,$2,$3,'catalogue',$4,1,$5,$6)`, [randomUUID(), ownerId, workspaceId, connectionId, provider === 'claude' ? 'claude_cpa' : 'codex_cpa', model])
    await pool.query('INSERT INTO workspace_subscription_shares ("ownerId","workspaceId","allowOthers") VALUES ($1,$2,true)', [ownerId, workspaceId])
    const deviceId = randomUUID(), agentId = randomUUID(), repoId = randomUUID(), remote = `https://github.com/mikka-ci/shared-${randomUUID()}.git`
    await pool.query(`INSERT INTO devices (id,"ownerId",name,kind,enabled,"protocolVersion","lastSeenAt",harnesses) VALUES ($1,$2,'Runner',$3,true,$4,now(),$5)`, [deviceId, userId, cloud ? 'cloud' : 'local', DAEMON_PROTOCOL_VERSION, JSON.stringify(harnesses)])
    await pool.query('INSERT INTO agents (id,"userId","deviceId",harness,name) VALUES ($1,$2,$3,$4,$5)', [agentId, userId, deviceId, harness, `synthetic-${agentId}`])
    await pool.query('INSERT INTO device_repos (id,"deviceId","userId","repoPath","remoteUrl") VALUES ($1,$2,$3,$4,$5)', [repoId, deviceId, userId, normalizeRepository(remote).key, remote])
    const token = `synthetic-${randomUUID()}`
    await pool.query('INSERT INTO device_tokens (id,"userId","tokenHash") VALUES ($1,$2,$3)', [randomUUID(), userId, hashDeviceToken(token)])
    if (cloud) {
      const sealed = sealSecret('synthetic-e2b-fixture', userE2bKeyAad(userId))
      await pool.query('INSERT INTO user_e2b_keys("userId",ciphertext,iv,"keyVersion",last4) VALUES($1,$2,$3,$4,\'test\')', [userId, sealed.ciphertext, sealed.iv, sealed.keyVersion])
      await pool.query(`INSERT INTO cloud_machines ("workspaceId","ownerId","operationId","sandboxId","deviceId",state,"runtimeReady") VALUES ($1,$2,$3,$4,$5,'running',true)`, [workspaceId, userId, randomUUID(), `synthetic-${randomUUID()}`, deviceId])
      await pool.query('INSERT INTO bot_desktops ("botId","workspaceId","ownerId",display) VALUES ($1,$2,$3,1)', [botId, workspaceId, userId])
      await pool.query('INSERT INTO bot_cloud_runtimes ("botId","ownerId","workspaceId",harness,"agentId","repoId") VALUES ($1,$2,$3,$4,$5,$6)', [botId, userId, workspaceId, harness, agentId, repoId])
    }
    const scope = { ownerId: userId, workspaceId }
    // An own paid key offering the very same model must not steal an authorized shared subscription.
    await keys.addApiKey(pool, userId, { provider: provider === 'claude' ? 'anthropic' : 'openai', apiKey: `sk-${randomUUID()}` }, { fetch: (async () => Response.json({ data: [{ id: model }] })) as typeof fetch })
    await keys.setApiKeyAfterQuota(pool, userId, false)
    const candidates = await order.orderCandidates(pool, scope)
    assert.equal(candidates.find(item => item.source.kind === 'subscription' && item.source.connectionId === connectionId)?.credentialOwnerId, ownerId)
    if (cloud) await bindAgentToConnection(pool, scope, agentId, harness, connectionId, model)
    else {
      const dispatch = await resolveModelDispatch(pool, { ...scope, botId }, { harness, model })
      assert.equal(dispatch.kind, 'device')
      assert.equal(dispatch.kind === 'device' && dispatch.agentId, agentId)
      assert.equal(dispatch.kind === 'device' && dispatch.entry.source.kind, 'subscription')
    }
    const entry = { id: randomUUID(), harness: harness as 'claude_code' | 'codex', model, source: { kind: 'subscription' as const, connectionId } }
    const selection = withProfile ? {
      agentProfile: (await import('../lib/factory/agent-profile')).builtinAgentProfileSelection(scope, entry),
      modelDispatch: { mode: 'picked' as const, location: cloud ? 'cloud' as const : 'local' as const, entry },
    } : {}
    const queued = cloud
      ? await queueCloudRun(pool, { userId, workspaceId }, { botId, issueId, agentId, deviceRepoId: repoId, title: 'Read', body: '', model, readOnly: true, ...selection })
      : await queueRun(userId, { issueId, agentId, repo: remote, model, readOnly: true, ...selection }, botId)
    const definition = (await pool.query('SELECT "agentDefinition" FROM agent_runs WHERE id=$1', [queued.runId])).rows[0].agentDefinition
    assert.equal(definition.modelSource, 'subscription')
    assert.equal(definition.apiKey, undefined, 'apiKeyAfterQuota=false also forbids an unintended paid-key substitution')
    const frozen = await repository.nativeBinding(userId, agentId, harness, definition.subscription.bindingId, workspaceId)
    assert.equal(frozen?.ownerId, ownerId, 'the lender remains the credential owner')
    const worker = cloud ? await threadMachines.start({ userId, workspaceId }, queued.runId) : { deviceId, token }
    const claim = (runId = queued.runId) => claimRoute.POST(new Request(`http://127.0.0.1/v1/devices/${worker.deviceId}/runs/${runId}/claim`, { method: 'POST', headers: { 'x-mikka-client-version': '0.0.456', authorization: `Bearer ${worker.token}`, [REPO_ORIGIN_HEADER]: '1' } }), { params: Promise.resolve({ deviceId: worker.deviceId, runId }) })
    return { ownerId, userId, workspaceId, botId, agentId, harness, connectionId, model, scope, worker, runId: queued.runId, repoId, issueId, remote, claim }
  }
  const staleProfileQuota = async (p: Awaited<ReturnType<typeof seed>>) => {
    await pool.query('UPDATE byos_connections SET quota=jsonb_set(quota,\'{observedAt}\',to_jsonb($2::text)) WHERE id=$1',
      [p.connectionId, new Date(Date.now() - 60_001).toISOString()])
    const { quota } = (await pool.query('SELECT quota FROM byos_connections WHERE id=$1', [p.connectionId])).rows[0]
    assert.equal((await import('../lib/subscription-quota')).subscriptionAvailability(quota, p.model, 'codex').status, 'checking')
  }
  const quotaReader = async (context: TestContext, p: Awaited<ReturnType<typeof seed>>, runId = p.runId,
    fault?: 'share' | 'revision' | 'stop' | 'unavailable') => {
    const { SubscriptionWorkerClient } = await import('../packages/daemon/src/subscription-worker-client')
    const syntheticRuntime = {
      MIKKA_BYOS_INFISICAL_ORIGIN: 'http://127.0.0.1:1', MIKKA_BYOS_INFISICAL_PROJECT: 'synthetic-claim-quota',
      MIKKA_BYOS_INFISICAL_ENVIRONMENT: 'test', MIKKA_BYOS_INFISICAL_PATH: '/synthetic-custody',
      MIKKA_BYOS_ACCESS_INFISICAL_PATH: '/synthetic-access', MIKKA_BYOS_INFISICAL_TOKEN: 'synthetic-custody-token',
      MIKKA_BYOS_ACCESS_INFISICAL_TOKEN: 'synthetic-distinct-access-token', MIKKA_BYOS_SHARED_CUSTODY_IDENTITY: '0',
    }
    const saved = Object.fromEntries(Object.keys(syntheticRuntime).map(key => [key, process.env[key]]))
    Object.assign(process.env, syntheticRuntime)
    context.after(() => { for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value })
    let reads = 0
    context.mock.method(SubscriptionWorkerClient.prototype, 'call', async function<T>(this: InstanceType<typeof SubscriptionWorkerClient>, method: string, input: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
      assert.equal(method, 'allowance'); assert.equal(input.revision, 1); assert.ok(signal)
      const config = Reflect.get(this, 'config') as { scope: { ownerId: string; connectionId: string } }
      assert.equal(config.scope.ownerId, p.ownerId, 'the authorized lender, never the run principal, owns the quota read')
      assert.equal(config.scope.connectionId, p.connectionId, 'the preflight reads only the exact frozen connection')
      reads++
      const run = (await pool.query('SELECT status,"startedAt" FROM agent_runs WHERE id=$1', [runId])).rows[0]
      assert.equal(run.status, 'queued'); assert.equal(run.startedAt, null)
      const probe = await pool.connect()
      try {
        await probe.query('BEGIN')
        await probe.query('SELECT 1 FROM byos_connections WHERE id=$1 FOR UPDATE NOWAIT', [p.connectionId])
        await probe.query('SELECT 1 FROM agent_runs WHERE id=$1 FOR UPDATE NOWAIT', [runId])
      } finally { await probe.query('ROLLBACK'); probe.release() }
      if (fault === 'share') await pool.query('UPDATE workspace_subscription_shares SET "allowOthers"=false WHERE "ownerId"=$1 AND "workspaceId"=$2', [p.ownerId, p.workspaceId])
      if (fault === 'revision') await pool.query('UPDATE byos_connections SET epoch=epoch+1 WHERE id=$1', [p.connectionId])
      if (fault === 'stop') await pool.query('UPDATE agent_runs SET "stopRequestedAt"=clock_timestamp() WHERE id=$1', [runId])
      return (fault === 'unavailable' ? { status: 503, body: {} } : {
        status: 200, body: { plan_type: 'plus', credits: { has_credits: false, unlimited: false },
          rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18_000, reset_at: Math.floor(Date.now() / 1000) + 3600 } } },
      }) as T
    })
    return () => reads
  }
  for (const cloud of [false, true]) await t.test('default Profile real ' + (cloud ? 'cloud' : 'local') + ' claim refreshes only its frozen shared quota after a delayed queue', async context => {
    const p = await seed('codex', cloud, true)
    const before = (await pool.query('SELECT "agentDefinition" FROM agent_runs WHERE id=$1', [p.runId])).rows[0].agentDefinition
    await staleProfileQuota(p)
    await assert.rejects((await import('../lib/factory/profile-admission')).assertRunProfileClaim(pool, p.runId), { message: 'agentProfileUnavailable' })
    const reads = await quotaReader(context, p)
    const response = await p.claim()
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    const body = await response.json(), after = (await pool.query('SELECT * FROM agent_runs WHERE id=$1', [p.runId])).rows[0]
    assert.equal(reads(), 1); assert.equal(after.status, 'preparing'); assert.ok(after.startedAt)
    assert.equal(after.sessionId, null)
    assert.equal(after.agentDefinition.model, before.model)
    assert.deepEqual(after.agentDefinition.agentProfile, before.agentProfile)
    assert.deepEqual(after.agentDefinition.subscription, before.subscription)
    assert.equal(after.agentDefinition.apiKey, undefined)
    assert.equal(body.subscriptionBinding.bindingId, before.subscription.bindingId)
    assert.equal(body.subscriptionBinding.ownerId, p.ownerId)
    assert.equal((await pool.query('SELECT 1 FROM byos_native_runs WHERE "runId"=$1 AND "bindingId"=$2', [p.runId, before.subscription.bindingId])).rowCount, 1)
  })
  for (const fault of ['share', 'revision', 'stop'] as const) await t.test('a ' + fault + ' change during the Profile quota read still prevents the real cloud claim', async context => {
    const p = await seed('codex', true, true)
    const before = (await pool.query('SELECT "agentDefinition" FROM agent_runs WHERE id=$1', [p.runId])).rows[0].agentDefinition
    await staleProfileQuota(p)
    const reads = await quotaReader(context, p, p.runId, fault)
    const response = await p.claim()
    assert.equal(response.status, 409, JSON.stringify(await response.clone().json()))
    const after = (await pool.query('SELECT * FROM agent_runs WHERE id=$1', [p.runId])).rows[0]
    assert.equal(reads(), 1); assert.equal(after.startedAt, null); assert.equal(after.sessionId, null)
    assert.equal((await pool.query('SELECT 1 FROM byos_native_runs WHERE "runId"=$1', [p.runId])).rowCount, 0)
    assert.deepEqual(after.agentDefinition, before)
    if (fault === 'stop') assert.ok(after.stopRequestedAt)
    else assert.equal(await (await import('../lib/computer/native-run-binding')).nativeRunBinding(pool, p.userId, p.agentId, p.harness, p.workspaceId, before.subscription.bindingId), null)
  })
  await t.test('a failed quota refresh does not revoke a started native Profile continuation at the real claim boundary', async context => {
    const p = await seed('codex', false, true)
    assert.equal((await p.claim()).status, 200)
    const original = (await pool.query('SELECT * FROM agent_runs WHERE id=$1', [p.runId])).rows[0]
    const sessionId = 'synthetic-profile-session-' + randomUUID()
    // The real HTTP claim above established the lease. This synthetic completion
    // supplies native execution evidence without making a model/provider call.
    await pool.query('UPDATE agent_runs SET status=\'succeeded\',"sessionId"=$2,"finishedAt"=clock_timestamp(),"leaseExpiresAt"=NULL WHERE id=$1', [p.runId, sessionId])
    await staleProfileQuota(p)
    const { dispatchToTask } = await import('../lib/thread-dispatch')
    const continued = await dispatchToTask(p.userId, p.issueId, { note: 'Continue the same native session.',
      start: async (previous, note) => {
        assert.equal(previous?.id, p.runId)
        return queueRun(p.userId, { issueId: p.issueId, agentId: p.agentId, repo: p.remote, model: p.model, note, readOnly: true,
          subscriptionBindingId: original.agentDefinition.subscription.bindingId,
          agentProfile: original.agentDefinition.agentProfile, modelDispatch: original.agentDefinition.modelDispatch, threadRunId: p.runId }, p.botId)
      },
    })
    if ('error' in continued) assert.fail(continued.error)
    assert.equal(continued.thread, 'continued')
    const queued = (await pool.query('SELECT * FROM agent_runs WHERE id=$1', [continued.runId])).rows[0]
    assert.equal(queued.agentDefinition.profileOriginRunId, p.runId); assert.equal(queued.continuesRunId, p.runId)
    await assert.rejects((await import('../lib/factory/agent-profile')).assertProfileSelection(pool, p.scope, queued.agentDefinition.agentProfile), { code: 'agentProfileModelUnavailable' })
    await (await import('../lib/factory/profile-admission')).assertRunProfileClaim(pool, queued.id)
    const reads = await quotaReader(context, p, queued.id, 'unavailable')
    const response = await p.claim(queued.id)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    const body = await response.json(), claimed = (await pool.query('SELECT * FROM agent_runs WHERE id=$1', [queued.id])).rows[0]
    assert.equal(reads(), 1); assert.equal(claimed.status, 'preparing'); assert.equal(claimed.sessionId, null)
    assert.equal(body.resumeSessionId, sessionId)
    assert.equal(body.continuesRunId, p.runId)
    assert.deepEqual(claimed.agentDefinition.agentProfile, original.agentDefinition.agentProfile)
    assert.deepEqual(claimed.agentDefinition.subscription, original.agentDefinition.subscription)
  })
  await t.test('unknown shared quota refresh uses the lender owner, not the task owner', async () => {
    const p = await seed('codex', false)
    await pool.query('UPDATE byos_connections SET quota=NULL WHERE id=$1', [p.connectionId])
    const calls: string[] = []
    const view = await order.checkOrderQuota(pool, p.scope, p.connectionId, async (scope, connectionId, _signal, credentialOwnerId) => {
      assert.equal(scope.ownerId, p.userId)
      assert.equal(connectionId, p.connectionId)
      calls.push(credentialOwnerId!)
      await pool.query('UPDATE byos_connections SET quota=$2::jsonb WHERE id=$1', [connectionId, JSON.stringify({ vendor: 'codex', source: 'official', status: 'ok', plan: null, observedAt: new Date().toISOString(), windows: [{ kind: 'five_hour', used: .2, resetsAt: new Date(Date.now() + 3_600_000).toISOString() }] })])
    })
    assert.deepEqual(calls, [p.ownerId])
    const subscription = view.entries.find(entry => entry.source.kind === 'subscription')!
    assert.notEqual(subscription.block?.reason, 'checking')
    assert.equal(view.candidates.find(candidate => candidate.source.kind === 'subscription')?.source.kind, 'subscription')
  })
  for (const provider of ['claude', 'codex'] as const) for (const cloud of [false, true]) {
    const label = `${provider} ${cloud ? 'cloud' : 'local'}`
    await t.test(`${label}: a teammate subscription is frozen and the real device claim succeeds`, async () => {
      const p = await seed(provider, cloud)
      const response = await p.claim()
      assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
      const body = await response.json()
      assert.equal(body.subscriptionBinding.ownerId, p.ownerId)
      assert.equal((await service.nativeRun(p.userId, p.worker.deviceId, p.runId)).ownerId, p.ownerId)
      await pool.query('UPDATE workspace_subscription_shares SET "allowOthers"=false WHERE "ownerId"=$1 AND "workspaceId"=$2', [p.ownerId, p.workspaceId])
      await assert.rejects(service.nativeRun(p.userId, p.worker.deviceId, p.runId), { code: 'account_unavailable' }, 'an existing run cannot renew after unsharing')
    })
    await t.test(`${label}: default native admission uses the run principal while custody remains with the lender`, async () => {
      const p = await seed(provider, cloud)
      const route = provider === 'claude' ? 'claude_code_cli' : 'codex_cli'
      const setPolicy = async (principal: string, revoked = false) => {
        const policy = { schemaVersion: 1, revoked, routes: [{ ...subscriptionModelRoute(route), model: p.model, servingProviders: [provider === 'claude' ? 'anthropic' : 'openai'], principalIds: [principal], dataRegions: ['unknown'] }] }
        await pool.query(`INSERT INTO workspace_computer_policies ("workspaceId",permission,model_admission) VALUES ($1,'allow',$2)
          ON CONFLICT ("workspaceId") DO UPDATE SET model_admission=excluded.model_admission`, [p.workspaceId, JSON.stringify(policy)])
      }
      await setPolicy(p.userId)
      assert.equal((await p.claim()).status, 200)
      const use = await service.nativeRun(p.userId, p.worker.deviceId, p.runId)
      assert.equal(use.ownerId, p.ownerId)
      const request = { path: provider === 'claude' ? '/v1/messages' : '/responses', headers: {}, body: { model: p.model, stream: true } }
      const allowed = async () => {
        const before = nativeCalls.length
        assert.equal((await service.nativeContext(use)).modelId, p.model)
        const response = await service.nativeRequest(use, request)
        assert.match(await new Response(response.body).text(), /fixture-native-response/)
        assert.ok(nativeCalls.length > before)
        assert.ok(nativeCalls.slice(before).every(call => call.ownerId === p.ownerId && call.runId === p.runId), 'provider custody keeps the lender identity')
      }
      await allowed()
      // Do not re-run nativeRun here: even a cached authorized use must still
      // obey current sharing, both members and the actual run's model policy.
      const assertBlocked = async (code?: string) => {
        const before = nativeCalls.length
        if (code) {
          await assert.rejects(service.nativeContext(use), { code })
          await assert.rejects(service.nativeRequest(use, request), { code })
        } else {
          await assert.rejects(service.nativeContext(use))
          await assert.rejects(service.nativeRequest(use, request))
        }
        assert.equal(nativeCalls.length, before, 'refusal reaches no provider worker')
      }
      await setPolicy(p.ownerId)
      await assertBlocked('modelRouteDenied')
      await setPolicy(p.userId, true)
      await assertBlocked('modelPolicyRevoked')
      await setPolicy(p.userId)
      for (const revoke of ['share', 'admin', 'lender-left', 'runner-left'] as const) {
        if (revoke === 'share') await pool.query('UPDATE workspace_subscription_shares SET "allowOthers"=false WHERE "ownerId"=$1 AND "workspaceId"=$2', [p.ownerId, p.workspaceId])
        else if (revoke === 'admin') await pool.query('INSERT INTO workspace_personal_policies ("workspaceId",subscriptions) VALUES ($1,false) ON CONFLICT ("workspaceId") DO UPDATE SET subscriptions=false', [p.workspaceId])
        else await pool.query(`UPDATE mikka_workspace_members SET status='suspended' WHERE "workspaceId"=$1 AND "userId"=$2`, [p.workspaceId, revoke === 'lender-left' ? p.ownerId : p.userId])
        await assertBlocked()
        if (revoke === 'share') await pool.query('UPDATE workspace_subscription_shares SET "allowOthers"=true WHERE "ownerId"=$1 AND "workspaceId"=$2', [p.ownerId, p.workspaceId])
        else if (revoke === 'admin') await pool.query('UPDATE workspace_personal_policies SET subscriptions=true WHERE "workspaceId"=$1', [p.workspaceId])
        else await pool.query(`UPDATE mikka_workspace_members SET status='active' WHERE "workspaceId"=$1 AND "userId"=$2`, [p.workspaceId, revoke === 'lender-left' ? p.ownerId : p.userId])
        await allowed()
      }
      const audit = await pool.query(`SELECT "actorId" AS principal FROM workspace_audit_events WHERE "workspaceId"=$1 AND action='model.admitted'`, [p.workspaceId])
      assert.ok(audit.rows.length > 0)
      assert.ok(audit.rows.every(row => row.principal === p.userId), 'admission audits the executor rather than the credential lender')
    })
    for (const revoke of ['share', 'admin', 'lender-left', 'runner-left'] as const) await t.test(`${label}: ${revoke} before claim refuses the frozen credential`, async () => {
      const p = await seed(provider, cloud)
      if (revoke === 'share') await pool.query('UPDATE workspace_subscription_shares SET "allowOthers"=false WHERE "ownerId"=$1 AND "workspaceId"=$2', [p.ownerId, p.workspaceId])
      else if (revoke === 'admin') await pool.query('INSERT INTO workspace_personal_policies ("workspaceId",subscriptions) VALUES ($1,false)', [p.workspaceId])
      else await pool.query(`UPDATE mikka_workspace_members SET status='suspended' WHERE "workspaceId"=$1 AND "userId"=$2`, [p.workspaceId, revoke === 'lender-left' ? p.ownerId : p.userId])
      assert.equal(await repository.nativeBinding(p.userId, p.agentId, p.harness, undefined, p.workspaceId), null)
      assert.equal((await p.claim()).status, 409)
      const offered = await order.orderCandidates(pool, p.scope)
      if (revoke !== 'runner-left') assert.equal(offered.some(item => item.source.kind === 'subscription' && item.source.connectionId === p.connectionId), false)
    })
  }
  await t.test('a cloud thread\'s next run keeps the thread\'s own model and subscription; one queued without a model fails', async () => {
    // The hosted runner starts only when the run's model equals the subscription context's; a continuation
    // queued without one was frozen with model null and failed every time with subscription_hosted_runtime_unavailable.
    const { latestThreadRunModel } = await import('../lib/computer/run-model')
    const p = await seed('claude', true)
    const first = (await pool.query('SELECT "issueId","agentDefinition" FROM agent_runs WHERE id=$1', [p.runId])).rows[0]
    const input = { botId: p.botId, issueId: first.issueId, agentId: p.agentId, deviceRepoId: p.repoId, title: 'Continue', body: '', readOnly: true, threadRunId: p.runId }
    const runs = async () => Number((await pool.query('SELECT count(*) FROM agent_runs WHERE "userId"=$1', [p.userId])).rows[0].count)
    const before = await runs()
    for (const model of [undefined, '', 'auto']) {
      await assert.rejects(queueCloudRun(pool, { userId: p.userId, workspaceId: p.workspaceId }, { ...input, model: model as string }), new RegExp(`Run model missing \\(run [0-9a-f-]+, thread ${p.runId}\\)`))
    }
    assert.equal(await runs(), before, 'nothing is written for a run without its model')
    const runModel = await latestThreadRunModel(pool, p.userId, first.issueId, p.agentId)
    assert.deepEqual(runModel, { model: p.model, subscriptionBindingId: first.agentDefinition.subscription.bindingId })
    const next = await queueCloudRun(pool, { userId: p.userId, workspaceId: p.workspaceId }, { ...input, ...runModel! })
    const definition = (await pool.query('SELECT "agentDefinition" FROM agent_runs WHERE id=$1', [next.runId])).rows[0].agentDefinition
    assert.equal(definition.modelSource, 'subscription')
    assert.equal(definition.subscription.bindingId, first.agentDefinition.subscription.bindingId)
    assert.equal(definition.subscription.modelId, p.model)
    assert.equal(definition.model, p.model)
    assert.equal(definition.cliModelSelection, 'explicit')
    // The thread's model no longer served by its subscription: refused, never swapped for another model.
    await assert.rejects(queueCloudRun(pool, { userId: p.userId, workspaceId: p.workspaceId }, { ...input, ...runModel!, model: 'another-model' }), { status: 409 })
  })
  await t.test('own subscription works across workspaces without a share or admin personal-use gate', async () => {
    const p = await seed('claude', false)
    const other = await seedWorkspace(pool, p.ownerId, [{ userId: p.ownerId, role: 'admin' }])
    await pool.query('INSERT INTO workspace_personal_policies ("workspaceId",subscriptions) VALUES ($1,false)', [other.id])
    const deviceId = randomUUID(), agentId = randomUUID()
    await pool.query(`INSERT INTO devices (id,"ownerId",name,kind,enabled,"lastSeenAt",harnesses) VALUES ($1,$2,'Lender local','local',true,now(),$3)`, [deviceId, p.ownerId, JSON.stringify(harnesses)])
    await pool.query('INSERT INTO agents (id,"userId","deviceId",harness,name) VALUES ($1,$2,$3,\'claude_code\',$4)', [agentId, p.ownerId, deviceId, `synthetic-${agentId}`])
    const target = await resolveModelDispatch(pool, { ownerId: p.ownerId, workspaceId: other.id, botId: null })
    assert.equal(target.kind, 'device')
    const binding = await repository.nativeBinding(p.ownerId, agentId, 'claude_code', undefined, other.id)
    assert.equal(binding?.connectionId, p.connectionId)
    assert.equal(binding?.workspaceId, other.id)
  })
})
