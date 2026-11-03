// Real dispatch metadata, queues, device claim HTTP and native-use authorization. Provider inference
// and E2B are not called: a shared subscription remains owned by its lender throughout the run.
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mock, test } from 'node:test'
import { DAEMON_PROTOCOL_VERSION } from '@mikka/protocol/daemon'
import { REPO_ORIGIN_HEADER } from '@mikka/protocol/device'
import { normalizeRepository } from '@mikka/protocol/repository'
import type { SubscriptionUse } from '@mikka/protocol/subscription'
import { subscriptionModelRoute } from '../lib/model-admission/contract'
import { dbUrl, seedBot, seedIssue, seedUser, seedWorkspace } from './support/workspace-admin-db'
import { fakeThreadMachines } from './support/thread-machine-fake'

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
  const harnesses = ['claude_code', 'codex'].map(harness => ({ harness, installed: true, toolApproval: true, subscriptionBroker: true }))
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
    for (const table of ['byos_bindings', 'byos_connections', 'workspace_subscription_shares', 'bot_desktops', 'cloud_machines']) await pool.query(`DELETE FROM ${table} WHERE "ownerId"=ANY($1)`, [users])
    for (const table of ['model_order_entries', 'model_order_settings']) await pool.query(`DELETE FROM ${table} WHERE "ownerId"=ANY($1)`, [users])
    for (const table of ['device_tokens', 'agents', 'device_repos']) await pool.query(`DELETE FROM ${table} WHERE "${table === 'agents' || table === 'device_repos' || table === 'device_tokens' ? 'userId' : 'ownerId'}"=ANY($1)`, [users])
    await pool.query('DELETE FROM devices WHERE "ownerId"=ANY($1)', [users])
    await Promise.all([pool.end(), appPool.end(), workspacePool.end()])
  })
  const seed = async (provider: 'claude' | 'codex', cloud: boolean) => {
    const ownerId = await seedUser(pool, 'shared-lender'), userId = await seedUser(pool, 'shared-runner')
    users.push(ownerId, userId)
    const workspace = await seedWorkspace(pool, userId, [{ userId, role: 'admin' }, { userId: ownerId, role: 'member' }])
    const workspaceId = workspace.id, botId = await seedBot(pool, workspaceId, userId), issueId = await seedIssue(pool, userId)
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
      await pool.query(`INSERT INTO cloud_machines ("workspaceId","ownerId","operationId","sandboxId","deviceId",state,"runtimeReady") VALUES ($1,$2,$3,$4,$5,'running',true)`, [workspaceId, userId, randomUUID(), `synthetic-${randomUUID()}`, deviceId])
      await pool.query('INSERT INTO bot_desktops ("botId","workspaceId","ownerId",display) VALUES ($1,$2,$3,1)', [botId, workspaceId, userId])
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
    const queued = cloud
      ? await queueCloudRun(pool, { userId, workspaceId }, { botId, issueId, agentId, deviceRepoId: repoId, title: 'Read', body: '', model, readOnly: true })
      : await queueRun(userId, { issueId, agentId, repo: remote, model, readOnly: true }, botId)
    const definition = (await pool.query('SELECT "agentDefinition" FROM agent_runs WHERE id=$1', [queued.runId])).rows[0].agentDefinition
    assert.equal(definition.modelSource, 'subscription')
    assert.equal(definition.apiKey, undefined, 'apiKeyAfterQuota=false also forbids an unintended paid-key substitution')
    const frozen = await repository.nativeBinding(userId, agentId, harness, definition.subscription.bindingId, workspaceId)
    assert.equal(frozen?.ownerId, ownerId, 'the lender remains the credential owner')
    const worker = cloud ? await threadMachines.start({ userId, workspaceId }, queued.runId) : { deviceId, token }
    const claim = () => claimRoute.POST(new Request(`http://127.0.0.1/v1/devices/${worker.deviceId}/runs/${queued.runId}/claim`, { method: 'POST', headers: { authorization: `Bearer ${worker.token}`, [REPO_ORIGIN_HEADER]: '1' } }), { params: Promise.resolve({ deviceId: worker.deviceId, runId: queued.runId }) })
    return { ownerId, userId, workspaceId, botId, agentId, harness, connectionId, model, scope, worker, runId: queued.runId, claim }
  }
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
  await t.test('a cloud thread\'s next run, queued without a model, freezes the subscription\'s own model', async () => {
    // The hosted runner starts only when the run's model equals the subscription context's; a
    // continuation that left the model out failed every time with subscription_hosted_runtime_unavailable.
    const p = await seed('claude', true)
    const issueId = await seedIssue(pool, p.userId)
    const repoId = (await pool.query('SELECT "deviceRepoId" FROM agent_runs WHERE id=$1', [p.runId])).rows[0].deviceRepoId
    for (const model of [undefined, 'auto'] as const) {
      const next = await queueCloudRun(pool, { userId: p.userId, workspaceId: p.workspaceId }, { botId: p.botId, issueId, agentId: p.agentId, deviceRepoId: repoId, title: 'Continue', body: '', readOnly: true, ...(model ? { model } : {}) })
      const definition = (await pool.query('SELECT "agentDefinition" FROM agent_runs WHERE id=$1', [next.runId])).rows[0].agentDefinition
      assert.equal(definition.modelSource, 'subscription')
      assert.equal(definition.subscription.modelId, p.model)
      assert.equal(definition.model, p.model, `model ${model ?? 'omitted'}`)
      assert.equal(definition.cliModelSelection, 'explicit')
    }
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
