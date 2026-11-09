import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { DAEMON_PROTOCOL_VERSION } from '@mikka/protocol/daemon'
import { MIN_DAEMON_VERSION, REPO_ORIGIN_HEADER } from '@mikka/protocol/device'
import { normalizeRepository } from '@mikka/protocol/repository'
import { dbUrl, seedBot, seedIssue, seedUser, seedWorkspace } from './support/workspace-admin-db'
import { disposableDatabase } from './helpers/e2e-target.mjs'
import type { DecisionAnswer, DecisionInput, DecisionQuestion } from '../lib/coordinator/decision'
import type { ModelDispatch } from '../lib/model-dispatch'
import { MODEL_ROUTING_EFFORTS, MODEL_ROUTING_TIERS, modelTier } from '../lib/model-routing'
import type { OrderEntry, OrderHarness } from '../lib/model-order-plan'

if (dbUrl && !disposableDatabase(process.env, dbUrl)) throw Error('Model routing DB tests require isolated loopback *_e2e targets')

type Decision = typeof import('../lib/coordinator/decide').invokeDecision
type DecisionCall = { purpose: string; input: DecisionInput; questions: DecisionQuestion[] }
/** Answers the judged tier of `model` and the effort level; the judge never sees candidates. */
function decisionFixture(model: string, _legacyDifficulty = 'easy', effort = 'low', options: { choice?: 'not-listed' | 'none'; confidence?: number; unavailable?: boolean } = {}) {
  const calls: DecisionCall[] = []
  const decision: Decision = async (purpose, input, questions) => {
    calls.push({ purpose, input, questions })
    if (options.unavailable) return null
    const confidence = options.confidence ?? .95
    const answers = new Map<string, Exclude<DecisionAnswer, { type: 'refusal' }>>()
    if (options.choice !== 'none') answers.set('tier', { name: 'tier', type: 'score', score: options.choice === 'not-listed' ? 9 : MODEL_ROUTING_TIERS.indexOf(modelTier(model)), confidence })
    if (effort !== 'default') answers.set('effort', { name: 'effort', type: 'score', score: MODEL_ROUTING_EFFORTS.indexOf(effort as never), confidence })
    return {
      answers,
      execution: { executionId: randomUUID(), modelId: 'openai/gpt-6-luna-decisions', providerGenerationId: 'fixture-model-routing',
        startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), requestDigest: 'a'.repeat(64), imageDigests: [], vision: 'no-image-input' },
    }
  }
  return { calls, decision }
}
const judgeInput = (call: DecisionCall) => JSON.parse(typeof call.input === 'string' ? call.input : call.input.text) as Record<string, unknown>
function localTarget(target: ModelDispatch) {
  assert.equal(target.kind, 'device')
  if (target.kind !== 'device') assert.fail('Expected a runnable fixture device')
  return target
}

test('difficulty routing: real eligibility, explicit precedence, frozen queue and outcome ledger', { skip: !dbUrl, timeout: 120_000 }, async t => {
  const saved = { enabled: process.env.MIKKA_BYOS_ENABLED, routes: process.env.MIKKA_BYOS_VALIDATED_MODEL_ROUTES }
  process.env.MIKKA_BYOS_ENABLED = '1'
  process.env.MIKKA_BYOS_VALIDATED_MODEL_ROUTES = 'claude_cpa,codex_cpa'
  // node:test has no Next request lifetime; authorization and claim remain real.
  const next = await import('next/server')
  mock.module('next/server', { namedExports: { NextRequest: next.NextRequest, NextResponse: next.NextResponse, after: () => {} } })
  const { Pool: PostgresPool } = await import('pg')
  const pool = new PostgresPool({ connectionString: dbUrl, max: 8 })
  const [{ pool: appPool, withDatabaseClient }, { workspacePool }, { resolveModelDispatch }, order, profiles] = await Promise.all([
    import('../lib/db'), import('../lib/workspace-db'), import('../lib/model-dispatch'), import('../lib/model-order'), import('../lib/factory/agent-profile'),
  ])
  const owners: string[] = [], workspaces: string[] = []
  t.after(async () => {
    try {
      await pool.query('DELETE FROM factory_tasks WHERE "userId"=ANY($1)', [owners])
      await pool.query('DELETE FROM byos_native_runs WHERE "runId" IN (SELECT id FROM agent_runs WHERE "userId"=ANY($1))', [owners])
      await pool.query('DELETE FROM run_publications WHERE "userId"=ANY($1)', [owners])
      await pool.query('DELETE FROM run_tokens WHERE "runId" IN (SELECT id FROM agent_runs WHERE "userId"=ANY($1))', [owners])
      await pool.query('DELETE FROM agent_runs WHERE "userId"=ANY($1)', [owners])
      await pool.query('DELETE FROM factory_agent_profile_versions WHERE "ownerId"=ANY($1)', [owners])
      await pool.query('DELETE FROM factory_agent_profiles WHERE "ownerId"=ANY($1)', [owners])
      await pool.query('DELETE FROM model_order_entries WHERE "ownerId"=ANY($1)', [owners])
      await pool.query('DELETE FROM model_order_settings WHERE "ownerId"=ANY($1)', [owners])
      await pool.query('DELETE FROM byos_bindings WHERE "ownerId"=ANY($1)', [owners])
      await pool.query('DELETE FROM byos_connections WHERE "ownerId"=ANY($1)', [owners])
      await pool.query('DELETE FROM coordinator_events WHERE "userId"=ANY($1)', [owners])
      await pool.query('DELETE FROM device_repos WHERE "userId"=ANY($1)', [owners])
      await pool.query('DELETE FROM repository_settings WHERE "userId"=ANY($1)', [owners])
      await pool.query('DELETE FROM agent_kit_heads WHERE owner_id=ANY($1)', [owners])
      await pool.query('DELETE FROM bots WHERE "ownerId"=ANY($1)', [owners])
      await pool.query('DELETE FROM agents WHERE "userId"=ANY($1)', [owners])
      await pool.query('DELETE FROM device_tokens WHERE "userId"=ANY($1)', [owners])
      await pool.query('DELETE FROM devices WHERE "ownerId"=ANY($1)', [owners])
      await pool.query('DELETE FROM issues WHERE "userId"=ANY($1)', [owners])
      await pool.query('DELETE FROM mikka_workspace_members WHERE "workspaceId"=ANY($1::uuid[])', [workspaces])
      await pool.query('DELETE FROM mikka_workspaces WHERE id=ANY($1::uuid[])', [workspaces])
      await pool.query('DELETE FROM "user" WHERE id=ANY($1)', [owners])
    } finally {
      await Promise.all([pool.end(), appPool.end(), workspacePool.end()])
      for (const [key, value] of [['MIKKA_BYOS_ENABLED', saved.enabled], ['MIKKA_BYOS_VALIDATED_MODEL_ROUTES', saved.routes]] as const) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value
      }
    }
  })
  const person = async (name: string) => {
    const ownerId = await seedUser(pool, name); owners.push(ownerId)
    const { id: workspaceId } = await seedWorkspace(pool, ownerId, [{ userId: ownerId, role: 'admin' }]); workspaces.push(workspaceId)
    const botId = await seedBot(pool, workspaceId, ownerId)
    await pool.query(`INSERT INTO model_order_settings ("ownerId","workspaceId",location,customized,"autoModelRouting") VALUES ($1,$2,'local',true,true)`, [ownerId, workspaceId])
    return { ownerId, workspaceId, botId }
  }
  const scope = await person('routing-owner'), foreign = await person('routing-foreign')
  const quota = (provider: 'claude' | 'codex', used = .1) => JSON.stringify({ vendor: provider === 'claude' ? 'claude_code' : 'codex', source: 'official', status: 'ok', plan: null,
    observedAt: new Date().toISOString(), windows: [{ kind: 'five_hour', used, resetsAt: new Date(Date.now() + 3_600_000).toISOString() }] })
  const subscribe = async (who: typeof scope, provider: 'claude' | 'codex', models: string[]) => {
    const id = randomUUID()
    await pool.query(`INSERT INTO byos_connections (id,"ownerId","workspaceId",provider,state,epoch,"secretName","secretDigest","providerSubject","modelCatalog",quota)
      VALUES ($1,$2,$3,$4,'connected',1,$5,$6,'synthetic-routing-subject',$7,$8)`,
    [id, who.ownerId, who.workspaceId, provider, `synthetic-routing-${id}`, 'a'.repeat(64), JSON.stringify({ revision: '1', models }), quota(provider)])
    for (const model of models) await pool.query(`INSERT INTO byos_bindings (id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision",route,"modelId")
      VALUES ($1,$2,$3,'catalogue',$4,1,$5,$6)`, [randomUUID(), who.ownerId, who.workspaceId, id, provider === 'claude' ? 'claude_cpa' : 'codex_cpa', model])
    return id
  }
  const strongSource = await subscribe(scope, 'claude', ['claude-opus-5-5'])
  const lightSource = await subscribe(scope, 'claude', ['claude-haiku-5-5'])
  const standardSource = await subscribe(scope, 'claude', ['claude-sonnet-5-5'])
  const codexSource = await subscribe(scope, 'codex', ['gpt-6.1-sol', 'gpt-6-luna'])
  const foreignSource = await subscribe(foreign, 'claude', ['claude-fable-5-1'])
  const rows: OrderEntry[] = [
    [strongSource, 'claude_code', 'claude-opus-5-5'], [codexSource, 'codex', 'gpt-6.1-sol'],
    [standardSource, 'claude_code', 'claude-sonnet-5-5'], [lightSource, 'claude_code', 'claude-haiku-5-5'], [codexSource, 'codex', 'gpt-6-luna'],
  ].map(([connectionId, harness, model]) => ({ id: randomUUID(), harness: harness as OrderHarness, model, source: { kind: 'subscription', connectionId } }))
  for (const [position, entry] of rows.entries()) await pool.query(`INSERT INTO model_order_entries (id,"ownerId","workspaceId",position,harness,model,"sourceKind","sourceId")
    VALUES ($1,$2,$3,$4,$5,$6,'subscription',$7)`, [entry.id, scope.ownerId, scope.workspaceId, position, entry.harness, entry.model, entry.source.kind === 'subscription' ? entry.source.connectionId : null])
  const device = async (harness: OrderHarness, models: string[]) => {
    const id = randomUUID(), agentId = randomUUID()
    const report = [{ harness, installed: true, subscriptionBroker: true, toolApproval: true, models }]
    await pool.query(`INSERT INTO devices (id,"ownerId",name,kind,enabled,"protocolVersion","lastSeenAt",harnesses,"deviceType")
      VALUES ($1,$2,$3,'local',true,$4,now(),$5,'laptop')`, [id, scope.ownerId, `Routing ${harness}`, DAEMON_PROTOCOL_VERSION, JSON.stringify(report)])
    await pool.query('INSERT INTO agents (id,"userId","deviceId",harness,name) VALUES ($1,$2,$3,$4,$5)', [agentId, scope.ownerId, id, harness, `Routing ${harness}`])
    return { id, agentId, report }
  }
  const claude = await device('claude_code', ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'])
  const codex = await device('codex', ['gpt-6.1-sol', 'gpt-6-luna'])
  const taskText = 'Fix one punctuation mark in the task title.'
  const route = (decision: Decision, extra: Partial<NonNullable<Parameters<typeof resolveModelDispatch>[5]>> = {}) => resolveModelDispatch(pool, scope, undefined, 'local', undefined,
    { routing: { task: taskText }, decision, ...extra })

  await t.test('host filters real authorized models and selects light or strongest with frozen reasoning', async () => {
    const easy = decisionFixture('claude-haiku-5-5')
    const picked = localTarget(await route(easy.decision))
    assert.equal(easy.calls.length, 1)
    assert.equal(easy.calls[0].purpose, 'task-model-routing')
    assert.equal(picked.deviceId, claude.id)
    assert.deepEqual(picked.entry.source, { kind: 'subscription', connectionId: lightSource })
    assert.deepEqual(picked.routing, { version: 2, required: 'light', model: 'claude-haiku-5-5', harness: 'claude_code', tier: 'light', effort: 'low', reason: 'difficulty_fit' })
    const publicData = JSON.stringify(easy.calls)
    for (const hidden of [scope.ownerId, foreign.ownerId, scope.workspaceId, scope.botId, claude.id, codex.id, claude.agentId, codex.agentId,
      strongSource, lightSource, standardSource, codexSource, foreignSource, 'synthetic-routing-', 'providerSubject', 'secretDigest', 'connectionId', 'sourceId']) assert.ok(!publicData.includes(hidden), hidden)
    assert.deepEqual(Object.keys(judgeInput(easy.calls[0])).sort(), ['stage', 'task'], 'the judge sees the task, never candidates')
    for (const entry of rows) assert.ok(!publicData.includes(entry.model), entry.model)
    const hard = decisionFixture('gpt-6.1-sol', 'hard', 'high')
    const strongest = localTarget(await route(hard.decision, { harness: 'codex' }))
    assert.equal(hard.calls.length, 1)
    assert.equal(strongest.deviceId, codex.id)
    assert.equal(strongest.routing?.tier, 'strongest')
    assert.equal(strongest.routing?.effort, 'high')
    const binding = (await pool.query('SELECT "connectionId"::text,"modelId" FROM byos_bindings WHERE id=$1', [strongest.subscriptionBindingId])).rows[0]
    assert.deepEqual(binding, { connectionId: codexSource, modelId: 'gpt-6.1-sol' })
  })

  await t.test('the preferred Agent routes first and the other Agent is available when it cannot run', async () => {
    await order.changeOrder(pool, scope, { kind: 'preferred', harness: 'codex' })
    try {
      const preferred = decisionFixture('gpt-6-luna')
      const codexTarget = localTarget(await route(preferred.decision))
      assert.equal(codexTarget.deviceId, codex.id)
      assert.equal(codexTarget.model, 'gpt-6-luna')
      await pool.query(`UPDATE devices SET "lastSeenAt"=now()-interval '1 hour' WHERE id=$1`, [codex.id])
      const other = decisionFixture('claude-haiku-5-5')
      const otherTarget = localTarget(await route(other.decision))
      assert.deepEqual([otherTarget.deviceId, otherTarget.entry.harness, otherTarget.model], [claude.id, 'claude_code', 'claude-haiku-5-5'])
    } finally {
      await pool.query('UPDATE devices SET "lastSeenAt"=now() WHERE id=$1', [codex.id])
      await order.changeOrder(pool, scope, { kind: 'preferred', harness: 'claude_code' })
    }
  })

  await t.test('naming only an Agent retains its first reported candidate when its customized list is empty', async () => {
    await pool.query(`DELETE FROM model_order_entries WHERE "ownerId"=$1 AND "workspaceId"=$2 AND harness='codex'`, [scope.ownerId, scope.workspaceId])
    try {
      const probe = decisionFixture('gpt-6.1-sol', 'hard', 'high')
      const target = localTarget(await resolveModelDispatch(pool, scope, { harness: 'codex' }, 'local', undefined,
        { routing: { task: taskText }, decision: probe.decision }))
      assert.equal(target.deviceId, codex.id)
      assert.equal(target.model, 'gpt-6.1-sol')
      assert.deepEqual(target.entry.source, { kind: 'subscription', connectionId: codexSource })
      assert.equal(probe.calls.length, 1)
      assert.equal(target.routing?.reason, 'difficulty_fit')
    } finally {
      for (const [position, entry] of rows.entries()) if (entry.harness === 'codex') await pool.query(`INSERT INTO model_order_entries (id,"ownerId","workspaceId",position,harness,model,"sourceKind","sourceId")
        VALUES ($1,$2,$3,$4,$5,$6,'subscription',$7)`, [entry.id, scope.ownerId, scope.workspaceId, position, entry.harness, entry.model, codexSource])
    }
  })

  await t.test('exhausted quota, paused credentials and offline devices never enter the Decision catalogue', async () => {
    await pool.query('UPDATE byos_connections SET quota=$2 WHERE id=$1', [lightSource, quota('claude', 1)])
    await pool.query('UPDATE byos_connections SET paused=true WHERE id=$1', [standardSource])
    await pool.query(`UPDATE devices SET "lastSeenAt"=now()-interval '1 hour' WHERE id=$1`, [codex.id])
    try {
      // A light judgement can only rise to the one model left runnable.
      const probe = decisionFixture('claude-haiku-5-5', 'easy', 'high')
      const picked = localTarget(await route(probe.decision))
      assert.equal(probe.calls.length, 1)
      assert.equal(picked.model, 'claude-opus-5-5')
      assert.equal(picked.routing?.required, 'light')
      assert.equal(picked.routing?.reason, 'difficulty_fit')
    } finally {
      await pool.query('UPDATE byos_connections SET quota=$2 WHERE id=$1', [lightSource, quota('claude')])
      await pool.query('UPDATE byos_connections SET paused=false WHERE id=$1', [standardSource])
      await pool.query('UPDATE devices SET "lastSeenAt"=now() WHERE id=$1', [codex.id])
    }
    await pool.query('UPDATE devices SET harnesses=$2 WHERE id=$1', [claude.id, JSON.stringify([{ ...claude.report[0], models: ['claude-opus-5-5', 'claude-sonnet-5-5'] }])])
    try {
      // Missing device shortcuts do not remove an authorized credential model from routing.
      const probe = decisionFixture('claude-haiku-5-5', 'easy', 'medium')
      assert.equal(localTarget(await route(probe.decision)).model, 'claude-haiku-5-5')
    } finally { await pool.query('UPDATE devices SET harnesses=$2 WHERE id=$1', [claude.id, JSON.stringify(claude.report)]) }
  })

  await t.test('an explicit model, fixed source, disabled toggle and read-only resolution do not call the judge', async () => {
    const probe = decisionFixture('claude-haiku-5-5')
    const explicit = localTarget(await resolveModelDispatch(pool, scope, { harness: 'claude_code', model: 'claude-opus-5-5' }, 'local', undefined,
      { routing: { task: taskText }, decision: probe.decision }))
    assert.equal(explicit.model, 'claude-opus-5-5'); assert.equal(explicit.routing, undefined)
    const fixed = localTarget(await route(probe.decision, { exactEntry: rows[0] }))
    assert.deepEqual(fixed.entry, rows[0]); assert.equal(fixed.routing, undefined)
    const foreignEntry: OrderEntry = { id: 'foreign-fixed', harness: 'claude_code', model: 'claude-fable-5-1', source: { kind: 'subscription', connectionId: foreignSource } }
    assert.equal((await route(probe.decision, { exactEntry: foreignEntry })).kind, 'none')
    await order.changeOrder(pool, scope, { kind: 'autoRouting', enabled: false })
    try {
      const disabled = localTarget(await route(probe.decision))
      assert.equal(disabled.model, rows[0].model); assert.equal(disabled.routing, undefined)
    } finally { await order.changeOrder(pool, scope, { kind: 'autoRouting', enabled: true }) }
    await resolveModelDispatch(pool, scope, undefined, 'local', undefined, { decision: probe.decision, bindSubscription: false, probeQuota: false, skipCatalogueRefresh: true })
    assert.equal(probe.calls.length, 0)
  })

  await t.test('an unknown first quota fences routing before later runnable models', async () => {
    await pool.query('UPDATE byos_connections SET quota=NULL WHERE id=$1', [strongSource])
    const probe = decisionFixture('claude-haiku-5-5'), refreshed: string[] = []
    try {
      const result = await route(probe.decision, { refreshQuota: async (_scope, id) => {
        refreshed.push(id)
        throw new Error('synthetic quota unavailable')
      } })
      assert.deepEqual(refreshed, [strongSource])
      assert.equal(result.kind, 'none')
      assert.equal(result.kind === 'none' && result.reason, 'checking')
      assert.equal(probe.calls.length, 0)
    } finally { await pool.query('UPDATE byos_connections SET quota=$2 WHERE id=$1', [strongSource, quota('claude')]) }
  })

  await t.test('invalid, uncertain and unavailable Decisions use list order without invented difficulty or effort', async () => {
    for (const [options, reason] of [[{ choice: 'not-listed' }, 'invalid_answer'], [{ choice: 'none' }, 'no_selection'], [{ confidence: .1 }, 'low_confidence'], [{ unavailable: true }, 'decision_unavailable']] as const) {
      const probe = decisionFixture('claude-haiku-5-5', 'easy', 'low', options)
      const result = localTarget(await route(probe.decision))
      assert.equal(probe.calls.length, 1)
      assert.equal(result.model, rows[0].model)
      assert.equal(result.routing?.reason, reason)
      assert.equal(result.routing?.required, 'unknown')
      assert.equal(result.routing?.effort, undefined)
    }
  })

  await t.test('an uncertain Decision preserves the existing server placement preference', async () => {
    await pool.query(`UPDATE devices SET "deviceType"='server' WHERE id=$1`, [codex.id])
    try {
      const probe = decisionFixture('claude-haiku-5-5', 'easy', 'low', { confidence: .1 })
      const ordered = localTarget(await resolveModelDispatch(pool, scope, undefined, 'local', undefined, { decision: probe.decision }))
      assert.equal(ordered.deviceId, codex.id)
      assert.equal(ordered.model, 'gpt-6.1-sol')
      const fallback = localTarget(await route(probe.decision))
      assert.equal(probe.calls.length, 1)
      assert.equal(fallback.deviceId, ordered.deviceId)
      assert.deepEqual(fallback.entry, ordered.entry)
      assert.deepEqual(fallback.routing, { version: 2, required: 'unknown', model: 'gpt-6.1-sol', harness: 'codex', tier: 'strongest', reason: 'low_confidence' })
      const confident = localTarget(await route(decisionFixture('claude-haiku-5-5').decision))
      assert.equal(confident.deviceId, claude.id)
      assert.equal(confident.model, 'claude-haiku-5-5')
      assert.equal(confident.routing?.reason, 'difficulty_fit')
    } finally { await pool.query(`UPDATE devices SET "deviceType"='laptop' WHERE id=$1`, [codex.id]) }
  })

  await t.test('failure continuation escalates one available tier through the same resolver without a second Decision', async () => {
    const easy = localTarget(await route(decisionFixture('claude-haiku-5-5').decision))
    assert.ok(easy.routing)
    const probe = decisionFixture('claude-opus-5-5')
    const raised = localTarget(await route(probe.decision, { routing: { task: taskText, previous: easy.routing, escalate: true } }))
    assert.equal(raised.model, 'claude-sonnet-5-5')
    assert.equal(raised.routing?.reason, 'escalated')
    assert.equal(raised.routing?.tier, 'standard')
    assert.equal(raised.routing?.previousModel, 'claude-haiku-5-5')
    assert.equal(probe.calls.length, 0)
  })

  await t.test('the real Factory queue freezes routing, owner evidence reads it, and terminal outcomes are scoped and idempotent', async () => {
    const [{ createFactoryStore }, { createFactoryDispatch, factoryBinding, defaultFactoryDispatchAdapters }, { queueFactoryRun }, { issueForUser },
      { factoryCheckGates }, { factoryCheckIndependent }, { lockCliAgentPolicy }, { workerDefinitionDigest }, { recordModelRoutingOutcome }, { factoryEventId }, { runEvidence }, { threadExecutionEvidence }] = await Promise.all([
      import('../lib/factory/store'), import('../lib/factory/dispatch'), import('../lib/agent-runs'), import('../lib/issue-access'),
      import('../lib/factory/checks'), import('../lib/factory/check-independence'), import('../lib/agent-tool-approval/policy-store'),
      import('../lib/agent-kit/worker-digest'), import('../lib/model-routing-outcome'), import('../lib/factory/event-id'), import('../lib/captures/store'), import('../lib/thread-execution-identity-view'),
    ])
    const issueId = await seedIssue(pool, scope.ownerId, scope.workspaceId), sourceEventId = randomUUID()
    await pool.query('UPDATE issues SET title=$2 WHERE id=$1', [issueId, 'PRIVATE_ROUTING_TASK_CONTENT'])
    await pool.query(`INSERT INTO coordinator_events (id,"userId","botId","issueId",kind,"dedupeKey",payload) VALUES ($1,$2,$3,$4,'user_message',$5,$6)`,
      [sourceEventId, scope.ownerId, scope.botId, issueId, `routing-fixture:${sourceEventId}`, JSON.stringify({ text: 'Inspect the punctuation in this title.' })])
    const easy = decisionFixture('claude-haiku-5-5')
    const selected = await profiles.resolveAgentProfileDispatch(pool, scope, { issueId, location: 'local' }, { modelDecision: easy.decision })
    const target = localTarget(selected.target)
    assert.equal(easy.calls.length, 1); assert.equal(target.model, 'claude-haiku-5-5')
    assert.ok(target.routing)
    const repository = normalizeRepository(`https://github.com/synthetic/routing-${randomUUID()}.git`), repoId = randomUUID()
    await pool.query(`INSERT INTO device_repos (id,"userId","deviceId","repoPath","remoteUrl","baseBranch") VALUES ($1,$2,$3,$4,$5,'main')`, [repoId, scope.ownerId, target.deviceId, repository.key, repository.remoteUrl])
    const factory = createFactoryStore(pool, (owner, id, tx) => withDatabaseClient(tx, async () => Boolean(await issueForUser(owner, id))), scope.botId,
      { independent: factoryCheckIndependent, gates: factoryCheckGates })
    const routed = await factory.route(scope.ownerId, { issueId, sourceEventId, eventId: randomUUID(), rationale: 'Verify the selected model survives ordinary Factory admission.' })
    const dispatch = createFactoryDispatch(pool, factory, (tx, owner, input, bot, context) => queueFactoryRun(tx, owner, input, bot, context, undefined, {
      model: target.model, subscriptionBindingId: target.subscriptionBindingId, agentProfile: selected.agentProfile, readOnly: true,
      modelDispatch: { mode: selected.selectionMode!, location: 'local', entry: target.entry, routing: target.routing },
    }), { ...defaultFactoryDispatchAdapters, lockAdmission: (tx, owner, input) => lockCliAgentPolicy(tx, owner, input.agentId, scope.botId).then(() => undefined) })
    const queued = await dispatch(scope.ownerId, { binding: factoryBinding(routed.task), agentId: target.agentId, deviceRepoId: repoId })
    const row = (await pool.query('SELECT "agentDefinition" FROM agent_runs WHERE id=$1 AND "userId"=$2', [queued.runId, scope.ownerId])).rows[0]
    const frozen = row.agentDefinition
    assert.deepEqual(frozen.modelDispatch.routing, target.routing)
    assert.equal(frozen.model, 'claude-haiku-5-5'); assert.equal(frozen.modelDispatch.routing.effort, 'low')
    assert.equal(frozen.definitionDigest, workerDefinitionDigest(frozen))
    const visible = await runEvidence(scope.ownerId, queued.runId)
    assert.deepEqual(threadExecutionEvidence(visible, queued.runId).modelRouting, target.routing)
    assert.equal(await runEvidence(foreign.ownerId, queued.runId), null)
    await order.changeOrder(pool, scope, { kind: 'autoRouting', enabled: false })
    try { assert.deepEqual(threadExecutionEvidence(await runEvidence(scope.ownerId, queued.runId), queued.runId).modelRouting, target.routing) }
    finally { await order.changeOrder(pool, scope, { kind: 'autoRouting', enabled: true }) }

    const eventId = factoryEventId('model-routing-outcome', queued.runId)
    const events = async () => (await pool.query('SELECT request,result FROM factory_events WHERE "taskId"=$1 AND "eventId"=$2', [routed.task.id, eventId])).rows
    await recordModelRoutingOutcome(pool, scope.ownerId, queued.runId)
    assert.equal((await events()).length, 0, 'a queued run has no terminal outcome')
    await pool.query(`UPDATE agent_runs SET status='failed',"stopReason"='agent_error',"finishedAt"=now() WHERE id=$1`, [queued.runId])
    await pool.query(`UPDATE factory_attempts SET status='failed',"finishedAt"=now() WHERE "runId"=$1`, [queued.runId])
    await recordModelRoutingOutcome(pool, foreign.ownerId, queued.runId)
    assert.equal((await events()).length, 0, 'a different owner cannot record this run')
    await Promise.all([recordModelRoutingOutcome(pool, scope.ownerId, queued.runId), recordModelRoutingOutcome(pool, scope.ownerId, queued.runId)])
    const recorded = await events()
    assert.equal(recorded.length, 1)
    assert.deepEqual(recorded[0].request, { kind: 'model_routing_outcome', runId: queued.runId })
    assert.deepEqual(recorded[0].result, { runId: queued.runId, routing: target.routing,
      outcome: { status: 'failed', stopReason: 'agent_error', stage: 'execute', attemptStatus: 'failed' } })
    assert.ok(!JSON.stringify(recorded).includes('PRIVATE_ROUTING_TASK_CONTENT'))
  })

  await t.test('only an inherited profile invokes model routing; fixed or explicit models retain precedence', async () => {
    const store = new profiles.AgentProfileStore(pool), issueId = await seedIssue(pool, scope.ownerId, scope.workspaceId)
    const inherited = await store.create(scope, { name: 'Inherited routing fixture', harness: 'claude_code', model: { mode: 'inherit' }, instructions: 'PRIVATE_PROFILE_CONTENT' })
    const easy = decisionFixture('claude-haiku-5-5')
    const inheritedResult = await profiles.resolveAgentProfileDispatch(pool, scope, { issueId, profileId: inherited.id, location: 'local' }, { modelDecision: easy.decision })
    const inheritedTarget = localTarget(inheritedResult.target)
    assert.equal(easy.calls.length, 1); assert.equal(inheritedTarget.model, 'claude-haiku-5-5')
    assert.equal(inheritedResult.selectionMode, 'preference')
    assert.ok(!JSON.stringify(easy.calls).includes('PRIVATE_PROFILE_CONTENT'))
    assert.deepEqual(inheritedResult.agentProfile?.targetEntry, inheritedTarget.entry)
    const fixed = await store.create(scope, { name: 'Fixed routing fixture', harness: 'claude_code', effort: 'high',
      model: { mode: 'fixed', harness: 'claude_code', model: 'claude-opus-5-5', source: { kind: 'subscription', connectionId: strongSource } } })
    const ignored = decisionFixture('claude-haiku-5-5')
    const fixedResult = await profiles.resolveAgentProfileDispatch(pool, scope, { issueId, profileId: fixed.id, location: 'local' }, { modelDecision: ignored.decision })
    assert.equal(localTarget(fixedResult.target).model, 'claude-opus-5-5')
    assert.equal(localTarget(fixedResult.target).routing, undefined)
    assert.equal(fixedResult.agentProfile?.effort, 'high'); assert.equal(fixedResult.selectionMode, 'picked')
    const named = await profiles.resolveAgentProfileDispatch(pool, scope, { issueId, profileId: inherited.id, location: 'local', asked: { harness: 'claude_code', model: 'claude-opus-5-5' } }, { modelDecision: ignored.decision })
    assert.equal(localTarget(named.target).model, 'claude-opus-5-5'); assert.equal(localTarget(named.target).routing, undefined)
    assert.equal(named.selectionMode, 'picked'); assert.equal(ignored.calls.length, 0)
  })

  await t.test('an inherited profile effort survives default or unavailable Decisions, freezes and reaches the real claim assignment', async () => {
    const [{ createFactoryStore }, { createFactoryDispatch, factoryBinding, defaultFactoryDispatchAdapters }, { queueFactoryRun }, { issueForUser },
      { factoryCheckGates }, { factoryCheckIndependent }, { lockCliAgentPolicy }, { hashDeviceToken }, claimRoute] = await Promise.all([
      import('../lib/factory/store'), import('../lib/factory/dispatch'), import('../lib/agent-runs'), import('../lib/issue-access'),
      import('../lib/factory/checks'), import('../lib/factory/check-independence'), import('../lib/agent-tool-approval/policy-store'),
      import('../lib/device-link'), import('../app/v1/devices/[deviceId]/runs/[runId]/claim/route'),
    ])
    const profile = await new profiles.AgentProfileStore(pool).create(scope, {
      name: 'Inherited explicit effort', harness: 'claude_code', effort: 'high', model: { mode: 'inherit' },
    })
    const token = `synthetic-routing-${randomUUID()}`
    await pool.query('INSERT INTO device_tokens (id,"userId","tokenHash") VALUES ($1,$2,$3)', [randomUUID(), scope.ownerId, hashDeviceToken(token)])
    for (const unavailable of [false, true]) {
      await pool.query('UPDATE byos_connections SET quota=$2 WHERE id=ANY($1::uuid[])', [[strongSource, standardSource, lightSource], quota('claude')])
      await pool.query('UPDATE devices SET "lastSeenAt"=now() WHERE id=$1', [claude.id])
      const issueId = await seedIssue(pool, scope.ownerId, scope.workspaceId), sourceEventId = randomUUID()
      const probe = decisionFixture('claude-haiku-5-5', 'easy', 'default', { unavailable })
      const selected = await profiles.resolveAgentProfileDispatch(pool, scope, { issueId, profileId: profile.id, location: 'local' }, { modelDecision: probe.decision })
      const target = localTarget(selected.target)
      assert.equal(probe.calls.length, 1)
      assert.equal(selected.agentProfile?.effort, 'high')
      assert.equal(target.routing?.effort, 'high')
      assert.equal(target.routing?.reason, unavailable ? 'decision_unavailable' : 'difficulty_fit')
      assert.equal(target.routing?.required, unavailable ? 'unknown' : 'light')
      await pool.query(`INSERT INTO coordinator_events (id,"userId","botId","issueId",kind,"dedupeKey",payload)
        VALUES ($1,$2,$3,$4,'user_message',$5,$6)`, [sourceEventId, scope.ownerId, scope.botId, issueId, `routing-effort:${sourceEventId}`, JSON.stringify({ text: taskText })])
      const repository = normalizeRepository(`https://github.com/synthetic/effort-${randomUUID()}.git`), repoId = randomUUID()
      await pool.query(`INSERT INTO device_repos (id,"userId","deviceId","repoPath","remoteUrl","baseBranch")
        VALUES ($1,$2,$3,$4,$5,'main')`, [repoId, scope.ownerId, target.deviceId, repository.key, repository.remoteUrl])
      const factory = createFactoryStore(pool, (owner, id, tx) => withDatabaseClient(tx, async () => Boolean(await issueForUser(owner, id))), scope.botId,
        { independent: factoryCheckIndependent, gates: factoryCheckGates })
      const routed = await factory.route(scope.ownerId, { issueId, sourceEventId, eventId: randomUUID(), rationale: 'Keep the configured effort through routing and admission.' })
      const dispatch = createFactoryDispatch(pool, factory, (tx, owner, input, bot, context) => queueFactoryRun(tx, owner, input, bot, context, undefined, {
        model: target.model, subscriptionBindingId: target.subscriptionBindingId, agentProfile: selected.agentProfile, readOnly: true,
        modelDispatch: { mode: selected.selectionMode!, location: 'local', entry: target.entry, routing: target.routing },
      }), { ...defaultFactoryDispatchAdapters, lockAdmission: (tx, owner, input) => lockCliAgentPolicy(tx, owner, input.agentId, scope.botId).then(() => undefined) })
      const queued = await dispatch(scope.ownerId, { binding: factoryBinding(routed.task), agentId: target.agentId, deviceRepoId: repoId, profileId: profile.id })
      const frozen = (await pool.query('SELECT "agentDefinition" FROM agent_runs WHERE id=$1 AND "userId"=$2', [queued.runId, scope.ownerId])).rows[0].agentDefinition
      assert.equal(frozen.agentProfile.effort, 'high')
      assert.equal(frozen.modelDispatch.routing.effort, 'high')
      const response = await claimRoute.POST(new Request(`http://127.0.0.1/v1/devices/${target.deviceId}/runs/${queued.runId}/claim`, {
        method: 'POST', headers: { 'x-mikka-client-version': MIN_DAEMON_VERSION, authorization: `Bearer ${token}`, [REPO_ORIGIN_HEADER]: '1' },
      }), { params: Promise.resolve({ deviceId: target.deviceId, runId: queued.runId }) })
      assert.equal(response.status, 200)
      const assignment = await response.json()
      assert.equal(assignment.effort, 'high')
      assert.equal(assignment.effort, frozen.modelDispatch.routing.effort)
      assert.equal(assignment.model, frozen.model)
    }
  })
})
