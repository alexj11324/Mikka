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
  let decisionProfile = ''
  const decisionInputs: { purpose: string; input: unknown; questions: unknown; profileId: string }[] = []
  const decisionCounts = () => ({
    profile: decisionInputs.filter(call => call.purpose === 'factory-agent-profile').length,
    model: decisionInputs.filter(call => call.purpose === 'task-model-routing').length,
  })
  t.mock.module(new URL('../coordinator/decide.ts', import.meta.url).href, { namedExports: {
    invokeDecision: async (purpose: string, input: unknown, questions: unknown) => {
      decisionInputs.push({ purpose, input, questions, profileId: decisionProfile })
      // A legacy Profile may route its inherited model, independently of Profile
      // selection. Exercise its unavailable-decision fallback deliberately.
      if (purpose === 'task-model-routing') return null
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
  const fixture = async (withProfiles = true, missingCodex = false, inherit = false) => {
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
    const implement = withProfiles ? await profileStore.create(scope, inherit ? {
      name: 'Frontend', description: 'Implement responsive frontend behavior and validate it.', roles: ['execute', 'frontend'],
      harness: 'claude_code', model: { mode: 'inherit' },
      instructions: 'PRIVATE_PROFILE_frontend-v1\nImplement the requested UI and report concrete validation.',
      skills: ['implementation-evidence'],
    } : definition('claude_code', 'Implement')) : null
    const review = withProfiles ? await profileStore.create(scope, definition('codex', 'Review')) : null
    const store = createFactoryStore(pool, async (userId, id, tx) => (await tx.query('SELECT 1 FROM issues WHERE id=$1 AND "userId"=$2', [id, userId])).rowCount === 1, botId, { independent: factoryCheckIndependent, gates: factoryCheckGates })
    const routed = await store.route(ownerId, { issueId, sourceEventId, eventId: randomUUID(), rationale: 'Synthetic subscription profile stage fixture' })
    return { scope, actor, ownerId, workspaceId, botId, issueId, sourceEventId, deviceId, repoId, agents, connections, implement, review, store, task: routed.task }
  }
  const exercise = async (withProfiles: boolean, missingCodex: boolean) => {
    const f = await fixture(withProfiles, missingCodex), beforeDecisions = decisionCounts()
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
      assert.deepEqual(decisionCounts(), { profile: beforeDecisions.profile + 1, model: beforeDecisions.model }, 'a fixed Profile selects its role once without model routing')
    } else {
      assert.equal(frozen.profileId, 'default'); assert.equal(frozen.source, 'default')
      assert.deepEqual(decisionCounts(), { profile: beforeDecisions.profile, model: beforeDecisions.model + 1 }, 'legacy same-Harness fallback routes its model once without Profile selection')
      assert.equal(run.agentDefinition.modelDispatch.routing.reason, 'decision_unavailable')
    }
    assert.deepEqual(handoffs.at(-1), { previous: source.runId, runId: run.id })
    assert.deepEqual((await pool.query('SELECT * FROM agent_runs WHERE id=$1', [source.runId])).rows[0], sourceBefore)
    const afterDecisions = decisionCounts()
    await reconciler.run(f.ownerId, source.runId)
    assert.deepEqual(decisionCounts(), afterDecisions, 'reconciling the same source again does not repeat either Decision')
    assert.equal((await pool.query("SELECT 1 FROM factory_attempts WHERE \"taskId\"=$1 AND stage='review'", [f.task.id])).rowCount, 1)
    assert.equal((await pool.query("SELECT 1 FROM factory_attempts WHERE \"taskId\"=$1 AND stage='verify'", [f.task.id])).rowCount, 0)
    assert.equal((await pool.query('SELECT 1 FROM agent_runs WHERE "issueId"=$1', [f.issueId])).rowCount, 2)
    if (missingCodex) { assert.notEqual(runtime.agentId, f.agents.codex); assert.equal(runtime.repoId, f.repoId) }
  }
  await t.test('Decision rejection retains closed diagnostics and filtered availability without creating a run or binding', async t => {
    const f = await fixture(), profileStore = new profiles.AgentProfileStore(pool)
    const disabled = await profileStore.create(f.scope, { name: 'PRIVATE_DISABLED_PROFILE', description: 'PRIVATE_DISABLED_CAPABILITY', enabled: false, harness: 'codex', model: { mode: 'inherit' } })
    await pool.query('UPDATE byos_connections SET quota=NULL WHERE id=$1', [f.connections.codex])
    const oldUsageProbe = usageProbe; usageProbe = async () => {}
    const warnings: string[] = []
    const warning = t.mock.method(console, 'warn', (line: unknown) => { warnings.push(String(line)) })
    const beforeBindings = (await pool.query('SELECT * FROM byos_bindings WHERE "ownerId"=$1 ORDER BY id', [f.ownerId])).rows
    const execution = { executionId: randomUUID(), modelId: 'openai/gpt-6-luna-decisions' as const, providerGenerationId: 'PRIVATE_PROVIDER_GENERATION', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), requestDigest: 'a'.repeat(64), imageDigests: [], vision: 'no-image-input' as const }
    const privateAnswer = 'PRIVATE_RAW_DECISION_RESPONSE'
    const responses = [
      { detail: 'decision_unavailable', answers: null },
      { detail: 'invalid_profile_answer', answers: new Map<string, Exclude<DecisionAnswer, { type: 'refusal' }>>() },
      { detail: 'no_suitable_profile', answers: new Map<string, Exclude<DecisionAnswer, { type: 'refusal' }>>([
        ['profile', { name: 'profile', type: 'choice', choice: 'none' }], ['reason', { name: 'reason', type: 'choice', choice: 'uncertain' }],
      ]) },
      { detail: 'unknown_profile', answers: new Map<string, Exclude<DecisionAnswer, { type: 'refusal' }>>([
        ['profile', { name: 'profile', type: 'choice', choice: privateAnswer }], ['reason', { name: 'reason', type: 'choice', choice: 'stage_fit' }],
      ]) },
    ]
    try {
      for (const response of responses) {
        let decisions = 0
        await assert.rejects(profiles.resolveAgentProfileDispatch(pool, f.scope, { issueId: f.issueId, stage: 'review', location: 'cloud', cloudPurpose: 'desktop' }, {
          decision: async (purpose, input, questions, _signal, diagnostics) => {
            decisions++
            assert.equal(purpose, 'factory-agent-profile'); assert.deepEqual(diagnostics, { retainInvalidReceipt: true })
            assert.ok(!JSON.stringify(input).includes('PRIVATE_PROFILE_Implement'))
            const choices = questions[0].type === 'choice' ? questions[0].choices.map(item => item.value) : []
            assert.deepEqual(choices, [f.implement!.id, 'none'])
            return response.answers ? { answers: response.answers, execution } : null
          },
        }), error => {
          assert.ok(error instanceof profiles.AgentProfileError)
          assert.equal(error.code, 'agentProfileDecisionUnavailable'); assert.equal(error.message, 'agentProfileDecisionUnavailable')
          assert.equal(error.status, 409); assert.equal(error.detail, response.detail)
          return true
        })
        assert.equal(decisions, 1)
        const logged = JSON.parse(warnings.at(-1)!)
        assert.equal(logged.code, 'agentProfileDecisionUnavailable'); assert.equal(logged.detail, response.detail)
        assert.equal(logged.issueId, f.issueId); assert.equal(logged.stage, 'review')
        assert.equal(logged.candidateCount, 1); assert.equal(logged.candidateIds, f.implement!.id)
        assert.equal(logged.profileCount, 3); assert.equal(logged.profileDiagnosticsTruncated, false)
        assert.deepEqual(new Set(logged.profileAvailability.split(',')), new Set([`${f.implement!.id}:available`, `${f.review!.id}:checking`, `${disabled.id}:disabled`]))
        assert.equal(logged.decisionExecutionId, response.answers ? execution.executionId : undefined)
        assert.deepEqual(logged.causes, [])
      }
      assert.equal(warnings.length, responses.length)
      for (const forbidden of [privateAnswer, 'PRIVATE_PROFILE_', disabled.name, disabled.description, execution.providerGenerationId, f.ownerId, f.connections.codex, f.connections.claude_code]) assert.ok(!warnings.join('\n').includes(forbidden), forbidden)
      assert.deepEqual((await pool.query('SELECT * FROM byos_bindings WHERE "ownerId"=$1 ORDER BY id', [f.ownerId])).rows, beforeBindings)
      assert.equal((await pool.query('SELECT 1 FROM agent_runs WHERE "issueId"=$1', [f.issueId])).rowCount, 0)
    } finally { warning.mock.restore(); usageProbe = oldUsageProbe }
  })
  await t.test('CC implementation selects independent Codex Review with frozen exact Profile and subscription', async () => exercise(true, false))
  await t.test('a prepared sleeping parent gains its missing Codex metadata without provider I/O', async () => exercise(true, true))
  await t.test('no configured Profile retains CC despite Codex being first in model preference', async () => exercise(false, false))
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
    const f = await fixture(false, false), beforeDecisions = decisionCounts()
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
      assert.deepEqual(decisionCounts(), beforeDecisions)
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
    assert.deepEqual(decisionCounts(), beforeDecisions, 'The zero-configuration named model requires neither Profile nor model Decision')
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
  const claimFixture = async (inherit = false) => {
    const f = await fixture(true, false, inherit)
    if (inherit) decisionProfile = f.implement!.id
    const selected = await profiles.resolveAgentProfileDispatch(pool, f.scope, { issueId: f.issueId, ...(inherit ? {} : { profileId: f.implement!.id }), location: 'cloud', cloudPurpose: 'desktop' })
    if (selected.target.kind !== 'cloud') assert.fail(JSON.stringify(selected.target))
    const subscriptionBindingId = await bindAgentToConnection(pool, f.scope, f.agents.claude_code, 'claude_code', f.connections.claude_code, model.claude_code)
    const queue: typeof queueCloudRun = inherit ? async (db, actor, input) => {
      const dispatch = createFactoryDispatch(db, f.store, tx => queueCloudRun(db, actor, input, tx))
      return dispatch(f.ownerId, { binding: factoryBinding(f.task), agentId: f.agents.claude_code, deviceRepoId: f.repoId })
    } : queueCloudRun
    const { runId } = await queue(pool, f.actor, {
      botId: f.botId, issueId: f.issueId, agentId: f.agents.claude_code, deviceRepoId: f.repoId,
      title: 'Claim the frozen Profile', body: 'Synthetic freshness boundary', model: model.claude_code,
      ...(inherit ? { sourceEventId: f.sourceEventId } : {}),
      subscriptionBindingId, agentProfile: selected.agentProfile, readOnly: !inherit,
      ...(inherit ? { modelDispatch: { mode: selected.selectionMode ?? 'preference', location: 'cloud', entry: selected.target.entry, ...(selected.target.routing ? { routing: selected.target.routing } : {}) } } : {}),
    })
    // The same handoff as provisioning, with no provider or model call.
    const threadDevice = randomUUID()
    await pool.query(`INSERT INTO devices(id,"ownerId",name,kind,enabled) VALUES ($1,$2,'Prepared thread fixture','cloud',true)`, [threadDevice, f.ownerId])
    await pool.query(`UPDATE thread_machines SET state='running',"deviceId"=$2,"sandboxId"=$3 WHERE "runId"=$1`, [runId, threadDevice, `synthetic-thread-${runId}`])
    const source = (await pool.query('SELECT * FROM agent_runs WHERE id=$1', [runId])).rows[0]
    const definition = await rebindExecutionDevice(pool, source, threadDevice, pool)
    assert.ok(definition)
    await pool.query('UPDATE agent_runs SET "deviceId"=$2,"agentDefinition"=$3 WHERE id=$1', [runId, threadDevice, JSON.stringify(definition)])
    if (inherit) {
      const threadRepo = randomUUID()
      await pool.query(`INSERT INTO device_repos(id,"deviceId","userId","repoPath","baseBranch")
        SELECT $1,$2,"userId","repoPath","baseBranch" FROM device_repos WHERE id=$3`, [threadRepo, threadDevice, f.repoId])
      await pool.query('UPDATE agent_runs SET "deviceRepoId"=$2 WHERE id=$1', [runId, threadRepo])
      await pool.query('UPDATE thread_machines SET "repoId"=$2 WHERE "runId"=$1', [runId, threadRepo])
    }
    return { ...f, runId, threadDevice, subscriptionBindingId, definition, inherit }
  }
  const claim = async (f: Awaited<ReturnType<typeof claimFixture>>) => {
    const lease = new Date(Date.now() + 30_000)
    const beforeClaim = f.inherit ? async (tx: import('pg').PoolClient) => {
      const result = await (await import('./runtime')).guardFactoryClaim(tx, f.ownerId, f.threadDevice, f.runId, lease.toISOString())
      assert.equal(result.preserveQuestionWorktree, true)
    } : undefined
    return claimCloudRun(pool, f.actor, f.runId, f.threadDevice, lease, f.subscriptionBindingId, beforeClaim, undefined, false)
  }
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
      if (['usage-error', 'still-unknown', 'quota', 'profile'].includes(fault)) await assert.rejects(claim(f), error => {
        assert.ok(error instanceof AgentProfileAdmissionError)
        assert.equal(error.code, 'agentProfileUnavailable'); assert.equal(error.detail, 'current_profile')
        assert.ok(error.cause instanceof profiles.AgentProfileError)
        assert.equal(error.cause.code, fault === 'profile' ? 'agentProfileVersionConflict' : 'agentProfileModelUnavailable')
        if (fault !== 'profile') assert.equal(error.cause.detail, fault === 'quota' ? 'quota' : 'checking')
        return true
      })
      else assert.equal(await claim(f), null)
      assert.deepEqual(usageCalls.slice(before), [{ ownerId: f.ownerId, connectionId: f.connections.claude_code }])
      await unchangedRun(f)
      assert.equal((await pool.query('SELECT 1 FROM byos_native_runs WHERE "runId"=$1', [f.runId])).rowCount, 0)
    })
  }
  assert.deepEqual(decisionInputs.map(call => call.purpose), ['factory-agent-profile', 'factory-agent-profile', 'task-model-routing'])
  // Validate captured inputs outside the transport: model routing intentionally
  // catches transport errors, which must not swallow a privacy assertion.
  for (const call of decisionInputs) {
    const serialized = JSON.stringify(call.input)
    for (const privateText of ['PRIVATE_PROFILE_', 'connectionId', 'synthetic-subscription-', 'providerSubject']) assert.ok(!serialized.includes(privateText), privateText)
    assert.ok(serialized.includes('review'))
    if (call.purpose === 'factory-agent-profile') assert.ok(JSON.stringify(call.questions).includes(call.profileId))
  }
  await t.test('unchanged inherited frontend Profile survives JSONB, device handoff and expired quota at first cloud claim', async t => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
    const before = decisionCounts()
    const f = await claimFixture(true)
    const frozen = f.definition.agentProfile!
    assert.equal(frozen.version, 1)
    assert.equal(frozen.profileId, f.implement!.id)
    assert.equal(frozen.digest, f.implement!.digest)
    assert.equal(frozen.source, 'decision')
    assert.equal(frozen.definition.model.mode, 'inherit')
    assert.deepEqual(frozen.definition.skills, ['implementation-evidence'])
    assert.equal(frozen.effort, undefined)
    assert.equal(frozen.targetEntry.harness, 'claude_code')
    assert.equal(frozen.targetEntry.model, model.claude_code)
    assert.deepEqual(frozen.targetEntry.source, { kind: 'subscription', connectionId: f.connections.claude_code })
    assert.deepEqual(f.definition.modelDispatch?.entry, frozen.targetEntry, 'the preferred order UUID and full source entry survive freezing and relocation unchanged')
    await profiles.assertProfileSelection(pool, f.scope, frozen)
    await assertRunProfileClaim(pool, f.runId)
    t.mock.timers.tick(60_001)
    await assert.rejects(assertRunProfileClaim(pool, f.runId), error => {
      assert.ok(error instanceof AgentProfileAdmissionError)
      assert.equal(error.detail, 'current_profile')
      assert.ok(error.cause instanceof profiles.AgentProfileError)
      assert.equal(error.cause.code, 'agentProfileModelUnavailable'); assert.equal(error.cause.detail, 'checking')
      return true
    })
    const beforeUsage = usageCalls.length
    usageProbe = async (ownerId, connectionId) => {
      assert.equal(ownerId, f.ownerId); assert.equal(connectionId, f.connections.claude_code)
      await refreshQuota(connectionId)
    }
    assert.ok(await claim(f))
    await unchangedRun(f, 'preparing')
    assert.deepEqual(usageCalls.slice(beforeUsage), [{ ownerId: f.ownerId, connectionId: f.connections.claude_code }])
    assert.deepEqual(decisionCounts(), { profile: before.profile + 1, model: before.model + 1 })
  })
})
