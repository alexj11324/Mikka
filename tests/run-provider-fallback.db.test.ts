// Real PostgreSQL, model preference admission, completion and claim. Only the
// provider catalogue and Next's request-scoped `after` are replaced; Coordinator
// wakes are observed without running a separate inbox consumer. Provider
// signals stand for terminal adapter events after their native short retries;
// this suite never sends a paid model request or fabricates a worker snapshot.
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mock, test } from 'node:test'
import { DAEMON_PROTOCOL_VERSION } from '@mikka/protocol/daemon'
import { MODEL_CREDENTIAL_HEADER, RECOVERY_WORKTREE_HEADER, REPO_ORIGIN_HEADER, MIN_DAEMON_VERSION } from '@mikka/protocol/device'
import type { ProviderFailure } from '@mikka/protocol/provider-failure'
import { normalizeRepository } from '@mikka/protocol/repository'
import { emptyRunReport } from '@mikka/protocol/run'
import { dbUrl, seedBot, seedIssue, seedPersonalWorkspace, seedUser, seedWorkspace } from './support/workspace-admin-db'
import { recordPushGrant } from './support/github-app-stub'
import { ALLOWED_MODEL, codexWithModel, seedAllowedModel } from './support/allowed-model'
import type { DecisionAnswer } from '../lib/coordinator/decision'
import { MODEL_ROUTING_TIERS, modelTier } from '../lib/model-routing'
import { isolateCoordinatorWakes } from './support/coordinator-wake'
import { addFactoryVisualEvidence } from './helpers/factory-visual-evidence'

test('provider failure continues the same task through its authorized preferred models', { skip: !dbUrl }, async t => {
  const names = ['WORKSPACE_SECRETS_KEY', 'MIKKA_BYOS_ENABLED', 'MIKKA_CLOUD_COMPUTER_TASKS', 'MIKKA_FACTORY_ROUTING_ENABLED'] as const
  const saved = new Map(names.map(name => [name, process.env[name]]))
  process.env.WORKSPACE_SECRETS_KEY = randomBytes(32).toString('hex')
  process.env.MIKKA_BYOS_ENABLED = '1'
  delete process.env.MIKKA_CLOUD_COMPUTER_TASKS
  delete process.env.MIKKA_FACTORY_ROUTING_ENABLED
  const next = await import('next/server')
  let captureAfter: (() => Promise<void>)[] | undefined
  mock.module('next/server', { namedExports: { NextRequest: next.NextRequest, NextResponse: next.NextResponse,
    after: (work: () => Promise<void>) => { captureAfter?.push(work) },
  } })
  const coordinator = await isolateCoordinatorWakes(t)
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: dbUrl, max: 4 })
  const { pool: appPool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  const keys = await import('../lib/model-api-keys')
  const order = await import('../lib/model-order')
  const { entryKey } = await import('../lib/model-order-plan')
  const { resolveModelDispatch } = await import('../lib/model-dispatch')
  const { chooseLocalRunModel } = await import('../lib/computer/run-model')
  const { queueRun } = await import('../lib/agent-runs')
  const { persistRunCompletion } = await import('../lib/run-publications')
  const { recoverProviderFailure, providerContinuationMatches } = await import('../lib/run-provider-fallback')
  const { providerContinuationNote } = await import('../lib/run-retry')
  const { hashDeviceToken } = await import('../lib/device-link')
  const claimRoute = await import('../app/v1/devices/[deviceId]/runs/[runId]/claim/route')
  const users: string[] = []
  t.after(async () => {
    await coordinator.flush()
    for (const name of names) {
      const value = saved.get(name)
      if (value === undefined) delete process.env[name]; else process.env[name] = value
    }
    try {
      await pool.query('DELETE FROM factory_tasks WHERE "userId" = ANY($1)', [users])
      await pool.query('DELETE FROM coordinator_events WHERE "userId" = ANY($1)', [users])
      await pool.query('DELETE FROM model_api_key_runs m USING agent_runs r WHERE r.id=m."runId" AND r."userId" = ANY($1)', [users])
      await pool.query('DELETE FROM byos_native_runs n USING agent_runs r WHERE r.id=n."runId" AND r."userId" = ANY($1)', [users])
      await pool.query('DELETE FROM run_publications WHERE "userId" = ANY($1)', [users])
      await pool.query('DELETE FROM run_tokens t USING agent_runs r WHERE r.id=t."runId" AND r."userId" = ANY($1)', [users])
      await pool.query('UPDATE agent_runs SET "retryOf"=NULL WHERE "userId" = ANY($1)', [users])
      await pool.query('DELETE FROM agent_runs WHERE "userId" = ANY($1)', [users])
      await pool.query('DELETE FROM model_order_entries WHERE "ownerId" = ANY($1)', [users])
      await pool.query('DELETE FROM model_order_settings WHERE "ownerId" = ANY($1)', [users])
      await pool.query('DELETE FROM factory_agent_profile_versions WHERE "ownerId" = ANY($1)', [users])
      await pool.query('DELETE FROM factory_agent_profiles WHERE "ownerId" = ANY($1)', [users])
      await pool.query('DELETE FROM bot_model_choices WHERE "ownerId" = ANY($1)', [users])
      await pool.query('DELETE FROM model_api_keys WHERE "ownerId" = ANY($1)', [users])
      await pool.query('DELETE FROM byos_bindings WHERE "ownerId" = ANY($1)', [users])
      await pool.query('DELETE FROM byos_connections WHERE "ownerId" = ANY($1)', [users])
      await pool.query('DELETE FROM workspace_subscription_shares WHERE "ownerId" = ANY($1)', [users])
      await pool.query('DELETE FROM device_tokens WHERE "userId" = ANY($1)', [users])
      await pool.query('DELETE FROM agents WHERE "userId" = ANY($1)', [users])
      await pool.query('DELETE FROM device_repos WHERE "userId" = ANY($1)', [users])
      await pool.query('DELETE FROM devices WHERE "ownerId" = ANY($1)', [users])
      await pool.query('DELETE FROM repository_settings WHERE "userId" = ANY($1)', [users])
    } finally {
      await Promise.all([pool.end(), appPool.end(), workspacePool.end()])
    }
  })

  type Harness = 'claude_code' | 'codex'
  type Entry = { harness: Harness; model: string; source: { kind: 'api_key'; keyId: string } }
  const harnesses = (items: Harness[]) => JSON.stringify(items.map(harness => ({ harness, installed: true, toolApproval: true })))
  const models = (ids: string[]) => (async () => Response.json({ data: ids.map(id => ({ id })) })) as typeof fetch
  const addKey = (ownerId: string, provider: 'anthropic' | 'openai' | 'deepseek', listed: string[]) =>
    keys.addApiKey(pool, ownerId, { provider, apiKey: `sk-${randomBytes(16).toString('hex')}` }, { env: process.env, fetch: models(listed) })
  const entry = (harness: Harness, model: string, keyId: string): Entry => ({ harness, model, source: { kind: 'api_key', keyId } })
  const person = async (label: string) => {
    const id = await seedUser(pool, label)
    users.push(id)
    const ws = await seedWorkspace(pool, id, [{ userId: id, role: 'admin' }])
    await pool.query('INSERT INTO workspace_subscription_shares ("ownerId","workspaceId") VALUES ($1,$2)', [id, ws.id])
    const botId = await seedBot(pool, ws.id, id)
    const remote = `https://github.com/mikka-ci/provider-fallback-${randomUUID()}.git`
    await recordPushGrant(pool, id, normalizeRepository(remote).key)
    const deviceId = randomUUID()
    await pool.query(`INSERT INTO devices (id,"ownerId",name,kind,enabled,"protocolVersion","lastSeenAt",harnesses)
      VALUES ($1,$2,'Laptop','local',true,$3,now(),$4)`, [deviceId, id, DAEMON_PROTOCOL_VERSION, harnesses(['claude_code', 'codex'])])
    const agents: Record<Harness, string> = { claude_code: randomUUID(), codex: randomUUID() }
    for (const [harness, agentId] of Object.entries(agents))
      await pool.query('INSERT INTO agents (id,"userId","deviceId",harness,name) VALUES ($1,$2,$3,$4,$5)', [agentId, id, deviceId, harness, `${harness}-${agentId.slice(0, 8)}`])
    const token = `synthetic-${randomUUID()}`
    await pool.query('INSERT INTO device_tokens (id,"userId","tokenHash") VALUES ($1,$2,$3)', [randomUUID(), id, hashDeviceToken(token)])
    return { id, workspaceId: ws.id, botId, remote, deviceId, agents, token }
  }
  type Person = Awaited<ReturnType<typeof person>>
  const scope = (p: Person) => ({ ownerId: p.id, workspaceId: p.workspaceId, botId: p.botId })
  /** Use the same add/remove/reorder operations as Settings; no SQL snapshot edits. */
  const preferences = async (p: Person, entries: (Entry | { harness: Harness; model: string; source: { kind: 'subscription'; connectionId: string } })[]) => {
    await order.changeOrder(pool, scope(p), { kind: 'location', location: 'local' })
    await order.changeOrder(pool, scope(p), { kind: 'add', entries })
    const wanted = new Set(entries.map(entryKey))
    for (const existing of (await order.readOrder(pool, scope(p))).entries)
      if (!wanted.has(entryKey(existing))) await order.changeOrder(pool, scope(p), { kind: 'remove', id: existing.id })
    const stored = (await order.readOrder(pool, scope(p))).entries
    await order.changeOrder(pool, scope(p), { kind: 'reorder', ids: entries.map(item => stored.find(candidate => entryKey(candidate) === entryKey(item))!.id) })
  }
  const task = async (person: Person) => {
    const issueId = await seedIssue(pool, person.id, person.workspaceId)
    await pool.query('UPDATE issues SET content=$2 WHERE id=$1', [issueId, JSON.stringify({ type: 'doc', attrs: { mikka: { number: Math.floor(Math.random() * 1e6) + 1 } } })])
    return issueId
  }
  const running = async (p: Person, harness: Harness = 'claude_code', options: { asked?: string; pinned?: boolean } = {}) => {
    // Omitting `asked` is what makes a normal chooser preference-driven. The
    // required model argument to queueRun alone would mean an explicit pick.
    const selected = await chooseLocalRunModel(pool, scope(p), { id: p.agents[harness], deviceId: p.deviceId, harness }, options.asked)
    assert.ok(!('error' in selected), JSON.stringify(selected))
    const { runId } = await queueRun(p.id, {
      issueId: await task(p), agentId: p.agents[harness], repo: p.remote, ...selected,
      ...(options.pinned ? { pinnedDeviceId: p.deviceId } : {}),
    }, p.botId)
    // Device lifecycle fields are the only run fields seeded after admission.
    await pool.query(`UPDATE agent_runs SET status='running',"sessionId"=$2,"worktreePath"=$3,
      "startedAt"=now(),"leaseExpiresAt"=now()+interval '5 minutes' WHERE id=$1`, [runId, `session-${runId}`, `/tmp/provider-${runId}`])
    return runId
  }
  const routedSelection = async (p: Person, model: string, issueId: string, profileId?: string, harness: Harness = 'claude_code') => {
    const decision: typeof import('../lib/coordinator/decide').invokeDecision = async (_purpose, input) => {
      assert.ok(!('candidates' in JSON.parse(typeof input === 'string' ? input : input.text)), 'the judge never sees candidates')
      const answers = new Map<string, Exclude<DecisionAnswer, { type: 'refusal' }>>([
        ['tier', { name: 'tier', type: 'score', score: MODEL_ROUTING_TIERS.indexOf(modelTier(model)), confidence: .99 }],
        ['effort', { name: 'effort', type: 'score', score: 0, confidence: .99 }]])
      return { answers, execution: { executionId: randomUUID(), modelId: 'openai/gpt-6-luna-decisions', providerGenerationId: 'fixture-routing',
        startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), requestDigest: 'a'.repeat(64), imageDigests: [], vision: 'no-image-input' } }
    }
    const { resolveAgentProfileDispatch } = await import('../lib/factory/agent-profile')
    const picked = await resolveAgentProfileDispatch(pool, scope(p), { issueId, stage: 'execute', location: 'local',
      deviceId: p.deviceId, defaultHarness: harness, ...(profileId ? { profileId } : { defaultOnly: true }) }, { modelDecision: decision })
    const target = picked.target
    assert.equal(target.kind, 'device')
    if (target.kind !== 'device') assert.fail('The fixture must select its real local executor')
    assert.equal(target.model, model)
    assert.equal(target.entry.source.kind, 'api_key')
    if (target.entry.source.kind !== 'api_key') assert.fail('The fixture must select its admitted key')
    return { model: target.model,
      apiKeyId: target.entry.source.keyId, agentProfile: picked.agentProfile,
      modelDispatch: { mode: 'preference' as const, location: 'local' as const, entry: target.entry, routing: target.routing } }
  }
  const routedRunning = async (p: Person, model: string) => {
    const issueId = await task(p)
    const selected = await routedSelection(p, model, issueId)
    const { runId } = await queueRun(p.id, { issueId, agentId: p.agents.claude_code, repo: p.remote, ...selected }, p.botId)
    await pool.query(`UPDATE agent_runs SET status='running',"sessionId"=$2,"worktreePath"=$3,
      "startedAt"=now(),"leaseExpiresAt"=now()+interval '5 minutes' WHERE id=$1`, [runId, `session-${runId}`, `/tmp/provider-${runId}`])
    return runId
  }
  const row = async (runId: string) => (await pool.query('SELECT * FROM agent_runs WHERE id=$1', [runId])).rows[0]
  const children = async (runId: string) => (await pool.query('SELECT * FROM agent_runs WHERE "retryOf"=$1', [runId])).rows
  const events = async (runId: string) => (await pool.query('SELECT kind,"dedupeKey",payload FROM coordinator_events WHERE "runId"=$1 ORDER BY "createdAt"', [runId])).rows
  const end = (p: Person, runId: string, failure: ProviderFailure) => persistRunCompletion(p.id, runId, {
    stopReason: 'provider_failure', report: { ...emptyRunReport('The model provider could not serve the request.'), providerFailure: failure },
  })
  const claim = async (p: Person, runId: string) => {
    const response = await claimRoute.POST(new Request(`http://127.0.0.1/v1/devices/${p.deviceId}/runs/${runId}/claim`, {
      method: 'POST', headers: { 'x-mikka-client-version': MIN_DAEMON_VERSION, authorization: `Bearer ${p.token}`,
        [REPO_ORIGIN_HEADER]: '1', [MODEL_CREDENTIAL_HEADER]: '1', [RECOVERY_WORKTREE_HEADER]: '1' },
    }), { params: Promise.resolve({ deviceId: p.deviceId, runId }) })
    const body = await response.text()
    assert.equal(response.status, 200, body)
    return JSON.parse(body)
  }
  const balance: ProviderFailure = { kind: 'balance', retryable: false, status: 402, code: 'payment_required' }
  const twoModels = async (label: string, sameHarness = false) => {
    const p = await person(label)
    const first = await addKey(p.id, 'anthropic', ['fixture-claude-a'])
    // A preset allows one key per owner; a second Anthropic key would replace
    // A. DeepSeek is a distinct credential that also serves Claude Code.
    const second = await addKey(p.id, sameHarness ? 'deepseek' : 'openai', ['fixture-model-b'])
    const entries = [entry('claude_code', 'fixture-claude-a', first.id), entry(sameHarness ? 'claude_code' : 'codex', 'fixture-model-b', second.id)]
    await preferences(p, entries)
    return { p, first, second, entries }
  }

  const automaticFailure = async (label: string, options: { subscription?: boolean; onlyLight?: boolean } = {}) => {
    const [{ AgentProfileStore }, { createFactoryStore }, { createFactoryDispatch, factoryBinding }, { queueFactoryRun },
      { automaticFactoryDispatch }, { createFactoryReconciler }, { factoryCheckGates }, { factoryCheckIndependent },
      { ensureDeviceRepository }] = await Promise.all([
      import('../lib/factory/agent-profile'), import('../lib/factory/store'), import('../lib/factory/dispatch'), import('../lib/agent-runs'),
      import('../lib/factory/automatic-dispatch'), import('../lib/factory/reconcile'), import('../lib/factory/checks'),
      import('../lib/factory/check-independence'), import('../lib/device-repositories'),
    ])
    const p = await person(label), issueId = await task(p), epoch = randomUUID()
    const harness = options.subscription ? 'codex' : 'claude_code'
    const light = options.subscription ? 'gpt-6-luna' : 'claude-haiku-5-5'
    const standard = options.subscription ? 'gpt-6-sol' : 'claude-sonnet-5-5'
    const credential = await addKey(p.id, options.subscription ? 'openai' : 'anthropic',
      options.subscription || options.onlyLight ? [light] : [standard, light])
    if (options.subscription) {
      const { connectionId } = await seedAllowedModel(pool, p.id, { workspaceId: p.workspaceId })
      await pool.query('UPDATE byos_connections SET "modelCatalog"=$2 WHERE id=$1',
        [connectionId, JSON.stringify({ revision: '1', models: [standard] })])
      await pool.query('UPDATE byos_bindings SET "modelId"=$2 WHERE "connectionId"=$1', [connectionId, standard])
      await pool.query('UPDATE devices SET harnesses=$2 WHERE id=$1', [p.deviceId, JSON.stringify([
        { harness: 'codex', installed: true, subscriptionBroker: true, toolApproval: true,
          modelSlots: [{ slot: standard, model: standard, name: standard }] },
      ])])
      await preferences(p, [{ harness, model: standard, source: { kind: 'subscription', connectionId } }, entry(harness, light, credential.id)])
    } else await preferences(p, (options.onlyLight ? [light] : [standard, light]).map(model => entry(harness, model, credential.id)))
    const profiles = new AgentProfileStore(pool)
    const profile = await profiles.create(scope(p), { name: `Frozen ${label} role`, roles: ['implementation'],
      harness, model: { mode: 'inherit' }, effort: 'low', instructions: 'Keep this frozen responsibility through the existing repair path.' })
    const selected = await routedSelection(p, light, issueId, profile.id, harness)
    await pool.query(`INSERT INTO coordinator_events(id,"userId","botId","issueId",kind,"dedupeKey",payload)
      VALUES ($1,$2,$3,$4,'user_message',$5,'{"text":"Retry the existing implementation within its original authority"}')`,
    [epoch, p.id, p.botId, issueId, `cascade:${epoch}`])
    const repo = await ensureDeviceRepository(p.id, p.deviceId, p.remote)
    const factory = createFactoryStore(pool, async (owner, id, tx) =>
      (await tx.query('SELECT 1 FROM issues WHERE id=$1 AND "userId"=$2', [id, owner])).rowCount === 1, p.botId,
    { independent: factoryCheckIndependent, gates: factoryCheckGates })
    const routed = await factory.route(p.id, { issueId, sourceEventId: epoch, eventId: randomUUID(), rationale: 'Automatic repair transaction boundary fixture' })
    const dispatch = createFactoryDispatch(pool, factory, (tx, owner, input, bot, context) =>
      queueFactoryRun(tx, owner, input, bot, context, undefined, { ...selected, readOnly: true }))
    const first = await dispatch(p.id, { binding: factoryBinding(routed.task), agentId: p.agents[harness], deviceRepoId: repo.id })
    await pool.query(`UPDATE agent_runs SET status='failed',"stopReason"='agent_error',"startedAt"=now()-interval '1 second',
      "finishedAt"=now(),"sessionId"=$2,report=$3 WHERE id=$1`,
    [first.runId, `automatic-source-${first.runId}`, JSON.stringify(emptyRunReport('Synthetic terminal implementation failure'))])
    const original = await row(first.runId), automatic = automaticFactoryDispatch(pool)
    const bindings = async () => (await pool.query(`SELECT id,"consumerId","connectionId","connectionRevision","modelId","createdAt"
      FROM byos_bindings WHERE "ownerId"=$1 ORDER BY id`, [p.id])).rows
    const currentRun = async (query: Pick<import('pg').PoolClient, 'query'> = pool) => {
      const { rows: [run] } = await query.query(`SELECT r.* FROM factory_tasks t JOIN factory_attempts a ON a.id=t."attemptId"
        JOIN agent_runs r ON r.id=a."runId" WHERE t.id=$1`, [routed.task.id])
      return run
    }
    return { p, profile, profiles, factory, first, original, automatic, createFactoryReconciler, bindings, currentRun, light, standard }
  }

  for (const enabled of [true, false]) await t.test(`routed light failure ${enabled ? 'raises one tier before the failed list position' : 'respects a disabled routing switch'}`, async () => {
    const p = await person(`provider-routing-${enabled}`)
    const stronger = await addKey(p.id, 'anthropic', ['claude-opus-5-5', 'claude-sonnet-5-5'])
    const light = await addKey(p.id, 'deepseek', ['claude-haiku-5-5'])
    await preferences(p, [entry('claude_code', 'claude-opus-5-5', stronger.id),
      entry('claude_code', 'claude-sonnet-5-5', stronger.id), entry('claude_code', 'claude-haiku-5-5', light.id)])
    const runId = await routedRunning(p, 'claude-haiku-5-5')
    const admitted = await row(runId)
    assert.equal(admitted.agentDefinition.modelDispatch.routing.tier, 'light')
    if (!enabled) await order.changeOrder(pool, scope(p), { kind: 'autoRouting', enabled: false })
    await end(p, runId, balance)
    const original = await row(runId), continuations = await children(runId)
    if (!enabled) {
      assert.equal(continuations.length, 0)
      assert.equal(original.report.modelFallback.state, 'blocked')
      return
    }
    assert.equal(continuations.length, 1)
    const continuation = continuations[0]
    assert.equal(continuation.agentDefinition.model, 'claude-sonnet-5-5')
    assert.deepEqual(continuation.agentDefinition.modelDispatch.routing, { version: 2, required: 'light',
      model: 'claude-sonnet-5-5', harness: 'claude_code', tier: 'standard', effort: 'low', reason: 'escalated', previousModel: 'claude-haiku-5-5' })
    assert.deepEqual(continuation.agentDefinition.agentProfile,
      { ...admitted.agentDefinition.agentProfile, targetEntry: continuation.agentDefinition.modelDispatch.entry })
    assert.equal(providerContinuationMatches(original, continuation), true, 'the frozen definition and host receipt must agree')
    assert.equal(original.report.modelFallback.nextDefinitionDigest, continuation.agentDefinition.definitionDigest)
    assert.equal(original.report.modelFallback.attempted.length, 2, 'only the light source and selected standard entry have been tried')
    const assignment = await claim(p, continuation.id)
    assert.equal(assignment.effort, 'low')
    assert.equal(assignment.resumeSessionId, undefined, 'a changed Profile target starts a fresh native session')
    await recoverProviderFailure(pool, p.id, runId)
    assert.equal((await children(runId)).length, 1, 'completion replay cannot spend another tier or add a child')
  })

  for (const failure of ['execute', 'review'] as const) await t.test(`automatic ${failure} repair raises the inherited Profile one tier through real Factory admission`, async () => {
    const [{ AgentProfileStore }, { createFactoryStore }, { createFactoryDispatch, factoryBinding }, { queueFactoryRun },
      { automaticFactoryDispatch }, { createFactoryReconciler }, { factoryCheckGates }, { factoryCheckIndependent },
      { admitProfileSelection }, { profileNativeSessionMatches }, { ensureDeviceRepository }, { workerDefinitionDigest }] = await Promise.all([
      import('../lib/factory/agent-profile'), import('../lib/factory/store'), import('../lib/factory/dispatch'), import('../lib/agent-runs'),
      import('../lib/factory/automatic-dispatch'), import('../lib/factory/reconcile'), import('../lib/factory/checks'), import('../lib/factory/check-independence'),
      import('../lib/factory/profile-admission'), import('../lib/factory/profile-native-session'), import('../lib/device-repositories'), import('../lib/agent-kit/worker-digest'),
    ])
    const p = await person(`automatic-routing-${failure}`), issueId = await task(p), epoch = randomUUID()
    const credential = await addKey(p.id, 'anthropic', ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'])
    await preferences(p, ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'].map(model => entry('claude_code', model, credential.id)))
    const profile = await new AgentProfileStore(pool).create(scope(p), { name: `Frozen ${failure} role`, roles: ['implementation'],
      harness: 'claude_code', model: { mode: 'inherit' }, effort: 'low', instructions: 'Preserve this exact implementation responsibility.' })
    const selected = await routedSelection(p, 'claude-haiku-5-5', issueId, profile.id)
    await pool.query(`INSERT INTO coordinator_events(id,"userId","botId","issueId",kind,"dedupeKey",payload)
      VALUES ($1,$2,$3,$4,'user_message',$5,'{"text":"Fix the acceptance fixture and retain its standing constraints"}')`, [epoch, p.id, p.botId, issueId, `cascade:${epoch}`])
    const repo = await ensureDeviceRepository(p.id, p.deviceId, p.remote)
    const factory = createFactoryStore(pool, async (owner, id, tx) =>
      (await tx.query('SELECT 1 FROM issues WHERE id=$1 AND "userId"=$2', [id, owner])).rowCount === 1, p.botId,
    { independent: factoryCheckIndependent, gates: factoryCheckGates })
    const routed = await factory.route(p.id, { issueId, sourceEventId: epoch, eventId: randomUUID(), rationale: 'Real automatic routing cascade fixture' })
    const dispatch = createFactoryDispatch(pool, factory, (tx, owner, input, bot, context) =>
      queueFactoryRun(tx, owner, input, bot, context, undefined, { ...selected, readOnly: true }))
    const first = await dispatch(p.id, { binding: factoryBinding(routed.task), agentId: p.agents.claude_code, deviceRepoId: repo.id })
    const sha = 'a'.repeat(40), sessionId = `automatic-source-${first.runId}`
    await pool.query(`UPDATE agent_runs SET status=$2,"stopReason"=$3,"startedAt"=now()-interval '1 second',"finishedAt"=now(),
      "sessionId"=$4,report=$5 WHERE id=$1`, [first.runId, failure === 'execute' ? 'failed' : 'succeeded', failure === 'execute' ? 'agent_error' : 'submitted', sessionId,
      JSON.stringify(failure === 'execute' ? emptyRunReport('Synthetic terminal implementation failure') : { ...emptyRunReport('Synthetic candidate'), sourceCommit: sha, publish: { commit: sha }, verify: { status: 'passed' } })])
    const original = await row(first.runId)
    const automatic = automaticFactoryDispatch(pool)
    if (failure === 'execute') {
      const reconciler = createFactoryReconciler(pool, factory, undefined, {}, p.botId, async (tx, store, prior, run) => {
        const pending = await store.lockTask(tx, p.id, prior.id)
        const target = await resolveModelDispatch(pool, scope(p), null, 'local', p.deviceId, { harness: 'claude_code',
          routing: { issueId, stage: 'execute', previous: original.agentDefinition.modelDispatch.routing, escalate: true, effort: 'low' } })
        assert.equal(target.kind, 'device')
        if (target.kind !== 'device' || target.entry.source.kind !== 'api_key') assert.fail('The authorized standard target must be runnable')
        const admission = { ownerId: p.id, workspaceId: p.workspaceId, issueId, sourceRunId: first.runId,
          harness: 'claude_code', model: target.model, apiKeyId: target.entry.source.keyId,
          selection: { ...selected.agentProfile!, targetEntry: target.entry } }
        await assert.rejects(admitProfileSelection(tx, admission), { message: 'agentProfileUnavailable' }, 'copied role without a Factory context grants no new target')
        await assert.rejects(admitProfileSelection(tx, { ...admission, factoryContext: { attemptId: randomUUID(), sourceEventId: epoch } }),
          { message: 'agentProfileUnavailable' }, 'another attempt cannot authorize this repair')
        await assert.rejects(admitProfileSelection(tx, { ...admission, factoryContext: { attemptId: pending.attemptId, sourceEventId: randomUUID() } }),
          { message: 'agentProfileUnavailable' }, 'another request epoch cannot authorize this repair')
        assert.equal(await admitProfileSelection(tx, { ...admission, factoryContext: { attemptId: pending.attemptId, sourceEventId: epoch } }), undefined,
          'the current host repair admits a fresh session without an origin grant')
        return automatic(tx, store, prior, run)
      })
      await reconciler.run(p.id, first.runId)
    } else {
      await addFactoryVisualEvidence(pool, first.runId)
      let state = await factory.apply(p.id, first.binding, randomUUID(), { action: 'candidate', runId: first.runId,
        candidate: { sha, repository: p.remote, environment: `device:${p.deviceId}`, scope: `issue:${issueId}` } })
      state = await factory.apply(p.id, factoryBinding(state.task), randomUUID(), { action: 'finish', status: 'passed', reason: 'Synthetic completed implementation',
        evidence: [{ artifact: `run-report:${first.runId}`, kind: 'report', runId: first.runId, sessionId, candidateId: state.task.candidateId,
          sha, environment: `device:${p.deviceId}`, recordedAt: new Date().toISOString() }], output: {} })
      state = await factory.apply(p.id, factoryBinding(state.task), randomUUID(), { action: 'advance', stage: 'review', reason: 'Independent review' })
      const checkModel = await chooseLocalRunModel(pool, scope(p), { id: p.agents.claude_code, deviceId: p.deviceId, harness: 'claude_code' })
      assert.ok(!('error' in checkModel))
      const checkDispatch = createFactoryDispatch(pool, factory, (tx, owner, input, bot, context) =>
        queueFactoryRun(tx, owner, input, bot, context, undefined, { ...checkModel, readOnly: true }))
      const check = await checkDispatch(p.id, { binding: factoryBinding(state.task), agentId: p.agents.claude_code, deviceRepoId: repo.id })
      const reviewSession = `review-changes-${check.runId}`
      await pool.query(`UPDATE agent_runs SET status='succeeded',"stopReason"='submitted',"startedAt"=now()-interval '1 second',"finishedAt"=now(),"sessionId"=$2,report=$3 WHERE id=$1`,
        [check.runId, reviewSession, JSON.stringify({ ...emptyRunReport('Changes requested'), check: { sha, readOnly: true },
          filesChanged: [], criteria: [{ text: 'Acceptance fixture needs a correction', passed: false, evidence: 'Synthetic independent check observation' }] })])
      const { reconcileFactoryCheck } = await import('../lib/factory/reconcile-check')
      const reconciler = createFactoryReconciler(pool, factory, undefined,
        { review: reconcileFactoryCheck, verify: reconcileFactoryCheck }, p.botId, automatic)
      await reconciler.run(p.id, check.runId)
    }
    const current = (await pool.query('SELECT * FROM factory_tasks WHERE id=$1', [routed.task.id])).rows[0]
    assert.equal(current.stage, 'execute'); assert.equal(current.status, 'running', current.reason)
    const attempt = (await pool.query('SELECT * FROM factory_attempts WHERE id=$1', [current.attemptId])).rows[0]
    const repaired = await row(attempt.runId)
    assert.notEqual(repaired.id, first.runId)
    assert.equal(repaired.agentDefinition.model, 'claude-sonnet-5-5')
    assert.deepEqual(repaired.agentDefinition.modelDispatch.routing, { version: 2, required: 'light', model: 'claude-sonnet-5-5',
      harness: 'claude_code', tier: 'standard', effort: 'low', reason: 'escalated', previousModel: 'claude-haiku-5-5' })
    assert.deepEqual(repaired.agentDefinition.agentProfile, { ...original.agentDefinition.agentProfile, targetEntry: repaired.agentDefinition.modelDispatch.entry })
    assert.equal(repaired.agentDefinition.readOnly, true)
    assert.equal(repaired.continuesRunId, first.runId)
    assert.equal(repaired.agentDefinition.profileOriginRunId, undefined)
    assert.equal(repaired.agentDefinition.definitionDigest, workerDefinitionDigest(repaired.agentDefinition))
    assert.equal(profileNativeSessionMatches(original.agentDefinition, repaired.agentDefinition), false)
    const assignment = await claim(p, repaired.id)
    assert.equal(assignment.resumeSessionId, undefined)
    assert.equal(assignment.effort, 'low')
    assert.equal((await pool.query(`SELECT 1 FROM factory_attempts WHERE "taskId"=$1 AND stage='execute'`, [routed.task.id])).rowCount, 2)
  })

  await t.test('automatic escalation rolls its subscription binding back with the real Factory transaction', async () => {
    const setup = await automaticFailure('automatic-binding-rollback', { subscription: true })
    const before = await setup.bindings(), failure = new Error('fixture_after_automatic_queue')
    let queuedRunId: string | undefined
    const reconciler = setup.createFactoryReconciler(pool, setup.factory, undefined, {}, setup.p.botId, async (tx, store, prior, run) => {
      await setup.automatic(tx, store, prior, run)
      const queued = await setup.currentRun(tx)
      queuedRunId = queued.id
      assert.notEqual(queued.id, setup.first.runId)
      assert.equal(queued.agentDefinition.model, setup.standard)
      assert.ok(queued.agentDefinition.subscription?.bindingId)
      assert.equal((await tx.query('SELECT 1 FROM byos_bindings WHERE id=$1', [queued.agentDefinition.subscription.bindingId])).rowCount, 1)
      throw failure
    })
    await assert.rejects(reconciler.run(setup.p.id, setup.first.runId), error => error === failure)
    assert.ok(queuedRunId, 'the failure must occur after the real upgraded run and binding were queued')
    assert.equal((await pool.query('SELECT 1 FROM agent_runs WHERE id=$1', [queuedRunId])).rowCount, 0)
    assert.deepEqual(await setup.bindings(), before, 'no new binding or latest-binding timestamp may escape the outer rollback')
    assert.equal((await setup.currentRun()).id, setup.first.runId, 'Factory binding and run rollback together')
  })

  await t.test('disabled automatic routing does not publish an unused subscription binding', async () => {
    const setup = await automaticFailure('automatic-binding-off', { subscription: true })
    await order.changeOrder(pool, scope(setup.p), { kind: 'autoRouting', enabled: false })
    const before = await setup.bindings()
    const reconciler = setup.createFactoryReconciler(pool, setup.factory, undefined, {}, setup.p.botId, setup.automatic)
    await reconciler.run(setup.p.id, setup.first.runId)
    const repaired = await setup.currentRun()
    assert.notEqual(repaired.id, setup.first.runId)
    assert.equal(repaired.agentDefinition.model, setup.light)
    assert.deepEqual(repaired.agentDefinition.modelDispatch, setup.original.agentDefinition.modelDispatch)
    assert.equal(repaired.agentDefinition.profileOriginRunId, setup.first.runId)
    assert.deepEqual(await setup.bindings(), before, 'the ignored normal-order target must never write a binding')
  })

  await t.test('fresh automatic escalation rechecks workspace membership at the real outer commit', async () => {
    const setup = await automaticFailure('automatic-membership-commit')
    let queuedRunId: string | undefined
    const reconciler = setup.createFactoryReconciler(pool, setup.factory, undefined, {}, setup.p.botId, async (tx, store, prior, run) => {
      const start = await setup.automatic(tx, store, prior, run)
      const queued = await setup.currentRun(tx)
      queuedRunId = queued.id
      assert.equal(queued.agentDefinition.model, setup.standard)
      assert.equal(queued.agentDefinition.profileOriginRunId, undefined, 'an upgraded model is fresh admission')
      await workspacePool.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2',
        [setup.p.workspaceId, setup.p.id])
      return start
    })
    try {
      await assert.rejects(reconciler.run(setup.p.id, setup.first.runId), { message: 'agentProfileScopeNotFound' })
    } finally {
      await workspacePool.query('UPDATE mikka_workspace_members SET status=\'active\' WHERE "workspaceId"=$1 AND "userId"=$2',
        [setup.p.workspaceId, setup.p.id])
    }
    assert.ok(queuedRunId, 'membership is revoked after queue admission, before its owner commits')
    assert.equal((await pool.query('SELECT 1 FROM agent_runs WHERE id=$1', [queuedRunId])).rowCount, 0)
    assert.equal((await setup.currentRun()).id, setup.first.runId, 'the fresh attempt cannot outlive its revoked authority')
  })

  await t.test('same-target automatic repair preserves a started native session after its Profile is archived', async () => {
    const setup = await automaticFailure('automatic-native-frozen-role', { onlyLight: true })
    await setup.profiles.archive(scope(setup.p), setup.profile.id, setup.profile.version)
    const reconciler = setup.createFactoryReconciler(pool, setup.factory, undefined, {}, setup.p.botId, setup.automatic)
    await reconciler.run(setup.p.id, setup.first.runId)
    const repaired = await setup.currentRun()
    assert.notEqual(repaired.id, setup.first.runId)
    assert.equal(repaired.agentDefinition.model, setup.light)
    assert.equal(repaired.agentDefinition.modelDispatch.routing.reason, 'list_order')
    assert.deepEqual(repaired.agentDefinition.agentProfile, setup.original.agentDefinition.agentProfile)
    assert.equal(repaired.agentDefinition.profileOriginRunId, setup.first.runId, 'only the DB-validated exact native origin exempts the old role')
    assert.equal(repaired.continuesRunId, setup.first.runId)
    const { profileNativeSessionMatches } = await import('../lib/factory/profile-native-session')
    assert.equal(profileNativeSessionMatches(setup.original.agentDefinition, repaired.agentDefinition), true)
    const assignment = await claim(setup.p, repaired.id)
    assert.equal(assignment.effort, 'low', 'first claim still admits the frozen native role')
  })

  await t.test('an untouched default order persists its source and subscription continuation with the same entry identities', async () => {
    const p = await person('provider-default-order')
    await addKey(p.id, 'anthropic', ['fixture-opus'])
    const { connectionId } = await seedAllowedModel(pool, p.id, { workspaceId: p.workspaceId })
    await pool.query('UPDATE devices SET harnesses=$2 WHERE id=$1', [p.deviceId, JSON.stringify([
      { harness: 'claude_code', installed: true, toolApproval: true }, ...codexWithModel,
    ])])
    // A location change leaves the real default preference list untouched.
    await order.changeOrder(pool, scope(p), { kind: 'location', location: 'local' })
    const preferred = await order.readOrder(pool, scope(p))
    assert.equal(preferred.customized, false)
    assert.deepEqual(preferred.entries.map(item => [item.harness, item.model]), [['claude_code', 'fixture-opus'], ['codex', ALLOWED_MODEL]])
    assert.deepEqual(preferred.entries[1].source, { kind: 'subscription', connectionId })
    assert.ok(preferred.entries.every(item => item.id.startsWith('default:') && !item.id.includes('\u0000')))

    const runId = await running(p)
    assert.deepEqual((await row(runId)).agentDefinition.modelDispatch.entry, preferred.entries[0])
    await end(p, runId, balance)
    const original = await row(runId)
    const [continuation, ...extra] = await children(runId)
    assert.ok(continuation, 'the default subscription must be admitted after the first provider fails')
    assert.equal(extra.length, 0)
    assert.equal(original.report.modelFallback.state, 'switched')
    assert.deepEqual(continuation.agentDefinition.modelDispatch.entry, preferred.entries[1])
    assert.equal(continuation.agentDefinition.subscription.modelId, ALLOWED_MODEL)
    assert.equal(continuation.agentDefinition.apiKey, undefined)
    assert.equal(providerContinuationMatches(original, continuation), true)
    await recoverProviderFailure(pool, p.id, runId)
    assert.equal((await children(runId)).length, 1)
    assert.deepEqual(await order.readOrder(pool, scope(p)), preferred, 'freezing and replay neither encode an id twice nor customize the list')
  })

  await t.test('402 switches A to B, keeps the worktree across harnesses, and replay creates exactly one child', async () => {
    const { p, first, second } = await twoModels('provider-balance')
    const runId = await running(p)
    const admitted = await row(runId)
    assert.equal(admitted.agentDefinition.modelDispatch.mode, 'preference')
    assert.equal(admitted.agentDefinition.modelDispatch.entry.source.keyId, first.id)
    await end(p, runId, balance)
    const original = await row(runId)
    const [continuation, ...extra] = await children(runId)
    assert.ok(continuation, 'the ordinary preference admission must produce a continuation')
    assert.equal(extra.length, 0)
    assert.equal(original.status, 'failed')
    assert.equal(original.stopReason, 'provider_failure')
    assert.deepEqual(original.report.providerFailure, balance)
    assert.equal(original.report.modelFallback.state, 'switched')
    assert.equal(original.report.modelFallback.retryRunId, continuation.id)
    assert.equal(continuation.status, 'queued')
    for (const field of ['userId', 'botId', 'issueId', 'deviceId', 'deviceRepoId', 'attempt', 'kind', 'baseBranch'])
      assert.equal(continuation[field], original[field], field)
    assert.equal(continuation.agentDefinition.harness, 'codex')
    assert.deepEqual(continuation.agentDefinition.apiKey, { keyId: second.id, model: 'fixture-model-b' })
    assert.equal(continuation.agentDefinition.modelDispatch.mode, 'preference')
    assert.equal(continuation.agentDefinition.modelDispatch.location, 'local')
    assert.equal(providerContinuationMatches(original, continuation), true)
    for (const field of ['requester', 'botId', 'botOwner', 'executionPrincipal', 'workspaceId', 'outputOwner', 'personalResourcePolicy'])
      assert.deepEqual(continuation.agentDefinition.executionIdentity[field], original.agentDefinition.executionIdentity[field], field)
    assert.equal(continuation.agentDefinition.executionIdentity.billingAccount.runtime.kind, 'local_device')
    assert.equal(continuation.agentDefinition.executionIdentity.billingAccount.runtime.resourceId, p.deviceId)

    await Promise.all([end(p, runId, balance), end(p, runId, balance), recoverProviderFailure(pool, p.id, runId)])
    assert.equal((await children(runId)).length, 1)
    assert.deepEqual((await row(runId)).report.modelFallback, original.report.modelFallback, 'a replay cannot replace the committed receipt')
    const switches = (await events(runId)).filter(event => event.dedupeKey === `model_fallback:${runId}`)
    assert.equal(switches.length, 1)
    assert.equal(switches[0].payload.retryRunId, continuation.id)

    const assignment = await claim(p, continuation.id)
    assert.equal(assignment.harness, 'codex')
    assert.equal(assignment.continuesRunId, runId)
    assert.equal(assignment.requireWorktreeContinuation, true)
    assert.equal(assignment.resumeSessionId, undefined, 'a Claude session cannot be resumed by Codex')
    assert.equal(assignment.followUp, providerContinuationNote())
    assert.equal(assignment.modelCredential.protocol, 'openai')
    assert.equal(assignment.subscriptionBinding, undefined)
  })

  await t.test('the 优先使用的 Agent\'s list runs first, so a failure there still falls back to the other Agent\'s list', async () => {
    // Decision 2026-11-05-0400: stored [codexA, codexB, claudeX], 优先使用的 Agent Claude Code. claudeX runs first;
    // when it fails, codexA comes next. Taking the stored order would count codexA/B as already tried.
    const p = await person('provider-agent-order')
    const codexKey = await addKey(p.id, 'openai', ['fixture-codex-a', 'fixture-codex-b'])
    const claudeKey = await addKey(p.id, 'anthropic', ['fixture-claude-x'])
    await preferences(p, [entry('codex', 'fixture-codex-a', codexKey.id), entry('codex', 'fixture-codex-b', codexKey.id), entry('claude_code', 'fixture-claude-x', claudeKey.id)])
    await order.changeOrder(pool, scope(p), { kind: 'preferred', harness: 'claude_code' })
    const runId = await running(p)
    assert.equal((await row(runId)).agentDefinition.modelDispatch.entry.model, 'fixture-claude-x')
    await end(p, runId, balance)
    const [continuation, ...extra] = await children(runId)
    assert.ok(continuation, 'the Codex list is the fallback after the preferred list is exhausted')
    assert.equal(extra.length, 0)
    assert.equal(continuation.agentDefinition.harness, 'codex')
    assert.equal(continuation.agentDefinition.modelDispatch.entry.model, 'fixture-codex-a')
  })

  for (const status of [404, 429, 502]) await t.test(`terminal HTTP ${status} advances after native short retries, and the same harness resumes its session`, async () => {
    const { p, second } = await twoModels(`provider-transient-${status}`, true)
    const runId = await running(p)
    const failure: ProviderFailure = status === 404 ? { kind: 'model', retryable: false, status, code: 'model_not_found' }
      : { kind: 'unavailable', retryable: true, status, code: status === 429 ? 'rate_limit' : 'server_error' }
    await end(p, runId, failure)
    const original = await row(runId)
    const [continuation, ...extra] = await children(runId)
    assert.ok(continuation)
    assert.equal(extra.length, 0)
    assert.deepEqual(original.report.providerFailure, failure)
    if (status === 404) assert.equal((await order.orderView(pool, scope(p))).entries.find(entry => entry.model === original.agentDefinition.model)?.block, null, 'model refusal never marks the catalogue entry yellow')
    assert.equal(original.report.modelFallback.fallback, 'unavailable')
    assert.equal(continuation.agentDefinition.apiKey.keyId, second.id)
    assert.equal(continuation.attempt, original.attempt, 'provider retries do not spend the code repair budget')
    const assignment = await claim(p, continuation.id)
    assert.equal(assignment.continuesRunId, runId)
    assert.equal(assignment.resumeSessionId, `session-${runId}`)
    assert.equal(assignment.requireWorktreeContinuation, true)
  })

  await t.test('an explicit model pick never switches automatically', async () => {
    const { p, first } = await twoModels('provider-picked')
    const runId = await running(p, 'claude_code', { asked: 'fixture-claude-a' })
    assert.equal((await row(runId)).agentDefinition.modelDispatch.mode, 'picked')
    await end(p, runId, balance)
    const original = await row(runId)
    assert.equal(original.report.modelFallback.state, 'picked')
    assert.equal(original.agentDefinition.apiKey.keyId, first.id)
    assert.equal((await children(runId)).length, 0)
    assert.ok(original.report.modelFallback.card.options.some((option: { action: string }) => option.action === 'modelSettings'))
    assert.deepEqual(original.report.modelFallback.reasons, [{ choice: {
      harness: 'claude_code', model: 'fixture-claude-a', source: 'api_key',
    }, reason: 'balance' }], 'an explicit pick must not invent failure reasons for untried healthy preferences')
    assert.equal(await recoverProviderFailure(pool, p.id, runId), null)
  })

  await t.test('switching harnesses preserves the original worker permission ceiling through claim', async () => {
    const { p } = await twoModels('provider-policy-ceiling')
    await pool.query('UPDATE agents SET cli_run_policy=$2 WHERE id=$1', [p.agents.claude_code,
      { approvalMode: 'read_only', permissions: { git_push: 'deny' }, networkAllow: ['api.example.invalid'] }])
    const runId = await running(p)
    assert.equal((await row(runId)).agentDefinition.readOnly, undefined, 'the constraint originates in worker policy, not a readOnly run argument')
    await end(p, runId, balance)
    const [continuation] = await children(runId)
    assert.ok(continuation)
    assert.equal(continuation.agentDefinition.harness, 'codex')
    assert.equal(continuation.agentDefinition.policyCeiling.readOnly, true)
    // Even a later relaxation of the new worker cannot remove the inherited cap.
    // Open network is network=allow without a domain ceiling; bare '*' is not
    // a valid stored networkAllow domain and would reject the policy itself.
    await pool.query('UPDATE agents SET cli_run_policy=$2 WHERE id=$1', [p.agents.codex,
      { approvalMode: 'ask', permissions: { git_push: 'allow', network: 'allow' } }])
    const assignment = await claim(p, continuation.id)
    assert.equal(assignment.policy.readOnly, true)
    assert.equal(assignment.policy.permissions.git_push, 'deny')
    assert.equal(assignment.policy.permissions.computer_use, 'deny')
    assert.deepEqual(assignment.policy.networkCeiling, ['api.example.invalid'])
  })

  await t.test('when every entry is bad, the blocked card has each model and its specific reason', async () => {
    const { p, entries } = await twoModels('provider-all-bad')
    const third = await addKey(p.id, 'deepseek', ['fixture-model-c'])
    await preferences(p, [...entries, entry('claude_code', 'fixture-model-c', third.id)])
    // Real earlier runs establish current credential health; they are explicit
    // picks so they do not start a separate fallback chain.
    const refused = await running(p, 'codex', { asked: 'fixture-model-b' })
    await end(p, refused, { kind: 'auth', retryable: false, status: 401, code: 'invalid_api_key' })
    const unavailable = await running(p, 'claude_code', { asked: 'fixture-model-c' })
    await end(p, unavailable, { kind: 'unavailable', retryable: true, status: 503, code: 'server_error' })
    const runId = await running(p)
    await end(p, runId, balance)
    assert.equal((await children(runId)).length, 0)
    const receipt = (await row(runId)).report.modelFallback
    assert.equal(receipt.state, 'blocked')
    assert.deepEqual(receipt.reasons.map((item: { choice: { model: string }; reason: string }) => [item.choice.model, item.reason]), [
      ['fixture-claude-a', 'balance'], ['fixture-model-b', 'keyRefused'], ['fixture-model-c', 'providerUnavailable'],
    ])
    for (const model of ['fixture-claude-a', 'fixture-model-b', 'fixture-model-c']) assert.ok(receipt.card.description.includes(model))
    assert.ok(receipt.card.options.some((option: { action: string }) => option.action === 'modelSettings'))
    assert.equal((await events(runId)).filter(event => event.payload.modelFallback?.state === 'blocked').length, 1)
  })

  await t.test('fallback cannot take another owner\'s key or the preferences of another workspace', async () => {
    const { p, entries } = await twoModels('provider-workspace')
    // This owner has a healthy B, but chose it only in a different workspace.
    const ws = await seedWorkspace(pool, p.id, [{ userId: p.id, role: 'admin' }])
    const otherWorkspace = { ...p, workspaceId: ws.id, botId: await seedBot(pool, ws.id, p.id) }
    await preferences(otherWorkspace, [entries[1]])
    await preferences(p, [entries[0]])
    const foreign = await person('provider-other-owner')
    const foreignKey = await addKey(foreign.id, 'openai', ['foreign-model'])
    await preferences(foreign, [entry('codex', 'foreign-model', foreignKey.id)])
    await assert.rejects(order.changeOrder(pool, scope(p), { kind: 'add', entries: [entry('codex', 'foreign-model', foreignKey.id)] }), { code: 'executionModelUnknown' })
    const runId = await running(p)
    await end(p, runId, balance)
    assert.equal(await recoverProviderFailure(pool, foreign.id, runId), null)
    assert.equal((await children(runId)).length, 0)
    const original = await row(runId)
    assert.equal(original.agentDefinition.executionIdentity.workspaceId, p.workspaceId)
    assert.equal(original.report.modelFallback.state, 'blocked')
    assert.deepEqual(original.report.modelFallback.reasons.map((item: { choice: { model: string } }) => item.choice.model), ['fixture-claude-a'])
  })

  await t.test('a pinned device is not replaced by another available device', async () => {
    const { p, second } = await twoModels('provider-pinned')
    await pool.query('UPDATE devices SET harnesses=$2 WHERE id=$1', [p.deviceId, harnesses(['claude_code'])])
    const deviceId = randomUUID(), agentId = randomUUID()
    await pool.query(`INSERT INTO devices (id,"ownerId",name,kind,enabled,"protocolVersion","lastSeenAt",harnesses)
      VALUES ($1,$2,'Other laptop','local',true,$3,now(),$4)`, [deviceId, p.id, DAEMON_PROTOCOL_VERSION, harnesses(['codex'])])
    await pool.query('INSERT INTO agents (id,"userId","deviceId",harness,name) VALUES ($1,$2,$3,\'codex\',\'Other Codex\')', [agentId, p.id, deviceId])
    const runId = await running(p, 'claude_code', { pinned: true })
    await end(p, runId, balance)
    assert.equal((await children(runId)).length, 0)
    const original = await row(runId)
    assert.equal(original.agentDefinition.pinnedDeviceId, p.deviceId)
    assert.equal(original.report.modelFallback.state, 'blocked')
    assert.equal(original.report.modelFallback.reasons.find((item: { choice: { model: string } }) => item.choice.model === 'fixture-model-b')?.reason, 'noDevice')
    const unpinned = await resolveModelDispatch(pool, scope(p), null, 'local')
    assert.equal(unpinned.kind, 'device', 'B really is available when no device was pinned')
    if (unpinned.kind === 'device') {
      assert.equal(unpinned.deviceId, deviceId)
      assert.deepEqual(unpinned.entry.source, { kind: 'api_key', keyId: second.id })
    }
  })

  await t.test('an existing local task retains its location when the Settings default changes to cloud', async () => {
    const { p } = await twoModels('provider-location')
    const runId = await running(p)
    await order.changeOrder(pool, scope(p), { kind: 'location', location: 'cloud' })
    await end(p, runId, balance)
    const [continuation, ...extra] = await children(runId)
    assert.ok(continuation)
    assert.equal(extra.length, 0)
    assert.equal((await order.readOrder(pool, scope(p))).location, 'cloud')
    assert.equal(continuation.deviceId, p.deviceId)
    assert.equal(continuation.agentDefinition.modelDispatch.location, 'local')
    assert.equal(continuation.agentDefinition.executionIdentity.billingAccount.runtime.kind, 'local_device')
  })

  await t.test('an ordinary code/tool HTTP error does not enter provider fallback', async () => {
    const { p } = await twoModels('provider-ordinary-error')
    const runId = await running(p)
    await persistRunCompletion(p.id, runId, { stopReason: 'error', report: emptyRunReport('The app test received HTTP 502; fixture text also says API Error: 402.') })
    const original = await row(runId)
    assert.equal(original.stopReason, 'error')
    assert.equal(original.report.providerFailure, undefined)
    assert.equal(original.report.modelFallback, undefined)
    assert.equal((await children(runId)).length, 0)
  })

  for (const stopReason of ['error', 'cancelled'] as const) await t.test(`${stopReason} strips residual provider metadata without poisoning the next dispatch`, async () => {
    const { p } = await twoModels(`provider-residual-${stopReason}`)
    const runId = await running(p)
    await persistRunCompletion(p.id, runId, { stopReason, report: { ...emptyRunReport(), providerFailure: balance, providerCheckpoint: 'unavailable' } })
    const original = await row(runId)
    assert.equal(original.report.providerFailure, undefined)
    assert.equal(original.report.providerCheckpoint, undefined)
    assert.equal(original.report.modelFallback, undefined)
    assert.equal((await children(runId)).length, 0)
    const selected = await resolveModelDispatch(pool, scope(p), null, 'local')
    assert.ok(selected.kind === 'device' && selected.model === 'fixture-claude-a')
  })

  await t.test('a cancellation racing the provider completion wins and never starts a replacement', async () => {
    const { p } = await twoModels('provider-cancelled-completion')
    const runId = await running(p)
    await pool.query('UPDATE agent_runs SET "stopRequestedAt"=now() WHERE id=$1', [runId])
    await end(p, runId, balance)
    const original = await row(runId)
    assert.equal(original.stopReason, 'cancelled')
    assert.equal(original.report.providerFailure, undefined)
    assert.equal(original.report.modelFallback, undefined)
    assert.equal((await children(runId)).length, 0)
  })

  await t.test('a completed issue settles the failed handoff without a false model setup card', async () => {
    const { p } = await twoModels('provider-completed-issue')
    const runId = await running(p)
    const original = await row(runId)
    await pool.query("UPDATE issues SET status='done' WHERE id=$1", [original.issueId])
    await end(p, runId, balance)
    assert.equal((await row(runId)).report.modelFallback.state, 'stopped')
    assert.equal((await children(runId)).length, 0)
    assert.equal((await events(runId)).filter(event => event.payload.noModel).length, 0)
  })

  await t.test('a failed final checkpoint can continue on the original worktree but cannot migrate to another device', async () => {
    const { p } = await twoModels('provider-checkpoint-local')
    const runId = await running(p)
    await persistRunCompletion(p.id, runId, { stopReason: 'provider_failure', report: {
      ...emptyRunReport(), providerFailure: balance, providerCheckpoint: 'unavailable',
    } })
    const [continuation] = await children(runId)
    assert.ok(continuation)
    assert.equal(continuation.deviceId, p.deviceId)
    const assignment = await claim(p, continuation.id)
    assert.equal(assignment.continuesRunId, runId)
    assert.equal(assignment.requireWorktreeContinuation, true)
    assert.equal(assignment.checkpoint, undefined, 'a stale checkpoint is never substituted for the failed final upload')

    const { p: second } = await twoModels('provider-checkpoint-remote')
    await pool.query('UPDATE devices SET harnesses=$2 WHERE id=$1', [second.deviceId, harnesses(['claude_code'])])
    const deviceId = randomUUID(), agentId = randomUUID()
    await pool.query(`INSERT INTO devices (id,"ownerId",name,kind,enabled,"protocolVersion","lastSeenAt",harnesses)
      VALUES ($1,$2,'Other laptop','local',true,$3,now(),$4)`, [deviceId, second.id, DAEMON_PROTOCOL_VERSION, harnesses(['codex'])])
    await pool.query(`INSERT INTO agents (id,"userId","deviceId",harness,name) VALUES ($1,$2,$3,'codex','Checkpoint Codex')`, [agentId, second.id, deviceId])
    const otherRun = await running(second)
    await persistRunCompletion(second.id, otherRun, { stopReason: 'provider_failure', report: {
      ...emptyRunReport(), providerFailure: balance, providerCheckpoint: 'unavailable',
    } })
    assert.equal((await children(otherRun)).length, 0)
    assert.equal((await row(otherRun)).report.modelFallback.state, 'blocked')
  })
  await t.test('committed provider recovery wakes its existing thread; rollback and replay stay silent', async liveTest => {
    const { observePoolCommits } = await import('../lib/db/commit-effects')
    const { liveChannelId } = await import('../lib/live/scope')
    const { pendingProviderFallback } = await import('../lib/run-provider-fallback')
    observePoolCommits(pool)
    const previous = { url: process.env.DEVICE_GATEWAY_URL, secret: process.env.DEVICE_GATEWAY_PUSH_SECRET }
    process.env.DEVICE_GATEWAY_URL = 'https://provider-live.example.invalid'
    process.env.DEVICE_GATEWAY_PUSH_SECRET = 'synthetic-live-fixture'
    const scheduled: (() => Promise<void>)[] = [], sent: { path: string; events: { kind: string; id: string }[] }[] = []
    captureAfter = scheduled
    liveTest.mock.method(globalThis, 'fetch', async (input: string | URL | Request, options?: RequestInit) => {
      const target = new URL(String(input))
      assert.equal(target.hostname, 'provider-live.example.invalid', 'only the isolated live gateway is allowed')
      assert.match(target.pathname, /^\/v1\/live\/[^/]+\/push$/)
      // The same commit also refreshes owner lists, the bot chat and the issue's
      // thread list (lib/live/lists, chats and issue-threads DB tests cover those
      // keys); this case checks the existing thread's panel key.
      const events = (JSON.parse(String(options?.body)) as { kind: string; id: string }[]).filter(event => !event.kind.endsWith('_list') && !['bot_chat', 'issue_threads'].includes(event.kind))
      if (events.length) sent.push({ path: target.pathname, events })
      return new Response(null, { status: 204 })
    })
    const drain = async () => { await coordinator.flush(); await Promise.all(scheduled.splice(0).map(work => work())) }
    // A normal admission remains intact. This lifecycle-only fixture is the
    // durable crash boundary: completion committed pending, then the host died
    // before recoverProviderFailure. No provider call or worker success is faked.
    const interrupted = async (label: string, kind: 'preference' | 'picked' = 'preference') => {
      const setup = await twoModels(label)
      const home = await seedPersonalWorkspace(pool, setup.p.id)
      const runId = await running(setup.p, 'claude_code', kind === 'picked' ? { asked: 'fixture-claude-a' } : {})
      const source = await row(runId)
      await pool.query(`UPDATE agent_runs SET status='failed',"stopReason"='provider_failure',"finishedAt"=now(),report=$2 WHERE id=$1`,
        [runId, JSON.stringify({ ...emptyRunReport(), providerFailure: balance, modelFallback: pendingProviderFallback(source, balance) })])
      await drain(); sent.length = 0
      const { runLiveTargets } = await import('../lib/live/panels')
      assert.deepEqual(await runLiveTargets(appPool, workspacePool, runId, 'run'), [{
        scope: { ownerId: setup.p.id, workspaceId: setup.p.workspaceId }, events: [{ kind: 'run', id: runId }],
      }], 'the run keeps the task workspace channel even when its owner also has a personal home')
      assert.notEqual(setup.p.workspaceId, home)
      return { ...setup, runId, homeId: setup.p.workspaceId }
    }
    const assertSent = async (p: Person, homeId: string, runId: string, state: string) => {
      assert.equal((await row(runId)).report.modelFallback.state, state, 'independent connection sees the committed receipt')
      assert.ok(scheduled.length > 0, 'post-COMMIT work is scheduled for the existing thread')
      assert.equal(sent.length, 0, 'delivery waits for the actual Next after callback')
      await drain()
      // The continuation's own writer also wakes its new run, whose key names its parent.
      const delivered = sent.splice(0), path = `/v1/live/${liveChannelId({ ownerId: p.id, workspaceId: homeId })}/push`
      assert.ok(delivered.every(value => value.path === path && value.events.every(event => event.kind === 'run')), 'only the task workspace receives run keys')
      assert.ok(delivered.some(value => value.events.some(event => event.id === runId)), 'the existing thread is woken')
      await recoverProviderFailure(pool, p.id, runId)
      assert.equal(scheduled.length, 0, 'a replay cannot notify an unchanged receipt')
    }
    try {
      const setup = await interrupted('provider-live-switch')
      const functionName = `live_rollback_${randomUUID().replaceAll('-', '')}`
      // Force a real PG error after the receipt write and notification
      // registration, before COMMIT. Its queued effect must roll back too.
      await pool.query(`CREATE FUNCTION "${functionName}"() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW."runId"='${setup.runId}'::uuid THEN RAISE EXCEPTION 'fixture_provider_event_rollback'; END IF; RETURN NEW; END $$`)
      await pool.query(`CREATE TRIGGER "${functionName}" BEFORE INSERT ON coordinator_events FOR EACH ROW EXECUTE FUNCTION "${functionName}"()`)
      try {
        await assert.rejects(recoverProviderFailure(pool, setup.p.id, setup.runId), error => error instanceof Error && error.cause instanceof Error
          && error.cause.message === 'fixture_provider_event_rollback' && (error.cause as Error & { code?: string }).code === 'P0001')
        assert.equal((await row(setup.runId)).report.modelFallback.state, 'pending')
        assert.equal((await children(setup.runId)).length, 0)
        assert.equal(scheduled.length, 0, 'the failed recovery transaction emits no live event')
      } finally {
        await pool.query(`DROP TRIGGER "${functionName}" ON coordinator_events`)
        await pool.query(`DROP FUNCTION "${functionName}"()`)
      }
      const continued = await recoverProviderFailure(pool, setup.p.id, setup.runId)
      assert.ok(continued)
      await assertSent(setup.p, setup.homeId, setup.runId, 'switched')
      for (const state of ['picked', 'blocked', 'stopped'] as const) {
        const current = await interrupted(`provider-live-${state}`, state === 'picked' ? 'picked' : 'preference')
        if (state === 'blocked') await preferences(current.p, [current.entries[0]])
        if (state === 'stopped') await pool.query(`UPDATE issues SET status='done' WHERE id=$1`, [(await row(current.runId)).issueId])
        assert.equal(await recoverProviderFailure(pool, current.p.id, current.runId), null)
        assert.equal((await children(current.runId)).length, 0)
        await assertSent(current.p, current.homeId, current.runId, state)
      }
    } finally {
      captureAfter = undefined
      if (previous.url === undefined) delete process.env.DEVICE_GATEWAY_URL; else process.env.DEVICE_GATEWAY_URL = previous.url
      if (previous.secret === undefined) delete process.env.DEVICE_GATEWAY_PUSH_SECRET; else process.env.DEVICE_GATEWAY_PUSH_SECRET = previous.secret
    }
  })

})
