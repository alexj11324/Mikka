// Production resolver, cloud queue, stage dispatcher and worker freeze on real
// PostgreSQL. Reports, subscriptions and Decision transport are synthetic;
// provider lifecycle is observed at its boundary, never called or claimed live.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readFile, readdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { gzipSync } from 'node:zlib'
import { Pool } from 'pg'
import { dbUrl, seedUser, seedPersonalWorkspace, seedBot, seedIssue } from '../../tests/support/workspace-admin-db'
import { dropTestDatabase } from '../../tests/support/drop-test-database'
import { templateModelsFixture } from '../../tests/support/template-models'
import { orderMigrations } from '../../scripts/migration-order.mjs'
import type { DecisionAnswer } from '../coordinator/decision'
import type { OrderHarness } from '../model-order-plan'
import type { FactorySnapshot } from './store'
import type { ReviewActor } from '../coding-workspace/diff/authority'
import type { DiffFileMetadata, ReviewBatchRequest } from '@mikka/protocol/coding-workspace-review'

process.env.MIKKA_BYOS_ENABLED = '1'
process.env.MIKKA_BYOS_VALIDATED_MODEL_ROUTES = 'claude_cpa,codex_cpa'

// This parent includes all migrations and the sequential Profile/recheck
// matrix. Give the expanded matrix its own total budget; per-query statement
// (15s) and lock (5s) deadlines below remain unchanged. A parent timeout runs
// teardown while the current child is still unwinding, obscuring that failure.
test('real PG: independent cross-Harness Profile stages and recorded cloud runtimes', { skip: !dbUrl, timeout: 240_000 }, async t => {
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
      allowance: async (ownerId: string, connectionId: string, signal: AbortSignal) => {
        usageCalls.push({ ownerId, connectionId })
        assert.equal(signal.aborted, false)
        await usageProbe(ownerId, connectionId, signal)
      },
    }),
  } })
  let decisionProfile = ''
  let decisionFailure: 'missing-pair-reason' | 'none' | 'refusal' | null = null
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
      const answers = new Map<string, Exclude<DecisionAnswer, { type: 'refusal' }>>([
        ['profile', { name: 'profile', type: 'choice', choice: decisionFailure === 'none' ? 'none' : decisionFailure === 'missing-pair-reason' ? decisionProfile : `${decisionProfile}:stage_fit`, confidence: .95 }],
      ])
      if (decisionFailure === 'refusal') answers.clear() // The actual adapter omits refused answers.
      return { answers, execution: { executionId: randomUUID(), modelId: 'openai/gpt-6-luna-decisions', providerGenerationId: 'synthetic-profile-stage', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), requestDigest: 'a'.repeat(64), imageDigests: [], vision: 'no-image-input' } }
    },
  } })
  const modules = await Promise.all([
    import('../db'), import('../workspace-db'), import('./agent-profile'), import('../model-dispatch'),
    import('../computer/queue-run'), import('./store'), import('./dispatch'), import('./reconcile'),
    import('./automatic-dispatch'), import('./checks'), import('./check-independence'),
    import('../agent-kit/worker-digest'), import('../computer/bot-runtime-records'),
  ])
  appPool = modules[0].pool; workspacePool = modules[1].workspacePool
  const [, , profiles, { bindAgentToConnection }, { queueCloudRun }, { createFactoryStore }, { createFactoryDispatch: rawDispatch, factoryBinding },
    { createFactoryReconciler: rawReconciler }, { automaticFactoryDispatch, factoryAutomaticRuntime }, { factoryCheckGates }, { factoryCheckIndependent },
    { workerDefinitionDigest }, { ensureRecordedBotHarnessRuntime }] = modules
  const { resourceBoundFactoryDispatch, factoryResourceWorkspace } = await import('../../tests/helpers/factory-resource-boundary')
  const { bindFactoryQuestionsWorkspace, bindFactoryStoreWorkspace } = await import('./background-workspace')
  const createFactoryDispatch: typeof rawDispatch = (...args) => resourceBoundFactoryDispatch(args[0], rawDispatch(...args))
  const createFactoryReconciler: typeof rawReconciler = (source, store, questions, consumers, botId, automatic, boundary) =>
    rawReconciler(source, store, questions, consumers, botId, automatic, boundary ?? factoryResourceWorkspace(source))
  const handoffs: { previous: string | null; runId: string }[] = []
  t.mock.method(factoryAutomaticRuntime, 'enqueue', async (_pool: Pool, _actor: unknown, previous: string | null, runId: string) => { handoffs.push({ previous, runId }) })
  t.mock.method(factoryAutomaticRuntime, 'park', async () => { throw new Error('Provider park must stay outside dispatch') })
  t.mock.method(factoryAutomaticRuntime, 'start', async () => { throw new Error('Provider start must stay outside dispatch') })
  const model = { claude_code: 'claude-haiku-5-5', codex: 'gpt-6-luna' } as const
  const caps = () => (['claude_code', 'codex'] as const).map(harness => ({ harness, installed: true, models: [model[harness]], subscriptionBroker: true, computerBroker: true }))
  const template = templateModelsFixture(Object.values(model)); t.after(() => template.restore())
  const fixture = async (withProfiles = true, missingCodex = false, inherit = false, profileId?: 'default', needsSpec = false) => {
    const ownerId = await seedUser(pool, 'profile-stage')
    const workspaceId = await seedPersonalWorkspace(pool, ownerId)
    const botId = await seedBot(pool, workspaceId, ownerId), issueId = await seedIssue(pool, ownerId, workspaceId)
    const scope = { ownerId, workspaceId, botId }, actor = { userId: ownerId, workspaceId }
    const submissionId = randomUUID()
    const submitted = profileId ? await (await import('../coordinator-submission')).recordPersonalSubmission(modules[0].db, ownerId, 'Create a checked deliverable', { botId, submissionId, profileId }) : null
    const sourceEventId = submitted?.eventId ?? randomUUID(), deviceId = randomUUID(), repoId = randomUUID()
    const agents = { claude_code: randomUUID(), codex: randomUUID() }, connections = { claude_code: randomUUID(), codex: randomUUID() }
    if (!submitted) await pool.query(`INSERT INTO coordinator_events (id,"userId","botId","issueId",kind,"dedupeKey",payload) VALUES ($1::uuid,$2,$3,$4,'user_message',$1::text,'{"text":"Create a checked deliverable"}')`, [sourceEventId, ownerId, botId, issueId])
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
    const routed = await store.route(ownerId, { issueId, sourceEventId, eventId: randomUUID(), rationale: 'Synthetic subscription profile stage fixture', needsSpec })
    return { scope, actor, ownerId, workspaceId, botId, issueId, sourceEventId, deviceId, repoId, agents, connections, implement, review, store, task: routed.task }
  }
  for (const withProfile of [false, true]) await t.test(`group intent preserves stale allowance without admission or refresh (${withProfile ? 'fixed Profile' : 'Default'})`, async () => {
    const f = await fixture(withProfile)
    const now = Date.now(), request = { location: 'cloud' as const, cloudPurpose: 'desktop' as const, ...(f.implement ? { profileId: f.implement.id } : {}) }
    await pool.query('UPDATE model_order_settings SET "preferredHarness"=\'claude_code\' WHERE "ownerId"=$1 AND "workspaceId"=$2', [f.ownerId, f.workspaceId])
    const storedQuota = (age: number, used = .1) => ({ vendor: 'claude_code', source: 'official', status: 'ok', plan: null, observedAt: new Date(now - age).toISOString(), windows: [{ kind: 'five_hour', used, resetsAt: new Date(now + 3_600_000).toISOString() }] })
    await pool.query('UPDATE byos_connections SET quota=$2 WHERE id=$1', [f.connections.claude_code, JSON.stringify(storedQuota(94_000))])
    await pool.query('UPDATE byos_connections SET quota=$2 WHERE id=$1', [f.connections.codex, JSON.stringify({ ...storedQuota(23_000), vendor: 'codex' })])
    const before = (await pool.query('SELECT id,epoch,state,paused,quota FROM byos_connections WHERE "ownerId"=$1 ORDER BY id', [f.ownerId])).rows
    const bindings = (await pool.query('SELECT * FROM byos_bindings WHERE "ownerId"=$1 ORDER BY id', [f.ownerId])).rows
    const beforeUsage = usageCalls.length
    assert.deepEqual(await profiles.agentProfileDispatchAvailability(pool, f.scope, request), { available: false, reason: 'checking' })
    assert.deepEqual(await profiles.agentProfileDispatchAvailability(pool, f.scope, request, { deferStaleQuota: true }), { available: true, reason: 'quota_check_required' })
    const target = await modules[3].resolveModelDispatch(pool, f.scope, undefined, 'cloud', undefined, {
      cloudPurpose: 'desktop', skipCatalogueRefresh: true, probeQuota: false, bindSubscription: false, deferStaleQuota: true,
    })
    assert.equal(target.kind, 'cloud')
    if (target.kind !== 'cloud') assert.fail('The authorized cloud destination remains available for admission')
    assert.equal(target.entry.source.kind, 'subscription'); assert.equal(target.harness, 'claude_code')
    assert.equal(target.model, model.claude_code); assert.equal(target.quotaCheckPending, true)
    assert.deepEqual(target.entry.source, { kind: 'subscription', connectionId: f.connections.claude_code }, 'a fresh later Codex entry cannot displace the unchecked preferred Claude entry')
    const strict = await modules[3].resolveModelDispatch(pool, f.scope, undefined, 'cloud', undefined, {
      cloudPurpose: 'desktop', skipCatalogueRefresh: true, probeQuota: false, deferStaleQuota: true,
    })
    assert.equal(strict.kind, 'none', 'omitting the no-binding fence cannot enable the group-only preview')
    assert.equal(usageCalls.length, beforeUsage)
    assert.deepEqual((await pool.query('SELECT id,epoch,state,paused,quota FROM byos_connections WHERE "ownerId"=$1 ORDER BY id', [f.ownerId])).rows, before)
    assert.deepEqual((await pool.query('SELECT * FROM byos_bindings WHERE "ownerId"=$1 ORDER BY id', [f.ownerId])).rows, bindings)
    assert.equal((await pool.query('SELECT 1 FROM agent_runs WHERE "issueId"=$1', [f.issueId])).rowCount, 0)
    const unreported = templateModelsFixture([model.codex])
    try {
      assert.deepEqual(await profiles.agentProfileDispatchAvailability(pool, f.scope, request, { deferStaleQuota: true }), { available: true, reason: 'quota_check_required' }, 'a template probe cannot veto the credential model or displace its pending allowance')
      const unreportedTarget = await modules[3].resolveModelDispatch(pool, f.scope, undefined, 'cloud', undefined, {
        cloudPurpose: 'desktop', skipCatalogueRefresh: true, probeQuota: false, bindSubscription: false, deferStaleQuota: true,
      })
      assert.equal(unreportedTarget.kind, 'cloud')
      if (unreportedTarget.kind !== 'cloud') assert.fail('An unreported credential model remains eligible for quota admission')
      assert.equal(unreportedTarget.harness, 'claude_code')
      assert.equal(unreportedTarget.model, model.claude_code)
      assert.equal(unreportedTarget.quotaCheckPending, true)
      assert.deepEqual(unreportedTarget.entry.source, { kind: 'subscription', connectionId: f.connections.claude_code }, 'the unchecked preferred source still fences the later Codex entry')
      // Remove the actual Agent, rather than one ID from its shortcut list.
      // An unresolved preferred allowance still cannot be bypassed for Codex.
      const catalogue = JSON.parse(process.env.MIKKA_CLOUD_TEMPLATE_MODELS!)
      catalogue.templates.desktop.models = catalogue.templates.desktop.models.filter((info: { harness: string }) => info.harness !== 'claude_code')
      process.env.MIKKA_CLOUD_TEMPLATE_MODELS = JSON.stringify(catalogue)
      assert.equal((await profiles.agentProfileDispatchAvailability(pool, f.scope, request, { deferStaleQuota: true })).available, false, 'a pending preferred allowance cannot be skipped for a later supported source')
    } finally { unreported.restore() }
    const pinned = { ...request, asked: { harness: 'claude_code' as const, model: model.claude_code } }
    for (const quota of [null, {}, { ...storedQuota(94_000), status: 'unknown' }, { ...storedQuota(94_000), source: 'local_credentials' }, storedQuota(94_000, 1)]) {
      await pool.query('UPDATE byos_connections SET quota=$2 WHERE id=$1', [f.connections.claude_code, JSON.stringify(quota)])
      assert.equal((await profiles.agentProfileDispatchAvailability(pool, f.scope, pinned, { deferStaleQuota: true })).available, false)
    }
    await pool.query('UPDATE byos_connections SET quota=$2 WHERE id=$1', [f.connections.claude_code, JSON.stringify(storedQuota(94_000))])
    for (const state of ['paused', 'removed', 'disconnected'] as const) {
      await pool.query('UPDATE byos_connections SET paused=$2,"removedAt"=CASE WHEN $3 THEN now() END,state=$4 WHERE id=$1', [f.connections.claude_code, state === 'paused', state === 'removed', state === 'paused' ? 'connected' : 'disconnected'])
      assert.equal((await profiles.agentProfileDispatchAvailability(pool, f.scope, pinned, { deferStaleQuota: true })).available, false, state)
    }
    await pool.query('UPDATE byos_connections SET paused=false,"removedAt"=NULL,state=\'connected\' WHERE id=$1', [f.connections.claude_code])
    await pool.query('UPDATE user_e2b_keys SET "lastErrorCode"=\'invalid\' WHERE "userId"=$1', [f.ownerId])
    assert.equal((await profiles.agentProfileDispatchAvailability(pool, f.scope, pinned, { deferStaleQuota: true })).available, false, 'no cloud destination remains a real denial')
    await pool.query('UPDATE user_e2b_keys SET "lastErrorCode"=NULL WHERE "userId"=$1', [f.ownerId])
    const bindingId = await bindAgentToConnection(pool, f.scope, f.agents.claude_code, 'claude_code', f.connections.claude_code, model.claude_code)
    await pool.query(`INSERT INTO agent_runs (id,"userId","botId","issueId","agentId","deviceId",status,"stopReason",prompt,"agentDefinition",report,"startedAt","finishedAt")
      VALUES ($1,$2,$3,$4,$5,$6,'failed','provider_failure','Synthetic provider failure',$7,$8,now()-interval '1 second',now())`,
    [randomUUID(), f.ownerId, f.botId, f.issueId, f.agents.claude_code, f.deviceId, JSON.stringify({ harness: 'claude_code', model: model.claude_code, subscription: { bindingId, modelId: model.claude_code }, executionIdentity: { workspaceId: f.workspaceId } }), JSON.stringify({ providerFailure: { kind: 'auth', retryable: false, status: 401, code: 'authentication_failed' } })])
    assert.equal((await profiles.agentProfileDispatchAvailability(pool, f.scope, pinned, { deferStaleQuota: true })).available, false, 'provider failure memory wins over a positive old allowance')
    assert.equal(usageCalls.length, beforeUsage)
  })
  const exercise = async (withProfiles: boolean, missingCodex: boolean, autoModelRouting = true, explicitDefault = false, parentMode: 'prepared' | 'metadata-only' = 'prepared', flowVersion: 1 | 2 = 2) => {
    const f = await fixture(withProfiles, missingCodex, false, explicitDefault ? 'default' : undefined), beforeDecisions = decisionCounts()
    if (flowVersion === 1) {
      // Persist the historical contract before any execution/check is queued.
      await pool.query(`UPDATE factory_tasks SET route=route-'flowVersion' WHERE id=$1`, [f.task.id])
      delete f.task.route.flowVersion
    }
    const readParent = async () => (await pool.query(`
      SELECT to_jsonb(m) AS machine, to_jsonb(d) AS device
      FROM cloud_machines m
      JOIN devices d ON d.id=m."deviceId" AND d."ownerId"=m."ownerId"
      WHERE m."workspaceId"=$1 AND m."ownerId"=$2 AND m."deviceId"=$3
    `, [f.workspaceId, f.ownerId, f.deviceId])).rows[0]
    if (parentMode === 'metadata-only') {
      await pool.query(`UPDATE devices SET harnesses='[]'::jsonb,"lastSeenAt"=NULL WHERE id=$1 AND "ownerId"=$2`, [f.deviceId, f.ownerId])
      await pool.query(`UPDATE cloud_machines SET state='sleeping',"sandboxId"=NULL,"runtimeReady"=false WHERE "workspaceId"=$1 AND "ownerId"=$2 AND "deviceId"=$3`, [f.workspaceId, f.ownerId, f.deviceId])
    }
    const parentBefore = parentMode === 'metadata-only' ? await readParent() : undefined
    if (parentMode === 'metadata-only') {
      assert.ok(parentBefore)
      assert.deepEqual([parentBefore.machine.state, parentBefore.machine.sandboxId, parentBefore.machine.runtimeReady, parentBefore.device.lastSeenAt, parentBefore.device.harnesses], ['sleeping', null, false, null, []])
    }
    if (!autoModelRouting) await pool.query('UPDATE model_order_settings SET "autoModelRouting"=false WHERE "ownerId"=$1 AND "workspaceId"=$2', [f.ownerId, f.workspaceId])
    const originalRequest = 'ORIGINAL_IMPLEMENTATION_REQUEST: implement the backend; do not reinterpret this as the current review assignment.'
    await pool.query('UPDATE issues SET title=$2,content=$3 WHERE id=$1', [f.issueId, 'Build the requested backend deliverable', JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: originalRequest }] }] })])
    const profileId = explicitDefault
      ? await (await import('./profile-request')).requestedAgentProfile(pool, f.scope, f.sourceEventId, f.implement!.id)
      : f.implement?.id
    if (explicitDefault) assert.equal(profileId, 'default')
    const selected = withProfiles ? await profiles.resolveAgentProfileDispatch(pool, f.scope, { issueId: f.issueId, profileId, location: 'cloud', cloudPurpose: 'desktop', ...(explicitDefault ? { asked: { harness: 'claude_code' as const, model: model.claude_code } } : {}) }) : null
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
    await pool.query(`UPDATE agent_runs SET status='succeeded',"startedAt"=now(),"finishedAt"=now(),"sessionId"=$2,"stopReason"='submitted',report=$3 WHERE id=$1`, [source.runId, nativeSession, JSON.stringify({ sourceCommit: sha, deliverableCommit: deliverySha, summary: 'PRIVATE_PRODUCER_REPORT Synthetic successful implementation and validation report', runtime: { observedModel: model.claude_code } })])
    const sourceBefore = (await pool.query('SELECT * FROM agent_runs WHERE id=$1', [source.runId])).rows[0]
    if (missingCodex && parentMode === 'prepared') await pool.query(`UPDATE cloud_machines SET state='sleeping' WHERE "workspaceId"=$1 AND "ownerId"=$2`, [f.workspaceId, f.ownerId])
    decisionProfile = f.review?.id ?? ''
    const reconciler = createFactoryReconciler(pool, f.store, undefined, {}, f.botId, automaticFactoryDispatch(pool))
    await reconciler.run(f.ownerId, source.runId)
    const current = (await pool.query('SELECT * FROM factory_tasks WHERE id=$1', [f.task.id])).rows[0]
    assert.equal(current.stage, 'review', current.reason); assert.equal(current.status, 'running', current.reason)
    assert.equal(current.route.flowVersion ?? 1, flowVersion)
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
      const profileCall = decisionInputs.filter(call => call.purpose === 'factory-agent-profile').at(-1)!
      const profileInput = JSON.parse(String(profileCall.input))
      assert.equal(profileInput.currentWork?.stage, 'review', 'the host supplies the current stage before selecting a role')
      assert.equal(profileInput.currentWork.responsibility, 'independent_review')
      assert.equal(profileInput.currentWork.readOnly, true)
      assert.match(profileInput.currentWork.objective, /correctness and regressions/)
      assert.match(profileInput.currentWork.evidence, /implementation.*validation evidence/)
      if (flowVersion === 2) assert.match(profileInput.currentWork.evidence, /single review/)
      assert.deepEqual(profileInput.currentWork.candidate, { id: candidate.id, kind: candidate.kind, sha: candidate.sha })
      assert.equal(candidate.sha, null, 'a deliverable is not given a fabricated repository candidate SHA')
      assert.deepEqual(profileInput.currentWork.producer, { runId: source.runId, harness: 'claude_code', model: model.claude_code,
        profile: { id: explicitDefault ? 'default' : f.implement!.id, version: sourceBefore.agentDefinition.agentProfile.version } })
      assert.equal(profileInput.currentWork.taskId, current.id); assert.equal(profileInput.currentWork.attemptId, current.attemptId)
      assert.equal(profileInput.currentWork.requestEpoch, current.sourceEventId)
      assert.match(profileInput.acceptanceReference.originalTask.content, /ORIGINAL_IMPLEMENTATION_REQUEST/)
      assert.ok(!JSON.stringify(profileInput.currentWork).includes(originalRequest), 'original execution text remains background, never current-stage instructions')
      assert.match(String(profileCall.questions && JSON.stringify(profileCall.questions)), /currentWork/)
      for (const privateValue of ['PRIVATE_PROFILE_', 'PRIVATE_PRODUCER_REPORT', nativeSession, f.connections.claude_code, f.connections.codex]) assert.ok(!String(profileCall.input).includes(privateValue), privateValue)
      assert.equal(frozen.targetEntry.source.connectionId, f.connections.codex)
      assert.match(run.prompt, /PRIVATE_PROFILE_Review/)
      assert.equal(sourceBefore.agentDefinition.agentProfile.profileId, explicitDefault ? 'default' : f.implement!.id)
      assert.deepEqual(decisionCounts(), { profile: beforeDecisions.profile + 1, model: beforeDecisions.model }, 'a fixed Profile selects its role once without model routing')
    } else {
      assert.equal(frozen.profileId, 'default'); assert.equal(frozen.source, 'default')
      assert.deepEqual(decisionCounts(), { profile: beforeDecisions.profile, model: beforeDecisions.model + (autoModelRouting ? 1 : 0) }, 'same-Harness fallback routes once only when automatic routing is enabled')
      if (autoModelRouting) assert.equal(run.agentDefinition.modelDispatch.routing.reason, 'decision_unavailable')
      else assert.equal(run.agentDefinition.modelDispatch.routing, undefined, 'an older choice has no fabricated routing snapshot')
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
    if (parentBefore) assert.deepEqual(await readParent(), parentBefore, 'producer and independent Review must not prepare, wake or change the parent')
    return { ...f, source, current, attempt, candidate, run }
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
        ['profile', { name: 'profile', type: 'choice', choice: 'none' }],
      ]) },
      { detail: 'uncertain_profile', answers: new Map<string, Exclude<DecisionAnswer, { type: 'refusal' }>>([
        ['profile', { name: 'profile', type: 'choice', choice: `${f.implement!.id}:stage_fit`, confidence: .42 }],
      ]) },
      { detail: 'invalid_profile_answer', answers: new Map<string, Exclude<DecisionAnswer, { type: 'refusal' }>>([
        ['profile', { name: 'profile', type: 'choice', choice: `${f.implement!.id}:stage_fit`, confidence: .95 }],
        ['reason', { name: 'reason', type: 'choice', choice: 'stage_fit' }],
      ]) },
      { detail: 'invalid_reason', answers: new Map<string, Exclude<DecisionAnswer, { type: 'refusal' }>>([
        ['profile', { name: 'profile', type: 'choice', choice: f.implement!.id, confidence: .95 }],
      ]) },
      { detail: 'unknown_profile', answers: new Map<string, Exclude<DecisionAnswer, { type: 'refusal' }>>([
        ['profile', { name: 'profile', type: 'choice', choice: privateAnswer }],
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
            assert.equal(questions.length, 1)
            assert.deepEqual(choices, [`${f.implement!.id}:capability_fit`, `${f.implement!.id}:stage_fit`, 'none'])
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
        assert.equal(logged.selectedProfileId, response.detail === 'uncertain_profile' ? f.implement!.id : undefined)
        assert.equal(logged.decisionConfidence, response.detail === 'uncertain_profile' ? .42 : undefined)
        assert.deepEqual(logged.causes, [])
      }
      assert.equal(warnings.length, responses.length)
      assert.ok(!warnings.join('\n').includes(`${f.implement!.id}:stage_fit`), 'raw atomic pair answers are not logged')
      for (const forbidden of [privateAnswer, 'PRIVATE_PROFILE_', disabled.name, disabled.description, execution.providerGenerationId, f.ownerId, f.connections.codex, f.connections.claude_code]) assert.ok(!warnings.join('\n').includes(forbidden), forbidden)
      assert.deepEqual((await pool.query('SELECT * FROM byos_bindings WHERE "ownerId"=$1 ORDER BY id', [f.ownerId])).rows, beforeBindings)
      assert.equal((await pool.query('SELECT 1 FROM agent_runs WHERE "issueId"=$1', [f.issueId])).rowCount, 0)
    } finally { warning.mock.restore(); usageProbe = oldUsageProbe }
  })
  await t.test('CC implementation selects independent Codex Review with frozen exact Profile and subscription', async () => { await exercise(true, false) })
  await t.test('a prepared sleeping parent gains its missing Codex metadata without provider I/O', async () => { await exercise(true, true) })
  await t.test('an unprepared parent admits CC implementation and independent Codex Profile Review without changing the parent', async () => {
    const before = decisionInputs.length
    const f = await exercise(true, true, true, false, 'metadata-only')
    const calls = decisionInputs.slice(before).filter(call => call.purpose === 'factory-agent-profile')
    assert.equal(calls.length, 1)
    const input = JSON.parse(calls[0]!.input as string)
    assert.equal(input.task.kind, 'independent_check'); assert.equal(input.task.stage, 'review'); assert.equal(input.task.readOnly, true)
    assert.equal(input.task.taskId, f.task.id); assert.equal(input.task.requestEpoch, f.sourceEventId); assert.equal(input.task.candidateId, f.candidate.id)
    assert.equal(input.task.content, undefined); assert.ok(input.acceptanceReference?.originalTask)
  })
  await t.test('no configured Profile retains CC despite Codex being first in model preference', async () => { await exercise(false, false) })
  await t.test('an owner Default task still permits the host to choose independent Codex Review for its next stage', async () => {
    const f = await exercise(true, false, true, true)
    const input = JSON.parse(decisionInputs.at(-1)!.input as string)
    assert.equal(input.task.kind, 'independent_check', 'the actual selection request describes the current check, not another producer')
    assert.equal(input.task.stage, 'review'); assert.equal(input.task.readOnly, true)
    assert.equal(input.task.taskId, f.task.id); assert.equal(input.task.requestEpoch, f.sourceEventId)
    assert.equal(input.task.candidateId, f.candidate.id)
    const issue = (await pool.query('SELECT title,content FROM issues WHERE id=$1', [f.issueId])).rows[0]
    assert.equal(input.acceptanceReference.originalTask.title, issue.title)
    assert.equal(input.acceptanceReference.originalTask.content, JSON.stringify(issue.content))
    assert.equal(input.acceptanceReference.currentOwnerRequest, '')
    assert.equal(input.task.content, undefined, 'the implementation contract is only an acceptance reference')
  })
  const profileRefusal = 'The selected Agent Profile changed or is no longer available. Select an available Profile for a new run.'
  const unclaimedReview = async (withRouting = false) => {
    const f = await exercise(false, false, withRouting)
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
  const recheckCallsStart = decisionInputs.length
  const { createFactoryHumanStore } = await import('./human-store')
  const humanStore = (dispatch = automaticFactoryDispatch(pool)) => createFactoryHumanStore(pool, botId => bindFactoryStoreWorkspace(pool, createFactoryStore(pool,
    async (owner, issueId, tx) => (await tx.query('SELECT 1 FROM issues WHERE id=$1 AND "userId"=$2', [issueId, owner])).rowCount === 1,
    botId, { independent: factoryCheckIndependent, gates: factoryCheckGates }), botId), dispatch)
  const recheckCandidate = async (waiting: boolean, legacy = false) => {
    const f = await exercise(true, false, false, false, 'prepared', 1)
    const { reconcileFactoryCheck } = await import('./reconcile-check')
    const { createFactoryQuestions } = await import('./questions/store')
    const questions = createFactoryQuestions(pool,
      async (owner, issue, tx) => (await tx.query('SELECT 1 FROM issues WHERE id=$1 AND "userId"=$2', [issue, owner])).rowCount === 1,
      f.store, async () => { throw new Error('A recheck must never resume a native session') })
    const reconcile = createFactoryReconciler(pool, f.store, questions, { review: reconcileFactoryCheck, verify: reconcileFactoryCheck }, f.botId, automaticFactoryDispatch(pool))
    const complete = async (runId: string, question = false, failed = false) => {
      const run = (await pool.query('SELECT * FROM agent_runs WHERE id=$1', [runId])).rows[0]
      await pool.query(`UPDATE agent_runs SET status=$2,"stopReason"=$3,"startedAt"=now()-interval '1 second',"finishedAt"=now(),"leaseExpiresAt"=NULL,"sessionId"=$4,report=$5 WHERE id=$1`,
        [runId, question ? 'stopped' : 'succeeded', question ? 'asked_human' : 'submitted', `independent-${runId}`, JSON.stringify({
          summary: 'Actual synthetic adapter completion', filesChanged: [], verify: { status: 'not_run' },
          check: { sha: run.baseBranch, readOnly: true }, criteria: [{ text: 'Inspect the delivered bytes', passed: !failed, evidence: 'The fixed candidate artifact was inspected' }],
          ...(question ? { question: { questionId: randomUUID(), kind: 'decision', question: 'Which criterion should be inspected?', options: ['All acceptance criteria'] } } : {}),
        })])
      await reconcile.run(f.ownerId, runId)
      return (await f.store.read(f.ownerId, f.task.id)).task
    }
    // The two historical checks intentionally have different frozen roles and sources.
    decisionProfile = f.implement!.id
    const verifyTask = await complete(f.run.id)
    assert.equal(verifyTask.stage, 'verify'); assert.equal(verifyTask.status, 'running')
    const verify = (await pool.query('SELECT r.* FROM factory_attempts a JOIN agent_runs r ON r.id=a."runId" WHERE a.id=$1', [verifyTask.attemptId])).rows[0]
    if (legacy) for (const runId of [f.run.id, verify.id]) {
      const run = (await pool.query('SELECT "agentDefinition" FROM agent_runs WHERE id=$1', [runId])).rows[0]
      delete run.agentDefinition.agentProfile
      run.agentDefinition.modelDispatch.mode = 'preference'
      run.agentDefinition.definitionDigest = workerDefinitionDigest(run.agentDefinition)
      await pool.query('UPDATE agent_runs SET "agentDefinition"=$2 WHERE id=$1', [runId, JSON.stringify(run.agentDefinition)])
    }
    const current = await complete(verify.id, waiting)
    assert.equal(current.stage, waiting ? 'verify' : 'approval'); assert.equal(current.status, waiting ? 'waiting' : 'pending')
    const human = humanStore(), { handleFactory } = await import('./http')
    const request = { userId: f.ownerId, taskId: f.task.id, method: 'POST', origin: 'https://app.example', url: `https://app.example/api/factory/tasks/${f.task.id}`,
      body: { binding: { taskId: f.task.id, revision: current.revision }, eventId: randomUUID(), action: 'recheck', reason: 'Inspect every criterion again on this same candidate.' } }
    return { ...f, current, verify, human, handleFactory, request, complete, reconcile, questions }
  }
  for (const state of ['waiting verify', 'pending approval', 'elapsed open', 'elapsed waiting_user', 'saved expired'] as const)
    for (const legacy of [true, false]) await t.test(`Owner rechecks the same v1 candidate from ${state} (${legacy ? 'legacy frozen source' : 'Profile'})`, async () => {
    const waiting = state !== 'pending approval', expired = state.startsWith('elapsed') || state === 'saved expired'
    const f = await recheckCandidate(waiting, legacy)
    if (expired) await pool.query(`UPDATE factory_questions SET status=$2,"expiresAt"=clock_timestamp()-interval '1 minute' WHERE "taskId"=$1`,
      [f.task.id, state === 'saved expired' ? 'expired' : state === 'elapsed open' ? 'open' : 'waiting_user'])
    const originalRuns = (await pool.query('SELECT * FROM agent_runs WHERE id=ANY($1::uuid[]) ORDER BY id', [[f.run.id, f.verify.id]])).rows
    const originalAttempts = (await pool.query('SELECT * FROM factory_attempts WHERE "taskId"=$1 ORDER BY position', [f.task.id])).rows
    const question = (await pool.query('SELECT * FROM factory_questions WHERE "taskId"=$1', [f.task.id])).rows[0]
    const detail = await f.handleFactory(f.human, { ...f.request, method: 'GET' })
    assert.deepEqual((detail.body as { candidateRecheck?: unknown }).candidateRecheck, { binding: f.request.body.binding })
    if (question) assert.deepEqual((await pool.query('SELECT * FROM factory_questions WHERE id=$1', [question.id])).rows[0], question, 'GET never persists expiry or supersession')
    const humanSessionId = randomUUID(), oldActor = { source: 'human' as const, userId: f.ownerId, sessionId: humanSessionId }
    const oldReference = question && (await f.questions.read(f.ownerId, question.id)).reference
    const rejectsExpiredAnswer = () => assert.rejects(f.questions.answer(oldActor, { reference: oldReference, answerId: randomUUID(), text: 'This old continuation must not resume.' }),
      (error: unknown) => (error as { code?: string }).code === 'factoryQuestionExpired')
    if (expired) {
      await pool.query(`INSERT INTO "session" (id,"userId",token,"expiresAt","createdAt","updatedAt") VALUES ($1,$2,$3,now()+interval '1 hour',now(),now())`,
        [humanSessionId, f.ownerId, `fixture-${randomUUID()}`])
      await assert.rejects(f.questions.recover(oldActor, { requestId: randomUUID(), expectedFailedRunId: f.verify.id, reference: oldReference }),
        (error: unknown) => (error as { code?: string }).code === 'factoryQuestionExpired')
      await assert.rejects(f.questions.claimContinuation(f.ownerId, f.verify.deviceId, f.verify.id, new Date(Date.now() + 60_000).toISOString()),
        (error: unknown) => (error as { code?: string }).code === 'factoryQuestionContinuationUnavailable')
    }
    // Changing present preferences cannot change either historical selection.
    await pool.query('UPDATE model_order_settings SET "preferredHarness"=\'claude_code\' WHERE "ownerId"=$1 AND "workspaceId"=$2', [f.ownerId, f.workspaceId])
    decisionProfile = f.implement!.id
    const decisionsBefore = decisionCounts()
    const [response, duplicate] = await Promise.all([f.handleFactory(f.human, f.request), f.handleFactory(f.human, f.request),
      expired ? rejectsExpiredAnswer() : Promise.resolve()])
    assert.equal(response.status, 200, JSON.stringify(response.body)); assert.deepEqual(duplicate, response)
    const result = response.body as FactorySnapshot
    assert.equal(result.task.stage, 'review'); assert.equal(result.task.status, 'running')
    assert.equal(result.task.revision, f.current.revision + 2); assert.equal(result.task.candidateId, f.current.candidateId)
    assert.equal(result.task.sourceEventId, f.current.sourceEventId)
    const review = (await pool.query('SELECT r.* FROM factory_attempts a JOIN agent_runs r ON r.id=a."runId" WHERE a.id=$1', [result.task.attemptId])).rows[0]
    for (const key of ['harness', 'model', 'subscription', 'agentProfile', 'modelDispatch']) assert.deepEqual(review.agentDefinition[key], originalRuns.find(r => r.id === f.run.id).agentDefinition[key], key)
    for (const key of ['sessionId', 'continuesRunId', 'retryOf', 'questionContinuation']) assert.equal(review[key], null, key)
    const machine = (await pool.query('SELECT * FROM thread_machines WHERE "runId"=$1', [review.id])).rows[0]
    assert.equal(machine.state, 'starting'); assert.equal(machine.snapshotId, 'pending'); assert.equal(machine.sandboxId, null)
    if (question) {
      const after = (await pool.query('SELECT * FROM factory_questions WHERE id=$1', [question.id])).rows[0]
      assert.equal(after.status, expired ? 'expired' : 'superseded')
      for (const key of ['expiresAt', 'answerId', 'answerSource', 'answerSourceEventId', 'answerFingerprint', 'answeredAt', 'answer', 'result', 'continuationRunId']) assert.deepEqual(after[key], question[key], key)
      assert.equal(after.revision, question.revision + (question.status === 'expired' ? 0 : 1))
      if (question.status === 'expired') assert.deepEqual(after, question, 'a terminal expired question remains byte-for-byte unchanged')
      const receipt = (await pool.query('SELECT request FROM factory_events WHERE "taskId"=$1 AND "eventId"=$2', [f.task.id, f.request.body.eventId])).rows[0]
      assert.deepEqual(receipt.request.questionDisposition, { id: question.id, revision: question.revision, fromStatus: question.status, toStatus: expired ? 'expired' : 'superseded' })
      if (expired) await rejectsExpiredAnswer()
    }
    assert.deepEqual((await pool.query('SELECT * FROM factory_attempts WHERE id=ANY($1::uuid[]) ORDER BY position', [originalAttempts.map(a => a.id)])).rows, originalAttempts)
    const next = await f.complete(review.id)
    assert.equal(next.stage, 'verify'); assert.equal(next.status, 'running')
    const verify = (await pool.query('SELECT r.* FROM factory_attempts a JOIN agent_runs r ON r.id=a."runId" WHERE a.id=$1', [next.attemptId])).rows[0]
    for (const key of ['harness', 'model', 'subscription', 'agentProfile', 'modelDispatch']) assert.deepEqual(verify.agentDefinition[key], originalRuns.find(r => r.id === f.verify.id).agentDefinition[key], key)
    assert.notEqual(verify.id, review.id)
    const verifyMachine = (await pool.query('SELECT * FROM thread_machines WHERE "runId"=$1', [verify.id])).rows[0]
    assert.equal(verifyMachine.state, 'starting'); assert.equal(verifyMachine.snapshotId, 'pending')
    assert.notEqual(verifyMachine.operationId, machine.operationId, 'each independent run queues its own new thread machine')
    const approved = await f.complete(verify.id)
    assert.equal(approved.stage, 'approval'); assert.equal(approved.status, 'pending'); assert.equal(approved.candidateId, f.current.candidateId)
    assert.deepEqual(decisionCounts(), decisionsBefore, 'neither check reselects a role or model')
    assert.deepEqual((await pool.query('SELECT * FROM agent_runs WHERE id=ANY($1::uuid[]) ORDER BY id', [[f.run.id, f.verify.id]])).rows, originalRuns)
    assert.deepEqual(await f.handleFactory(f.human, f.request), response, 'the same Owner event replays without queuing another pair')
    assert.equal((await f.handleFactory(f.human, { ...f.request, body: { ...f.request.body, reason: 'Different intent' } })).status, 409)
  })
  await t.test('Owner recheck rejects stale, stopped, answered, active and accepted state without changing historical evidence', async t => {
    const f = await recheckCandidate(true, true)
    const base = (await pool.query('SELECT * FROM factory_tasks WHERE id=$1', [f.task.id])).rows[0]
    const question = (await pool.query('SELECT * FROM factory_questions WHERE "taskId"=$1', [f.task.id])).rows[0]
    const mutations = [
      ["UPDATE factory_tasks SET route=route || '{\"flowVersion\":2}' WHERE id=$1", [f.task.id]],
      ["UPDATE factory_tasks SET revision=revision+1 WHERE id=$1", [f.task.id]],
      ["UPDATE factory_tasks SET status='cancelled' WHERE id=$1", [f.task.id]],
      ["UPDATE agent_runs SET \"leaseExpiresAt\"=now()+interval '1 minute' WHERE id=$1", [f.verify.id]],
      ["UPDATE agent_runs SET status='running' WHERE id=$1", [f.verify.id]],
      ["UPDATE factory_questions SET status='answered',\"answerId\"=$2 WHERE id=$1", [question.id, randomUUID()]],
      ["UPDATE factory_questions SET status='blocked',\"answerId\"=$2 WHERE id=$1", [question.id, randomUUID()]],
      ["UPDATE factory_questions SET status='expired',\"expiresAt\"=NULL WHERE id=$1", [question.id]],
      ["UPDATE factory_questions SET status='expired',\"expiresAt\"=now()+interval '1 minute' WHERE id=$1", [question.id]],
      ["UPDATE factory_questions SET status='expired',\"expiresAt\"=now()-interval '1 minute',\"originSessionId\"='wrong-session' WHERE id=$1", [question.id]],
      ["UPDATE factory_questions SET status='expired',\"expiresAt\"=now()-interval '1 minute',\"answerSource\"='human' WHERE id=$1", [question.id]],
      ["UPDATE factory_questions SET status='expired',\"expiresAt\"=now()-interval '1 minute',\"answerFingerprint\"='partial-answer' WHERE id=$1", [question.id]],
      ["UPDATE factory_questions SET status='expired',\"expiresAt\"=now()-interval '1 minute',\"answerSourceEventId\"=$2 WHERE id=$1", [question.id, randomUUID()]],
      ["UPDATE factory_questions SET status='expired',\"expiresAt\"=now()-interval '1 minute',\"answeredAt\"=now() WHERE id=$1", [question.id]],
      ["UPDATE factory_questions SET status='expired',\"expiresAt\"=now()-interval '1 minute',answer='{}' WHERE id=$1", [question.id]],
      ["UPDATE factory_questions SET status='expired',\"expiresAt\"=now()-interval '1 minute',result='{}' WHERE id=$1", [question.id]],
      ["UPDATE factory_questions SET status='expired',\"expiresAt\"=now()-interval '1 minute',\"continuationRunId\"=$2 WHERE id=$1", [question.id, f.verify.id]],
      ['UPDATE factory_questions SET "waitingBinding"=jsonb_set("waitingBinding",\'{revision}\',to_jsonb($2::int)) WHERE id=$1', [question.id, base.revision + 1]],
      ['UPDATE agent_runs SET "questionContinuation"=$2 WHERE id=$1', [f.verify.id, JSON.stringify({ questionId: question.id })]],
      ['UPDATE factory_attempts SET output=jsonb_set(output,\'{check,requestEpoch}\',to_jsonb($2::text)) WHERE id=$1', [f.attempt.id, randomUUID()]],
      ['INSERT INTO factory_deliverable_acceptances (id,"taskId","candidateId","userId","sessionId","eventId") VALUES ($1,$2,$3,$4,\'synthetic\',$5)', [randomUUID(), f.task.id, base.candidateId, f.ownerId, randomUUID()]],
    ] as const
    for (const [sql, values] of mutations) await t.test(sql, async () => {
      const tx = await pool.connect()
      try {
        await tx.query('BEGIN'); await tx.query(sql, [...values])
        const { candidateRecheckForRecovery } = await import('./candidate-recheck')
        const current = (await tx.query('SELECT * FROM factory_tasks WHERE id=$1', [f.task.id])).rows[0]
        assert.equal(await candidateRecheckForRecovery(tx, current, true), null)
      } finally { await tx.query('ROLLBACK'); tx.release() }
    })
    assert.equal((await f.handleFactory(f.human, { ...f.request, userId: null })).status, 401)
    assert.equal((await f.handleFactory(f.human, { ...f.request, origin: 'https://other.example' })).status, 403)
    assert.equal((await f.handleFactory(f.human, { ...f.request, userId: await seedUser(pool, 'foreign-recheck') })).status, 404)
    assert.equal((await f.handleFactory(f.human, { ...f.request, body: { ...f.request.body, binding: { ...f.request.body.binding, revision: base.revision - 1 } } })).status, 409)
  })
  await t.test('Owner recheck refuses an expiry crossing preflight and the locked write, then accepts a fresh exact request', async () => {
    const f = await recheckCandidate(true, true)
    const question = (await pool.query('SELECT * FROM factory_questions WHERE "taskId"=$1', [f.task.id])).rows[0]
    await pool.query(`UPDATE byos_connections SET quota=jsonb_set(quota,'{observedAt}',to_jsonb((now()-interval '94 seconds')::text)) WHERE "ownerId"=$1`, [f.ownerId])
    await pool.query(`UPDATE factory_questions SET "expiresAt"=clock_timestamp()+interval '2 seconds' WHERE id=$1`, [question.id])
    const before = (await pool.query('SELECT * FROM factory_questions WHERE id=$1', [question.id])).rows[0]
    const oldProbe = usageProbe
    let crossed = false
    usageProbe = async (owner, connection) => {
      assert.equal(owner, f.ownerId)
      if (!crossed) {
        crossed = true
        assert.equal((await pool.query('SELECT "expiresAt">clock_timestamp() AS fresh FROM factory_questions WHERE id=$1', [question.id])).rows[0].fresh, true)
        await pool.query('SELECT pg_sleep(GREATEST(0,extract(epoch FROM ("expiresAt"-clock_timestamp())))+0.02) FROM factory_questions WHERE id=$1', [question.id])
      }
      await pool.query(`UPDATE byos_connections SET quota=jsonb_set(quota,'{observedAt}',to_jsonb(now()::text)) WHERE id=$1 AND "ownerId"=$2`, [connection, owner])
    }
    try {
      const response = await f.handleFactory(f.human, f.request)
      assert.equal(crossed, true); assert.equal(response.status, 409); assert.deepEqual(response.body, { error: 'factoryStale' })
    } finally { usageProbe = oldProbe }
    assert.deepEqual((await pool.query('SELECT * FROM factory_questions WHERE id=$1', [question.id])).rows[0], before)
    assert.deepEqual((await f.store.read(f.ownerId, f.task.id)).task, f.current)
    assert.equal((await pool.query('SELECT 1 FROM factory_events WHERE "taskId"=$1 AND "eventId"=$2', [f.task.id, f.request.body.eventId])).rowCount, 0)
    assert.equal((await f.handleFactory(f.human, f.request)).status, 200, 'no failed preflight event or answer is forged; the Owner can read and retry')
    const after = (await pool.query('SELECT * FROM factory_questions WHERE id=$1', [question.id])).rows[0]
    assert.equal(after.status, 'expired'); assert.deepEqual(after.expiresAt, before.expiresAt); assert.equal(after.answerId, null); assert.equal(after.result, null)
  })
  await t.test('a failed Owner recheck keeps its candidate and original verdict, with no automatic repair or alternate model', async () => {
    const f = await recheckCandidate(false, true)
    const response = await f.handleFactory(f.human, f.request)
    assert.equal(response.status, 200)
    const result = response.body as FactorySnapshot
    const attempt = result.attempts.find(a => a.id === result.task.attemptId)!
    const decisionsBefore = decisionCounts()
    const failed = await f.complete(attempt.runId!, false, true)
    assert.equal(failed.stage, 'review'); assert.equal(failed.status, 'failed'); assert.equal(failed.candidateId, f.current.candidateId)
    assert.deepEqual(decisionCounts(), decisionsBefore)
    assert.equal((await pool.query('SELECT count(*)::int n FROM factory_attempts WHERE "taskId"=$1 AND stage=\'execute\'', [f.task.id])).rows[0].n, 1)
  })
  for (const stage of ['review', 'verify'] as const) for (const quota of [false, true]) await t.test(`Owner ${stage} keeps its exact legacy subscription after ${quota ? 'quota exhaustion' : 'provider failure'}`, async () => {
    const f = await recheckCandidate(false, true)
    const response = await f.handleFactory(f.human, f.request)
    assert.equal(response.status, 200)
    let task = (response.body as FactorySnapshot).task
    if (stage === 'verify') task = await f.complete((response.body as FactorySnapshot).attempts.find(a => a.id === task.attemptId)!.runId!)
    const run = (await pool.query('SELECT r.* FROM factory_attempts a JOIN agent_runs r ON r.id=a."runId" WHERE a.id=$1', [task.attemptId])).rows[0]
    assert.equal(run.agentDefinition.modelDispatch.mode, 'preference')
    assert.equal(run.agentDefinition.agentProfile, undefined)
    // Both another healthy official subscription and an API source are offered.
    // No key is opened and no provider call is made in this real SQL fixture.
    const keyId = randomUUID()
    await pool.query(`INSERT INTO model_api_keys (id,"ownerId",provider,protocol,ciphertext,iv,"keyVersion",last4,models)
      VALUES ($1,$2,'openai','openai','synthetic-unopened','synthetic-unopened',1,'test',$3)`, [keyId, f.ownerId, JSON.stringify([model.codex])])
    await pool.query(`INSERT INTO model_order_entries (id,"ownerId","workspaceId",position,harness,model,"sourceKind","sourceId")
      VALUES ($1,$2,$3,2,'codex',$4,'api_key',$5)`, [randomUUID(), f.ownerId, f.workspaceId, model.codex, keyId])
    const { emptyRunReport } = await import('@mikka/protocol/run')
    const { recoverProviderFailure, pendingProviderFallback, providerCompletion } = await import('../run-provider-fallback')
    const completion = providerCompletion(run, { stopReason: quota ? 'quota_exhausted' : 'provider_failure', report: {
      ...emptyRunReport('Synthetic adapter provider failure'), check: { sha: run.baseBranch, readOnly: true },
      ...(!quota ? { providerFailure: { kind: 'unavailable' as const, retryable: true as const, code: 'rate_limit' as const } } : {}),
    } })
    const report = { ...completion.report, modelFallback: pendingProviderFallback(run, completion.report!.providerFailure!) }
    await pool.query(`UPDATE agent_runs SET status='failed',"stopReason"='provider_failure',"startedAt"=now()-interval '1 second',
      "finishedAt"=now(),"leaseExpiresAt"=NULL,"sessionId"=$2,report=$3 WHERE id=$1`, [run.id, `independent-${run.id}`, JSON.stringify(report)])
    const beforeRuns = (await pool.query('SELECT id FROM agent_runs WHERE "issueId"=$1 ORDER BY id', [f.issueId])).rows
    const beforeBindings = (await pool.query('SELECT id FROM byos_bindings WHERE "ownerId"=$1 ORDER BY id', [f.ownerId])).rows
    const beforeDecisions = decisionCounts(), beforeUsage = usageCalls.length
    assert.equal(await recoverProviderFailure(pool, f.ownerId, run.id), null)
    assert.equal(await recoverProviderFailure(pool, f.ownerId, run.id), null, 'a repeated completion cannot plan an alternate')
    assert.deepEqual((await pool.query('SELECT id FROM agent_runs WHERE "issueId"=$1 ORDER BY id', [f.issueId])).rows, beforeRuns)
    assert.deepEqual((await pool.query('SELECT id FROM byos_bindings WHERE "ownerId"=$1 ORDER BY id', [f.ownerId])).rows, beforeBindings)
    assert.deepEqual(decisionCounts(), beforeDecisions); assert.equal(usageCalls.length, beforeUsage)
    const failed = (await pool.query('SELECT * FROM agent_runs WHERE id=$1', [run.id])).rows[0]
    assert.deepEqual(failed.agentDefinition, run.agentDefinition)
    assert.equal(failed.report.modelFallback.state, 'picked')
    assert.equal(failed.report.modelFallback.retryRunId, undefined)
    // Even a separately queued, otherwise valid host provider receipt cannot
    // adopt another subscription/API source into this Owner's frozen round.
    await factoryResourceWorkspace(pool)(f.ownerId, task.id, async () => {
    const tx = await pool.connect()
    try {
      await tx.query('BEGIN')
      const { readOrder } = await import('../model-order')
      const entries = (await readOrder(tx, f.scope)).entries
      const target = entries.find(entry => quota ? entry.source.kind === 'api_key'
        : entry.source.kind === 'subscription' && entry.harness !== run.agentDefinition.harness)!
      assert.ok(target)
      const subscriptionBindingId = target.source.kind === 'subscription'
        ? await bindAgentToConnection(tx, f.scope, f.agents[target.harness], target.harness, target.source.connectionId, target.model) : undefined
      const queued = await queueCloudRun(pool, f.actor, { botId: f.botId, issueId: f.issueId, agentId: f.agents[target.harness], deviceRepoId: f.repoId,
        title: 'Synthetic inadmissible provider continuation', body: 'Isolated transaction; never started', model: target.model,
        modelDispatch: { mode: 'preference', location: 'cloud', entry: target }, readOnly: true, sourceEventId: f.sourceEventId,
        ...(subscriptionBindingId ? { subscriptionBindingId } : {}), ...(target.source.kind === 'api_key' ? { apiKeyId: target.source.keyId } : {}),
      }, tx)
      const child = (await tx.query('SELECT * FROM agent_runs WHERE id=$1', [queued.runId])).rows[0]
      const { providerContinuationDefinition, providerContinuationMatches, providerContinuationLaunchMatches } = await import('../run-provider-fallback')
      const prompt = (await import('../run-retry')).providerContinuationPrompt(run.prompt)
      const definition = providerContinuationDefinition(run.agentDefinition, child.agentDefinition, prompt)
      definition.executionIdentity = await (await import('../execution-identity')).freezeExecutionIdentity(tx, { ...child, agentDefinition: definition }, undefined, f.workspaceId)
      await tx.query('UPDATE agent_runs SET "retryOf"=$2,kind=$3,"baseBranch"=$4,prompt=$5,"agentDefinition"=$6 WHERE id=$1',
        [child.id, run.id, run.kind, run.baseBranch, prompt, JSON.stringify(definition)])
      await tx.query(`UPDATE agent_runs SET report=jsonb_set(report,'{modelFallback}',$2::jsonb) WHERE id=$1`, [run.id, JSON.stringify({
        ...failed.report.modelFallback, state: 'switched', to: { harness: target.harness, model: target.model, source: target.source.kind },
        retryRunId: child.id, nextDefinitionDigest: definition.definitionDigest,
      })])
      const prior = (await tx.query('SELECT * FROM agent_runs WHERE id=$1', [run.id])).rows[0]
      const next = (await tx.query('SELECT * FROM agent_runs WHERE id=$1', [child.id])).rows[0]
      assert.equal(providerContinuationMatches(prior, next), true, 'the ordinary host continuation contract is otherwise valid')
      assert.equal(await providerContinuationLaunchMatches(tx, prior, next), false, 'launch still requires the Owner round source')
      await assert.rejects(f.store.apply(f.ownerId, factoryBinding(task), randomUUID(), { action: 'adopt_retry', runId: child.id, reason: 'Synthetic forbidden source change' }, tx),
        (error: unknown) => (error as { code?: string }).code === 'factoryRunMismatch')
    } finally { await tx.query('ROLLBACK'); tx.release() }
    })
    await f.reconcile.run(f.ownerId, run.id)
    const current = (await f.store.read(f.ownerId, f.task.id)).task
    assert.equal(current.stage, stage); assert.equal(current.status, 'blocked'); assert.equal(current.candidateId, f.current.candidateId)
    assert.equal((await pool.query('SELECT count(*)::int n FROM factory_attempts WHERE "taskId"=$1 AND stage=\'execute\'', [f.task.id])).rows[0].n, 1)
  })
  await t.test('a lost Owner response does not restart a committed check, and normal retry keeps its frozen round after startup failure', async () => {
    const f = await recheckCandidate(true, true)
    const response = await f.handleFactory(f.human, f.request)
    assert.equal(response.status, 200)
    const result = response.body as FactorySnapshot, attempt = result.attempts.find(a => a.id === result.task.attemptId)!
    const queued = (await pool.query('SELECT * FROM agent_runs WHERE id=$1', [attempt.runId])).rows[0]
    const beforeHandoffs = handoffs.length
    // Exact terminal metadata written by failFactoryCloudStage when enqueue
    // fails before claim; this is not a Profile refusal or a native resume.
    await pool.query(`UPDATE agent_runs SET status='failed',"stopReason"='device_lost',error='Cloud stage handoff could not be queued',
      "finishedAt"=now(),"updatedAt"=now() WHERE id=$1`, [queued.id])
    await f.reconcile.run(f.ownerId, queued.id)
    const blocked = (await f.store.read(f.ownerId, f.task.id)).task
    assert.equal(blocked.stage, 'review'); assert.equal(blocked.status, 'blocked')
    assert.deepEqual(await f.handleFactory(f.human, f.request), response)
    assert.equal(handoffs.length, beforeHandoffs, 'replaying the committed Owner event never starts or creates a second run')
    const retried = await f.handleFactory(f.human, { ...f.request, body: { action: 'retry', reason: 'Retry the unstarted check',
      eventId: randomUUID(), binding: { taskId: blocked.id, revision: blocked.revision } } })
    assert.equal(retried.status, 200)
    const pending = (retried.body as FactorySnapshot).task
    assert.equal(pending.stage, 'review'); assert.equal(pending.status, 'pending'); assert.equal(pending.candidateId, f.current.candidateId)
    const { beginFactoryTransaction, commitFactoryTransaction, rollbackFactoryTransaction, forgetFactoryTransaction } = await import('./transaction')
    await factoryResourceWorkspace(pool)(f.ownerId, pending.id, async () => {
    const tx = await pool.connect()
    try {
      await beginFactoryTransaction(tx)
      const start = await automaticFactoryDispatch(pool)(tx, f.store, pending, queued)
      await commitFactoryTransaction(tx)
      await start?.()
    } catch (error) { await rollbackFactoryTransaction(tx); throw error }
    finally { forgetFactoryTransaction(tx); tx.release() }
    })
    const next = (await pool.query('SELECT r.* FROM factory_tasks t JOIN factory_attempts a ON a.id=t."attemptId" JOIN agent_runs r ON r.id=a."runId" WHERE t.id=$1', [f.task.id])).rows[0]
    assert.notEqual(next.id, queued.id)
    for (const key of ['harness', 'model', 'subscription', 'agentProfile', 'modelDispatch']) assert.deepEqual(next.agentDefinition[key], queued.agentDefinition[key], key)
    for (const key of ['sessionId', 'retryOf', 'continuesRunId', 'questionContinuation']) assert.equal(next[key], null, key)
    assert.equal((await f.store.read(f.ownerId, f.task.id)).task.candidateId, f.current.candidateId)
  })
  for (const expired of [false, true]) await t.test(`same-candidate Owner receipt failure rolls back question ${expired ? 'expiry' : 'supersession'}, queue and task together`, async () => {
    const f = await recheckCandidate(true, true)
    if (expired) await pool.query(`UPDATE factory_questions SET status='waiting_user',"expiresAt"=now()-interval '1 minute' WHERE "taskId"=$1`, [f.task.id])
    const rows = async () => ({
      task: (await pool.query('SELECT * FROM factory_tasks WHERE id=$1', [f.task.id])).rows,
      attempts: (await pool.query('SELECT * FROM factory_attempts WHERE "taskId"=$1 ORDER BY position', [f.task.id])).rows,
      questions: (await pool.query('SELECT * FROM factory_questions WHERE "taskId"=$1 ORDER BY id', [f.task.id])).rows,
      runs: (await pool.query('SELECT * FROM agent_runs WHERE "issueId"=$1 ORDER BY id', [f.issueId])).rows,
    })
    const before = await rows()
    await pool.query(`CREATE FUNCTION reject_recheck_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic Owner recheck receipt failure'; END $$;
      CREATE TRIGGER reject_recheck_receipt BEFORE INSERT ON factory_events FOR EACH ROW
      WHEN (NEW.request->>'kind'='owner_candidate_recheck') EXECUTE FUNCTION reject_recheck_receipt()`)
    try { await assert.rejects(f.handleFactory(f.human, f.request), /synthetic Owner recheck receipt failure/) }
    finally { await pool.query('DROP TRIGGER reject_recheck_receipt ON factory_events; DROP FUNCTION reject_recheck_receipt()') }
    assert.deepEqual(await rows(), before)
    await pool.query('UPDATE byos_connections SET paused=true WHERE id=$1', [f.connections.codex])
    assert.equal((await f.handleFactory(f.human, f.request)).status, 409)
    assert.deepEqual(await rows(), before, 'source refusal never consumes the waiting question')
  })
  await t.test('a missing exact verify source in the Owner receipt cannot fall back to current preferences', async () => {
    const f = await recheckCandidate(false, true)
    const response = await f.handleFactory(f.human, f.request)
    assert.equal(response.status, 200)
    const result = response.body as FactorySnapshot, review = result.attempts.find(a => a.id === result.task.attemptId)!
    await pool.query(`UPDATE factory_events SET request=jsonb_set(request,'{sources,verify,runId}',to_jsonb($3::text)) WHERE "taskId"=$1 AND "eventId"=$2`, [f.task.id, f.request.body.eventId, randomUUID()])
    const before = decisionCounts()
    const blocked = await f.complete(review.runId!)
    assert.equal(blocked.stage, 'review'); assert.equal(blocked.status, 'blocked'); assert.equal(blocked.candidateId, f.current.candidateId)
    assert.equal((await pool.query('SELECT count(*)::int n FROM factory_attempts WHERE "taskId"=$1 AND stage=\'verify\'', [f.task.id])).rows[0].n, 1)
    assert.deepEqual(decisionCounts(), before)
  })
  for (const exhausted of [false, true]) await t.test(`Owner recheck discovers a stale allowance without probing and re-admits official ${exhausted ? 'exhaustion' : 'availability'} only on POST`, async () => {
    const f = await recheckCandidate(true, true), oldProbe = usageProbe
    await pool.query(`UPDATE byos_connections SET quota=jsonb_set(quota,'{observedAt}',to_jsonb((now()-interval '94 seconds')::text)) WHERE "ownerId"=$1`, [f.ownerId])
    const beforeCalls = usageCalls.length
    assert.ok((await f.handleFactory(f.human, { ...f.request, method: 'GET' })).body &&
      (await f.human.read(f.ownerId, f.task.id)).candidateRecheck)
    assert.equal(usageCalls.length, beforeCalls)
    usageProbe = async (owner, connection) => {
      assert.equal(owner, f.ownerId)
      await pool.query(`UPDATE byos_connections SET quota=jsonb_set(jsonb_set(quota,'{observedAt}',to_jsonb(now()::text)),'{windows,0,used}',$3::jsonb) WHERE id=$1 AND "ownerId"=$2`, [connection, owner, exhausted ? '1' : '0.1'])
    }
    try {
      const response = await f.handleFactory(f.human, f.request)
      assert.equal(response.status, exhausted ? 409 : 200, JSON.stringify(response.body))
      assert.ok(usageCalls.length > beforeCalls)
      const current = (await f.store.read(f.ownerId, f.task.id)).task
      assert.equal(current.stage, exhausted ? 'verify' : 'review'); assert.equal(current.status, exhausted ? 'waiting' : 'running')
      if (exhausted) assert.equal((await pool.query('SELECT status FROM factory_questions WHERE "taskId"=$1', [f.task.id])).rows[0].status, 'open')
    } finally { usageProbe = oldProbe }
  })
  const recheckCallsEnd = decisionInputs.length
  const unsubmittedReview = async (snapshot = false) => {
    const f = await exercise(false, false, false)
    // The daemon boundary is synthetic; queue, immutable completion receipt,
    // original candidate, Owner API, authorization and fresh dispatch are real.
    // Legacy workers did not attach a check snapshot to an unsubmitted turn.
    const report = { summary: 'Session ended without a submission summary.', filesChanged: [], verify: { status: 'not_run' },
      openQuestions: [], nextStep: null, ...(snapshot ? { check: { sha: f.run.baseBranch, readOnly: true } } : {}) }
    await pool.query(`UPDATE agent_runs SET status='stopped',"stopReason"='turn_ended',error=NULL,
      "startedAt"=clock_timestamp()-interval '1 second',"finishedAt"=clock_timestamp(),"sessionId"=$2,report=$3 WHERE id=$1 AND status='queued'`,
      [f.run.id, `independent-unsubmitted-${f.run.id}`, JSON.stringify(report)])
    const { reconcileFactoryCheck } = await import('./reconcile-check')
    const reconciler = createFactoryReconciler(pool, f.store, undefined, { review: reconcileFactoryCheck }, f.botId)
    await reconciler.run(f.ownerId, f.run.id)
    const blocked = await f.store.read(f.ownerId, f.task.id)
    assert.equal(blocked.task.status, 'blocked'); assert.equal(blocked.task.stage, 'review')
    const attempt = (await pool.query('SELECT * FROM factory_attempts WHERE id=$1', [blocked.task.attemptId])).rows[0]
    assert.equal(attempt.output.completion.stopReason, 'turn_ended')
    assert.equal(attempt.output.completion.trustedFailureProvenance, snapshot)
    assert.equal(attempt.sessionId, `independent-unsubmitted-${f.run.id}`)
    return { ...f, blocked, attempt }
  }
  for (const snapshot of [false, true]) await t.test(`Owner finishes the one unsubmitted review with a fresh independent checker (daemon snapshot: ${snapshot})`, async () => {
    const f = await unsubmittedReview(snapshot), human = humanStore()
    const { handleFactory } = await import('./http')
    const { factoryEventId } = await import('./event-id')
    const binding = { taskId: f.task.id, revision: f.blocked.task.revision }, eventId = randomUUID()
    const request = { userId: f.ownerId, method: 'POST', taskId: f.task.id, origin: 'https://app.example',
      url: `https://app.example/api/factory/tasks/${f.task.id}`, body: { binding, eventId, action: 'retry', reason: 'Finish the unsubmitted independent review of this same candidate.' } }
    const beforeRun = (await pool.query('SELECT * FROM agent_runs WHERE id=$1', [f.run.id])).rows[0]
    const beforeProducer = (await pool.query('SELECT * FROM agent_runs WHERE id=$1', [f.source.runId])).rows[0]
    const beforeAttempt = (await pool.query('SELECT * FROM factory_attempts WHERE id=$1', [f.attempt.id])).rows[0]
    const beforeCandidate = (await pool.query('SELECT * FROM factory_candidates WHERE id=$1', [f.candidate.id])).rows[0]
    const beforeFinish = (await pool.query('SELECT * FROM factory_events WHERE "taskId"=$1 AND "eventId"=$2',
      [f.task.id, factoryEventId('check-completion', f.run.id)])).rows[0]
    const beforeHandoffs = handoffs.length, beforeDecisions = decisionCounts()
    const detail = await handleFactory(human, { ...request, method: 'GET' })
    assert.equal(detail.status, 200)
    assert.deepEqual((detail.body as { checkSubmissionRecovery?: unknown }).checkSubmissionRecovery, { binding })
    assert.equal((detail.body as { checkStartRecovery?: unknown }).checkStartRecovery, undefined, 'an executed turn is never described as unstarted')
    await assert.rejects(f.store.apply(f.ownerId, binding, randomUUID(), { action: 'retry', reason: 'A model cannot acquire the Owner capability' }), { code: 'factoryTransition' })
    assert.equal((await handleFactory(human, { ...request, userId: null })).status, 401)
    assert.equal((await handleFactory(human, { ...request, origin: 'https://other.example' })).status, 403)
    assert.equal((await handleFactory(human, { ...request, userId: await seedUser(pool, 'foreign-review-owner') })).status, 404)
    const [response, duplicate] = await Promise.all([handleFactory(human, request), handleFactory(human, request)])
    assert.equal(response.status, 200, JSON.stringify(response.body))
    assert.deepEqual(duplicate, response)
    const result = response.body as FactorySnapshot, nextAttempt = result.attempts.find(a => a.id === result.task.attemptId)!
    assert.equal(result.task.stage, 'review'); assert.equal(result.task.status, 'running')
    assert.equal(result.task.revision, binding.revision + 2)
    assert.equal(result.task.candidateId, f.candidate.id); assert.equal(result.task.sourceEventId, f.sourceEventId)
    assert.notEqual(nextAttempt.id, f.attempt.id); assert.ok(nextAttempt.runId)
    const next = (await pool.query('SELECT * FROM agent_runs WHERE id=$1', [nextAttempt.runId])).rows[0]
    assert.equal(next.status, 'queued'); assert.equal(next.kind, 'acceptance'); assert.equal(next.baseBranch, beforeRun.baseBranch)
    for (const key of ['harness', 'model', 'subscription', 'agentProfile', 'modelDispatch'])
      assert.deepEqual(next.agentDefinition[key], beforeRun.agentDefinition[key], key)
    assert.equal(next.agentDefinition.readOnly, true)
    for (const key of ['sessionId', 'startedAt', 'leaseExpiresAt', 'continuesRunId', 'retryOf', 'questionContinuation']) assert.equal(next[key], null, key)
    assert.equal(next.agentDefinition.profileOriginRunId, undefined)
    const nextOutput = (await pool.query('SELECT output FROM factory_attempts WHERE id=$1', [nextAttempt.id])).rows[0].output
    for (const key of ['stage', 'candidateId', 'sha', 'repository', 'candidateEnvironment', 'requestEpoch', 'command', 'inferCommand', 'reportOnly', 'policy'])
      assert.deepEqual(nextOutput.check[key], beforeAttempt.output.check[key], key)
    assert.deepEqual(decisionCounts(), beforeDecisions)
    assert.equal(handoffs.length, beforeHandoffs + 1)
    assert.deepEqual(handoffs.at(-1), { previous: f.run.id, runId: next.id })
    assert.deepEqual((await pool.query('SELECT * FROM agent_runs WHERE id=$1', [f.run.id])).rows[0], beforeRun)
    assert.deepEqual((await pool.query('SELECT * FROM agent_runs WHERE id=$1', [f.source.runId])).rows[0], beforeProducer)
    assert.deepEqual((await pool.query('SELECT * FROM factory_attempts WHERE id=$1', [f.attempt.id])).rows[0], beforeAttempt)
    assert.deepEqual((await pool.query('SELECT * FROM factory_candidates WHERE id=$1', [f.candidate.id])).rows[0], beforeCandidate)
    assert.deepEqual((await pool.query('SELECT * FROM factory_events WHERE "taskId"=$1 AND "eventId"=$2', [f.task.id, beforeFinish.eventId])).rows[0], beforeFinish)
    const receipt = (await pool.query('SELECT request FROM factory_events WHERE "taskId"=$1 AND "eventId"=$2', [f.task.id, eventId])).rows[0]
    assert.equal(receipt.request.kind, 'owner_check_submission_recovery')
    assert.equal(receipt.request.runId, f.run.id); assert.equal(receipt.request.attemptId, f.attempt.id)
    assert.deepEqual(await handleFactory(human, request), response)
    assert.equal(handoffs.length, beforeHandoffs + 1)
    assert.equal((await pool.query('SELECT 1 FROM agent_runs WHERE "issueId"=$1', [f.issueId])).rowCount, 3)
    assert.equal(result.attempts.filter(a => a.stage === 'execute').length, 1)
    // A further unsubmitted execution does not authorize an unbounded series
    // of independent reviews. The one explicit completion opportunity is spent.
    await pool.query(`UPDATE agent_runs SET status='stopped',"stopReason"='turn_ended',error=NULL,
      "startedAt"=clock_timestamp()-interval '1 second',"finishedAt"=clock_timestamp(),"sessionId"=$2,report=$3 WHERE id=$1`,
      [next.id, `fresh-independent-${next.id}`, beforeRun.report])
    const { reconcileFactoryCheck } = await import('./reconcile-check')
    await createFactoryReconciler(pool, f.store, undefined, { review: reconcileFactoryCheck }, f.botId).run(f.ownerId, next.id)
    const ended = await f.store.read(f.ownerId, f.task.id)
    assert.equal(ended.task.status, 'blocked'); assert.equal(ended.checkSubmissionRecovery, undefined)
    assert.equal((await handleFactory(human, { ...request, body: { ...request.body, eventId: randomUUID(),
      binding: { taskId: f.task.id, revision: ended.task.revision } } })).status, 409)
    assert.equal(handoffs.length, beforeHandoffs + 1)
  })
  await t.test('an unsubmitted-review capability refuses verdicts, changed receipts, cancellation, active work and stale custody', async t => {
    const f = await unsubmittedReview(), human = humanStore(), { handleFactory } = await import('./http')
    const { factoryEventId } = await import('./event-id')
    const beforeRun = (await pool.query('SELECT * FROM agent_runs WHERE id=$1', [f.run.id])).rows[0]
    const beforeAttempt = (await pool.query('SELECT * FROM factory_attempts WHERE id=$1', [f.attempt.id])).rows[0]
    const beforeHandoffs = handoffs.length, binding = { taskId: f.task.id, revision: f.blocked.task.revision }
    const runChange = (column: string, value: unknown) => async () => {
      await pool.query(`UPDATE agent_runs SET "${column}"=$2 WHERE id=$1`, [f.run.id, value])
      return async () => { await pool.query(`UPDATE agent_runs SET "${column}"=$2 WHERE id=$1`, [f.run.id, beforeRun[column]]) }
    }
    const cases: [string, () => Promise<() => Promise<void>>, (404 | 409)?][] = [
      ['submitted result', runChange('stopReason', 'submitted')],
      ['verdict criteria', runChange('report', { ...beforeRun.report, criteria: [{ text: 'A completed finding', passed: false, evidence: 'Synthetic verdict' }] })],
      ['verification result', runChange('report', { ...beforeRun.report, verify: { status: 'passed', command: 'node check.mjs', exitCode: 0 } })],
      ['stop request', runChange('stopRequestedAt', new Date())],
      ['live lease', runChange('leaseExpiresAt', new Date(Date.now() + 60_000))],
      ['mismatched native session', runChange('sessionId', 'another-check-session')],
      ['native continuation', runChange('continuesRunId', f.source.runId)],
      ['provider lineage', runChange('retryOf', f.source.runId)],
      ['changed immutable completion data', async () => {
        await pool.query(`UPDATE factory_attempts SET output=jsonb_set(output,'{completion,summary}','"rewritten"') WHERE id=$1`, [f.attempt.id])
        return async () => { await pool.query('UPDATE factory_attempts SET output=$2 WHERE id=$1', [f.attempt.id, beforeAttempt.output]) }
      }],
      ['missing completion receipt', async () => {
        const replacement = randomUUID(), eventId = factoryEventId('check-completion', f.run.id)
        await pool.query('UPDATE factory_events SET "eventId"=$3 WHERE "taskId"=$1 AND "eventId"=$2', [f.task.id, eventId, replacement])
        return async () => { await pool.query('UPDATE factory_events SET "eventId"=$3 WHERE "taskId"=$1 AND "eventId"=$2', [f.task.id, replacement, eventId]) }
      }],
      ['request epoch changed', async () => {
        await pool.query('UPDATE factory_tasks SET "sourceEventId"=$2 WHERE id=$1', [f.task.id, randomUUID()])
        return async () => { await pool.query('UPDATE factory_tasks SET "sourceEventId"=$2 WHERE id=$1', [f.task.id, f.sourceEventId]) }
      }, 404],
      ['candidate removed', async () => {
        await pool.query('UPDATE factory_tasks SET "candidateId"=NULL WHERE id=$1', [f.task.id])
        return async () => { await pool.query('UPDATE factory_tasks SET "candidateId"=$2 WHERE id=$1', [f.task.id, f.candidate.id]) }
      }],
      ['Owner cancellation', async () => {
        await pool.query("UPDATE factory_tasks SET status='cancelled' WHERE id=$1", [f.task.id])
        return async () => { await pool.query("UPDATE factory_tasks SET status='blocked' WHERE id=$1", [f.task.id]) }
      }],
      ['unresolved question', async () => {
        const id = randomUUID()
        await pool.query(`INSERT INTO factory_questions (id,"userId","issueId","taskId","attemptId",stage,"originRunId","originSessionId","originRevision","waitingBinding",kind,question,request,status,reason,"sourceEventId")
          VALUES ($1,$2,$3,$4,$5,'review',$6,$7,$8,$9,'context','Synthetic unresolved review question','{}','waiting_user','Needs an Owner answer',$10)`,
          [id, f.ownerId, f.issueId, f.task.id, f.attempt.id, f.run.id, beforeRun.sessionId, f.blocked.task.revision,
            JSON.stringify(factoryBinding(f.blocked.task)), f.sourceEventId])
        return async () => { await pool.query('DELETE FROM factory_questions WHERE id=$1', [id]) }
      }],
      ['another live run', async () => {
        await pool.query("UPDATE agent_runs SET status='running' WHERE id=$1", [f.source.runId])
        return async () => { await pool.query("UPDATE agent_runs SET status='succeeded' WHERE id=$1", [f.source.runId]) }
      }],
    ]
    for (const [name, change, expectedStatus = 409] of cases) await t.test(name, async () => {
      const undo = await change()
      try {
        const request = { userId: f.ownerId, method: 'POST', taskId: f.task.id,
          origin: 'https://app.example', url: `https://app.example/api/factory/tasks/${f.task.id}`,
          body: { binding, eventId: randomUUID(), action: 'retry', reason: 'Retry only if host custody is still valid' } }
        const detail = await handleFactory(human, { ...request, method: 'GET' })
        assert.equal(detail.status, expectedStatus === 404 ? 404 : 200)
        assert.equal((detail.body as { checkSubmissionRecovery?: unknown }).checkSubmissionRecovery, undefined)
        const response = await handleFactory(human, request)
        assert.equal(response.status, expectedStatus)
        assert.equal((await pool.query('SELECT 1 FROM agent_runs WHERE "issueId"=$1', [f.issueId])).rowCount, 2)
        assert.equal(handoffs.length, beforeHandoffs)
      } finally { await undo() }
    })
    const { readFactoryCheckFailure } = await import('./check-recovery-evidence')
    const tx = await pool.connect()
    try { await assert.rejects(readFactoryCheckFailure(tx, f.blocked.task), { code: 'factoryCheckBindingMismatch' }) }
    finally { tx.release() }
  })
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
  for (const withRouting of [false, true]) await t.test(`Owner retry preserves the ${withRouting ? 'routed' : 'legacy without routing'} review source without a new execution or model selection`, async () => {
    const f = await unclaimedReview(withRouting)
    assert.equal(f.blocked.task.route.flowVersion, 2)
    assert.equal(f.run.agentDefinition.modelDispatch.routing !== undefined, withRouting)
    // New defaults and a different preferred Harness cannot reinterpret an
    // already frozen check, including one recorded before routing existed.
    await pool.query('UPDATE model_order_settings SET "autoModelRouting"=true,"preferredHarness"=\'codex\' WHERE "ownerId"=$1 AND "workspaceId"=$2', [f.ownerId, f.workspaceId])
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
    const beforeCalls = decisionCounts(), beforeHandoffs = handoffs.length
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
    assert.deepEqual(decisionCounts(), beforeCalls, 'an explicit retry asks neither Profile nor difficulty Decision to choose another source')
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
  await t.test('Owner frozen-check recovery holds membership through commit and refuses the next request after revocation', async () => {
    const f = await unclaimedReview(), dispatch = automaticFactoryDispatch(pool)
    const before = await f.store.read(f.ownerId, f.task.id), beforeHandoffs = handoffs.length, beforeDecisions = decisionCounts()
    const beforeEvents = (await pool.query('SELECT 1 FROM factory_events WHERE "taskId"=$1', [f.task.id])).rowCount
    assert.ok(beforeEvents !== null)
    const previousRuns = (await pool.query('SELECT * FROM agent_runs WHERE "issueId"=$1 ORDER BY id', [f.issueId])).rows
    const revoker = await pool.connect()
    const pid = (await revoker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
    let queued = false, revoked = false, revocation: Promise<unknown> | undefined
    const human = humanStore(async (tx, store, task, run, recovery) => {
      const start = await dispatch(tx, store, task, run, recovery)
      assert.equal((await tx.query('SELECT 1 FROM agent_runs WHERE "issueId"=$1', [f.issueId])).rowCount, 3)
      queued = true
      // The current member lease serializes a real concurrent revocation after
      // the already admitted APP commit. It cannot slip between queue and commit.
      revocation = revoker.query("UPDATE mikka_workspace_members SET status='suspended' WHERE \"workspaceId\"=$1 AND \"userId\"=$2", [f.workspaceId, f.ownerId])
        .then(() => { revoked = true })
      const deadline = Date.now() + 1_000
      let blocked = false
      while (Date.now() < deadline) {
        blocked = (await pool.query('SELECT cardinality(pg_blocking_pids($1))>0 AS blocked', [pid])).rows[0].blocked
        if (blocked) break
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      assert.equal(blocked, true, 'the real revocation waits on the held Workspace member')
      assert.equal(revoked, false)
      return start
    })
    const { handleFactory } = await import('./http')
    const request = { userId: f.ownerId, method: 'POST', taskId: f.task.id, origin: 'https://app.example',
      url: `https://app.example/api/factory/tasks/${f.task.id}`, body: { binding: { taskId: f.task.id, revision: f.blocked.task.revision },
        eventId: randomUUID(), action: 'retry', reason: 'Retry only the frozen independent review' } }
    try {
      const response = await handleFactory(human, request)
      assert.equal(response.status, 200, JSON.stringify(response.body))
      assert.equal(queued, true)
      await revocation
      assert.equal(revoked, true)
      assert.equal((await pool.query('SELECT 1 FROM agent_runs WHERE "issueId"=$1', [f.issueId])).rowCount, 3)
      assert.equal((await pool.query('SELECT 1 FROM factory_attempts WHERE "taskId"=$1', [f.task.id])).rowCount, before.attempts.length + 1)
      assert.equal(handoffs.length, beforeHandoffs + 1)
      const admitted = await f.store.read(f.ownerId, f.task.id)
      const runHistory = (await pool.query('SELECT * FROM agent_runs WHERE "issueId"=$1 ORDER BY id', [f.issueId])).rows
      const eventHistory = (await pool.query('SELECT * FROM factory_events WHERE "taskId"=$1 ORDER BY "eventId"', [f.task.id])).rows
      assert.ok(eventHistory.length > beforeEvents)
      assert.equal(eventHistory.filter(event => event.request.kind === 'owner_check_start_recovery').length, 1)
      assert.deepEqual(runHistory.filter(run => previousRuns.some(previous => previous.id === run.id)), previousRuns,
        'a newly admitted retry preserves both the producer and failed check history')
      assert.deepEqual(await handleFactory(human, request), { status: 404, body: { error: 'factoryNotFound' } },
        'receipt replay after revocation cannot inherit the earlier admission')
      assert.deepEqual(await f.store.read(f.ownerId, f.task.id), admitted)
      assert.deepEqual((await pool.query('SELECT * FROM agent_runs WHERE "issueId"=$1 ORDER BY id', [f.issueId])).rows, runHistory)
      assert.deepEqual((await pool.query('SELECT * FROM factory_events WHERE "taskId"=$1 ORDER BY "eventId"', [f.task.id])).rows, eventHistory)
      assert.equal(handoffs.length, beforeHandoffs + 1)
      assert.deepEqual(decisionCounts(), beforeDecisions, 'neither an admitted retry nor a refused replay reselects the frozen model')
    } finally {
      await revocation
      revoker.release()
      await pool.query("UPDATE mikka_workspace_members SET status='active' WHERE \"workspaceId\"=$1 AND \"userId\"=$2", [f.workspaceId, f.ownerId])
    }
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
    const f = await fixture(false, false), beforeDecisions = decisionCounts()
    const chatBotId = await seedBot(pool, f.workspaceId, f.ownerId), issueId = await seedIssue(pool, f.ownerId, f.workspaceId), sourceEventId = randomUUID()
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
      assert.equal(method, 'allowance', 'the quota preflight cannot send inference or acquire a new binding')
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
      assert.deepEqual(await profiles.agentProfileDispatchAvailability(pool, f.scope, {
        profileId: 'default', location: 'cloud', cloudPurpose: 'desktop', asked: { harness: 'codex', model: model.codex },
      }, { deferStaleQuota: true }), { available: true, reason: 'quota_check_required' })
      assert.equal(quotaReads, 0, 'group intent never refreshes or admits a subscription')
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
    return factoryResourceWorkspace(pool)(f.ownerId, f.task.id, () =>
      claimCloudRun(pool, f.actor, f.runId, f.threadDevice, lease, f.subscriptionBindingId, beforeClaim, undefined, false))
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
  const planQuestionFixture = async () => {
    const [{ createFactoryQuestions }, { queueCloudQuestionContinuation }, { createFactoryClaim }, { factoryEventId }] = await Promise.all([
      import('./questions/store'), import('./questions/queue-continuation'), import('./claim'), import('./event-id'),
    ])
    const f = await fixture(true, false, false, undefined, true)
    assert.equal(f.task.stage, 'spec'); assert.equal(f.task.candidateId, null)
    // The fixture's named Codex Profile is explicitly picked; role discovery
    // and Decision transport are not part of an already admitted native resume.
    const selected = await profiles.resolveAgentProfileDispatch(pool, f.scope, {
      issueId: f.issueId, stage: 'spec', profileId: f.review!.id, location: 'cloud', cloudPurpose: 'desktop',
    })
    const target = selected.target
    if (target.kind !== 'cloud') assert.fail('the plan requires its recorded cloud Codex destination')
    assert.equal(target.harness, 'codex'); assert.equal(target.model, model.codex)
    const subscriptionBindingId = await bindAgentToConnection(pool, f.scope, f.agents.codex, 'codex', f.connections.codex, model.codex)
    const queued: string[] = [], preparations: { ownerId: string; runId: string; workspaceId: string }[] = []
    const dispatch = createFactoryDispatch(pool, f.store, async (tx, owner, input, bot, context) => {
      assert.equal(context.stage, 'spec'); assert.equal(context.sourceEventId, f.sourceEventId)
      if (context.questionOriginRunId) {
        const continued = await queueCloudQuestionContinuation(tx, owner, input, bot, context)
        assert.ok(continued, 'a plan answer must use the strict original-session queue')
        queued.push(continued.runId)
        return continued
      }
      return queueCloudRun(pool, f.actor, {
        botId: f.botId, issueId: f.issueId, agentId: f.agents.codex, deviceRepoId: f.repoId,
        title: 'Read-only plan before implementation', body: 'Inspect the repository, then submit a plan for human approval.',
        model: model.codex, subscriptionBindingId, agentProfile: selected.agentProfile, readOnly: true,
        modelDispatch: { mode: 'picked', location: 'cloud', entry: target.entry },
        idempotencyKey: `factory:${context.attemptId}`, sourceEventId: context.sourceEventId,
      }, tx)
    })
    const authorize = async (owner: string, issue: string, tx: import('pg').PoolClient) => (await tx.query('SELECT 1 FROM issues WHERE id=$1 AND "userId"=$2', [issue, owner])).rowCount === 1
    const questions = bindFactoryQuestionsWorkspace(pool, createFactoryQuestions(pool, authorize, f.store, dispatch, undefined, undefined, undefined, async (ownerId, scope) => {
      // Observe only the existing provider boundary. No VM or model is called.
      assert.equal(ownerId, f.ownerId); assert.equal(scope.workspaceId, f.workspaceId)
      preparations.push({ ownerId, ...scope })
    }), f.botId)
    const factoryClaim = createFactoryClaim(f.store, questions)
    let metadata: Record<string, unknown> = {}
    const claimRun = (runId: string) => {
      const lease = new Date(Date.now() + 30_000)
      return factoryResourceWorkspace(pool)(f.ownerId, f.task.id, () =>
        claimCloudRun(pool, f.actor, runId, f.deviceId, lease, subscriptionBindingId,
          async tx => { metadata = await factoryClaim(tx, f.ownerId, f.deviceId, runId, lease.toISOString()) }, undefined, false))
    }
    const first = await dispatch(f.ownerId, { binding: factoryBinding(f.task), agentId: f.agents.codex, deviceRepoId: f.repoId, profileId: f.review!.id })
    const sandboxId = `synthetic-plan-thread-${first.runId}`
    await pool.query(`UPDATE thread_machines SET state='running',"deviceId"=$2,"issueId"=$3,"repoId"=$4,"sandboxId"=$5,"snapshotId"='synthetic-codex' WHERE "runId"=$1`, [first.runId, f.deviceId, f.issueId, f.repoId, sandboxId])
    assert.equal((await claimRun(first.runId))?.ownerId, f.ownerId)
    const nativeSession = `synthetic-plan-native-${first.runId}`, questionId = randomUUID()
    await pool.query(`UPDATE agent_runs SET status='stopped',"stopReason"='blocked',"sessionId"=$2,"leaseExpiresAt"=NULL,"finishedAt"=now(),report=$3 WHERE id=$1`, [first.runId, nativeSession, JSON.stringify({
      summary: 'Synthetic read-only inspection blocker', question: { questionId, kind: 'external', question: 'Read-only repository inspection is unavailable.' },
    })])
    const origin = (await pool.query('SELECT * FROM agent_runs WHERE id=$1', [first.runId])).rows[0]
    assert.equal(origin.kind, 'plan'); assert.ok(origin.startedAt); assert.equal(origin.agentDefinition.readOnly, true)
    const question = await questions.record(f.ownerId, first.runId)
    const humanSessionId = randomUUID()
    await pool.query(`INSERT INTO "session" (id,"userId",token,"expiresAt","createdAt","updatedAt") VALUES ($1,$2,$3,now()+interval '1 hour',now(),now())`, [humanSessionId, f.ownerId, `fixture-${randomUUID()}`])
    const human = { source: 'human' as const, userId: f.ownerId, sessionId: humanSessionId }
    const answer = { reference: question.reference, answerId: randomUUID(), text: 'Use the restored read-only repository tools, then submit the plan for approval.' }
    const resumed = await questions.answer(human, answer)
    assert.equal((await questions.answer(human, answer)).continuationRunId, resumed.continuationRunId)
    assert.equal(queued.length, 1, 'answer replay never queues a second native continuation')
    const child = (await pool.query('SELECT * FROM agent_runs WHERE id=$1', [resumed.continuationRunId])).rows[0]
    assert.equal(child.kind, 'plan'); assert.equal(child.status, 'queued')
    assert.equal(child.startedAt, null); assert.equal(child.sessionId, null); assert.equal(child.leaseExpiresAt, null)
    assert.equal(child.agentDefinition.readOnly, true)
    assert.deepEqual(child.agentDefinition.agentProfile, origin.agentDefinition.agentProfile)
    assert.deepEqual(child.agentDefinition.subscription, origin.agentDefinition.subscription)
    assert.equal(child.questionContinuation.originSessionId, nativeSession)
    assert.equal(child.questionContinuation.requiredSandboxId, sandboxId)
    const receiptId = factoryEventId('question-resume', answer.answerId)
    const expireQuota = () => pool.query(`UPDATE byos_connections SET quota=jsonb_set(quota,'{observedAt}',$2::jsonb) WHERE id=$1`, [f.connections.codex, JSON.stringify(new Date(Date.now() - 61_000).toISOString())])
    const failBeforeClaim = async (runId = child.id) => {
      // The actual Profile refusal rolls back claim before this completion is
      // persisted: no startedAt, lease, SID, native binding or provider output.
      await pool.query(`UPDATE agent_runs SET status='failed',"stopReason"='blocked',error='Synthetic preclaim refusal',report=$2,"finishedAt"=now() WHERE id=$1`, [runId, JSON.stringify({ summary: 'Synthetic preclaim refusal', filesChanged: [], verify: { status: 'not_run' }, openQuestions: [], nextStep: null })])
      await questions.settle(f.ownerId, runId)
      const current = await questions.read(f.ownerId, questionId)
      assert.ok(current.recoverReference)
      return { requestId: randomUUID(), ...current.recoverReference }
    }
    const rows = async () => ({
      task: (await pool.query('SELECT * FROM factory_tasks WHERE id=$1', [f.task.id])).rows,
      attempts: (await pool.query('SELECT * FROM factory_attempts WHERE "taskId"=$1 ORDER BY position', [f.task.id])).rows,
      runs: (await pool.query('SELECT * FROM agent_runs WHERE "issueId"=$1 ORDER BY id', [f.issueId])).rows,
      questions: (await pool.query('SELECT * FROM factory_questions WHERE "taskId"=$1 ORDER BY id', [f.task.id])).rows,
      receipts: (await pool.query('SELECT * FROM factory_events WHERE "taskId"=$1 ORDER BY "eventId"', [f.task.id])).rows,
      machines: (await pool.query('SELECT * FROM thread_machines WHERE "issueId"=$1 ORDER BY "runId"', [f.issueId])).rows,
      messages: (await pool.query('SELECT m.* FROM run_messages m JOIN agent_runs r ON r.id=m."runId" WHERE r."issueId"=$1 ORDER BY m.id', [f.issueId])).rows,
      native: (await pool.query('SELECT n.* FROM byos_native_runs n JOIN agent_runs r ON r.id=n."runId" WHERE r."issueId"=$1 ORDER BY n."runId"', [f.issueId])).rows,
    })
    return { ...f, selected, subscriptionBindingId, first, origin, child, questions, human, answer, resumed, nativeSession, sandboxId,
      receiptId, queued, preparations, claimRun, claimMetadata: () => metadata, expireQuota, failBeforeClaim, rows }
  }
  await t.test('spec question claim keeps the frozen read-only Codex Profile after the quota observation becomes checking', async () => {
    const before = decisionCounts(), f = await planQuestionFixture(), beforeUsage = usageCalls.length
    const { questionExecutionContinuation, questionPlanContinuation } = await import('./questions/execution-continuation')
    await f.expireQuota()
    await assert.rejects(profiles.assertProfileSelection(pool, f.scope, f.selected.agentProfile!), { code: 'agentProfileModelUnavailable', detail: 'checking' }, 'a fresh selection still cannot use the stale observation')
    assert.equal(await questionExecutionContinuation(pool, f.resumed.task, f.resumed.task.attemptId), null, 'a plan receipt is not implementation evidence')
    assert.equal((await questionPlanContinuation(pool, f.resumed.task, f.resumed.task.attemptId))?.questionOriginRunId, f.first.runId)
    await assertRunProfileClaim(pool, f.child.id)
    assert.equal((await f.claimRun(f.child.id))?.ownerId, f.ownerId)
    const claimed = (await pool.query('SELECT * FROM agent_runs WHERE id=$1', [f.child.id])).rows[0]
    assert.equal(claimed.status, 'preparing'); assert.ok(claimed.startedAt)
    assert.deepEqual(claimed.agentDefinition, f.child.agentDefinition)
    assert.equal(f.claimMetadata().resumeSessionId, f.nativeSession)
    assert.equal(f.claimMetadata().continuesRunId, f.first.runId)
    assert.equal(f.claimMetadata().requireSessionResume, true); assert.equal(f.claimMetadata().preserveQuestionWorktree, true)
    assert.equal((await pool.query('SELECT "bindingId" FROM byos_native_runs WHERE "runId"=$1', [f.child.id])).rows[0].bindingId, f.subscriptionBindingId)
    assert.equal(usageCalls.length, beforeUsage, 'an existing native session is not a fresh quota/model selection')
    assert.deepEqual(decisionCounts(), before)
  })
  await t.test('spec question resume preserves its admitted role after a Profile edit while a fresh selection remains fenced', async () => {
    const f = await planQuestionFixture()
    await pool.query('UPDATE factory_agent_profiles SET version=version+1 WHERE id=$1', [f.review!.id])
    await assert.rejects(profiles.assertProfileSelection(pool, f.scope, f.selected.agentProfile!), { code: 'agentProfileVersionConflict' })
    assert.equal((await f.claimRun(f.child.id))?.ownerId, f.ownerId)
    assert.deepEqual((await pool.query('SELECT "agentDefinition" FROM agent_runs WHERE id=$1', [f.child.id])).rows[0].agentDefinition, f.child.agentDefinition)
  })
  await t.test('spec question claim rejects missing receipts, stale epochs, changed targets and revoked subscriptions without consuming the run', async t => {
    const f = await planQuestionFixture()
    await f.expireQuota()
    // A different real origin in the same tenant gets past the database's
    // lineage boundary, so this still exercises the exact question receipt.
    const differentOrigin = randomUUID()
    await pool.query(`INSERT INTO agent_runs (id,"userId","issueId","agentId","deviceId","botId","workspaceId",status,"finishedAt")
      SELECT $1,"userId","issueId","agentId","deviceId","botId","workspaceId",'succeeded',now() FROM agent_runs WHERE id=$2`,
      [differentOrigin, f.first.runId])
    const receipt = (await pool.query('SELECT request,result FROM factory_events WHERE "taskId"=$1 AND "eventId"=$2', [f.task.id, f.receiptId])).rows[0]
    const attempt = (await pool.query('SELECT output FROM factory_attempts WHERE id=$1', [f.resumed.task.attemptId])).rows[0]
    const change = (sql: string, values: unknown[], undo: string, previous: unknown[]) => async () => {
      await pool.query(sql, values)
      return async () => { await pool.query(undo, previous) }
    }
    const faults: [string, () => Promise<() => Promise<void>>][] = [
      ['missing host receipt', change('DELETE FROM factory_events WHERE "taskId"=$1 AND "eventId"=$2', [f.task.id, f.receiptId], 'INSERT INTO factory_events ("taskId","eventId",request,result) VALUES ($1,$2,$3,$4)', [f.task.id, f.receiptId, JSON.stringify(receipt.request), JSON.stringify(receipt.result)])],
      ['receipt owner mismatch', change('UPDATE factory_events SET result=$3 WHERE "taskId"=$1 AND "eventId"=$2', [f.task.id, f.receiptId, JSON.stringify({ ...receipt.result, task: { ...receipt.result.task, userId: 'foreign-owner' } })], 'UPDATE factory_events SET result=$3 WHERE "taskId"=$1 AND "eventId"=$2', [f.task.id, f.receiptId, JSON.stringify(receipt.result)])],
      ['stale request epoch', change('UPDATE factory_attempts SET output=$2 WHERE id=$1', [f.resumed.task.attemptId, JSON.stringify({ ...attempt.output, requestEpoch: randomUUID() })], 'UPDATE factory_attempts SET output=$2 WHERE id=$1', [f.resumed.task.attemptId, JSON.stringify(attempt.output)])],
      ['different question origin', change('UPDATE agent_runs SET "questionContinuation"=$2 WHERE id=$1', [f.child.id, JSON.stringify({ ...f.child.questionContinuation, originRunId: differentOrigin })], 'UPDATE agent_runs SET "questionContinuation"=$2 WHERE id=$1', [f.child.id, JSON.stringify(f.child.questionContinuation)])],
      ['writable plan', change('UPDATE agent_runs SET "agentDefinition"=$2 WHERE id=$1', [f.child.id, JSON.stringify({ ...f.child.agentDefinition, readOnly: false })], 'UPDATE agent_runs SET "agentDefinition"=$2 WHERE id=$1', [f.child.id, JSON.stringify(f.child.agentDefinition)])],
      ['different model', change('UPDATE agent_runs SET "agentDefinition"=$2 WHERE id=$1', [f.child.id, JSON.stringify({ ...f.child.agentDefinition, model: 'changed-model' })], 'UPDATE agent_runs SET "agentDefinition"=$2 WHERE id=$1', [f.child.id, JSON.stringify(f.child.agentDefinition)])],
      ['different Profile snapshot', change('UPDATE agent_runs SET "agentDefinition"=$2 WHERE id=$1', [f.child.id, JSON.stringify({ ...f.child.agentDefinition, agentProfile: { ...f.child.agentDefinition.agentProfile, digest: 'changed-role' } })], 'UPDATE agent_runs SET "agentDefinition"=$2 WHERE id=$1', [f.child.id, JSON.stringify(f.child.agentDefinition)])],
      ['paused subscription', change('UPDATE byos_connections SET paused=true WHERE id=$1', [f.connections.codex], 'UPDATE byos_connections SET paused=false WHERE id=$1', [f.connections.codex])],
      ['disconnected subscription', change("UPDATE byos_connections SET state='disconnected' WHERE id=$1", [f.connections.codex], "UPDATE byos_connections SET state='connected' WHERE id=$1", [f.connections.codex])],
      ['revoked connection epoch', change('UPDATE byos_connections SET epoch=epoch+1 WHERE id=$1', [f.connections.codex], 'UPDATE byos_connections SET epoch=epoch-1 WHERE id=$1', [f.connections.codex])],
    ]
    for (const [name, mutate] of faults) await t.test(name, async () => {
      const restore = await mutate(), before = await f.rows()
      try {
        try { assert.equal(await f.claimRun(f.child.id), null) }
        catch (error) { assert.ok(error && typeof error === 'object' && 'code' in error && ['agentProfileUnavailable', 'factoryQuestionContinuationUnavailable'].includes(String(error.code)), `unexpected rejection for ${name}`) }
        assert.deepEqual(await f.rows(), before, 'denied claim cannot consume a receipt, advance the task or allocate a native binding')
      } finally { await restore() }
    })
    assert.equal((await f.claimRun(f.child.id))?.ownerId, f.ownerId, 'restoring the actual authorization makes this same queued run claimable')
  })
  await t.test('spec question recovery resumes the original SID after an unclaimed failed child and never duplicates the answer or recovery', async () => {
    const before = decisionCounts(), f = await planQuestionFixture(), beforeUsage = usageCalls.length
    await f.expireQuota()
    const request = await f.failBeforeClaim(), beforeRecovery = await f.rows()
    const failed = beforeRecovery.runs.find(run => run.id === f.child.id)
    assert.ok(failed); assert.equal(failed.status, 'failed'); assert.equal(failed.startedAt, null); assert.equal(failed.sessionId, null)
    assert.equal(beforeRecovery.native.some(run => run.runId === failed.id), false)
    const recovered = await f.questions.recover(f.human, request)
    assert.notEqual(recovered.continuationRunId, failed.id)
    assert.equal(recovered.task.stage, 'spec'); assert.equal(recovered.task.sourceEventId, f.sourceEventId)
    assert.equal(recovered.task.candidateId, null)
    const replay = await f.questions.recover(f.human, request)
    assert.equal(replay.replayed, true); assert.equal(replay.continuationRunId, recovered.continuationRunId)
    assert.deepEqual(f.queued, [f.child.id, recovered.continuationRunId])
    assert.deepEqual(f.preparations, [{ ownerId: f.ownerId, runId: failed.id, workspaceId: f.workspaceId }])
    const next = (await pool.query('SELECT * FROM agent_runs WHERE id=$1', [recovered.continuationRunId])).rows[0]
    assert.equal(next.continuesRunId, failed.id, 'the immutable failed-child audit edge is retained')
    assert.equal(next.status, 'queued'); assert.equal(next.startedAt, null); assert.equal(next.sessionId, null)
    assert.deepEqual(next.agentDefinition.agentProfile, f.origin.agentDefinition.agentProfile)
    assert.deepEqual(next.agentDefinition.subscription, f.origin.agentDefinition.subscription)
    assert.equal(next.agentDefinition.readOnly, true); assert.equal(next.agentDefinition.model, model.codex)
    assert.equal((await f.claimRun(next.id))?.ownerId, f.ownerId)
    assert.equal(f.claimMetadata().continuesRunId, f.first.runId, 'resume native history from the original run, not the child that never started')
    assert.equal(f.claimMetadata().resumeSessionId, f.nativeSession)
    assert.equal(f.claimMetadata().requireSessionResume, true); assert.equal(f.claimMetadata().preserveQuestionWorktree, true)
    assert.ok(String(f.claimMetadata().followUp).includes(f.answer.text), 'the never-delivered answer still reaches its original native session')
    assert.ok(String(f.claimMetadata().followUp).includes(f.answer.answerId), 'the existing authenticated answer source is preserved')
    const after = await f.rows()
    assert.deepEqual(after.runs.find(run => run.id === failed.id), failed, 'recovery never rewrites the original failure as a success')
    assert.deepEqual(after.messages, beforeRecovery.messages); assert.equal(after.messages.filter(message => message.id === f.answer.answerId).length, 1)
    assert.equal(after.runs.length, 3); assert.deepEqual(after.attempts.map(attempt => attempt.stage), ['spec', 'spec', 'spec'])
    assert.equal(after.native.filter(run => run.runId === next.id && run.bindingId === f.subscriptionBindingId).length, 1)
    assert.equal(after.native.some(run => run.runId === failed.id), false)
    assert.equal(usageCalls.length, beforeUsage); assert.deepEqual(decisionCounts(), before)
    const secondReplay = await f.questions.recover(f.human, request)
    assert.equal(secondReplay.continuationRunId, next.id); assert.equal(secondReplay.replayed, true)
    assert.deepEqual(await f.rows(), after, 'replaying recovery after claim also leaves all durable state untouched')
  })
  await t.test('spec question recovery skips unclaimed gaps but keeps the latest claimed history without redelivering an answered message', async () => {
    const f = await planQuestionFixture()
    assert.equal((await f.claimRun(f.child.id))?.ownerId, f.ownerId)
    const beforeUsage = usageCalls.length
    await f.expireQuota()
    // B really crossed the SQL claim boundary and obtained its native binding;
    // the following same-SID failure is synthetic provider completion data.
    await pool.query(`UPDATE agent_runs SET status='failed',"stopReason"='error',"sessionId"=$2,"leaseExpiresAt"=NULL,error='Synthetic claimed continuation failure',"finishedAt"=now() WHERE id=$1`, [f.child.id, f.nativeSession])
    await f.questions.settle(f.ownerId, f.child.id)
    const view = await f.questions.read(f.ownerId, f.answer.reference.questionId)
    assert.ok(view.recoverReference)
    const firstRecovery = await f.questions.recover(f.human, { requestId: randomUUID(), ...view.recoverReference })
    const gap = (await pool.query('SELECT * FROM agent_runs WHERE id=$1', [firstRecovery.continuationRunId])).rows[0]
    assert.equal(gap.startedAt, null); assert.equal(gap.sessionId, null); assert.equal(gap.continuesRunId, f.child.id)
    const secondRequest = await f.failBeforeClaim(gap.id), before = await f.rows()
    const secondRecovery = await f.questions.recover(f.human, secondRequest)
    const next = (await pool.query('SELECT * FROM agent_runs WHERE id=$1', [secondRecovery.continuationRunId])).rows[0]
    assert.equal(next.continuesRunId, gap.id, 'the database retains the immediate failed-child audit edge')
    assert.equal((await f.claimRun(next.id))?.ownerId, f.ownerId)
    assert.equal(f.claimMetadata().continuesRunId, f.child.id, 'the native history is B, beyond the unclaimed C gap, rather than the original A')
    assert.equal(f.claimMetadata().resumeSessionId, f.nativeSession)
    assert.equal(f.claimMetadata().requireSessionResume, true)
    assert.equal(String(f.claimMetadata().followUp).includes(f.answer.text), false, 'B already received the accepted answer; D must not deliver it again')
    const after = await f.rows()
    for (const id of [f.child.id, gap.id]) assert.deepEqual(after.runs.find(run => run.id === id), before.runs.find(run => run.id === id), 'both failures stay unchanged')
    assert.deepEqual(after.messages, before.messages); assert.equal(after.messages.filter(message => message.id === f.answer.answerId).length, 1)
    assert.equal(after.runs.length, 4); assert.deepEqual(after.attempts.map(attempt => attempt.stage), ['spec', 'spec', 'spec', 'spec'])
    assert.equal(after.native.some(run => run.runId === gap.id), false)
    assert.equal(after.native.filter(run => run.runId === next.id && run.bindingId === f.subscriptionBindingId).length, 1)
    assert.deepEqual(f.queued, [f.child.id, gap.id, next.id]); assert.equal(f.preparations.length, 2)
    assert.equal(usageCalls.length, beforeUsage)
  })
  await t.test('spec question unclaimed recovery refuses execution evidence, stale receipts and lost custody before provider preparation', async t => {
    const f = await planQuestionFixture(), request = await f.failBeforeClaim()
    const receipt = (await pool.query('SELECT request,result FROM factory_events WHERE "taskId"=$1 AND "eventId"=$2', [f.task.id, f.receiptId])).rows[0]
    const attempt = (await pool.query('SELECT output FROM factory_attempts WHERE id=$1', [f.resumed.task.attemptId])).rows[0]
    const change = (sql: string, values: unknown[], undo: string, previous: unknown[]) => async () => {
      await pool.query(sql, values)
      return async () => { await pool.query(undo, previous) }
    }
    const chunkId = randomUUID()
    const faults: [string, () => Promise<() => Promise<void>>][] = [
      ['already started child', change('UPDATE agent_runs SET "startedAt"=now() WHERE id=$1', [f.child.id], 'UPDATE agent_runs SET "startedAt"=NULL WHERE id=$1', [f.child.id])],
      ['wrong native SID', change("UPDATE agent_runs SET \"sessionId\"='different-session' WHERE id=$1", [f.child.id], 'UPDATE agent_runs SET "sessionId"=NULL WHERE id=$1', [f.child.id])],
      ['existing native binding', change('INSERT INTO byos_native_runs ("runId","bindingId") VALUES ($1,$2)', [f.child.id, f.subscriptionBindingId], 'DELETE FROM byos_native_runs WHERE "runId"=$1', [f.child.id])],
      ['existing native output', change('INSERT INTO run_chunks (id,"runId",seq,chunk) VALUES ($1,$2,1,$3)', [chunkId, f.child.id, JSON.stringify({ type: 'text', text: 'Synthetic execution observation' })], 'DELETE FROM run_chunks WHERE id=$1', [chunkId])],
      ['missing answer receipt', change('DELETE FROM factory_events WHERE "taskId"=$1 AND "eventId"=$2', [f.task.id, f.receiptId], 'INSERT INTO factory_events ("taskId","eventId",request,result) VALUES ($1,$2,$3,$4)', [f.task.id, f.receiptId, JSON.stringify(receipt.request), JSON.stringify(receipt.result)])],
      ['stale attempt epoch', change('UPDATE factory_attempts SET output=$2 WHERE id=$1', [f.resumed.task.attemptId, JSON.stringify({ ...attempt.output, requestEpoch: randomUUID() })], 'UPDATE factory_attempts SET output=$2 WHERE id=$1', [f.resumed.task.attemptId, JSON.stringify(attempt.output)])],
      ['changed original SID', change("UPDATE agent_runs SET \"sessionId\"='different-origin' WHERE id=$1", [f.first.runId], 'UPDATE agent_runs SET "sessionId"=$2 WHERE id=$1', [f.first.runId, f.nativeSession])],
      ['lost sandbox custody', change("UPDATE thread_machines SET \"sandboxId\"='different-sandbox' WHERE \"runId\"=$1", [f.child.id], 'UPDATE thread_machines SET "sandboxId"=$2 WHERE "runId"=$1', [f.child.id, f.sandboxId])],
      ['active worker lease', change('UPDATE thread_machines SET "workerLeaseUntil"=now()+interval \'1 hour\' WHERE "runId"=$1', [f.child.id], 'UPDATE thread_machines SET "workerLeaseUntil"=NULL WHERE "runId"=$1', [f.child.id])],
      ['paused subscription', change('UPDATE byos_connections SET paused=true WHERE id=$1', [f.connections.codex], 'UPDATE byos_connections SET paused=false WHERE id=$1', [f.connections.codex])],
      ['revoked connection epoch', change('UPDATE byos_connections SET epoch=epoch+1 WHERE id=$1', [f.connections.codex], 'UPDATE byos_connections SET epoch=epoch-1 WHERE id=$1', [f.connections.codex])],
    ]
    for (const [name, mutate] of faults) await t.test(name, async () => {
      const restore = await mutate(), before = await f.rows()
      try {
        await assert.rejects(f.questions.recover(f.human, request), { code: 'factoryQuestionContinuationUnavailable' }, name)
        assert.equal(f.preparations.length, 0, 'invalid custody or execution history is refused before provider preparation')
        assert.deepEqual(await f.rows(), before, 'refused recovery does not consume the answer or create another run')
      } finally { await restore() }
    })
    assert.equal(f.queued.length, 1)
  })
  await t.test('task-form Default reaches real queue and claim, then the owner answer resumes the same frozen native Profile', async () => {
    const [{ requestedAgentProfile }, { createFactoryQuestions }, { queueCloudQuestionContinuation }, { createFactoryClaim }, { factoryEventId }] = await Promise.all([
      import('./profile-request'), import('./questions/store'), import('./questions/queue-continuation'), import('./claim'), import('./event-id'),
    ])
    const f = await fixture(true, false, false, 'default'), beforeDecisions = decisionCounts()
    const producerContract = 'Produce the requested artifact, ask the Owner once, and submit it. Do not self-review: the host arranges a separate independent Review after submission.'
    const contractDocument = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: producerContract }] }] }
    await pool.query('UPDATE issues SET content=$2 WHERE id=$1', [f.issueId, JSON.stringify(contractDocument)])
    const originalEvent = (await pool.query('SELECT * FROM coordinator_events WHERE id=$1', [f.sourceEventId])).rows[0]
    assert.equal(originalEvent.kind, 'user_message'); assert.equal(originalEvent.payload.profileId, 'default')
    const profileId = await requestedAgentProfile(pool, f.scope, f.sourceEventId, f.review!.id)
    assert.equal(profileId, 'default', 'the model cannot replace the actual task-form choice with the eligible review role')
    const selected = await profiles.resolveAgentProfileDispatch(pool, f.scope, {
      issueId: f.issueId, stage: 'execute', profileId, location: 'cloud', cloudPurpose: 'desktop',
      asked: { harness: 'codex', model: model.codex },
    })
    const target = selected.target
    if (target.kind !== 'cloud') assert.fail('the selected Default must use the prepared cloud destination')
    assert.equal(target.harness, 'codex'); assert.equal(target.model, model.codex)
    assert.equal(selected.selectionMode, 'picked')
    assert.equal(selected.agentProfile?.profileId, 'default'); assert.equal(selected.agentProfile?.version, 1)
    assert.equal(selected.agentProfile?.source, 'default'); assert.equal(selected.agentProfile?.reason, 'default')
    assert.equal(selected.agentProfile?.decision, undefined); assert.equal(selected.agentProfile?.instructions, '')
    assert.deepEqual(selected.agentProfile?.targetEntry.source, { kind: 'subscription', connectionId: f.connections.codex })
    const subscriptionBindingId = await bindAgentToConnection(pool, f.scope, f.agents.codex, 'codex', f.connections.codex, model.codex)
    let firstQueues = 0, nativeQueues = 0
    const dispatch = createFactoryDispatch(pool, f.store, async (tx, owner, input, bot, context) => {
      assert.equal(context.sourceEventId, f.sourceEventId)
      assert.equal(await requestedAgentProfile(tx, f.scope, context.sourceEventId, input.profileId), 'default')
      if (context.questionOriginRunId) {
        const continued = await queueCloudQuestionContinuation(tx, owner, input, bot, context)
        assert.ok(continued, 'the answer must use the original native session adapter')
        nativeQueues++
        return continued
      }
      firstQueues++
      return queueCloudRun(pool, f.actor, {
        botId: f.botId, issueId: f.issueId, agentId: f.agents.codex, deviceRepoId: f.repoId,
        title: 'Owner-selected Default', body: producerContract,
        model: model.codex, subscriptionBindingId, agentProfile: selected.agentProfile,
        modelDispatch: { mode: 'picked', location: 'cloud', entry: target.entry },
        idempotencyKey: `factory:${context.attemptId}`, sourceEventId: context.sourceEventId,
      }, tx)
    })
    const authorize = async (owner: string, issue: string, tx: import('pg').PoolClient) => (await tx.query('SELECT 1 FROM issues WHERE id=$1 AND "userId"=$2', [issue, owner])).rowCount === 1
    const questions = bindFactoryQuestionsWorkspace(pool, createFactoryQuestions(pool, authorize, f.store, dispatch), f.botId)
    const factoryClaim = createFactoryClaim(f.store, questions)
    const first = await dispatch(f.ownerId, { binding: factoryBinding(f.task), agentId: f.agents.codex, deviceRepoId: f.repoId, profileId })
    const sandboxId = `synthetic-default-thread-${first.runId}`
    // Provider preparation and completion are synthetic. The production queue,
    // Factory claim, question store and native continuation all use real SQL.
    await pool.query(`UPDATE thread_machines SET state='running',"deviceId"=$2,"issueId"=$3,"repoId"=$4,"sandboxId"=$5,"snapshotId"='synthetic-codex' WHERE "runId"=$1`, [first.runId, f.deviceId, f.issueId, f.repoId, sandboxId])
    const lease = new Date(Date.now() + 30_000)
    let claimMetadata: Record<string, unknown> = {}
    const claimRun = (runId: string) => factoryResourceWorkspace(pool)(f.ownerId, f.task.id, () =>
      claimCloudRun(pool, f.actor, runId, f.deviceId, lease, subscriptionBindingId,
        async tx => { claimMetadata = await factoryClaim(tx, f.ownerId, f.deviceId, runId, lease.toISOString()) }, undefined, false))
    assert.equal((await claimRun(first.runId))?.ownerId, f.ownerId)
    const origin = (await pool.query('SELECT * FROM agent_runs WHERE id=$1', [first.runId])).rows[0]
    assert.equal(origin.status, 'preparing'); assert.ok(origin.startedAt)
    assert.deepEqual(origin.agentDefinition.agentProfile, selected.agentProfile)
    assert.equal(origin.agentDefinition.definitionDigest, workerDefinitionDigest(origin.agentDefinition))
    const nativeSession = `synthetic-codex-native-${first.runId}`, questionId = randomUUID()
    await pool.query(`UPDATE agent_runs SET status='stopped',"stopReason"='asked_human',"sessionId"=$2,"finishedAt"=now(),report=$3 WHERE id=$1`, [first.runId, nativeSession, JSON.stringify({
      summary: 'Synthetic native question hand-in', question: { questionId, kind: 'decision', question: 'Continue this same task?', options: ['Continue'] },
    })])
    const question = await questions.record(f.ownerId, first.runId)
    const humanSessionId = randomUUID()
    await pool.query(`INSERT INTO "session" (id,"userId",token,"expiresAt","createdAt","updatedAt") VALUES ($1,$2,$3,now()+interval '1 hour',now(),now())`, [humanSessionId, f.ownerId, `fixture-${randomUUID()}`])
    const actor = { source: 'human' as const, userId: f.ownerId, sessionId: humanSessionId }
    const answer = { reference: question.reference, answerId: randomUUID(), text: 'Continue the same task in the original session.' }
    const resumed = await questions.answer(actor, answer)
    assert.equal((await questions.answer(actor, answer)).continuationRunId, resumed.continuationRunId)
    assert.equal(resumed.task.sourceEventId, f.sourceEventId)
    assert.equal(firstQueues, 1); assert.equal(nativeQueues, 1)
    const child = (await pool.query('SELECT * FROM agent_runs WHERE id=$1', [resumed.continuationRunId])).rows[0]
    assert.equal(child.status, 'queued'); assert.equal(child.sessionId, null)
    assert.deepEqual(child.agentDefinition.agentProfile, origin.agentDefinition.agentProfile)
    assert.equal(child.agentDefinition.definitionDigest, origin.agentDefinition.definitionDigest)
    assert.equal(child.agentDefinition.subscription.bindingId, subscriptionBindingId)
    assert.equal(child.questionContinuation.originRunId, first.runId)
    assert.equal(child.questionContinuation.originSessionId, nativeSession)
    assert.equal(child.questionContinuation.requiredSandboxId, sandboxId)
    const receiptId = factoryEventId('question-resume', answer.answerId)
    const receipt = (await pool.query('SELECT request,result FROM factory_events WHERE "taskId"=$1 AND "eventId"=$2', [f.task.id, receiptId])).rows[0]
    await pool.query('DELETE FROM factory_events WHERE "taskId"=$1 AND "eventId"=$2', [f.task.id, receiptId])
    try { await assert.rejects(claimRun(child.id), AgentProfileAdmissionError, 'the Default pin cannot replace the native continuation receipt') }
    finally { await pool.query('INSERT INTO factory_events ("taskId","eventId",request,result) VALUES ($1,$2,$3,$4)', [f.task.id, receiptId, JSON.stringify(receipt.request), JSON.stringify(receipt.result)]) }
    await pool.query('UPDATE byos_connections SET paused=true WHERE id=$1', [f.connections.codex])
    try { assert.equal(await claimRun(child.id), null, 'the frozen Default role cannot bypass current subscription authorization') }
    finally { await pool.query('UPDATE byos_connections SET paused=false WHERE id=$1', [f.connections.codex]) }
    assert.equal((await claimRun(child.id))?.ownerId, f.ownerId)
    assert.equal(claimMetadata.resumeSessionId, nativeSession); assert.equal(claimMetadata.continuesRunId, first.runId)
    assert.equal(claimMetadata.requireSessionResume, true); assert.equal(claimMetadata.preserveQuestionWorktree, true)
    const claimed = (await pool.query('SELECT * FROM agent_runs WHERE id=$1', [child.id])).rows[0]
    assert.equal(claimed.status, 'preparing')
    assert.deepEqual(claimed.agentDefinition, child.agentDefinition)
    assert.equal((await pool.query('SELECT "bindingId" FROM byos_native_runs WHERE "runId"=$1', [child.id])).rows[0].bindingId, subscriptionBindingId)
    assert.equal((await pool.query('SELECT 1 FROM agent_runs WHERE "issueId"=$1', [f.issueId])).rowCount, 2)
    assert.deepEqual((await pool.query('SELECT * FROM coordinator_events WHERE id=$1', [f.sourceEventId])).rows[0], originalEvent)
    assert.deepEqual(decisionCounts(), beforeDecisions, 'a named model on Default does not invoke either Decision during first dispatch or same-session answer')

    // #1225 production reached a valid native submission, then a Profile/reason
    // protocol rejection. This is one representative invalid_reason response;
    // it does not claim which private answer the live Decision returned.
    const deliverySha = 'b'.repeat(40)
    await pool.query(`UPDATE agent_runs SET status='succeeded',"stopReason"='submitted',"sessionId"=$2,"finishedAt"=now(),report=$3 WHERE id=$1`, [child.id, nativeSession, JSON.stringify({
      sourceCommit: 'a'.repeat(40), deliverableCommit: deliverySha, summary: 'Synthetic completed native deliverable', runtime: { observedModel: model.codex },
    })])
    const producerRows = (await pool.query('SELECT * FROM agent_runs WHERE "issueId"=$1 ORDER BY id', [f.issueId])).rows
    const beforeHandoffs = handoffs.length, completion = createFactoryReconciler(pool, f.store, questions, {}, f.botId, automaticFactoryDispatch(pool))
    const warnings: string[] = [], warning = t.mock.method(console, 'warn', (line: unknown) => { warnings.push(String(line)) })
    decisionProfile = f.review!.id
    try {
      decisionFailure = 'missing-pair-reason'
      await completion.run(f.ownerId, child.id)
      let blocked = await f.store.read(f.ownerId, f.task.id)
      assert.equal(blocked.task.stage, 'review'); assert.equal(blocked.task.status, 'blocked')
      assert.ok(blocked.task.candidateId)
      const candidateId = blocked.task.candidateId
      const candidate = (await pool.query('SELECT * FROM factory_candidates WHERE id=$1', [candidateId])).rows[0]
      assert.equal(candidate.runId, child.id)
      assert.deepEqual(blocked.checkDispatchRecovery, { binding: { taskId: f.task.id, revision: blocked.task.revision } })
      assert.equal(JSON.parse(warnings.at(-1)!).detail, 'invalid_reason')
      assert.equal(handoffs.length, beforeHandoffs)
      const human = humanStore(), { handleFactory } = await import('./http')
      const request = (revision: number) => ({ userId: f.ownerId, method: 'POST', taskId: f.task.id, origin: 'https://app.example',
        url: `https://app.example/api/factory/tasks/${f.task.id}`, body: { binding: { taskId: f.task.id, revision }, eventId: randomUUID(), action: 'retry', reason: 'Retry the independent review of the retained candidate.' } })
      const { sweepFactoryWatchdog } = await import('./watchdog')
      // Owner retry records a pending attempt. The existing recovery cron then
      // dispatches it after one minute; the HTTP handler does not dispatch it.
      // Age only this synthetic task relative to the oldest task in this test
      // database, so no other fixture enters the real bounded cron query.
      const sweepAt = new Date((await pool.query('SELECT min("updatedAt") AS value FROM factory_tasks')).rows[0].value)
      const sweepReview = async () => {
        const pending = await f.store.read(f.ownerId, f.task.id)
        assert.equal(pending.task.status, 'pending'); assert.equal(pending.task.stage, 'review')
        assert.equal(pending.task.candidateId, candidateId)
        await pool.query('UPDATE factory_tasks SET "updatedAt"=$2 WHERE id=$1', [f.task.id, new Date(sweepAt.getTime() - 60_001)])
        const observed = await sweepFactoryWatchdog(pool, {
          runtime: botId => { assert.equal(botId, f.botId); return { store: f.store, reconcile: completion } },
          dispatch: automaticFactoryDispatch(pool),
          wake: async () => { assert.fail('a retained candidate retry must use the normal check dispatcher') },
        }, sweepAt)
        assert.deepEqual(observed, { scanned: 1, recovered: 1, blocked: 0, deferred: 0, failed: 0 })
        return f.store.read(f.ownerId, f.task.id)
      }
      for (const failure of ['none', 'refusal'] as const) {
        decisionFailure = failure
        const retry = request(blocked.task.revision)
        const response = await handleFactory(human, retry)
        assert.equal(response.status, 200)
        const calls = decisionCounts()
        assert.deepEqual(await handleFactory(human, retry), response, 'the same Owner retry does not repeat a refused Decision')
        assert.deepEqual(decisionCounts(), calls)
        blocked = await sweepReview()
        assert.equal(blocked.task.status, 'blocked'); assert.equal(blocked.task.stage, 'review')
        assert.equal(blocked.task.candidateId, candidateId)
        assert.equal((await pool.query('SELECT 1 FROM factory_candidates WHERE "taskId"=$1', [f.task.id])).rowCount, 1)
        assert.deepEqual((await pool.query('SELECT * FROM agent_runs WHERE "issueId"=$1 ORDER BY id', [f.issueId])).rows, producerRows)
        assert.equal(handoffs.length, beforeHandoffs, 'none/refusal never becomes Default or starts another producer')
        const afterSweep = decisionCounts()
        assert.deepEqual(await handleFactory(human, retry), response, 'the accepted retry receipt stays idempotent after cron observes the refusal')
        assert.deepEqual(decisionCounts(), afterSweep)
      }
      decisionFailure = null
      const retry = request(blocked.task.revision)
      const [response, duplicate] = await Promise.all([handleFactory(human, retry), handleFactory(human, retry)])
      assert.equal(response.status, 200); assert.deepEqual(duplicate, response)
      const result = await sweepReview()
      assert.equal(result.task.status, 'running'); assert.equal(result.task.stage, 'review')
      assert.equal(result.task.candidateId, candidateId); assert.equal(result.task.sourceEventId, f.sourceEventId)
      const reviewAttempt = result.attempts.find(attempt => attempt.id === result.task.attemptId)!
      assert.ok(reviewAttempt.runId)
      const review = (await pool.query('SELECT * FROM agent_runs WHERE id=$1', [reviewAttempt.runId])).rows[0]
      assert.equal(review.baseBranch, deliverySha); assert.equal(review.agentDefinition.readOnly, true)
      assert.equal(review.agentDefinition.agentProfile.profileId, f.review!.id)
      assert.equal(review.agentDefinition.agentProfile.reason, 'stage_fit', 'the host stores the reason selected in the same constrained pair')
      assert.equal(review.agentDefinition.agentProfile.source, 'decision')
      assert.equal(review.agentDefinition.agentProfile.version, f.review!.version); assert.equal(review.agentDefinition.agentProfile.digest, f.review!.digest)
      assert.equal(review.agentDefinition.model, model.codex); assert.equal(review.agentDefinition.harness, 'codex')
      for (const key of ['sessionId', 'continuesRunId', 'retryOf', 'questionContinuation']) assert.equal(review[key], null, key)
      assert.equal(review.agentDefinition.profileOriginRunId, undefined)
      assert.equal(review.agentDefinition.definitionDigest, workerDefinitionDigest(review.agentDefinition))
      // The transport returns the same fixed pair regardless of these fields.
      // Inspect the real request outside it: this proves the host supplied its
      // actual stage/target, not that a live model must choose this Profile.
      const expectedOwnerRequest = await (await import('./checks')).currentFactoryRequest(pool, result.task)
      assert.ok(expectedOwnerRequest.includes(answer.text))
      const checkCalls = decisionInputs.filter(call => call.purpose === 'factory-agent-profile').slice(beforeDecisions.profile)
      assert.equal(checkCalls.length, 4)
      for (const call of checkCalls) {
        const input = JSON.parse(call.input as string)
        assert.equal(input.task.kind, 'independent_check')
        assert.equal(input.task.stage, 'review'); assert.equal(input.task.readOnly, true)
        assert.equal(input.task.taskId, f.task.id); assert.equal(input.task.requestEpoch, f.sourceEventId)
        assert.equal(input.task.candidateId, reviewAttempt.candidateId)
        // The database adds the task's number to its document; the contract text is unchanged.
        assert.deepEqual(JSON.parse(input.acceptanceReference.originalTask.content).content, contractDocument.content)
        assert.equal(input.acceptanceReference.currentOwnerRequest, expectedOwnerRequest, 'reuse the receipt-bound Owner answer already used by this candidate')
        assert.equal(JSON.stringify(input.task).includes(producerContract), false)
        assert.equal(JSON.stringify(input.task).includes(answer.text), false)
      }
      const afterDecisions = decisionCounts()
      await completion.run(f.ownerId, child.id)
      assert.deepEqual(await handleFactory(human, retry), response)
      assert.deepEqual(decisionCounts(), afterDecisions)
      assert.deepEqual(afterDecisions, { profile: beforeDecisions.profile + 4, model: beforeDecisions.model })
      assert.equal((await pool.query('SELECT 1 FROM factory_candidates WHERE "taskId"=$1', [f.task.id])).rowCount, 1)
      assert.equal((await pool.query('SELECT 1 FROM factory_attempts WHERE "taskId"=$1 AND stage=\'review\' AND "runId" IS NOT NULL', [f.task.id])).rowCount, 1)
      assert.equal((await pool.query('SELECT 1 FROM agent_runs WHERE "issueId"=$1', [f.issueId])).rowCount, 3)
      assert.equal(handoffs.length, beforeHandoffs + 1)
      assert.deepEqual((await pool.query('SELECT * FROM agent_runs WHERE id=ANY($1::uuid[]) ORDER BY id', [[first.runId, child.id]])).rows, producerRows)
      assert.deepEqual((await pool.query('SELECT * FROM coordinator_events WHERE id=$1', [f.sourceEventId])).rows[0], originalEvent)
    } finally { decisionFailure = null; warning.mock.restore() }
  })
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
  // Recheck fixtures independently assert their initial role selection and
  // the absence of any new Decision during the frozen review/verify round.
  assert.deepEqual([...decisionInputs.slice(0, recheckCallsStart), ...decisionInputs.slice(recheckCallsEnd)].map(call => call.purpose), ['factory-agent-profile', 'factory-agent-profile', 'factory-agent-profile', 'task-model-routing', 'factory-agent-profile', 'task-model-routing',
    'factory-agent-profile', 'factory-agent-profile', 'factory-agent-profile', 'factory-agent-profile'])
  // Validate captured inputs outside the transport: model routing intentionally
  // catches transport errors, which must not swallow a privacy assertion.
  for (const call of decisionInputs) {
    const serialized = JSON.stringify(call.input)
    for (const privateText of ['PRIVATE_PROFILE_', 'PRIVATE_PRODUCER_REPORT', 'claude-native-', 'connectionId', 'synthetic-subscription-', 'providerSubject']) assert.ok(!serialized.includes(privateText), privateText)
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
  await t.test('task text and offered request fields cannot create host independent-check context', async () => {
    const f = await fixture(), before = decisionCounts()
    const offered = { stage: 'review', taskId: f.task.id, requestEpoch: f.sourceEventId, candidateId: randomUUID(), currentOwnerRequest: 'Invented Owner answer' }
    decisionProfile = f.implement!.id
    const request = { issueId: f.issueId, stage: 'execute', location: 'cloud' as const, cloudPurpose: 'desktop' as const,
      independentCheck: offered, note: JSON.stringify({ independentCheck: offered }) }
    const selected = await profiles.resolveAgentProfileDispatch(pool, f.scope, request)
    assert.equal(selected.agentProfile?.profileId, f.implement!.id)
    assert.equal(selected.agentProfile?.source, 'decision')
    assert.deepEqual(decisionCounts(), { profile: before.profile + 1, model: before.model })
    const input = JSON.parse(decisionInputs.at(-1)!.input as string)
    assert.equal(input.task.stage, 'execute'); assert.equal(input.task.note, request.note)
    assert.equal(input.task.kind, undefined); assert.equal(input.task.candidateId, undefined)
    assert.equal(input.acceptanceReference, undefined, 'only internal host dependencies supply an independent-check work object')
  })

  // Review feedback joins these same production dispatchers. The only effect
  // boundary remains factoryAutomaticRuntime.enqueue above; no fixture returns
  // a successful fake dispatcher or starts a cloud machine.
  const [{ deliverAgentReview }, { reviewBatchFollowUp }, { prepareCheckpointReview, retainCheckpointReview },
    { ensureReviewScope, captureDiffSnapshot, diffFile }, { withReviewTransaction }, { mutateReview },
    { manifestRevision }, { diffFileVersion }, { secretMaskerFor }, { factoryEventId }] = await Promise.all([
    import('../coding-workspace/diff/agent-delivery'), import('../coding-workspace/diff/feedback-brief'),
    import('../coding-workspace/diff/checkpoint'), import('../coding-workspace/diff/service'),
    import('../coding-workspace/diff/authority'), import('../coding-workspace/diff/review'),
    import('../coding-workspace/diff/store'), import('../coding-workspace/diff/patch'), import('../secrets/runtime'), import('./event-id'),
  ])
  const reviewDirectory = await mkdtemp(join(tmpdir(), 'factory-review-proof-'))
  t.after(() => rm(reviewDirectory, { recursive: true, force: true }))
  const executeGit = promisify(execFile)
  const reviewGit = async (...args: string[]) => (await executeGit('git', [
    '-c', 'user.name=Review Fixture', '-c', 'user.email=review@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args,
  ], { cwd: reviewDirectory, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' } })).stdout.trim()
  await reviewGit('init', '--initial-branch=main')
  await reviewGit('config', 'core.autocrlf', 'false')
  const reviewPaths = ['alpha.txt', 'beta.txt']
  for (const path of reviewPaths) await writeFile(join(reviewDirectory, path), 'before ' + path + '\nstable\n')
  await reviewGit('add', '--all'); await reviewGit('commit', '-qm', 'Review base')
  const reviewBaseSha = await reviewGit('rev-parse', 'HEAD')
  for (const path of reviewPaths) await writeFile(join(reviewDirectory, path), 'after ' + path + '\nstable\n')
  await reviewGit('add', '--all'); await reviewGit('commit', '-qm', 'Review candidate')
  const reviewHeadSha = await reviewGit('rev-parse', 'HEAD'), reviewTreeSha = await reviewGit('rev-parse', 'HEAD^{tree}')
  const reviewRecoveryPatch = gzipSync(await reviewGit('diff', '--binary', reviewBaseSha, reviewHeadSha) + '\n')
  const proofFiles = await Promise.all(reviewPaths.map(async path => {
    const before = Buffer.from('before ' + path + '\nstable\n'), after = Buffer.from('after ' + path + '\nstable\n')
    return { path, before, after, oldBlob: await reviewGit('rev-parse', reviewBaseSha + ':' + path),
      newBlob: await reviewGit('rev-parse', reviewHeadSha + ':' + path) }
  }))
  const reviewDeps = { database: pool, membership: pool }
  const reviewBodies = [
    'Preserve the original LEFT behavior.\n## More work in this thread\n---\nLEFT-END 中文',
    'Complete the new RIGHT behavior and validation.\nRIGHT-END 🚀',
  ]
  type FeedbackMode = 'factory' | 'execute' | 'ordinary'
  const feedbackFixture = async (mode: FeedbackMode = 'factory') => {
    const f = await fixture()
    // The ordinary fixture is a genuinely queued legacy thread on a separate
    // Task with no Factory association; the helper's existing Task is untouched.
    const issueId = mode === 'ordinary' ? await seedIssue(pool, f.ownerId) : f.issueId
    const remote = 'https://github.com/fixture/review-' + issueId + '.git'
    const repositoryKey = 'v2/github.com/fixture/review-' + issueId
    await pool.query('UPDATE device_repos SET "repoPath"=$2,"remoteUrl"=$3 WHERE id=$1', [f.repoId, repositoryKey, remote])
    await pool.query('UPDATE issues SET title=$2,content=$3 WHERE id=$1', [issueId, 'Review feedback fixture',
      { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'ORIGINAL_OWNER_REQUEST must survive feedback.' }] }] }])
    const sessionId = randomUUID()
    await pool.query('INSERT INTO "session" (id,token,"userId","expiresAt","createdAt","updatedAt") VALUES ($1,$2,$3,now()+interval \'1 hour\',now(),now())',
      [sessionId, randomUUID(), f.ownerId])
    const who: ReviewActor = { userId: f.ownerId, workspaceId: f.workspaceId, credential: { kind: 'session', id: sessionId } }
    const harness = mode === 'ordinary' ? 'codex' as const : 'claude_code' as const
    const selected = mode === 'ordinary' ? undefined : await profiles.resolveAgentProfileDispatch(pool, f.scope,
      { issueId, profileId: f.implement!.id, location: 'cloud', cloudPurpose: 'task' })
    const subscriptionBindingId = await bindAgentToConnection(pool, f.scope, f.agents[harness], harness, f.connections[harness], model[harness])
    const queue = (tx: import('pg').PoolClient, sourceEventId: string, idempotencyKey: string,
      agentId: string = f.agents[harness], deviceRepoId: string = f.repoId,
      factoryContext?: { attemptId: string; sourceEventId: string }) => queueCloudRun(pool, f.actor, {
      botId: f.botId, issueId, agentId, deviceRepoId, title: 'Review feedback fixture',
      body: 'ORIGINAL_OWNER_REQUEST must survive feedback.', model: model[harness], subscriptionBindingId,
      ...(selected?.agentProfile ? { agentProfile: selected.agentProfile } : {}), sourceEventId, idempotencyKey,
    }, tx, factoryContext)
    const dispatch = createFactoryDispatch(pool, f.store, (tx, _owner, input, _bot, context) =>
      queue(tx, context.sourceEventId, 'factory:' + context.attemptId, input.agentId, input.deviceRepoId, context))
    // Queuing with an existing APP transaction borrows the Workspace/resource
    // lease; acquire it before opening that transaction, as production callers do.
    const { withProjectResourceLease } = await import('@/lib/project-resources/store')
    const queued = <T>(work: () => Promise<T>) => withProjectResourceLease(f.ownerId, f.workspaceId, work)
    let runId: string
    if (mode === 'ordinary') {
      runId = await queued(async () => {
        const tx = await pool.connect()
        try {
          await tx.query('BEGIN')
          const eventId = randomUUID()
          await tx.query('INSERT INTO coordinator_events (id,"userId","botId","issueId",kind,"dedupeKey",payload) VALUES ($1::uuid,$2,$3,$4,\'user_message\',$1::text,$5)',
            [eventId, f.ownerId, f.botId, issueId, { text: 'Original legacy thread request.' }])
          const created = (await queue(tx, eventId, 'legacy-review:' + issueId)).runId
          await tx.query('COMMIT')
          return created
        } catch (error) { await tx.query('ROLLBACK'); throw error } finally { tx.release() }
      })
    } else runId = (await queued(() => dispatch(f.ownerId, { binding: factoryBinding(f.task), agentId: f.agents[harness], deviceRepoId: f.repoId }))).runId
    await pool.query('UPDATE agent_runs SET status=\'succeeded\',"startedAt"=now(),"finishedAt"=now(),"sessionId"=$2,"stopReason"=\'submitted\',report=$3 WHERE id=$1',
      [runId, 'native-review-' + runId, { sourceCommit: reviewBaseSha, publish: { commit: reviewHeadSha, pushed: true },
        verify: { status: 'passed' }, summary: 'Completed repository candidate.', runtime: { observedModel: model[harness] } }])
    assert.ok((await pool.query('SELECT 1 FROM run_publications WHERE "runId"=$1 AND "remoteKey"=$2', [runId, repositoryKey])).rowCount,
      'the production queue freezes the repository admission and publication')
    if (mode === 'factory') {
      // Complete the real producer without scheduling the independent review:
      // an owner can request repair of this exact pending repository candidate.
      await createFactoryReconciler(pool, f.store, undefined, {}, f.botId).run(f.ownerId, runId)
      const current = (await pool.query('SELECT * FROM factory_tasks WHERE id=$1', [f.task.id])).rows[0]
      assert.equal(current.stage, 'review', current.reason); assert.equal(current.status, 'pending', current.reason)
      const candidate = (await pool.query('SELECT * FROM factory_candidates WHERE id=$1', [current.candidateId])).rows[0]
      assert.equal(candidate.runId, runId); assert.equal(candidate.sha, reviewHeadSha); assert.equal(candidate.kind, 'repository')
    }
    const scope = await ensureReviewScope(reviewDeps, who, runId, f.repoId)
    const files: DiffFileMetadata[] = proofFiles.map(file => {
      const metadata = { path: file.path, previousPath: null, status: 'modified' as const,
        oldBlob: file.oldBlob, newBlob: file.newBlob, oldMode: '100644', newMode: '100644',
        additions: 1, deletions: 1, binary: false, oldSize: file.before.length, newSize: file.after.length }
      return { ...metadata, fileVersion: diffFileVersion(f.repoId, { baseSha: reviewBaseSha, headSha: reviewHeadSha }, metadata) }
    })
    const revision = manifestRevision('checkpoint', reviewBaseSha, reviewHeadSha, reviewTreeSha, files)
    const mask = await secretMaskerFor({ workspaceId: f.workspaceId, ownerId: f.ownerId }), capturedAt = new Date()
    const checkpoint = { baseCommit: reviewBaseSha, patch: reviewRecoveryPatch.toString('base64'), files: files.length, takenAt: capturedAt.toISOString(),
      review: { version: 1, repoId: f.repoId, revision, files, reason: null,
        blobs: proofFiles.flatMap(file => [{ sha: file.oldBlob, base64: file.before.toString('base64') },
          { sha: file.newBlob, base64: file.after.toString('base64') }]) } }
    const prepared = prepareCheckpointReview(checkpoint, f.repoId, mask)
    assert.equal(prepared.reason, null, 'complete real Git blob proofs pass the production checkpoint validator')
    await withReviewTransaction(pool, pool, who, runId, f.repoId, async (tx, fresh) => {
      await tx.query('INSERT INTO run_checkpoints ("runId","userId","baseCommit",patch,files,"takenAt") VALUES ($1,$2,$3,$4,$5,$6)',
        [runId, f.ownerId, reviewBaseSha, reviewRecoveryPatch, files.length, capturedAt])
      await retainCheckpointReview(tx, fresh, prepared, capturedAt, mask)
    })
    const snapshot = await captureDiffSnapshot(reviewDeps, who, runId, f.repoId, { source: 'checkpoint' })
    assert.equal(snapshot.availability, 'available'); assert.equal(snapshot.counts.complete, true)
    const commentIds: string[] = []
    for (const [index, path] of reviewPaths.entries()) {
      const patch = await diffFile(reviewDeps, who, runId, f.repoId, snapshot.id, path)
      assert.equal(patch.format, 'text'); assert.ok(patch.hunks[0])
      const receipt = await mutateReview(reviewDeps, who, runId, f.repoId, snapshot.id, {
        action: 'create', requestId: randomUUID(), expectedRevision: index, draft: true, body: reviewBodies[index],
        anchor: { snapshotId: snapshot.id, sourceVersion: revision.version, path, side: index ? 'RIGHT' : 'LEFT',
          lineStart: 1, lineEnd: 1, hunkFingerprint: patch.hunks[0].fingerprint },
      })
      assert.ok(receipt.commentId); commentIds.push(receipt.commentId)
    }
    const current = mode === 'ordinary' ? null : (await pool.query('SELECT * FROM factory_tasks WHERE id=$1', [f.task.id])).rows[0]
    const input: ReviewBatchRequest = { requestId: randomUUID(), batchId: randomUUID(), expectedRevision: 2,
      snapshotId: snapshot.id, sourceVersion: revision.version, commentIds, note: 'Apply both complete findings.',
      failedCheckRefs: ['run-report:' + runId],
      ...(current ? { factory: { taskId: current.id, revision: current.revision, attemptId: current.attemptId,
        candidateId: current.candidateId, sourceEventId: current.sourceEventId } } : {}) }
    const source = (await pool.query('SELECT * FROM agent_runs WHERE id=$1', [runId])).rows[0]
    return { ...f, issueId, runId, source, who, scope, snapshot, input, dispatch, current, harness }
  }
  type FeedbackFixture = Awaited<ReturnType<typeof feedbackFixture>>
  const deliverFeedback = (f: FeedbackFixture, input = f.input) => deliverAgentReview(reviewDeps, f.who, f.runId, f.repoId, input)
  const feedbackRuns = async (f: FeedbackFixture) => (await pool.query('SELECT * FROM agent_runs WHERE "userId"=$1 AND "issueId"=$2 ORDER BY "createdAt",id', [f.ownerId, f.issueId])).rows
  const feedbackState = async (f: FeedbackFixture) => ({
    runs: await feedbackRuns(f),
    tasks: (await pool.query('SELECT * FROM factory_tasks WHERE "userId"=$1 AND "issueId"=$2 ORDER BY id', [f.ownerId, f.issueId])).rows,
    attempts: (await pool.query('SELECT a.* FROM factory_attempts a JOIN factory_tasks t ON t.id=a."taskId" WHERE t."userId"=$1 AND t."issueId"=$2 ORDER BY a.id', [f.ownerId, f.issueId])).rows,
    events: (await pool.query('SELECT e.* FROM factory_events e JOIN factory_tasks t ON t.id=e."taskId" WHERE t."userId"=$1 AND t."issueId"=$2 ORDER BY e."eventId"', [f.ownerId, f.issueId])).rows,
    continuations: (await pool.query('SELECT id,payload FROM coordinator_events WHERE "userId"=$1 AND "issueId"=$2 AND payload->>\'source\'=\'thread_continuation\' ORDER BY id', [f.ownerId, f.issueId])).rows,
    messages: (await pool.query('SELECT m.* FROM run_messages m JOIN agent_runs r ON r.id=m."runId" WHERE m."userId"=$1 AND r."userId"=$1 AND r."issueId"=$2 ORDER BY m.id', [f.ownerId, f.issueId])).rows,
  })
  const assertCompleteFeedback = async (f: FeedbackFixture, childId: string) => {
    const batch = (await pool.query('SELECT * FROM coding_workspace_review_batches WHERE id=$1', [f.input.batchId])).rows[0]
    const child = (await pool.query('SELECT * FROM agent_runs WHERE id=$1', [childId])).rows[0]
    assert.equal(batch.state, 'accepted'); assert.equal(batch.input.agent.comments.length, 2)
    assert.equal(child.status, 'queued'); assert.equal(child.continuesRunId, f.runId)
    assert.equal(child.agentDefinition.harness, f.harness); assert.equal(child.agentDefinition.model, model[f.harness])
    assert.equal(child.agentDefinition.subscription.bindingId, f.source.agentDefinition.subscription.bindingId)
    assert.equal(child.agentDefinition.definitionDigest, workerDefinitionDigest(child.agentDefinition))
    assert.equal(child.agentDefinition.promptDigest, createHash('sha256').update(JSON.stringify(child.prompt)).digest('hex'))
    assert.ok(child.prompt.includes('ORIGINAL_OWNER_REQUEST'))
    assert.ok(child.prompt.endsWith(batch.input.agent.text), 'the entire typed feedback is appended after stage repair/handoff instructions')
    assert.deepEqual(child.agentDefinition.workspaceReview, { batchId: f.input.batchId, fingerprint: batch.fingerprint, sourceRunId: f.runId })
    assert.equal(await reviewBatchFollowUp(pool, child), batch.input.agent.text, 'native session resume receives the entire accepted immutable request')
    const data = JSON.parse(batch.input.agent.text.split('\n').at(-1))
    assert.equal(data.runId, f.runId); assert.equal(data.repoId, f.repoId); assert.equal(data.snapshotId, f.snapshot.id)
    assert.equal(data.baseSha, reviewBaseSha); assert.equal(data.headSha, reviewHeadSha); assert.equal(data.source, 'checkpoint')
    assert.deepEqual(data.comments.map((comment: { body: string }) => comment.body).sort(), [...reviewBodies].sort())
    assert.deepEqual(data.comments.map((comment: { anchor: { side: string } }) => comment.anchor.side).sort(), ['LEFT', 'RIGHT'])
    for (const [index, id] of f.input.commentIds.entries()) {
      const comment = data.comments.find((value: { id: string }) => value.id === id)
      assert.equal(comment.body, reviewBodies[index]); assert.equal(comment.anchor.path, reviewPaths[index])
      assert.equal(comment.anchor.side, index ? 'RIGHT' : 'LEFT'); assert.equal(comment.anchor.lineStart, 1)
      assert.equal(comment.anchor.lineEnd, 1); assert.equal(comment.anchor.snapshotId, f.snapshot.id)
      assert.equal(comment.anchor.sourceVersion, f.snapshot.revision.version)
    }
    assert.deepEqual(data.failedCheckRefs, ['run-report:' + f.runId])
    const messageId = factoryEventId('workspace-review-message', f.input.batchId)
    const messages = (await feedbackState(f)).messages
    assert.equal(messages.length, 1, 'the original Task thread displays exactly one owner turn across the source and child Runs')
    assert.equal(messages[0].id, messageId)
    assert.equal(messages[0].runId, childId); assert.equal(messages[0].userId, f.ownerId)
    assert.equal(messages[0].text, batch.input.agent.text, 'the displayed turn retains the complete accepted feedback, including every inline finding')
    assert.equal(messages[0].origin, 'owner'); assert.equal(messages[0].mailboxWakeDepth, -1)
    assert.ok(messages[0].deliveredAt instanceof Date, 'feedback already present in the child prompt is display-only and is not delivered again')
    assert.equal(batch.receipt.delivery.messageId, messageId, 'the accepted receipt and display row share the stable batch-derived message identity')
    assert.equal((await pool.query('SELECT 1 FROM coding_workspace_review_comments WHERE "boardId"=$1 AND draft', [f.scope.boardId])).rowCount, 0)
    return { child, batch, messageId }
  }

  await t.test('Review repairs the exact Factory candidate once in the same epoch and keeps the complete native follow-up', async () => {
    const f = await feedbackFixture(), beforeHandoffs = handoffs.length
    const candidateBefore = (await pool.query('SELECT * FROM factory_candidates WHERE id=$1', [f.current.candidateId])).rows[0]
    const receipt = await deliverFeedback(f)
    assert.equal(receipt.state, 'accepted', receipt.reason); assert.equal(receipt.delivery?.kind, 'factory_repair')
    assert.ok(receipt.delivery?.runId)
    const { child, batch, messageId } = await assertCompleteFeedback(f, receipt.delivery.runId)
    assert.equal(receipt.delivery.messageId, messageId)
    const task = (await pool.query('SELECT * FROM factory_tasks WHERE id=$1', [f.task.id])).rows[0]
    assert.equal(task.stage, 'execute'); assert.equal(task.status, 'running'); assert.equal(task.sourceEventId, f.sourceEventId)
    assert.notEqual(task.attemptId, f.current.attemptId); assert.equal(task.candidateId, null)
    assert.equal(batch.input.agent.factory.candidateId, candidateBefore.id)
    assert.equal(batch.input.agent.factory.producerRunId, f.runId); assert.equal(batch.input.agent.factory.sha, reviewHeadSha)
    assert.deepEqual((await pool.query('SELECT * FROM factory_candidates WHERE id=$1', [candidateBefore.id])).rows[0], candidateBefore)
    assert.deepEqual(handoffs.slice(beforeHandoffs), [{ previous: f.runId, runId: child.id }])
    const after = await feedbackState(f)
    const replay = await deliverFeedback(f)
    const duplicate = await deliverFeedback(f, { ...f.input, requestId: randomUUID(), batchId: randomUUID() })
    for (const replayed of [replay, duplicate]) {
      assert.equal(replayed.batchId, receipt.batchId); assert.equal(replayed.state, 'accepted')
      assert.deepEqual(replayed.delivery, receipt.delivery)
    }
    assert.deepEqual(await feedbackState(f), after)
    assert.equal((await feedbackRuns(f)).length, 2); assert.equal(handoffs.length, beforeHandoffs + 1)
    assert.equal((await pool.query('SELECT 1 FROM coding_workspace_review_batches WHERE "boardId"=$1', [f.scope.boardId])).rowCount, 1)
  })

  await t.test('Review continues an ended ordinary Codex thread using its exact model and one atomic host queue', async () => {
    const f = await feedbackFixture('ordinary'), beforeHandoffs = handoffs.length
    await pool.query('UPDATE model_order_settings SET "preferredHarness"=\'claude_code\' WHERE "ownerId"=$1 AND "workspaceId"=$2', [f.ownerId, f.workspaceId])
    assert.equal((await feedbackState(f)).tasks.length, 0, 'the legacy source has no Factory association')
    const receipt = await deliverFeedback(f)
    assert.equal(receipt.state, 'accepted', receipt.reason); assert.equal(receipt.delivery?.kind, 'run_continuation')
    assert.ok(receipt.delivery?.runId)
    const { child, batch, messageId } = await assertCompleteFeedback(f, receipt.delivery.runId)
    assert.equal(receipt.delivery.messageId, messageId)
    assert.equal(batch.input.agent.factory, undefined)
    const state = await feedbackState(f)
    assert.equal(state.runs.length, 2); assert.equal(state.tasks.length, 1); assert.equal(state.attempts.length, 1)
    assert.equal(state.attempts[0].runId, child.id); assert.equal(state.tasks[0].stage, 'execute'); assert.equal(state.tasks[0].status, 'running')
    assert.equal(state.continuations.length, 1)
    assert.equal(state.tasks[0].sourceEventId, state.continuations[0].id)
    assert.equal(state.continuations[0].payload.text, batch.input.agent.text)
    assert.equal(state.continuations[0].payload.previousRunId, f.runId)
    for (const input of [f.input, { ...f.input, requestId: randomUUID(), batchId: randomUUID() }]) {
      const replay = await deliverFeedback(f, input)
      assert.equal(replay.batchId, receipt.batchId); assert.deepEqual(replay.delivery, receipt.delivery)
    }
    assert.deepEqual(await feedbackState(f), state)
    assert.deepEqual(handoffs.slice(beforeHandoffs), [{ previous: f.runId, runId: child.id }])
  })

  await t.test('Review rejects stale Factory revision and source epoch without producing a new execution', async () => {
    const f = await feedbackFixture(), before = await feedbackState(f), beforeHandoffs = handoffs.length
    assert.ok(f.input.factory)
    for (const factory of [{ ...f.input.factory, revision: f.input.factory.revision + 1 },
      { ...f.input.factory, sourceEventId: randomUUID() }]) {
      const receipt = await deliverFeedback(f, { ...f.input, requestId: randomUUID(), batchId: randomUUID(),
        expectedRevision: Number((await pool.query('SELECT revision FROM coding_workspace_review_boards WHERE id=$1', [f.scope.boardId])).rows[0].revision), factory })
      assert.equal(receipt.state, 'rejected'); assert.equal(receipt.reason, 'source_changed'); assert.equal(receipt.delivery, null)
      assert.deepEqual(await feedbackState(f), before)
    }
    assert.equal(handoffs.length, beforeHandoffs)
    assert.equal((await pool.query('SELECT 1 FROM coding_workspace_review_batches WHERE "boardId"=$1 AND state=\'accepted\'', [f.scope.boardId])).rowCount, 0)
  })

  for (const status of ['merging', 'merged'] as const) await t.test('Review cannot move the exact candidate owned by a ' + status + ' merge receipt', async () => {
    const f = await feedbackFixture(), mergeId = randomUUID(), beforeHandoffs = handoffs.length
    assert.ok(f.current.candidateId)
    await pool.query(`INSERT INTO factory_merges
      (id,"taskId","candidateId","userId","eventId","pullRequestUrl",sha,status,source,"headSha","finishedAt")
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'mikka',$9,CASE WHEN $8='merged' THEN clock_timestamp() ELSE NULL END)`,
    [mergeId, f.task.id, f.current.candidateId, f.ownerId, randomUUID(),
      'https://github.com/fixture/review-' + f.issueId + '/pull/71', reviewHeadSha, status, status === 'merged' ? reviewHeadSha : null])
    const before = await feedbackState(f), mergeBefore = (await pool.query('SELECT * FROM factory_merges WHERE id=$1', [mergeId])).rows[0]
    assert.deepEqual(before.messages, [])
    const receipt = await deliverFeedback(f)
    assert.equal(receipt.state, 'rejected'); assert.equal(receipt.reason, 'source_changed'); assert.equal(receipt.delivery, null)
    assert.deepEqual(await feedbackState(f), before, 'no message, child Run, repair, attempt advance or epoch event is committed')
    assert.deepEqual((await pool.query('SELECT * FROM factory_merges WHERE id=$1', [mergeId])).rows[0], mergeBefore)
    assert.equal(handoffs.length, beforeHandoffs, 'the claimed candidate cannot wake a repair execution')
    assert.equal((await pool.query('SELECT 1 FROM run_messages WHERE id=$1', [factoryEventId('workspace-review-message', f.input.batchId)])).rowCount, 0)
    assert.equal((await pool.query('SELECT 1 FROM coding_workspace_review_comments WHERE "boardId"=$1 AND draft', [f.scope.boardId])).rowCount, 2)
    assert.deepEqual(await deliverFeedback(f), receipt, 'replaying rejected feedback cannot move the merge-owned candidate')
    assert.deepEqual(await feedbackState(f), before); assert.equal(handoffs.length, beforeHandoffs)
  })

  await t.test('a definitively failed merge receipt does not prevent repair of its still-current candidate', async () => {
    const f = await feedbackFixture(), mergeId = randomUUID(), beforeHandoffs = handoffs.length
    await pool.query(`INSERT INTO factory_merges
      (id,"taskId","candidateId","userId","eventId","pullRequestUrl",sha,status,source,code,"finishedAt")
      VALUES($1,$2,$3,$4,$5,$6,$7,'failed','mikka','githubMergeBlocked',clock_timestamp())`,
    [mergeId, f.task.id, f.current.candidateId, f.ownerId, randomUUID(),
      'https://github.com/fixture/review-' + f.issueId + '/pull/72', reviewHeadSha])
    const mergeBefore = (await pool.query('SELECT * FROM factory_merges WHERE id=$1', [mergeId])).rows[0]
    const receipt = await deliverFeedback(f)
    assert.equal(receipt.state, 'accepted', receipt.reason); assert.equal(receipt.delivery?.kind, 'factory_repair')
    assert.ok(receipt.delivery?.runId)
    await assertCompleteFeedback(f, receipt.delivery.runId)
    assert.equal(handoffs.length, beforeHandoffs + 1)
    assert.deepEqual((await pool.query('SELECT * FROM factory_merges WHERE id=$1', [mergeId])).rows[0], mergeBefore)
  })

  await t.test('Review cannot attach an old checkpoint to a newer candidate-less execute attempt', async () => {
    const f = await feedbackFixture('execute')
    let task = (await f.store.apply(f.ownerId, factoryBinding(f.current), randomUUID(),
      { action: 'finish', status: 'blocked', reason: 'Original execution ended.', evidence: [], output: {} })).task
    task = (await f.store.apply(f.ownerId, factoryBinding(task), randomUUID(), { action: 'retry', reason: 'Start a separate exact attempt.' })).task
    const newer = await f.dispatch(f.ownerId, { binding: factoryBinding(task), agentId: f.agents.claude_code, deviceRepoId: f.repoId })
    await pool.query('UPDATE agent_runs SET status=\'failed\',"finishedAt"=now(),"stopReason"=\'error\' WHERE id=$1', [newer.runId])
    const current = (await pool.query('SELECT * FROM factory_tasks WHERE id=$1', [task.id])).rows[0]
    assert.equal(current.candidateId, null)
    const before = await feedbackState(f), beforeHandoffs = handoffs.length
    await assert.rejects(deliverFeedback(f, { ...f.input, factory: { taskId: current.id, revision: current.revision,
      attemptId: current.attemptId, candidateId: null, sourceEventId: current.sourceEventId } }),
    (error: unknown) => (error as { code?: string }).code === 'workspace_snapshot_outdated')
    assert.deepEqual(await feedbackState(f), before); assert.equal(handoffs.length, beforeHandoffs)
    assert.equal((await pool.query('SELECT 1 FROM coding_workspace_review_batches WHERE "boardId"=$1', [f.scope.boardId])).rowCount, 0)
  })

  for (const mode of ['factory', 'ordinary'] as const) await t.test('Review ' + mode + ' delivery rolls back queue and acceptance together before retry', async () => {
    const f = await feedbackFixture(mode), before = await feedbackState(f), beforeHandoffs = handoffs.length
    assert.deepEqual(before.messages, [])
    const functionName = 'profile_review_failure_' + randomUUID().replaceAll('-', '')
    const triggerName = functionName + '_trigger'
    const table = mode === 'factory' ? 'coding_workspace_review_batches' : 'agent_runs'
    if (mode === 'factory') {
      await pool.query('CREATE FUNCTION ' + functionName + '() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ' +
        'IF NEW.id::text = TG_ARGV[0] AND NEW.state = \'accepted\' THEN RAISE EXCEPTION \'fixture acceptance failure\'; END IF; RETURN NEW; END $$')
      await pool.query('CREATE TRIGGER ' + triggerName + ' BEFORE UPDATE ON ' + table + ' FOR EACH ROW EXECUTE FUNCTION ' + functionName + '(\'' + f.input.batchId + '\')')
    } else {
      await pool.query('CREATE FUNCTION ' + functionName + '() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ' +
        'IF NEW."issueId"::text = TG_ARGV[0] THEN RAISE EXCEPTION \'fixture queue commit failure\'; END IF; RETURN NEW; END $$')
      await pool.query('CREATE CONSTRAINT TRIGGER ' + triggerName + ' AFTER INSERT ON ' + table +
        ' DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ' + functionName + '(\'' + f.issueId + '\')')
    }
    try {
      await assert.rejects(deliverFeedback(f), (error: unknown) => {
        const failure = error as { code?: string; cause?: { code?: string; message?: string } }
        assert.equal(failure.code, 'workspace_review_delivery_uncertain')
        assert.equal(failure.cause?.code, 'P0001', 'the installed SQL fault, rather than admission, caused the rollback')
        assert.equal(failure.cause?.message, mode === 'factory' ? 'fixture acceptance failure' : 'fixture queue commit failure')
        return true
      })
      assert.deepEqual(await feedbackState(f), before, 'the child, display message, attempt, epoch event and Factory receipt all roll back')
      assert.equal((await pool.query('SELECT 1 FROM run_messages WHERE id=$1', [factoryEventId('workspace-review-message', f.input.batchId)])).rowCount, 0,
        'a rejected COMMIT leaves no displayed turn on either the original or continuation Run')
      const batch = (await pool.query('SELECT state,receipt FROM coding_workspace_review_batches WHERE id=$1', [f.input.batchId])).rows[0]
      assert.equal(batch.state, 'prepared'); assert.equal(batch.receipt, null)
      assert.equal(handoffs.length, beforeHandoffs, 'no provider wake precedes a successful COMMIT')
      assert.equal((await pool.query('SELECT 1 FROM coding_workspace_review_comments WHERE "boardId"=$1 AND draft', [f.scope.boardId])).rowCount, 2)
    } finally {
      await pool.query('DROP TRIGGER ' + triggerName + ' ON ' + table)
      await pool.query('DROP FUNCTION ' + functionName + '()')
    }
    const accepted = await deliverFeedback(f)
    assert.equal(accepted.state, 'accepted', accepted.reason); assert.ok(accepted.delivery?.runId)
    const { messageId } = await assertCompleteFeedback(f, accepted.delivery.runId)
    assert.equal(accepted.delivery.messageId, messageId)
    assert.equal((await feedbackRuns(f)).length, 2); assert.equal(handoffs.length, beforeHandoffs + 1)
  })
})
