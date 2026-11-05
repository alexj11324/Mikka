// Production resolver, cloud queue, stage dispatcher and worker freeze on real
// PostgreSQL. Reports, subscriptions and Decision transport are synthetic;
// provider lifecycle is observed at its boundary, never called or claimed live.
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { Pool } from 'pg'
import { dbUrl, seedUser, seedWorkspace, seedBot, seedIssue } from '../../tests/support/workspace-admin-db'
import { dropTestDatabase } from '../../tests/support/drop-test-database'
import { templateModelsFixture } from '../../tests/support/template-models'
import { orderMigrations } from '../../scripts/migration-order.mjs'
import type { DecisionAnswer } from '../coordinator/decision'
import type { OrderHarness } from '../model-order-plan'

process.env.MIKKA_BYOS_ENABLED = '1'
process.env.MIKKA_BYOS_VALIDATED_MODEL_ROUTES = 'claude_cpa,codex_cpa'

test('real PG: independent cross-Harness Profile stages and recorded cloud runtimes', { skip: !dbUrl, timeout: 120_000 }, async t => {
  assert.ok(dbUrl)
  const admin = new Pool({ connectionString: dbUrl })
  const database = `factory_profile_dispatch_${randomUUID().replaceAll('-', '')}_e2e`
  await admin.query(`CREATE DATABASE "${database}"`)
  const isolated = new URL(dbUrl); isolated.pathname = `/${database}`
  const url = isolated.toString()
  const old = { E2E_DATABASE_URL: process.env.E2E_DATABASE_URL, MIKKA_DATABASE_URL: process.env.MIKKA_DATABASE_URL, DATABASE_URL: process.env.DATABASE_URL }
  Object.assign(process.env, { E2E_DATABASE_URL: url, MIKKA_DATABASE_URL: url, DATABASE_URL: url })
  const pool = new Pool({ connectionString: url, max: 12, options: '-c statement_timeout=15000 -c lock_timeout=5000' })
  let appPool: Pool | undefined, workspacePool: Pool | undefined
  t.after(async () => {
    await dropTestDatabase(admin, database, pool, appPool, workspacePool)
    await admin.end()
    for (const [key, value] of Object.entries(old)) if (value === undefined) delete process.env[key]; else process.env[key] = value
  })
  assert.equal(Math.floor(Number((await pool.query('SHOW server_version_num')).rows[0].server_version_num) / 10000), 17)
  const migrations = new URL('../../drizzle/', import.meta.url)
  for (const file of orderMigrations((await readdir(migrations)).filter(f => f.endsWith('.sql')))) await pool.query(await readFile(new URL(file, migrations), 'utf8'))

  const subscriptionModule = await import('../subscription-runtime')
  let usageProbe: (ownerId: string, connectionId: string, signal: AbortSignal) => Promise<void> = async () => { throw new Error('Unexpected subscription usage probe') }
  const usageCalls: { ownerId: string; connectionId: string }[] = []
  // Only existing provider usage I/O is replaced. Membership, authorization,
  // queue admission, frozen definitions and the final claim use real SQL.
  t.mock.module(new URL('../subscription-runtime.ts', import.meta.url).href, { namedExports: {
    ...subscriptionModule,
    subscriptionRuntime: () => ({
      member: subscriptionModule.authorizeSubscriptionWorkspace,
      workspace: subscriptionModule.authorizeSubscriptionWorkspace,
      usage: async (ownerId: string, connectionId: string, signal: AbortSignal) => {
        usageCalls.push({ ownerId, connectionId })
        assert.equal(signal.aborted, false)
        await usageProbe(ownerId, connectionId, signal)
      },
    }),
  } })
  let decisionProfile = '', decisionCalls = 0
  const decisionInputs: unknown[] = []
  t.mock.module(new URL('../coordinator/decide.ts', import.meta.url).href, { namedExports: {
    invokeDecision: async (_purpose: string, input: unknown, questions: unknown) => {
      decisionCalls++; decisionInputs.push(input)
      const serialized = JSON.stringify(input)
      for (const privateText of ['PRIVATE_PROFILE_', 'connectionId', 'synthetic-subscription-', 'providerSubject']) assert.ok(!serialized.includes(privateText), privateText)
      assert.ok(serialized.includes('review'))
      assert.ok(JSON.stringify(questions).includes(decisionProfile))
      return { answers: new Map<string, Exclude<DecisionAnswer, { type: 'refusal' }>>([
        ['profile', { name: 'profile', type: 'choice', choice: decisionProfile, confidence: .95 }],
        ['reason', { name: 'reason', type: 'choice', choice: 'stage_fit' }],
      ]), execution: { executionId: randomUUID(), modelId: 'openai/gpt-6-luna-decisions', providerGenerationId: 'synthetic-profile-stage', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), requestDigest: 'a'.repeat(64), imageDigests: [], vision: 'no-image-input' } }
    },
  } })
  const modules = await Promise.all([
    import('../db'), import('../workspace-db'), import('./agent-profile'), import('../model-dispatch'),
    import('../computer/queue-run'), import('./store'), import('./dispatch'), import('./reconcile'),
    import('./automatic-dispatch'), import('./checks'), import('./check-independence'),
    import('../agent-kit/worker-digest'), import('../computer/bot-runtime-records'),
  ])
  appPool = modules[0].pool; workspacePool = modules[1].workspacePool
  const [, , profiles, { bindAgentToConnection }, { queueCloudRun }, { createFactoryStore }, { createFactoryDispatch, factoryBinding },
    { createFactoryReconciler }, { automaticFactoryDispatch, factoryAutomaticRuntime }, { factoryCheckGates }, { factoryCheckIndependent },
    { workerDefinitionDigest }, { ensureRecordedBotHarnessRuntime }] = modules
  const handoffs: { previous: string | null; runId: string }[] = []
  t.mock.method(factoryAutomaticRuntime, 'enqueue', async (_pool: Pool, _actor: unknown, previous: string | null, runId: string) => { handoffs.push({ previous, runId }) })
  t.mock.method(factoryAutomaticRuntime, 'park', async () => { throw new Error('Provider park must stay outside dispatch') })
  t.mock.method(factoryAutomaticRuntime, 'start', async () => { throw new Error('Provider start must stay outside dispatch') })
  const model = { claude_code: 'claude-haiku-5-5', codex: 'gpt-6-luna' } as const
  const caps = () => (['claude_code', 'codex'] as const).map(harness => ({ harness, installed: true, models: [model[harness]], subscriptionBroker: true, computerBroker: true }))
  const template = templateModelsFixture(Object.values(model)); t.after(() => template.restore())
  const fixture = async (withProfiles = true, missingCodex = false) => {
    const ownerId = await seedUser(pool, 'profile-stage')
    const { id: workspaceId } = await seedWorkspace(pool, ownerId, [{ userId: ownerId, role: 'admin' }])
    await pool.query("UPDATE mikka_workspaces SET kind='personal' WHERE id=$1", [workspaceId])
    const botId = await seedBot(pool, workspaceId, ownerId), issueId = await seedIssue(pool, ownerId)
    const scope = { ownerId, workspaceId, botId }, actor = { userId: ownerId, workspaceId }
    const sourceEventId = randomUUID(), deviceId = randomUUID(), repoId = randomUUID()
    const agents = { claude_code: randomUUID(), codex: randomUUID() }, connections = { claude_code: randomUUID(), codex: randomUUID() }
    await pool.query(`INSERT INTO coordinator_events (id,"userId","botId","issueId",kind,"dedupeKey",payload) VALUES ($1::uuid,$2,$3,$4,'user_message',$1::text,'{"text":"Create a checked deliverable"}')`, [sourceEventId, ownerId, botId, issueId])
    await pool.query(`INSERT INTO user_e2b_keys ("userId",ciphertext,iv,"keyVersion",last4) VALUES ($1,'synthetic-unopened','synthetic-unopened',1,'test')`, [ownerId])
    await pool.query(`INSERT INTO model_order_settings ("ownerId","workspaceId",location,customized) VALUES ($1,$2,'cloud',true)`, [ownerId, workspaceId])
    await pool.query(`INSERT INTO devices (id,"ownerId",name,kind,enabled,"lastSeenAt",harnesses) VALUES ($1,$2,'Prepared cloud fixture','cloud',true,now(),$3)`, [deviceId, ownerId, JSON.stringify(caps())])
    await pool.query(`INSERT INTO cloud_machines ("workspaceId","ownerId","deviceId","sandboxId","operationId",state,"runtimeReady") VALUES ($1,$2,$3,$4,$5,'running',true)`, [workspaceId, ownerId, deviceId, `synthetic-machine-${deviceId}`, randomUUID()])
    await pool.query(`INSERT INTO bot_desktops ("botId","workspaceId","ownerId",display) VALUES ($1,$2,$3,1)`, [botId, workspaceId, ownerId])
    await pool.query(`INSERT INTO device_repos (id,"deviceId","userId","repoPath","baseBranch") VALUES ($1,$2,$3,$4,'main')`, [repoId, deviceId, ownerId, `/home/user/.mikka/bot-workspaces/${botId}`])
    for (const [position, harness] of (['codex', 'claude_code'] as const).entries()) {
      const provider = harness === 'codex' ? 'codex' : 'claude'
      const quota = { vendor: harness, source: 'official', status: 'ok', plan: null, observedAt: new Date().toISOString(), windows: [{ kind: 'five_hour', used: .1, resetsAt: new Date(Date.now() + 3_600_000).toISOString() }] }
      await pool.query(`INSERT INTO byos_connections (id,"ownerId","workspaceId",provider,state,epoch,"secretName","secretDigest","providerSubject","modelCatalog",quota) VALUES ($1,$2,$3,$4,'connected',1,$5,$6,'synthetic-subject',$7,$8)`, [connections[harness], ownerId, workspaceId, provider, `synthetic-subscription-${connections[harness]}`, 'a'.repeat(64), JSON.stringify({ revision: '1', models: [model[harness]] }), JSON.stringify(quota)])
      await pool.query(`INSERT INTO byos_bindings (id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision",route,"modelId") VALUES ($1,$2,$3,'catalogue',$4,1,$5,$6)`, [randomUUID(), ownerId, workspaceId, connections[harness], harness === 'codex' ? 'codex_cpa' : 'claude_cpa', model[harness]])
      await pool.query(`INSERT INTO model_order_entries (id,"ownerId","workspaceId",position,harness,model,"sourceKind","sourceId") VALUES ($1,$2,$3,$4,$5,$6,'subscription',$7)`, [randomUUID(), ownerId, workspaceId, position, harness, model[harness], connections[harness]])
      if (missingCodex && harness === 'codex') continue
      await pool.query('INSERT INTO agents (id,"userId",name,harness,"deviceId") VALUES ($1,$2,$3,$4,$5)', [agents[harness], ownerId, `Cloud ${harness} ${botId}`, harness, deviceId])
      await pool.query('INSERT INTO bot_cloud_runtimes ("botId","workspaceId","ownerId",harness,"agentId","repoId") VALUES ($1,$2,$3,$4,$5,$6)', [botId, workspaceId, ownerId, harness, agents[harness], repoId])
    }
    const profileStore = new profiles.AgentProfileStore(pool)
    const definition = (harness: OrderHarness, role: string) => ({ name: role, description: `${role} public capability`, roles: [role], harness, model: { mode: 'fixed', harness, model: model[harness], source: { kind: 'subscription', connectionId: connections[harness] } }, instructions: `PRIVATE_PROFILE_${role}`, skills: [role === 'Review' ? 'independent-review' : 'systematic-debugging'], effort: 'low' })
    const implement = withProfiles ? await profileStore.create(scope, definition('claude_code', 'Implement')) : null
    const review = withProfiles ? await profileStore.create(scope, definition('codex', 'Review')) : null
    const store = createFactoryStore(pool, async (userId, id, tx) => (await tx.query('SELECT 1 FROM issues WHERE id=$1 AND "userId"=$2', [id, userId])).rowCount === 1, botId, { independent: factoryCheckIndependent, gates: factoryCheckGates })
    const routed = await store.route(ownerId, { issueId, sourceEventId, eventId: randomUUID(), rationale: 'Synthetic subscription profile stage fixture' })
    return { scope, actor, ownerId, workspaceId, botId, issueId, sourceEventId, deviceId, repoId, agents, connections, implement, review, store, task: routed.task }
  }
  const exercise = async (withProfiles: boolean, missingCodex: boolean) => {
    const f = await fixture(withProfiles, missingCodex), beforeDecisions = decisionCalls
    const selected = withProfiles ? await profiles.resolveAgentProfileDispatch(pool, f.scope, { issueId: f.issueId, profileId: f.implement!.id, location: 'cloud', cloudPurpose: 'desktop' }) : null
    assert.equal(selected?.target.kind ?? 'cloud', 'cloud')
    const subscriptionBindingId = await bindAgentToConnection(pool, f.scope, f.agents.claude_code, 'claude_code', f.connections.claude_code, model.claude_code)
    const dispatch = createFactoryDispatch(pool, f.store, (tx, _owner, _input, _bot, context) => queueCloudRun(pool, f.actor, {
      botId: f.botId, issueId: f.issueId, agentId: f.agents.claude_code, deviceRepoId: f.repoId,
      title: 'Create a checked deliverable', body: 'Synthetic actual-queue fixture', model: model.claude_code, subscriptionBindingId,
      ...(selected?.agentProfile ? { agentProfile: selected.agentProfile } : {}),
      idempotencyKey: `factory:${context.attemptId}`, sourceEventId: context.sourceEventId,
    }, tx))
    const source = await dispatch(f.ownerId, { binding: factoryBinding(f.task), agentId: f.agents.claude_code, deviceRepoId: f.repoId })
    const sha = 'a'.repeat(40), deliverySha = 'b'.repeat(40), nativeSession = `claude-native-${source.runId}`
    await pool.query(`UPDATE agent_runs SET status='succeeded',"startedAt"=now(),"finishedAt"=now(),"sessionId"=$2,"stopReason"='submitted',report=$3 WHERE id=$1`, [source.runId, nativeSession, JSON.stringify({ sourceCommit: sha, deliverableCommit: deliverySha, summary: 'Synthetic successful implementation and validation report', runtime: { observedModel: model.claude_code } })])
    const sourceBefore = (await pool.query('SELECT * FROM agent_runs WHERE id=$1', [source.runId])).rows[0]
    if (missingCodex) await pool.query(`UPDATE cloud_machines SET state='sleeping' WHERE "workspaceId"=$1 AND "ownerId"=$2`, [f.workspaceId, f.ownerId])
    decisionProfile = f.review?.id ?? ''
    const reconciler = createFactoryReconciler(pool, f.store, undefined, {}, f.botId, automaticFactoryDispatch(pool))
    await reconciler.run(f.ownerId, source.runId)
    const current = (await pool.query('SELECT * FROM factory_tasks WHERE id=$1', [f.task.id])).rows[0]
    assert.equal(current.stage, 'review', current.reason); assert.equal(current.status, 'running', current.reason)
    assert.equal(current.route.flowVersion, 2)
    const attempt = (await pool.query('SELECT * FROM factory_attempts WHERE id=$1', [current.attemptId])).rows[0]
    const candidate = (await pool.query('SELECT * FROM factory_candidates WHERE id=$1', [current.candidateId])).rows[0]
    const run = (await pool.query('SELECT * FROM agent_runs WHERE id=$1', [attempt.runId])).rows[0]
    const expectedHarness = withProfiles ? 'codex' : 'claude_code'
    const runtime = (await pool.query('SELECT * FROM bot_cloud_runtimes WHERE "botId"=$1 AND harness=$2', [f.botId, expectedHarness])).rows[0]
    assert.equal(run.agentId, runtime.agentId); assert.equal(run.issueId, f.issueId); assert.equal(run.botId, f.botId)
    assert.equal(attempt.taskId, f.task.id); assert.equal(attempt.candidateId, candidate.id)
    assert.equal(candidate.runId, source.runId); assert.equal(candidate.taskId, f.task.id)
    assert.equal(run.baseBranch, deliverySha); assert.equal(run.status, 'queued')
    for (const key of ['sessionId', 'continuesRunId', 'retryOf', 'questionContinuation']) assert.equal(run[key], null, key)
    assert.equal(run.agentDefinition.profileOriginRunId, undefined)
    assert.equal(run.agentDefinition.harness, expectedHarness); assert.equal(run.agentDefinition.model, model[expectedHarness])
    assert.equal(run.agentDefinition.modelSource, 'subscription'); assert.equal(run.agentDefinition.readOnly, true)
    assert.equal(run.agentDefinition.definitionDigest, workerDefinitionDigest(run.agentDefinition))
    const binding = (await pool.query('SELECT * FROM byos_bindings WHERE id=$1', [run.agentDefinition.subscription.bindingId])).rows[0]
    assert.equal(binding.connectionId, f.connections[expectedHarness]); assert.equal(binding.consumerId, runtime.agentId)
    const frozen = run.agentDefinition.agentProfile
    if (withProfiles) {
      assert.equal(frozen.profileId, f.review!.id); assert.equal(frozen.version, f.review!.version); assert.equal(frozen.digest, f.review!.digest)
      assert.equal(frozen.source, 'decision'); assert.equal(frozen.effort, 'low')
      assert.equal(frozen.targetEntry.source.connectionId, f.connections.codex)
      assert.match(run.prompt, /PRIVATE_PROFILE_Review/)
      assert.equal(sourceBefore.agentDefinition.agentProfile.profileId, f.implement!.id)
      assert.equal(decisionCalls, beforeDecisions + 1)
    } else {
      assert.equal(frozen.profileId, 'default'); assert.equal(frozen.source, 'default')
      assert.equal(decisionCalls, beforeDecisions, 'legacy same-Harness fallback does not invoke Decision')
    }
    assert.deepEqual(handoffs.at(-1), { previous: source.runId, runId: run.id })
    assert.deepEqual((await pool.query('SELECT * FROM agent_runs WHERE id=$1', [source.runId])).rows[0], sourceBefore)
    await reconciler.run(f.ownerId, source.runId)
    assert.equal((await pool.query("SELECT 1 FROM factory_attempts WHERE \"taskId\"=$1 AND stage='review'", [f.task.id])).rowCount, 1)
    assert.equal((await pool.query("SELECT 1 FROM factory_attempts WHERE \"taskId\"=$1 AND stage='verify'", [f.task.id])).rowCount, 0)
    assert.equal((await pool.query('SELECT 1 FROM agent_runs WHERE "issueId"=$1', [f.issueId])).rowCount, 2)
    if (missingCodex) { assert.notEqual(runtime.agentId, f.agents.codex); assert.equal(runtime.repoId, f.repoId) }
  }
  await t.test('CC implementation selects independent Codex Review with frozen exact Profile and subscription', async () => exercise(true, false))
  await t.test('a prepared sleeping parent gains its missing Codex metadata without provider I/O', async () => exercise(true, true))
  await t.test('no configured Profile retains CC despite Codex being first in model preference', async () => exercise(false, false))
  await t.test('record initialization rejects foreign scope, unreported Harness and unprepared workspace', async () => {
    const f = await fixture(false, true)
    const invoke = async (actor = f.actor, harness = 'codex') => {
      const tx = await pool.connect()
      try { await tx.query('BEGIN'); const value = await ensureRecordedBotHarnessRuntime(tx, actor, f.botId, harness); await tx.query('COMMIT'); return value }
      catch (error) { await tx.query('ROLLBACK'); throw error } finally { tx.release() }
    }
    assert.equal(await invoke({ ...f.actor, userId: 'foreign-owner' }), null)
    assert.equal(await invoke({ ...f.actor, workspaceId: randomUUID() }), null)
    assert.equal(await invoke(f.actor, 'unknown-harness'), null)
    await pool.query('UPDATE devices SET harnesses=$2 WHERE id=$1', [f.deviceId, JSON.stringify(caps().filter(h => h.harness !== 'codex'))])
    assert.equal(await invoke(), null)
    await pool.query('UPDATE devices SET harnesses=$2,enabled=false WHERE id=$1', [f.deviceId, JSON.stringify(caps())])
    assert.equal(await invoke(), null)
    await pool.query('UPDATE devices SET enabled=true WHERE id=$1', [f.deviceId])
    await pool.query('UPDATE device_repos SET "repoPath"=\'/not-the-prepared-bot-workspace\' WHERE id=$1', [f.repoId])
    assert.equal(await invoke(), null)
    assert.equal((await pool.query("SELECT 1 FROM bot_cloud_runtimes WHERE \"botId\"=$1 AND harness='codex'", [f.botId])).rowCount, 0)
  })
  const { claimCloudRun } = await import('../computer/claim')
  const { assertRunProfileClaim, AgentProfileAdmissionError } = await import('./profile-admission')
  const { rebindExecutionDevice } = await import('../execution-identity')
  const claimFixture = async () => {
    const f = await fixture()
    const selected = await profiles.resolveAgentProfileDispatch(pool, f.scope, { issueId: f.issueId, profileId: f.implement!.id, location: 'cloud', cloudPurpose: 'desktop' })
    const subscriptionBindingId = await bindAgentToConnection(pool, f.scope, f.agents.claude_code, 'claude_code', f.connections.claude_code, model.claude_code)
    const { runId } = await queueCloudRun(pool, f.actor, {
      botId: f.botId, issueId: f.issueId, agentId: f.agents.claude_code, deviceRepoId: f.repoId,
      title: 'Claim the frozen Profile', body: 'Synthetic freshness boundary', model: model.claude_code,
      subscriptionBindingId, agentProfile: selected.agentProfile, readOnly: true,
    })
    // The same handoff as provisioning, with no provider or model call.
    const threadDevice = randomUUID()
    await pool.query(`INSERT INTO devices(id,"ownerId",name,kind,enabled) VALUES ($1,$2,'Prepared thread fixture','cloud',true)`, [threadDevice, f.ownerId])
    await pool.query(`UPDATE thread_machines SET state='running',"deviceId"=$2,"sandboxId"=$3 WHERE "runId"=$1`, [runId, threadDevice, `synthetic-thread-${runId}`])
    const source = (await pool.query('SELECT * FROM agent_runs WHERE id=$1', [runId])).rows[0]
    const definition = await rebindExecutionDevice(pool, source, threadDevice, pool)
    await pool.query('UPDATE agent_runs SET "deviceId"=$2,"agentDefinition"=$3 WHERE id=$1', [runId, threadDevice, JSON.stringify(definition)])
    return { ...f, runId, threadDevice, subscriptionBindingId, definition }
  }
  const claim = (f: Awaited<ReturnType<typeof claimFixture>>) => claimCloudRun(pool, f.actor, f.runId, f.threadDevice, new Date(Date.now() + 30_000), f.subscriptionBindingId, undefined, undefined, false)
  const refreshQuota = async (connectionId: string, used = .1) => {
    await pool.query(`UPDATE byos_connections SET quota=jsonb_set(jsonb_set(quota,'{observedAt}',$2::jsonb),'{windows,0,used}',$3::jsonb) WHERE id=$1`, [connectionId, JSON.stringify(new Date().toISOString()), JSON.stringify(used)])
  }
  const unchangedRun = async (f: Awaited<ReturnType<typeof claimFixture>>, status = 'queued') => {
    const rows = (await pool.query('SELECT * FROM agent_runs WHERE "issueId"=$1', [f.issueId])).rows
    assert.equal(rows.length, 1, 'freshness does not dispatch a replacement run')
    assert.equal(rows[0].id, f.runId); assert.equal(rows[0].status, status)
    assert.deepEqual(rows[0].agentDefinition, f.definition, 'the exact Profile, model and credential remain frozen')
  }
  await t.test('queue Available crosses 60s before claim; one exact-source usage refresh admits the original run', async t => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
    const f = await claimFixture(), before = usageCalls.length
    await assertRunProfileClaim(pool, f.runId)
    t.mock.timers.tick(60_000)
    await assertRunProfileClaim(pool, f.runId)
    t.mock.timers.tick(1)
    await assert.rejects(assertRunProfileClaim(pool, f.runId), AgentProfileAdmissionError, 'the unchanged final gate rejects the expired snapshot')
    usageProbe = async (ownerId, connectionId) => {
      assert.equal(ownerId, f.ownerId); assert.equal(connectionId, f.connections.claude_code)
      // An independent connection must be able to write: no claim/source row
      // share lock may surround the asynchronous provider refresh.
      await refreshQuota(connectionId)
    }
    assert.ok(await claim(f))
    assert.deepEqual(usageCalls.slice(before), [{ ownerId: f.ownerId, connectionId: f.connections.claude_code }])
    await unchangedRun(f, 'preparing')
    assert.equal((await pool.query('SELECT "bindingId" FROM byos_native_runs WHERE "runId"=$1', [f.runId])).rows[0].bindingId, f.subscriptionBindingId)
  })
  await t.test('a failed final refresh preserves a still-fresh legal snapshot', async t => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
    const f = await claimFixture(), before = usageCalls.length
    t.mock.timers.tick(59_000)
    const quota = (await pool.query('SELECT quota FROM byos_connections WHERE id=$1', [f.connections.claude_code])).rows[0].quota
    usageProbe = async () => { throw new Error('Synthetic usage unavailable') }
    assert.ok(await claim(f))
    assert.equal(usageCalls.length - before, 1)
    assert.deepEqual((await pool.query('SELECT quota FROM byos_connections WHERE id=$1', [f.connections.claude_code])).rows[0].quota, quota)
    await unchangedRun(f, 'preparing')
  })
  for (const fault of ['usage-error', 'still-unknown', 'quota', 'disconnect', 'pause', 'epoch', 'profile', 'model', 'stop'] as const) {
    await t.test(`final Profile claim still refuses ${fault} after its one usage probe`, async t => {
      t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
      const f = await claimFixture(), before = usageCalls.length
      t.mock.timers.tick(60_001)
      usageProbe = async (ownerId, connectionId) => {
        assert.equal(ownerId, f.ownerId); assert.equal(connectionId, f.connections.claude_code)
        if (fault === 'usage-error') throw new Error('Synthetic usage unavailable')
        if (fault === 'still-unknown') return
        await refreshQuota(connectionId, fault === 'quota' ? 1 : .1)
        if (fault === 'disconnect') await pool.query(`UPDATE byos_connections SET state='disconnected' WHERE id=$1`, [connectionId])
        if (fault === 'pause') await pool.query('UPDATE byos_connections SET paused=true WHERE id=$1', [connectionId])
        if (fault === 'epoch') await pool.query('UPDATE byos_connections SET epoch=epoch+1 WHERE id=$1', [connectionId])
        if (fault === 'profile') await pool.query('UPDATE factory_agent_profiles SET version=version+1 WHERE id=$1', [f.implement!.id])
        if (fault === 'model') await pool.query(`UPDATE byos_bindings SET "modelId"='changed-model' WHERE id=$1`, [f.subscriptionBindingId])
        if (fault === 'stop') await pool.query('UPDATE agent_runs SET "stopRequestedAt"=now() WHERE id=$1', [f.runId])
      }
      if (['usage-error', 'still-unknown', 'quota', 'profile'].includes(fault)) await assert.rejects(claim(f), AgentProfileAdmissionError)
      else assert.equal(await claim(f), null)
      assert.deepEqual(usageCalls.slice(before), [{ ownerId: f.ownerId, connectionId: f.connections.claude_code }])
      await unchangedRun(f)
      assert.equal((await pool.query('SELECT 1 FROM byos_native_runs WHERE "runId"=$1', [f.runId])).rowCount, 0)
    })
  }
  assert.equal(decisionInputs.length, 2)
})
