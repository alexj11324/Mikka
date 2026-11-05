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
import type { FactorySnapshot } from './store'

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
  let useServiceUsage = false
  const usageCalls: { ownerId: string; connectionId: string }[] = []
  // Only existing provider usage I/O is replaced. Membership, authorization,
  // queue admission, frozen definitions and the final claim use real SQL.
  t.mock.module(new URL('../subscription-runtime.ts', import.meta.url).href, { namedExports: {
    ...subscriptionModule,
    subscriptionRuntime: () => useServiceUsage ? subscriptionModule.subscriptionRuntime() : ({
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
    return { ...f, source, current, attempt, candidate, run }
  }
  await t.test('CC implementation selects independent Codex Review with frozen exact Profile and subscription', async () => { await exercise(true, false) })
  await t.test('a prepared sleeping parent gains its missing Codex metadata without provider I/O', async () => { await exercise(true, true) })
  await t.test('no configured Profile retains CC despite Codex being first in model preference', async () => { await exercise(false, false) })
  const profileRefusal = 'The selected Agent Profile changed or is no longer available. Select an available Profile for a new run.'
  const unclaimedReview = async () => {
    const f = await exercise(false, false)
    // Persist the exact host claim-refusal shape. No worker claim, session,
    // model invocation or question exists; the producer and its artifact stay real.
    await pool.query(`UPDATE agent_runs SET status='failed',"stopReason"='blocked',error=$2,
      report=$3,"finishedAt"=now(),"updatedAt"=now() WHERE id=$1 AND status='queued'`,
    [f.run.id, profileRefusal, JSON.stringify({ summary: profileRefusal, filesChanged: [], verify: { status: 'not_run' }, openQuestions: [], nextStep: null })])
    const { createFactoryQuestions } = await import('./questions/store')
    const { factoryCheckAssignment } = await import('./checks')
    const { reconcileFactoryCheck } = await import('./reconcile-check')
    const questions = createFactoryQuestions(pool,
      async (owner, issueId, tx) => (await tx.query('SELECT 1 FROM issues WHERE id=$1 AND "userId"=$2', [issueId, owner])).rowCount === 1,
      f.store, async () => { throw new Error('An unclaimed refusal cannot start a question continuation') },
      (tx, task, id) => factoryCheckAssignment(tx, task.userId, id))
    const reconcile = createFactoryReconciler(pool, f.store, questions, { review: reconcileFactoryCheck, verify: reconcileFactoryCheck }, f.botId)
    await reconcile.run(f.ownerId, f.run.id)
    return { ...f, blocked: await f.store.read(f.ownerId, f.task.id) }
  }
  const { createFactoryHumanStore } = await import('./human-store')
  const humanStore = (dispatch = automaticFactoryDispatch(pool)) => createFactoryHumanStore(pool, botId => createFactoryStore(pool,
    async (owner, issueId, tx) => (await tx.query('SELECT 1 FROM issues WHERE id=$1 AND "userId"=$2', [issueId, owner])).rowCount === 1,
    botId, { independent: factoryCheckIndependent, gates: factoryCheckGates }), dispatch)
  await t.test('an unclaimed Profile refusal stays an independent-check block, not a question-recovery mismatch', async () => {
    const f = await unclaimedReview()
    assert.equal(f.blocked.task.status, 'blocked')
    assert.equal(f.blocked.task.stage, 'review')
    assert.equal(f.blocked.task.candidateId, f.candidate.id)
    assert.equal(f.blocked.task.sourceEventId, f.sourceEventId)
    assert.equal(f.blocked.task.reason, `Independent check blocked: ${profileRefusal}`)
    assert.deepEqual(f.blocked.checkStartRecovery, { binding: { taskId: f.task.id, revision: f.blocked.task.revision } })
    assert.equal((await pool.query('SELECT 1 FROM factory_questions WHERE "taskId"=$1', [f.task.id])).rowCount, 0)
    assert.equal((await pool.query('SELECT 1 FROM agent_runs WHERE "issueId"=$1', [f.issueId])).rowCount, 2)
    assert.equal(f.blocked.attempts.filter(a => a.stage === 'execute').length, 1)
  })
  await t.test('Owner retry starts the unclaimed review on its frozen source without a new execution or model selection', async () => {
    const f = await unclaimedReview()
    assert.equal(f.blocked.task.route.flowVersion, 2)
    // Existing production rows retain the old question-mismatch reason and no
    // check-completion receipt. Eligibility must not require a backfill.
    const legacyReason = 'Question recovery blocked: factoryQuestionRunMismatch'
    await pool.query('UPDATE factory_tasks SET reason=$2 WHERE id=$1', [f.task.id, legacyReason])
    await pool.query('UPDATE factory_attempts SET reason=$2,output=$3 WHERE id=$1',
      [f.attempt.id, legacyReason, JSON.stringify({ ...f.attempt.output, runId: f.run.id })])
    const { factoryEventId } = await import('./event-id')
    await pool.query('DELETE FROM factory_events WHERE "taskId"=$1 AND "eventId"=$2', [f.task.id, factoryEventId('check-completion', f.run.id)])
    assert.deepEqual((await f.store.read(f.ownerId, f.task.id)).checkStartRecovery, f.blocked.checkStartRecovery)
    // Production's prepared parent can already be parked. The same producer
    // must still authorize its runtime; a failed check cannot impersonate it.
    await pool.query("UPDATE cloud_machines SET state='sleeping' WHERE \"workspaceId\"=$1 AND \"ownerId\"=$2", [f.workspaceId, f.ownerId])
    // A newly preferred independent role must not replace the source already
    // frozen for this acceptance case when the person asks to retry it.
    const otherProfile = await new profiles.AgentProfileStore(pool).create(f.scope, {
      name: 'Different review source', description: 'Synthetic independent role introduced after refusal', roles: ['Review'],
      harness: 'codex', model: { mode: 'fixed', harness: 'codex', model: model.codex, source: { kind: 'subscription', connectionId: f.connections.codex } },
      instructions: 'PRIVATE_PROFILE_Different_review', skills: ['independent-review'], effort: 'low',
    })
    decisionProfile = otherProfile.id
    const human = humanStore()
    const beforeCalls = decisionCalls, beforeHandoffs = handoffs.length
    const beforeRun = (await pool.query('SELECT * FROM agent_runs WHERE id=$1', [f.run.id])).rows[0]
    const beforeProducer = (await pool.query('SELECT * FROM agent_runs WHERE id=$1', [f.source.runId])).rows[0]
    const eventId = randomUUID(), binding = { taskId: f.task.id, revision: f.blocked.task.revision }
    const change = { action: 'retry' as const, reason: 'Retry the same independent review after its allowance is available.' }
    const { handleFactory } = await import('./http')
    // The same authenticated-session adapter input used by the Owner route:
    // identity stays outside the JSON body, and the same-origin POST owns retry.
    const request = { userId: f.ownerId, method: 'POST', taskId: f.task.id, origin: 'https://app.example',
      url: `https://app.example/api/factory/tasks/${f.task.id}`, body: { binding, eventId, ...change } }
    const detail = await handleFactory(human, { ...request, method: 'GET' })
    assert.equal(detail.status, 200)
    assert.deepEqual((detail.body as { checkStartRecovery?: unknown }).checkStartRecovery, f.blocked.checkStartRecovery)
    assert.deepEqual(await handleFactory(human, { ...request, userId: null }), { status: 401, body: { error: 'authRequired' } })
    assert.deepEqual(await handleFactory(human, { ...request, origin: 'https://other.example' }), { status: 403, body: { error: 'originRejected' } })
    assert.deepEqual(await handleFactory(human, { ...request, body: { ...request.body, binding: { ...binding, taskId: randomUUID() } } }),
      { status: 422, body: { error: 'factoryInvalid' } })
    const [response, duplicate] = await Promise.all([handleFactory(human, request), handleFactory(human, request)])
    assert.equal(response.status, 200)
    assert.deepEqual(duplicate, response, 'concurrent copies of one Owner POST commit only one queue receipt')
    const result = response.body as FactorySnapshot
    assert.equal(result.task.stage, 'review')
    assert.equal(result.task.status, 'running', 'the Owner action must queue and bind work, not leave an orphan pending attempt')
    assert.equal(result.task.revision, f.blocked.task.revision + 2)
    assert.equal(result.task.candidateId, f.candidate.id)
    assert.equal(result.task.sourceEventId, f.sourceEventId)
    assert.notEqual(result.task.attemptId, f.attempt.id)
    assert.equal(result.attempts.filter(a => a.stage === 'execute').length, 1)
    const nextAttempt = result.attempts.find(a => a.id === result.task.attemptId)
    assert.ok(nextAttempt?.runId)
    const next = (await pool.query('SELECT * FROM agent_runs WHERE id=$1', [nextAttempt.runId])).rows[0]
    assert.equal(next.status, 'queued')
    assert.equal(next.kind, 'acceptance')
    assert.equal(next.baseBranch, f.run.baseBranch)
    assert.equal(next.agentDefinition.harness, 'claude_code')
    assert.equal(next.agentDefinition.model, model.claude_code)
    assert.deepEqual(next.agentDefinition.subscription, f.run.agentDefinition.subscription)
    assert.deepEqual(next.agentDefinition.agentProfile, f.run.agentDefinition.agentProfile)
    assert.deepEqual(next.agentDefinition.modelDispatch, f.run.agentDefinition.modelDispatch)
    assert.equal(next.agentDefinition.readOnly, true)
    for (const key of ['sessionId', 'startedAt', 'leaseExpiresAt', 'continuesRunId', 'retryOf', 'questionContinuation']) assert.equal(next[key], null, key)
    assert.equal(next.agentDefinition.profileOriginRunId, undefined)
    assert.equal(decisionCalls, beforeCalls, 'an explicit retry never asks a model to choose another source')
    assert.equal(handoffs.length, beforeHandoffs + 1)
    assert.deepEqual(handoffs.at(-1), { previous: f.run.id, runId: next.id })
    assert.deepEqual((await pool.query('SELECT * FROM agent_runs WHERE id=$1', [f.run.id])).rows[0], beforeRun)
    assert.deepEqual((await pool.query('SELECT * FROM agent_runs WHERE id=$1', [f.source.runId])).rows[0], beforeProducer)
    assert.deepEqual(await handleFactory(human, request), response, 'the same Owner event replays its bound queue receipt')
    assert.deepEqual(await handleFactory(human, { ...request, body: { ...request.body, reason: 'Changed intent' } }),
      { status: 409, body: { error: 'factoryReplayMismatch' } })
    assert.equal(handoffs.length, beforeHandoffs + 1, 'a replay cannot start another handoff')
    assert.equal((await pool.query('SELECT 1 FROM agent_runs WHERE "issueId"=$1', [f.issueId])).rowCount, 3)
  })
  await t.test('claimed, continued, stale or active work never acquires unstarted-review recovery', async t => {
    const f = await unclaimedReview(), human = humanStore(), binding = factoryBinding(f.blocked.task)
    const beforeRun = (await pool.query('SELECT * FROM agent_runs WHERE id=$1', [f.run.id])).rows[0]
    const beforeAttempt = (await pool.query('SELECT * FROM factory_attempts WHERE id=$1', [f.attempt.id])).rows[0]
    const beforeHandoffs = handoffs.length
    const runChange = (column: string, value: unknown) => async () => {
      await pool.query(`UPDATE agent_runs SET "${column}"=$2 WHERE id=$1`, [f.run.id, value])
      return async () => { await pool.query(`UPDATE agent_runs SET "${column}"=$2 WHERE id=$1`, [f.run.id, beforeRun[column]]) }
    }
    const cases: [string, () => Promise<() => Promise<void>>][] = [
      ['claimed start', runChange('startedAt', new Date())],
      ['native session', runChange('sessionId', 'synthetic-existing-session')],
      ['worker lease', runChange('leaseExpiresAt', new Date(Date.now() + 60_000))],
      ['native thread continuation', runChange('continuesRunId', f.source.runId)],
      ['provider retry lineage', runChange('retryOf', f.source.runId)],
      ['question continuation', runChange('questionContinuation', { originRunId: f.source.runId, requireSessionResume: true })],
      ['native Profile origin grant', runChange('agentDefinition', { ...beforeRun.agentDefinition, profileOriginRunId: f.source.runId })],
      ['attempt session', async () => {
        await pool.query('UPDATE factory_attempts SET "sessionId"=$2 WHERE id=$1', [f.attempt.id, 'synthetic-attempt-session'])
        return async () => { await pool.query('UPDATE factory_attempts SET "sessionId"=NULL WHERE id=$1', [f.attempt.id]) }
      }],
      ['actual native tool observation', async () => {
        const id = randomUUID()
        await pool.query('INSERT INTO run_chunks (id,"runId",seq,chunk) VALUES ($1,$2,1,$3)',
          [id, f.run.id, JSON.stringify({ type: 'tool-output-available', toolCallId: 'synthetic-observation', output: 'A command already ran' })])
        return async () => { await pool.query('DELETE FROM run_chunks WHERE id=$1', [id]) }
      }],
      ['changed request epoch', async () => {
        await pool.query(`UPDATE factory_attempts SET output=jsonb_set(output,'{requestEpoch}',to_jsonb($2::text)) WHERE id=$1`, [f.attempt.id, randomUUID()])
        return async () => { await pool.query('UPDATE factory_attempts SET output=$2 WHERE id=$1', [f.attempt.id, beforeAttempt.output]) }
      }],
      ['changed candidate SHA assignment', async () => {
        await pool.query(`UPDATE factory_attempts SET output=jsonb_set(output,'{check,sha}',to_jsonb($2::text)) WHERE id=$1`, [f.attempt.id, 'c'.repeat(40)])
        return async () => { await pool.query('UPDATE factory_attempts SET output=$2 WHERE id=$1', [f.attempt.id, beforeAttempt.output]) }
      }],
      ['another live task run', async () => {
        await pool.query("UPDATE agent_runs SET status='running' WHERE id=$1", [f.source.runId])
        return async () => { await pool.query("UPDATE agent_runs SET status='succeeded' WHERE id=$1", [f.source.runId]) }
      }],
      ['a real question on the producer attempt', async () => {
        const id = randomUUID()
        await pool.query(`INSERT INTO factory_questions (id,"userId","issueId","taskId","attemptId",stage,"originRunId","originSessionId","originRevision","waitingBinding",kind,question,request,status,reason,"sourceEventId")
          VALUES ($1,$2,$3,$4,$5,'execute',$6,$7,1,$8,'context','Synthetic unresolved question','{}','waiting_user','Needs an Owner answer',$9)`,
        [id,f.ownerId,f.issueId,f.task.id,f.source.task.attemptId,f.source.runId,`claude-native-${f.source.runId}`,JSON.stringify(binding),f.sourceEventId])
        return async () => { await pool.query('DELETE FROM factory_questions WHERE id=$1', [id]) }
      }],
      ['ordinary failed check keeps its separate retry semantics', async () => {
        await pool.query("UPDATE factory_tasks SET status='failed' WHERE id=$1", [f.task.id])
        await pool.query("UPDATE factory_attempts SET status='failed' WHERE id=$1", [f.attempt.id])
        return async () => {
          await pool.query("UPDATE factory_tasks SET status='blocked' WHERE id=$1", [f.task.id])
          await pool.query("UPDATE factory_attempts SET status='blocked' WHERE id=$1", [f.attempt.id])
        }
      }],
    ]
    for (const [name, set] of cases) await t.test(name, async () => {
      const undo = await set()
      try {
        assert.equal((await f.store.read(f.ownerId, f.task.id)).checkStartRecovery, undefined)
        await assert.rejects(human.apply(f.ownerId, binding, randomUUID(), { action: 'retry', reason: 'Retry this same review' }),
          (error: { code?: string }) => ['factoryTransition','factoryStale'].includes(error.code ?? ''))
        assert.equal((await pool.query('SELECT 1 FROM agent_runs WHERE "issueId"=$1', [f.issueId])).rowCount, 2)
        assert.equal((await pool.query('SELECT 1 FROM factory_attempts WHERE "taskId"=$1', [f.task.id])).rowCount, f.blocked.attempts.length)
        assert.equal(handoffs.length, beforeHandoffs)
      } finally { await undo() }
    })
  })
  await t.test('paused or revoked sources return 409, while unknown receipt failure still rolls back and throws', async () => {
    const f = await unclaimedReview(), human = humanStore(), binding = { taskId: f.task.id, revision: f.blocked.task.revision }
    const before = await f.store.read(f.ownerId, f.task.id), beforeHandoffs = handoffs.length
    const beforeEvents = (await pool.query('SELECT 1 FROM factory_events WHERE "taskId"=$1', [f.task.id])).rowCount
    const change = { action: 'retry' as const, reason: 'Retry only the existing review' }
    const { handleFactory } = await import('./http')
    const request = () => ({ userId: f.ownerId, method: 'POST', taskId: f.task.id, origin: 'https://app.example',
      url: `https://app.example/api/factory/tasks/${f.task.id}`, body: { binding, eventId: randomUUID(), ...change } })
    for (const sourceState of ['paused', 'revoked'] as const) {
      await pool.query('UPDATE byos_connections SET paused=$2,state=$3 WHERE id=$1',
        [f.connections.claude_code, sourceState === 'paused', sourceState === 'revoked' ? 'disconnected' : 'connected'])
      assert.deepEqual(await handleFactory(human, request()), { status: 409, body: { error: 'agentProfileUnavailable' } })
      await assert.rejects(human.apply(f.ownerId, binding, randomUUID(), change),
        (error: { code?: string; cause?: { status?: number; message?: string } }) => error.code === 'agentProfileUnavailable' &&
          error.cause?.status === 409 && error.cause?.message === 'Bot subscription unavailable')
      await pool.query("UPDATE byos_connections SET paused=false,state='connected' WHERE id=$1", [f.connections.claude_code])
      assert.deepEqual(await f.store.read(f.ownerId, f.task.id), before)
      assert.equal((await pool.query('SELECT 1 FROM agent_runs WHERE "issueId"=$1', [f.issueId])).rowCount, 2)
      assert.equal((await pool.query('SELECT 1 FROM factory_events WHERE "taskId"=$1', [f.task.id])).rowCount, beforeEvents)
      assert.equal(handoffs.length, beforeHandoffs)
    }
    await pool.query(`CREATE FUNCTION reject_check_start_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.request->>'kind'='owner_check_start_recovery' THEN RAISE EXCEPTION 'synthetic check retry receipt failure'; END IF; RETURN NEW; END $$`)
    await pool.query('CREATE TRIGGER reject_check_start_receipt BEFORE INSERT ON factory_events FOR EACH ROW EXECUTE FUNCTION reject_check_start_receipt()')
    try {
      await assert.rejects(handleFactory(human, request()), /synthetic check retry receipt failure/)
      assert.deepEqual(await f.store.read(f.ownerId, f.task.id), before)
      assert.equal((await pool.query('SELECT 1 FROM agent_runs WHERE "issueId"=$1', [f.issueId])).rowCount, 2)
      assert.equal((await pool.query(`SELECT 1 FROM factory_events WHERE "taskId"=$1 AND request->>'kind'='owner_check_start_recovery'`, [f.task.id])).rowCount, 0)
      assert.equal((await pool.query('SELECT 1 FROM factory_events WHERE "taskId"=$1', [f.task.id])).rowCount, beforeEvents)
      assert.equal(handoffs.length, beforeHandoffs)
    } finally {
      await pool.query('DROP TRIGGER reject_check_start_receipt ON factory_events')
      await pool.query('DROP FUNCTION reject_check_start_receipt()')
    }
  })
  await t.test('Owner frozen-check recovery rechecks membership at the real commit and rolls back revocation', async () => {
    const f = await unclaimedReview(), dispatch = automaticFactoryDispatch(pool)
    const before = await f.store.read(f.ownerId, f.task.id), beforeHandoffs = handoffs.length, beforeDecisions = decisionCalls
    const beforeEvents = (await pool.query('SELECT 1 FROM factory_events WHERE "taskId"=$1', [f.task.id])).rowCount
    let queued = false
    const human = humanStore(async (tx, store, task, run, recovery) => {
      const start = await dispatch(tx, store, task, run, recovery)
      assert.equal((await tx.query('SELECT 1 FROM agent_runs WHERE "issueId"=$1', [f.issueId])).rowCount, 3)
      queued = true
      // A different workspace connection commits revocation after actual queue
      // admission, before the APP transaction's final authorization/COMMIT.
      await pool.query("UPDATE mikka_workspace_members SET status='suspended' WHERE \"workspaceId\"=$1 AND \"userId\"=$2", [f.workspaceId, f.ownerId])
      return start
    })
    const { handleFactory } = await import('./http')
    const request = { userId: f.ownerId, method: 'POST', taskId: f.task.id, origin: 'https://app.example',
      url: `https://app.example/api/factory/tasks/${f.task.id}`, body: { binding: { taskId: f.task.id, revision: f.blocked.task.revision },
        eventId: randomUUID(), action: 'retry', reason: 'Retry only the frozen independent review' } }
    try {
      await assert.rejects(handleFactory(human, request), { code: 'agentProfileScopeNotFound' },
        'the Owner POST must not commit an already queued check after membership was revoked')
      assert.equal(queued, true, 'this exercises final commit authority, not an early queue refusal')
      assert.equal((await pool.query('SELECT 1 FROM agent_runs WHERE "issueId"=$1', [f.issueId])).rowCount, 2)
      assert.equal((await pool.query('SELECT 1 FROM factory_attempts WHERE "taskId"=$1', [f.task.id])).rowCount, before.attempts.length)
      assert.equal((await pool.query('SELECT 1 FROM factory_events WHERE "taskId"=$1', [f.task.id])).rowCount, beforeEvents)
      assert.equal(handoffs.length, beforeHandoffs)
      assert.equal(decisionCalls, beforeDecisions, 'membership revalidation cannot reselect the frozen model')
    } finally {
      await pool.query("UPDATE mikka_workspace_members SET status='active' WHERE \"workspaceId\"=$1 AND \"userId\"=$2", [f.workspaceId, f.ownerId])
    }
    assert.deepEqual(await f.store.read(f.ownerId, f.task.id), before)
  })
  for (const quotaResult of ['fresh', 'available', 'exhausted', 'unknown', 'disconnect', 'pause', 'epoch'] as const) await t.test({
    fresh: 'default Profile admits explicitly named Codex after another preferred Harness',
    available: 'default Profile refreshes the same Codex quota after cloud preparation outlives its 60-second observation',
    exhausted: 'a refreshed exhausted allowance still refuses the original Profile without switching sources',
    unknown: 'a failed allowance read remains unknown and cannot admit the original Profile',
    disconnect: 'a disconnect during allowance refresh wins over the stale selected binding',
    pause: 'a pause during allowance refresh still prevents the selected subscription from running',
    epoch: 'a new connection revision during allowance refresh cannot refresh or reuse the old binding',
  }[quotaResult], async t => {
    const slowPreparation = quotaResult !== 'fresh'
    const f = await fixture(false, false), beforeDecisions = decisionCalls
    const chatBotId = await seedBot(pool, f.workspaceId, f.ownerId), issueId = await seedIssue(pool, f.ownerId), sourceEventId = randomUUID()
    await pool.query(`INSERT INTO coordinator_events (id,"userId","botId","issueId",kind,"dedupeKey",payload) VALUES ($1::uuid,$2,$3,$4,'user_message',$1::text,'{"text":"Run the explicit Codex task"}')`, [sourceEventId, f.ownerId, chatBotId, issueId])
    await pool.query('UPDATE model_order_settings SET "preferredHarness"=\'claude_code\' WHERE "ownerId"=$1 AND "workspaceId"=$2', [f.ownerId, f.workspaceId])
    await pool.query('UPDATE model_order_entries SET position=position+100 WHERE "ownerId"=$1 AND "workspaceId"=$2', [f.ownerId, f.workspaceId])
    await pool.query('UPDATE model_order_entries SET position=CASE WHEN harness=\'claude_code\' THEN 0 ELSE 1 END WHERE "ownerId"=$1 AND "workspaceId"=$2', [f.ownerId, f.workspaceId])
    assert.equal((await pool.query('SELECT 1 FROM factory_agent_profiles WHERE "ownerId"=$1 AND "workspaceId"=$2', [f.ownerId, f.workspaceId])).rowCount, 0)
    const selected = await profiles.resolveAgentProfileDispatch(pool, f.scope, {
      issueId, stage: 'execute', location: 'cloud', cloudPurpose: 'desktop',
      asked: { harness: 'codex', model: model.codex },
    })
    const target = selected.target
    assert.equal(target.kind, 'cloud')
    if (target.kind !== 'cloud') assert.fail('The named Codex source must resolve on the prepared fixture')
    assert.equal(target.harness, 'codex'); assert.equal(target.model, model.codex)
    assert.equal(selected.agentProfile?.profileId, 'default'); assert.equal(selected.agentProfile?.source, 'default')
    assert.equal(selected.selectionMode, 'picked')
    assert.deepEqual(target.entry.source, { kind: 'subscription', connectionId: f.connections.codex })
    const subscriptionBindingId = await bindAgentToConnection(pool, f.scope, f.agents.codex, 'codex', f.connections.codex, model.codex)
    const { SubscriptionWorkerClient } = await import('../../packages/daemon/src/subscription-worker-client')
    const syntheticRuntime = {
      MIKKA_BYOS_INFISICAL_ORIGIN: 'http://127.0.0.1:1', MIKKA_BYOS_INFISICAL_PROJECT: 'synthetic-quota',
      MIKKA_BYOS_INFISICAL_ENVIRONMENT: 'test', MIKKA_BYOS_INFISICAL_PATH: '/synthetic-custody',
      MIKKA_BYOS_ACCESS_INFISICAL_PATH: '/synthetic-access', MIKKA_BYOS_INFISICAL_TOKEN: 'synthetic-custody-token',
      MIKKA_BYOS_ACCESS_INFISICAL_TOKEN: 'synthetic-distinct-access-token', MIKKA_BYOS_SHARED_CUSTODY_IDENTITY: '0',
    }
    const originalRuntime = Object.fromEntries(Object.keys(syntheticRuntime).map(key => [key, process.env[key]]))
    Object.assign(process.env, syntheticRuntime)
    t.after(() => { for (const [key, value] of Object.entries(originalRuntime)) if (value === undefined) delete process.env[key]; else process.env[key] = value })
    let quotaReads = 0, preflightUnlocked = false
    t.mock.method(SubscriptionWorkerClient.prototype, 'call', async function<T>(method: string, input: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
      assert.equal(method, 'usage', 'the quota preflight cannot send inference or acquire a new binding')
      assert.equal(input.revision, 1); assert.ok(signal); assert.equal(signal.aborted, false)
      quotaReads++
      // The actual service/repository parse and save the synthetic provider
      // response. No provider process runs; all authorization stays real.
      assert.equal((await pool.query('SELECT 1 FROM agent_runs WHERE "issueId"=$1', [issueId])).rowCount, 0)
      assert.equal((await pool.query('SELECT 1 FROM factory_tasks WHERE "issueId"=$1', [issueId])).rowCount, 0)
      const probe = await pool.connect()
      try {
        await probe.query('BEGIN')
        await probe.query('SELECT 1 FROM byos_connections WHERE id=$1 FOR UPDATE NOWAIT', [f.connections.codex])
        preflightUnlocked = true
      } finally { await probe.query('ROLLBACK'); probe.release() }
      if (quotaResult === 'disconnect') await pool.query(`UPDATE byos_connections SET state='disconnected',epoch=epoch+1 WHERE id=$1`, [f.connections.codex])
      if (quotaResult === 'pause') await pool.query('UPDATE byos_connections SET paused=true WHERE id=$1', [f.connections.codex])
      if (quotaResult === 'epoch') await pool.query('UPDATE byos_connections SET epoch=epoch+1 WHERE id=$1', [f.connections.codex])
      if (quotaResult === 'unknown') return { status: 503, body: {} } as T
      return { status: 200, body: { plan_type: 'plus', credits: { has_credits: false, unlimited: false },
        rate_limit: { primary_window: { used_percent: quotaResult === 'exhausted' ? 100 : 10, limit_window_seconds: 18_000, reset_at: Math.floor(Date.now() / 1000) + 3600 } } } } as T
    })
    if (slowPreparation) {
      const observedAt = new Date(Date.now() - 60_001).toISOString()
      await pool.query(`UPDATE byos_connections SET quota=jsonb_set(quota,'{observedAt}',to_jsonb($2::text)) WHERE id=$1`, [f.connections.codex, observedAt])
      const { quota } = (await pool.query('SELECT quota FROM byos_connections WHERE id=$1', [f.connections.codex])).rows[0]
      assert.equal((await import('../subscription-quota')).subscriptionAvailability(quota, model.codex, 'codex').status, 'checking')
      await assert.rejects(profiles.assertProfileSelection(pool, f.scope, selected.agentProfile!), { code: 'agentProfileModelUnavailable' })
    }
    const { queueFactoryCloudRun } = await import('./queue-cloud')
    // These queue cases replace worker I/O above; retain the real service's
    // quota parser and revision-fenced save without the final-claim stub.
    useServiceUsage = true
    t.after(() => { useServiceUsage = false })
    const resultPending = queueFactoryCloudRun(pool, f.actor, {
      botId: f.botId, factoryBotId: chatBotId, issueId, agentId: f.agents.codex, deviceRepoId: f.repoId,
      title: 'Synthetic default Codex task', body: 'Validate original default Profile admission without provider I/O.',
      model: model.codex, subscriptionBindingId, agentProfile: selected.agentProfile,
      modelDispatch: { mode: 'picked', location: 'cloud', entry: target.entry },
      idempotencyKey: `coordinator:${randomUUID()}`, sourceEventId,
    })
    if (quotaResult !== 'fresh' && quotaResult !== 'available') {
      await assert.rejects(resultPending, ['disconnect', 'pause', 'epoch'].includes(quotaResult) ? { message: 'Bot subscription unavailable' } : { name: 'AgentProfileAdmissionError', message: 'agentProfileUnavailable' })
      assert.equal(quotaReads, 1); assert.equal(preflightUnlocked, true)
      assert.equal((await pool.query('SELECT 1 FROM agent_runs WHERE "issueId"=$1', [issueId])).rowCount, 0)
      assert.equal((await pool.query('SELECT 1 FROM factory_tasks WHERE "issueId"=$1', [issueId])).rowCount, 0)
      assert.deepEqual(selected.agentProfile?.targetEntry.source, { kind: 'subscription', connectionId: f.connections.codex })
      if (quotaResult === 'disconnect' || quotaResult === 'epoch') {
        const { quota } = (await pool.query('SELECT quota FROM byos_connections WHERE id=$1', [f.connections.codex])).rows[0]
        assert.equal((await import('../subscription-quota')).subscriptionAvailability(quota, model.codex, 'codex').status, 'checking', 'the old-revision provider response cannot save a new quota observation')
      }
      assert.equal(decisionCalls, beforeDecisions)
      return
    }
    const result = await resultPending
    const run = (await pool.query('SELECT * FROM agent_runs WHERE id=$1', [result.runId])).rows[0]
    assert.equal(run.status, 'queued'); assert.equal(run.agentId, f.agents.codex)
    assert.equal(run.agentDefinition.harness, 'codex'); assert.equal(run.agentDefinition.model, model.codex)
    assert.equal(run.agentDefinition.modelSource, 'subscription')
    assert.equal(run.agentDefinition.subscription.bindingId, subscriptionBindingId)
    assert.equal(run.agentDefinition.agentProfile.profileId, 'default')
    assert.equal(run.agentDefinition.agentProfile.source, 'default')
    assert.deepEqual(run.agentDefinition.agentProfile.targetEntry.source, { kind: 'subscription', connectionId: f.connections.codex })
    await (await import('./profile-admission')).assertRunProfileClaim(pool, result.runId)
    assert.equal((await pool.query('SELECT 1 FROM agent_runs WHERE "issueId"=$1', [issueId])).rowCount, 1)
    assert.equal((await pool.query('SELECT 1 FROM factory_tasks WHERE "issueId"=$1 AND "botId"=$2', [issueId, chatBotId])).rowCount, 1)
    assert.equal(decisionCalls, beforeDecisions, 'The zero-configuration named model requires no Profile Decision')
    assert.equal(quotaReads, slowPreparation ? 1 : 0, 'only the selected stale subscription needs one real service refresh')
    assert.equal(preflightUnlocked, slowPreparation, 'no source row is locked across the provider usage read')
  })
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
