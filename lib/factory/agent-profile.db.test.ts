import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { Pool } from 'pg'
import { dbUrl, seedUser, seedWorkspace, seedIssue, seedBot } from '../../tests/support/workspace-admin-db'
import type { OrderEntry, OrderHarness } from '@/lib/model-order-plan'
import { normalizeRepository } from '@mikka/protocol/repository'
import type { DecisionAnswer } from '@/lib/coordinator/decision'
process.env.MIKKA_BYOS_VALIDATED_MODEL_ROUTES = 'claude_cpa,codex_cpa'
process.env.MIKKA_BYOS_ENABLED = '1'

test('Agent Profiles: real PostgreSQL isolation, immutable versions, exact-source dispatch and Decision admission', { skip: !dbUrl, timeout: 120_000 }, async t => {
  const pool = new Pool({ connectionString: dbUrl, max: 8 })
  const [{ pool: appPool }, { workspacePool }, profiles, { resolveModelDispatch }] = await Promise.all([
    import('@/lib/db'), import('@/lib/workspace-db'), import('./agent-profile'), import('@/lib/model-dispatch'),
  ])
  const migration = await readFile(new URL('../../drizzle/20261104231000_agent_profiles.sql', import.meta.url), 'utf8')
  await pool.query(migration); await pool.query(migration)
  const owners: string[] = [], workspaces: string[] = []
  t.after(async () => {
    await pool.query('DELETE FROM factory_tasks WHERE "userId"=ANY($1)', [owners])
    await pool.query('DELETE FROM byos_native_runs WHERE "runId" IN (SELECT id FROM agent_runs WHERE "userId"=ANY($1))', [owners])
    await pool.query('DELETE FROM run_publications WHERE "userId"=ANY($1)', [owners])
    await pool.query('DELETE FROM coordinator_events WHERE "userId"=ANY($1)', [owners])
    await pool.query('DELETE FROM factory_agent_profiles WHERE "ownerId"=ANY($1)', [owners])
    await pool.query('DELETE FROM model_order_entries WHERE "ownerId"=ANY($1)', [owners])
    await pool.query('DELETE FROM model_order_settings WHERE "ownerId"=ANY($1)', [owners])
    await pool.query('DELETE FROM byos_bindings WHERE "ownerId"=ANY($1)', [owners])
    await pool.query('DELETE FROM byos_connections WHERE "ownerId"=ANY($1)', [owners])
    await pool.query('DELETE FROM agent_runs WHERE "userId"=ANY($1)', [owners])
    await pool.query('DELETE FROM model_api_keys WHERE "ownerId"=ANY($1)', [owners])
    await pool.query('DELETE FROM device_repos WHERE "userId"=ANY($1)', [owners])
    await pool.query('DELETE FROM bots WHERE "ownerId"=ANY($1)', [owners])
    await pool.query('DELETE FROM agents WHERE "userId"=ANY($1)', [owners])
    await pool.query('DELETE FROM devices WHERE "ownerId"=ANY($1)', [owners])
    await pool.query('DELETE FROM issues WHERE "userId"=ANY($1)', [owners])
    await pool.query('DELETE FROM mikka_workspace_members WHERE "workspaceId"=ANY($1::uuid[])', [workspaces])
    await pool.query('DELETE FROM mikka_workspaces WHERE id=ANY($1::uuid[])', [workspaces])
    await pool.query('DELETE FROM "user" WHERE id=ANY($1)', [owners])
    await Promise.all([pool.end(), appPool.end(), workspacePool.end()])
  })
  const person = async (label: string) => {
    const ownerId = await seedUser(pool, label); owners.push(ownerId)
    const workspace = await seedWorkspace(pool, ownerId, [{ userId: ownerId, role: 'admin' }]); workspaces.push(workspace.id)
    await pool.query('INSERT INTO model_order_settings ("ownerId","workspaceId",location) VALUES ($1,$2,\'local\')', [ownerId, workspace.id])
    return { ownerId, workspaceId: workspace.id, botId: null }
  }
  const scope = await person('profiles-owner'), foreign = await person('profiles-foreign')
  const store = new profiles.AgentProfileStore(pool)
  const issueId = await seedIssue(pool, scope.ownerId)
  const quota = (provider: 'claude' | 'codex', used = .1) => ({ vendor: provider === 'claude' ? 'claude_code' : 'codex', source: 'official', status: 'ok', plan: null, observedAt: new Date().toISOString(), windows: [{ kind: 'five_hour', used, resetsAt: new Date(Date.now() + 3_600_000).toISOString() }] })
  const subscribe = async (who: typeof scope, provider: 'claude' | 'codex', models: string[]) => {
    const id = randomUUID()
    await pool.query(`INSERT INTO byos_connections (id,"ownerId","workspaceId",provider,state,epoch,"secretName","secretDigest","providerSubject","modelCatalog",quota) VALUES ($1,$2,$3,$4,'connected',1,$5,$6,'synthetic-subject',$7,$8)`, [id, who.ownerId, who.workspaceId, provider, `synthetic-profile-${id}`, 'a'.repeat(64), JSON.stringify({ revision: '1', models }), JSON.stringify(quota(provider))])
    for (const model of models) await pool.query('INSERT INTO byos_bindings (id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision",route,"modelId") VALUES ($1,$2,$3,\'catalogue\',$4,1,$5,$6)', [randomUUID(), who.ownerId, who.workspaceId, id, provider === 'claude' ? 'claude_cpa' : 'codex_cpa', model])
    return id
  }
  const claude = await subscribe(scope, 'claude', ['claude-haiku-5-5'])
  const exactClaude = await subscribe(scope, 'claude', ['claude-haiku-5-5'])
  const codex = await subscribe(scope, 'codex', ['gpt-6-luna'])
  const foreignSource = await subscribe(foreign, 'codex', ['gpt-6-luna'])
  const deviceId = randomUUID(), agents = { claude_code: randomUUID(), codex: randomUUID() }
  await pool.query('INSERT INTO devices (id,"ownerId",name,kind,enabled,"lastSeenAt",harnesses) VALUES ($1,$2,\'Profile fixture\',\'local\',true,now(),$3)', [deviceId, scope.ownerId, JSON.stringify([
    { harness: 'claude_code', installed: true, models: ['claude-haiku-5-5'], subscriptionBroker: true }, { harness: 'codex', installed: true, models: ['gpt-6-luna'], subscriptionBroker: true },
  ])])
  for (const harness of ['claude_code', 'codex'] as const) await pool.query('INSERT INTO agents (id,"userId","deviceId",name,harness) VALUES ($1,$2,$3,$4,$4)', [agents[harness], scope.ownerId, deviceId, harness])
  const definition = (name: string, harness: OrderHarness, sourceId: string, model: string) => ({ name, harness, description: `${name} public capability`, roles: [name], model: { mode: 'fixed', harness, model, source: { kind: 'subscription', connectionId: sourceId } }, instructions: 'PRIVATE_PROFILE_INSTRUCTIONS_DO_NOT_SEND_TO_DECISION', skills: ['systematic-debugging'], effort: 'low' })

  await t.test('zero configuration preserves the existing model resolver', async () => {
    const actual = await profiles.resolveAgentProfileDispatch(pool, scope, { issueId, location: 'local' })
    const expected = await resolveModelDispatch(pool, scope, undefined, 'local')
    assert.deepEqual(actual.target, expected)
    assert.equal(actual.agentProfile?.profileId, 'default'); assert.equal(actual.agentProfile?.source, 'default')
    assert.equal(actual.agentProfile?.version, 1); assert.equal(actual.agentProfile?.instructions, '')
    assert.deepEqual(actual.agentProfile?.skills, []); assert.deepEqual(actual.agentProfile?.definition.roles, [])
    await profiles.assertProfileSelection(pool, scope, actual.agentProfile!)
    for (const forged of [{ ...actual.agentProfile!, version: 2 }, { ...actual.agentProfile!, source: 'explicit' as const }, { ...actual.agentProfile!, instructions: 'Injected builtin instruction' }, { ...actual.agentProfile!, definition: { ...actual.agentProfile!.definition, roles: ['administrator'] } }]) await assert.rejects(profiles.assertProfileSelection(pool, scope, forged), { code: 'agentProfileSelectionInvalid' })
    await assert.rejects(profiles.assertProfileSelection(pool, foreign, actual.agentProfile!), { code: 'agentProfileScopeNotFound' })
    const connection = actual.agentProfile!.targetEntry.source
    assert.equal(connection.kind, 'subscription')
    if (connection.kind === 'subscription') {
      await pool.query('UPDATE byos_connections SET paused=true WHERE id=$1', [connection.connectionId])
      await assert.rejects(profiles.assertProfileSelection(pool, scope, actual.agentProfile!), { code: 'agentProfileModelUnavailable' })
      await pool.query('UPDATE byos_connections SET paused=false WHERE id=$1', [connection.connectionId])
    }
    assert.equal((await pool.query('SELECT 1 FROM factory_agent_profiles WHERE "ownerId"=$1 AND "workspaceId"=$2', [scope.ownerId, scope.workspaceId])).rowCount, 0)
    const { admitProfileSelection } = await import('./profile-admission')
    if (actual.target.kind !== 'device') assert.fail('local default must select the fixture device')
    const sourceRunId = randomUUID()
    const snapshot = { harness: actual.target.entry.harness, model: actual.target.model, agentProfile: actual.agentProfile!, subscription: { bindingId: actual.target.subscriptionBindingId! }, executionIdentity: { workspaceId: scope.workspaceId } }
    await pool.query(`INSERT INTO agent_runs (id,"userId","agentId","deviceId","issueId",status,prompt,"startedAt","sessionId","agentDefinition") VALUES ($1,$2,$3,$4,$5,'succeeded','fixture',now(),'default-native-session',$6)`, [sourceRunId, scope.ownerId, actual.target.agentId, deviceId, issueId, JSON.stringify(snapshot)])
    const input = { ownerId: scope.ownerId, workspaceId: scope.workspaceId, issueId, sourceRunId, harness: snapshot.harness, model: snapshot.model, selection: actual.agentProfile!, subscriptionBindingId: actual.target.subscriptionBindingId! }
    assert.equal(await admitProfileSelection(pool, input), sourceRunId)
    await assert.rejects(admitProfileSelection(pool, { ...input, model: 'changed-default-model' }), { message: 'agentProfileUnavailable' })
    const forged = { ...actual.agentProfile!, instructions: 'A default receipt cannot grant instructions.' }
    await pool.query('UPDATE agent_runs SET "agentDefinition"=$2 WHERE id=$1', [sourceRunId, JSON.stringify({ ...snapshot, agentProfile: forged })])
    await assert.rejects(admitProfileSelection(pool, { ...input, selection: forged }), { message: 'agentProfileUnavailable' })

  })

  await t.test('default Profile preserves preferred sources after a remembered provider failure', async t => {
    const savedKey = process.env.WORKSPACE_SECRETS_KEY
    process.env.WORKSPACE_SECRETS_KEY = randomBytes(32).toString('hex')
    t.after(() => {
      if (savedKey === undefined) delete process.env.WORKSPACE_SECRETS_KEY
      else process.env.WORKSPACE_SECRETS_KEY = savedKey
    })
    const order = await import('@/lib/model-order')
    const keys = await import('@/lib/model-api-keys')
    const { entryKey } = await import('@/lib/model-order-plan')
    const who = await person('profiles-default-provider-memory')
    const taskId = await seedIssue(pool, who.ownerId)
    const claudeSource = await subscribe(who, 'claude', ['claude-haiku-5-5'])
    const codexSource = await subscribe(who, 'codex', ['gpt-6-luna'])
    const key = await keys.addApiKey(pool, who.ownerId, { provider: 'deepseek', apiKey: `fixture-${randomUUID()}` }, {
      fetch: (async () => Response.json({ data: [{ id: 'deepseek-flash' }] })) as typeof fetch,
      resolve: async () => ['93.184.216.34'],
    })
    const device = randomUUID(), runtimeAgents = { claude_code: randomUUID(), codex: randomUUID() }
    await pool.query('INSERT INTO devices (id,"ownerId",name,kind,enabled,"lastSeenAt",harnesses) VALUES ($1,$2,\'Default Profile fixture\',\'local\',true,now(),$3)', [device, who.ownerId, JSON.stringify([
      { harness: 'claude_code', installed: true, models: ['deepseek-flash', 'claude-haiku-5-5'], subscriptionBroker: true },
      { harness: 'codex', installed: true, models: ['gpt-6-luna'], subscriptionBroker: true },
    ])])
    for (const harness of ['claude_code', 'codex'] as const) await pool.query('INSERT INTO agents (id,"userId","deviceId",name,harness) VALUES ($1,$2,$3,$4,$4)', [runtimeAgents[harness], who.ownerId, device, harness])
    const wanted: Omit<OrderEntry, 'id'>[] = [
      { harness: 'claude_code', model: 'deepseek-flash', source: { kind: 'api_key', keyId: key.id } },
      // The preferred Codex Agent is healthy, but cannot replace a named Claude Code Agent.
      { harness: 'codex', model: 'gpt-6-luna', source: { kind: 'subscription', connectionId: codexSource } },
      { harness: 'claude_code', model: 'claude-haiku-5-5', source: { kind: 'subscription', connectionId: claudeSource } },
    ]
    await order.changeOrder(pool, who, { kind: 'add', entries: wanted })
    for (const entry of (await order.readOrder(pool, who)).entries) {
      if (!wanted.some(item => entryKey(item) === entryKey(entry))) await order.changeOrder(pool, who, { kind: 'remove', id: entry.id })
    }
    const added = (await order.readOrder(pool, who)).entries
    await order.changeOrder(pool, who, { kind: 'reorder', ids: wanted.map(item => added.find(entry => entryKey(entry) === entryKey(item))!.id) })
    // Each Agent keeps its rows; only the no-harness control follows the preferred Codex list first.
    await order.changeOrder(pool, who, { kind: 'preferred', harness: 'codex' })
    const preferred = (await order.readOrder(pool, who)).entries
    const request = { issueId: taskId, asked: { harness: 'claude_code' as const }, location: 'local' as const }
    assert.equal((await pool.query('SELECT 1 FROM factory_agent_profiles WHERE "ownerId"=$1 AND "workspaceId"=$2', [who.ownerId, who.workspaceId])).rowCount, 0)
    const initial = await profiles.resolveAgentProfileDispatch(pool, who, request)
    if (initial.target.kind !== 'device') assert.fail(JSON.stringify(initial.target))
    assert.deepEqual(initial.target.entry, preferred[0], 'before the provider failure the actual default entry is first')

    // The health fixture records the same structured terminal history used by
    // model-provider-health.db.test.ts. No resolver, credential state or quota is stubbed.
    // The key predates this completed run; no credential refresh follows its 402.
    await pool.query('UPDATE model_api_keys SET "updatedAt"=now()-interval \'1 hour\' WHERE id=$1', [key.id])
    const priorRunId = randomUUID()
    await pool.query(`INSERT INTO agent_runs (id,"userId","agentId","deviceId","issueId",status,"stopReason",prompt,"agentDefinition",report,"startedAt","finishedAt","createdAt","updatedAt")
      VALUES ($1,$2,$3,$4,$5,'failed','provider_failure','Completed fixture provider attempt',$6,$7,now()-interval '1 second',now(),now()-interval '1 second',now())`,
    [priorRunId, who.ownerId, runtimeAgents.claude_code, device, taskId, JSON.stringify({
      harness: 'claude_code', model: 'deepseek-flash', apiKey: { keyId: key.id, model: 'deepseek-flash' },
      executionIdentity: { workspaceId: who.workspaceId },
    }), JSON.stringify({ providerFailure: { kind: 'balance', retryable: false, status: 402, code: 'payment_required' } })])
    const candidates = await order.orderCandidates(pool, who)
    const states = await order.credentialStates(pool, who, preferred, candidates, undefined, { probe: false })
    assert.deepEqual(states.get(preferred[0].id)?.credential, { usable: false, reason: 'balance' })
    assert.equal(states.get(preferred[1].id)?.credential.usable, true)
    assert.equal(states.get(preferred[2].id)?.credential.usable, true)

    for (const defaultOnly of [false, true]) await t.test(defaultOnly
      ? 'default-only dispatch keeps the same harness and skips its failed first preference'
      : 'new default dispatch keeps the same harness and skips its failed first preference', async () => {
      const selected = await profiles.resolveAgentProfileDispatch(pool, who, { ...request, defaultOnly })
      if (selected.target.kind !== 'device') assert.fail(`Expected the healthy preferred source, got ${JSON.stringify(selected.target)}`)
      assert.equal(selected.target.agentId, runtimeAgents.claude_code)
      assert.equal(selected.target.deviceId, device)
      assert.deepEqual(selected.target.entry, preferred[2])
      assert.equal(selected.selectionMode, 'preference')
      assert.equal(selected.agentProfile?.source, 'default')
      assert.equal(selected.agentProfile?.profileId, 'default')
      assert.deepEqual(selected.agentProfile?.targetEntry, preferred[2])
      assert.ok(selected.agentProfile)
      await profiles.assertProfileSelection(pool, who, selected.agentProfile)
    })

    await t.test('default availability follows the healthy preferred source without writing bindings', async () => {
      const before = await pool.query('SELECT * FROM byos_bindings WHERE "ownerId"=$1 ORDER BY id', [who.ownerId])
      assert.deepEqual(await profiles.agentProfileDispatchAvailability(pool, who, request), { available: true })
      assert.deepEqual((await pool.query('SELECT * FROM byos_bindings WHERE "ownerId"=$1 ORDER BY id', [who.ownerId])).rows, before.rows)
    })

    await t.test('an explicitly named failed model stays unavailable instead of selecting Haiku', async () => {
      const picked = { ...request, asked: { harness: 'claude_code' as const, model: 'deepseek-flash' } }
      const selected = await profiles.resolveAgentProfileDispatch(pool, who, picked)
      assert.equal(selected.target.kind, 'none')
      if (selected.target.kind !== 'none') assert.fail('An explicit failed source must not dispatch')
      assert.equal(selected.target.reason, 'pickedUnavailable')
      assert.equal(selected.selectionMode, 'picked')
      assert.equal(selected.agentProfile, undefined)
      assert.deepEqual(await profiles.agentProfileDispatchAvailability(pool, who, picked), { available: false, reason: 'pickedUnavailable' })
    })

    await t.test('without a named harness the default Profile follows its preferred Agent first', async () => {
      const selected = await profiles.resolveAgentProfileDispatch(pool, who, { issueId: taskId, location: 'local' })
      if (selected.target.kind !== 'device') assert.fail(JSON.stringify(selected.target))
      assert.equal(selected.target.agentId, runtimeAgents.codex)
      assert.deepEqual(selected.target.entry, preferred[1])
      assert.equal(selected.selectionMode, 'preference')
      assert.deepEqual((await order.readOrder(pool, who)).entries, preferred, 'selection does not change the stored model rows')
    })

    await t.test('a named harness cannot borrow another Agent when no preferred source in that harness is healthy', async () => {
      await order.changeOrder(pool, who, { kind: 'remove', id: preferred[2].id })
      const selected = await profiles.resolveAgentProfileDispatch(pool, who, request)
      assert.equal(selected.target.kind, 'none')
      assert.equal(selected.selectionMode, 'preference')
      assert.equal(selected.agentProfile, undefined)
      assert.equal((await profiles.agentProfileDispatchAvailability(pool, who, request)).available, false)
    })
  })

  const ui = await store.create(scope, definition('UI', 'claude_code', exactClaude, 'claude-haiku-5-5'), randomUUID())
  const backend = await store.create(scope, definition('Backend', 'codex', codex, 'gpt-6-luna'))
  const review = await store.create(scope, { ...definition('Review', 'codex', codex, 'gpt-6-luna'), roles: ['review'], skills: ['independent-review'] })

  await t.test('default thread recovery never reselects a role when custom profiles were enabled later', async () => {
    const selected = await profiles.resolveAgentProfileDispatch(pool, scope, { issueId, location: 'local', defaultOnly: true }, {
      decision: async () => { throw new Error('An existing default thread must not enter Decision again') },
    })
    assert.equal(selected.agentProfile?.source, 'default')
    assert.equal(selected.agentProfile?.instructions, '')
    await assert.rejects(profiles.resolveAgentProfileDispatch(pool, scope, { issueId, profileId: ui.id, defaultOnly: true }), { code: 'agentProfilePinConflict' })
  })

  await t.test('scope isolation, creation replay and controlled source validation', async () => {
    assert.equal((await store.list(foreign)).length, 0)
    await assert.rejects(store.get(foreign, ui.id), { code: 'agentProfileNotFound' })
    const second = await seedWorkspace(pool, scope.ownerId, [{ userId: scope.ownerId, role: 'admin' }]); workspaces.push(second.id)
    await assert.rejects(store.get({ ...scope, workspaceId: second.id }, ui.id), { code: 'agentProfileNotFound' })
    await assert.rejects(store.create(scope, definition('Foreign', 'codex', foreignSource, 'gpt-6-luna')), { code: 'agentProfileModelUnavailable' })
    const replay = await store.create(scope, definition('UI', 'claude_code', exactClaude, 'claude-haiku-5-5'), ui.id)
    assert.equal(replay.id, ui.id); assert.equal(replay.version, 1)
    await assert.rejects(store.create(scope, { ...definition('UI', 'claude_code', exactClaude, 'claude-haiku-5-5'), name: 'Other name' }, ui.id), { code: 'agentProfileRequestConflict' })
  })

  await t.test('catalogue enumeration writes no binding and selected source remains exact', async () => {
    const before = (await pool.query('SELECT id,"createdAt" FROM byos_bindings WHERE "ownerId"=$1 ORDER BY id', [scope.ownerId])).rows
    const view = await profiles.readAgentProfileManagement(pool, scope)
    assert.equal(view.profiles.length, 3); assert.equal(view.availability[ui.id].available, true)
    assert.deepEqual(await profiles.agentProfileDispatchAvailability(pool, scope, { location: 'local', deviceId }), { available: true })
    assert.equal((await profiles.agentProfileDispatchAvailability(pool, scope, { location: 'local', deviceId: randomUUID() })).available, false)
    const unavailableDestination = await profiles.readAgentProfileManagement(pool, scope, { location: 'local', deviceId: randomUUID() })
    assert.equal(unavailableDestination.availability[ui.id].available, false)
    assert.equal(unavailableDestination.defaultAvailability.available, false)

    assert.deepEqual((await pool.query('SELECT id,"createdAt" FROM byos_bindings WHERE "ownerId"=$1 ORDER BY id', [scope.ownerId])).rows, before)
    assert.ok(!JSON.stringify(view.catalog).includes('synthetic-profile-'))
    const selected = await profiles.resolveAgentProfileDispatch(pool, scope, { issueId, profileId: ui.id, location: 'local' })
    assert.equal(selected.selectionMode, 'picked'); assert.equal(selected.target.kind, 'device')
    if (selected.target.kind !== 'device') assert.fail('device expected')
    assert.equal(selected.target.agentId, agents.claude_code)
    assert.deepEqual(selected.target.entry.source, { kind: 'subscription', connectionId: exactClaude })
    assert.ok(selected.target.subscriptionBindingId)
    const binding = (await pool.query('SELECT "connectionId"::text,"modelId" FROM byos_bindings WHERE id=$1', [selected.target.subscriptionBindingId])).rows[0]
    assert.deepEqual(binding, { connectionId: exactClaude, modelId: 'claude-haiku-5-5' })
    assert.ok(selected.agentProfile!.instructions.includes('Start from the observed failure'))
    assert.equal(selected.agentProfile!.effort, 'low')
    await assert.rejects(profiles.resolveAgentProfileDispatch(pool, scope, { issueId, profileId: ui.id, asked: { harness: 'codex', model: 'gpt-6-luna' } }), { code: 'agentProfilePinConflict' })
  })

  await t.test('Decision sees public capabilities only and selects exact profiles for three task scenarios', async () => {
    for (const [selected, stage, title] of [[ui, 'execute', 'Build an interface'], [backend, 'execute', 'Repair a backend failure'], [review, 'review', 'Review the frozen candidate']] as const) {
      await pool.query('UPDATE issues SET title=$2 WHERE id=$1', [issueId, title])
      const result = await profiles.resolveAgentProfileDispatch(pool, scope, { issueId, stage, location: 'local' }, {
        decision: async (_purpose, input, questions) => {
          const serialized = JSON.stringify(input)
          assert.ok(serialized.includes(title)); assert.ok(serialized.includes(stage))
          for (const forbidden of ['PRIVATE_PROFILE_INSTRUCTIONS', 'connectionId', 'providerSubject', 'synthetic-profile-', 'Start from the observed failure']) assert.ok(!serialized.includes(forbidden), forbidden)
          assert.ok(JSON.stringify(questions).includes(selected.id))
          return { answers: new Map<string, Exclude<DecisionAnswer, { type: 'refusal' }>>([['profile', { name: 'profile', type: 'choice', choice: selected.id, confidence: .95 }], ['reason', { name: 'reason', type: 'choice', choice: 'capability_fit' }]]), execution: { executionId: randomUUID(), modelId: 'openai/gpt-6-luna-decisions', providerGenerationId: 'fixture-decision', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), requestDigest: 'a'.repeat(64), imageDigests: [], vision: 'no-image-input' } }
        },
      })
      assert.equal(result.agentProfile!.profileId, selected.id); assert.equal(result.agentProfile!.source, 'decision')
      assert.equal(result.agentProfile!.decision!.modelId, 'openai/gpt-6-luna-decisions')
    }
    await assert.rejects(profiles.resolveAgentProfileDispatch(pool, scope, { issueId }, { decision: async () => null }), { code: 'agentProfileDecisionUnavailable' })
  })

  await t.test('Decision racing a profile edit cannot bind or dispatch the stale selection', async () => {
    const current = await store.create(scope, definition('Race', 'codex', codex, 'gpt-6-luna'))
    const before = (await pool.query('SELECT id,"createdAt" FROM byos_bindings WHERE "ownerId"=$1 ORDER BY id', [scope.ownerId])).rows
    await assert.rejects(profiles.resolveAgentProfileDispatch(pool, scope, { issueId, location: 'local' }, {
      decision: async () => {
        await store.update(scope, current.id, current.version, { ...definition('Race', 'codex', codex, 'gpt-6-luna'), instructions: 'Edited during Decision' })
        return { answers: new Map<string, Exclude<DecisionAnswer, { type: 'refusal' }>>([['profile', { name: 'profile', type: 'choice', choice: current.id, confidence: .95 }], ['reason', { name: 'reason', type: 'choice', choice: 'stage_fit' }]]), execution: { executionId: randomUUID(), modelId: 'openai/gpt-6-luna-decisions', providerGenerationId: 'fixture-racing-decision', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), requestDigest: 'b'.repeat(64), imageDigests: [], vision: 'no-image-input' } }
      },
    }), { code: 'agentProfileVersionConflict' })
    assert.deepEqual((await pool.query('SELECT id,"createdAt" FROM byos_bindings WHERE "ownerId"=$1 ORDER BY id', [scope.ownerId])).rows, before)
    await store.archive(scope, current.id, 2)
  })

  await t.test('disconnect does not prevent disabling the same fixed source', async () => {
    const current = await store.create(scope, definition('Disable after disconnect', 'claude_code', claude, 'claude-haiku-5-5'))
    await pool.query('UPDATE byos_connections SET paused=true WHERE id=$1', [claude])
    const disabled = await store.update(scope, current.id, current.version, { ...definition('Disable after disconnect', 'claude_code', claude, 'claude-haiku-5-5'), enabled: false })
    assert.equal(disabled.enabled, false)
    await pool.query('UPDATE byos_connections SET paused=false WHERE id=$1', [claude])
    await store.archive(scope, current.id, disabled.version)
  })

  await t.test('inheritance stays inside the chosen harness and preserves preferred model order', async () => {
    const inherited = await store.create(scope, { name: 'Inherited Claude', harness: 'claude_code', model: { mode: 'inherit' } })
    await pool.query('UPDATE model_order_settings SET customized=true WHERE "ownerId"=$1 AND "workspaceId"=$2', [scope.ownerId, scope.workspaceId])
    for (const [index, harness, model, connection] of [[0, 'codex', 'gpt-6-luna', codex], [1, 'claude_code', 'claude-haiku-5-5', claude], [2, 'claude_code', 'claude-haiku-5-5', exactClaude]] as const) await pool.query('INSERT INTO model_order_entries (id,"ownerId","workspaceId",position,harness,model,"sourceKind","sourceId") VALUES ($1,$2,$3,$4,$5,$6,\'subscription\',$7)', [randomUUID(), scope.ownerId, scope.workspaceId, index, harness, model, connection])
    await pool.query('UPDATE byos_connections SET quota=$2 WHERE id=$1', [claude, JSON.stringify(quota('claude', 1))])
    const result = await profiles.resolveAgentProfileDispatch(pool, scope, { issueId, profileId: inherited.id, location: 'local' })
    assert.equal(result.selectionMode, 'preference'); assert.equal(result.agentProfile!.targetEntry.harness, 'claude_code')
    assert.deepEqual(result.agentProfile!.targetEntry.source, { kind: 'subscription', connectionId: exactClaude })
  })

  await t.test('admission binds exact target/source and only a started native continuation retains the frozen profile', async () => {
    const { admitProfileSelection, assertRunProfileClaim } = await import('./profile-admission')
    const resolved = await profiles.resolveAgentProfileDispatch(pool, scope, { issueId, profileId: review.id, location: 'local' })
    assert.equal(resolved.target.kind, 'device')
    if (resolved.target.kind !== 'device') assert.fail('device expected')
    const selection = resolved.agentProfile!, bindingId = resolved.target.subscriptionBindingId!
    const input = { ownerId: scope.ownerId, workspaceId: scope.workspaceId, issueId, harness: 'codex', model: 'gpt-6-luna', selection, subscriptionBindingId: bindingId }
    assert.equal(await admitProfileSelection(pool, input), undefined)
    await assert.rejects(admitProfileSelection(pool, { ...input, harness: 'claude_code' }), { message: 'agentProfileUnavailable' })
    await assert.rejects(admitProfileSelection(pool, { ...input, model: 'wrong-model' }), { message: 'agentProfileUnavailable' })
    await assert.rejects(admitProfileSelection(pool, { ...input, apiKeyId: randomUUID() }), { message: 'agentProfileUnavailable' })
    await assert.rejects(admitProfileSelection(pool, { ...input, subscriptionBindingId: randomUUID() }), { message: 'agentProfileUnavailable' })
    const sourceRunId = randomUUID(), queuedRunId = randomUUID(), continuedRunId = randomUUID()
    const snapshot = { harness: 'codex', model: 'gpt-6-luna', agentProfile: selection, subscription: { bindingId }, executionIdentity: { workspaceId: scope.workspaceId } }
    await pool.query(`INSERT INTO agent_runs (id,"userId","agentId","deviceId","issueId",status,prompt,"startedAt","sessionId","agentDefinition") VALUES ($1,$2,$3,$4,$5,'succeeded','fixture',now(),'native-profile-fixture',$6)`, [sourceRunId, scope.ownerId, agents.codex, deviceId, issueId, JSON.stringify(snapshot)])
    await pool.query(`INSERT INTO agent_runs (id,"userId","agentId","deviceId","issueId",status,prompt,"agentDefinition") VALUES ($1,$2,$3,$4,$5,'queued','fixture',$6),($7,$2,$3,$4,$5,'queued','fixture',$8)`, [queuedRunId, scope.ownerId, agents.codex, deviceId, issueId, JSON.stringify(snapshot), continuedRunId, JSON.stringify({ ...snapshot, profileOriginRunId: sourceRunId })])
    await assertRunProfileClaim(pool, queuedRunId)
    await store.update(scope, review.id, review.version, { ...selection.definition, enabled: false, instructions: 'Changed future instructions.' })
    await assert.rejects(assertRunProfileClaim(pool, queuedRunId), { message: 'agentProfileUnavailable' })
    assert.equal(await admitProfileSelection(pool, { ...input, sourceRunId }), sourceRunId)
    await assertRunProfileClaim(pool, continuedRunId)
    // A manual native retry may retain stop-request history. It has no host
    // watchdog attempt/event and must keep the existing exact-session grant.
    await pool.query(`UPDATE agent_runs SET status='stopped',"stopRequestedAt"=now() WHERE id=$1`, [sourceRunId])
    await pool.query('UPDATE agent_runs SET "retryOf"=$2 WHERE id=$1', [continuedRunId, sourceRunId])
    await assertRunProfileClaim(pool, continuedRunId)
    await pool.query(`UPDATE agent_runs SET status='succeeded',"stopRequestedAt"=NULL WHERE id=$1`, [sourceRunId])
    await assert.rejects(admitProfileSelection(pool, { ...input, sourceRunId: randomUUID() }), { message: 'agentProfileUnavailable' })
    await assert.rejects(admitProfileSelection(pool, { ...input, sourceRunId, ownerId: foreign.ownerId }), { message: 'agentProfileUnavailable' })
    await assert.rejects(admitProfileSelection(pool, { ...input, sourceRunId, issueId: randomUUID() }), { message: 'agentProfileUnavailable' })
    await assert.rejects(admitProfileSelection(pool, { ...input, sourceRunId, selection: { ...selection, instructions: 'Forged continuation' } }), { message: 'agentProfileUnavailable' })
    await pool.query('UPDATE agent_runs SET "startedAt"=NULL WHERE id=$1', [sourceRunId])
    await assert.rejects(admitProfileSelection(pool, { ...input, sourceRunId }), { message: 'agentProfileUnavailable' })
    await pool.query('UPDATE agent_runs SET "startedAt"=now(),"sessionId"=NULL WHERE id=$1', [sourceRunId])
    await assert.rejects(admitProfileSelection(pool, { ...input, sourceRunId }), { message: 'agentProfileUnavailable' })
    await pool.query('UPDATE agent_runs SET "sessionId"=\'native-profile-fixture\',"agentDefinition"=$2 WHERE id=$1', [sourceRunId, JSON.stringify({ ...snapshot, model: 'different-model' })])
    await assert.rejects(admitProfileSelection(pool, { ...input, sourceRunId }), { message: 'agentProfileUnavailable' })
  })

  await t.test('only an unclaimed failed startup can re-admit the same role on a different authorized target', async () => {
    const { admitProfileSelection } = await import('./profile-admission')
    const profile = await store.create(scope, { name: 'Unclaimed startup role', harness: 'auto', model: { mode: 'inherit' }, instructions: 'Preserve the role, not the failed machine.' })
    const first = await profiles.resolveAgentProfileDispatch(pool, scope, { issueId, profileId: profile.id, location: 'local', asked: { harness: 'claude_code' } })
    const next = await profiles.resolveAgentProfileDispatch(pool, scope, { issueId, profileId: profile.id, location: 'local', asked: { harness: 'codex' } })
    if (first.target.kind !== 'device' || next.target.kind !== 'device') assert.fail('both native fixture harnesses are available')
    const sourceRunId = randomUUID()
    const snapshot = { harness: first.target.entry.harness, model: first.target.model, agentProfile: first.agentProfile!, subscription: { bindingId: first.target.subscriptionBindingId! }, executionIdentity: { workspaceId: scope.workspaceId } }
    await pool.query(`INSERT INTO agent_runs (id,"userId","agentId","deviceId","issueId",status,"stopReason",prompt,"agentDefinition") VALUES ($1,$2,$3,$4,$5,'failed','device_lost','fixture',$6)`, [sourceRunId, scope.ownerId, first.target.agentId, deviceId, issueId, JSON.stringify(snapshot)])
    const input = { ownerId: scope.ownerId, workspaceId: scope.workspaceId, issueId, sourceRunId, harness: next.target.entry.harness, model: next.target.model, selection: next.agentProfile!, subscriptionBindingId: next.target.subscriptionBindingId! }
    assert.equal(await admitProfileSelection(pool, input), undefined, 'recovery authorizes a fresh target, never the old native SID')
    for (const fault of ['claimed', 'session', 'owner-stop', 'running', 'other-failure'] as const) {
      await pool.query('UPDATE agent_runs SET "startedAt"=$2,"sessionId"=$3,"stopRequestedAt"=$4,status=$5,"stopReason"=$6 WHERE id=$1', [sourceRunId,
        fault === 'claimed' ? new Date() : null, fault === 'session' ? 'already-started' : null, fault === 'owner-stop' ? new Date() : null,
        fault === 'running' ? 'running' : 'failed', fault === 'other-failure' ? 'error' : 'device_lost'])
      await assert.rejects(admitProfileSelection(pool, input), { message: 'agentProfileUnavailable' }, fault)
    }
    await pool.query(`UPDATE agent_runs SET "startedAt"=NULL,"sessionId"=NULL,"stopRequestedAt"=NULL,status='failed',"stopReason"='device_lost' WHERE id=$1`, [sourceRunId])
    await assert.rejects(admitProfileSelection(pool, { ...input, selection: { ...input.selection, instructions: 'Changed role' } }), { message: 'agentProfileUnavailable' })
    await store.update(scope, profile.id, profile.version, { ...input.selection.definition, enabled: false })
    await assert.rejects(admitProfileSelection(pool, input), { message: 'agentProfileUnavailable' }, 'unstarted recovery still checks current Profile authorization')
  })

  await t.test('profile first admission holds a real row lock against concurrent disable', async () => {
    const frozen = (await profiles.resolveAgentProfileDispatch(pool, scope, { issueId, profileId: backend.id, location: 'local' })).agentProfile!
    const admitted = await pool.connect(), editor = await pool.connect()
    try {
      await admitted.query('BEGIN')
      await profiles.assertProfileSelection(admitted, scope, frozen)
      await editor.query('BEGIN'); await editor.query("SET LOCAL lock_timeout='100ms'")
      await assert.rejects(editor.query('UPDATE factory_agent_profiles SET version=version+1 WHERE id=$1', [backend.id]), { code: '55P03' })
    } finally { await editor.query('ROLLBACK'); editor.release(); await admitted.query('ROLLBACK'); admitted.release() }
  })

  await t.test('optimistic edits serialize; frozen history remains immutable and stale/disabled selection fails admission', async () => {
    const frozen = (await profiles.resolveAgentProfileDispatch(pool, scope, { issueId, profileId: backend.id, location: 'local' })).agentProfile!
    const results = await Promise.allSettled([
      store.update(scope, backend.id, 1, { ...frozen.definition, name: 'Backend v2 A' }),
      store.update(scope, backend.id, 1, { ...frozen.definition, name: 'Backend v2 B' }),
    ])
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
    assert.equal(results.filter(result => result.status === 'rejected' && result.reason.code === 'agentProfileVersionConflict').length, 1)
    const history = await store.history(scope, backend.id)
    assert.equal(history.length, 2); assert.equal(history[1].digest, frozen.digest)
    assert.equal(history[1].definition.name, 'Backend')
    await assert.rejects(profiles.assertProfileSelection(pool, scope, frozen), { code: 'agentProfileVersionConflict' })
    const current = await store.get(scope, backend.id)
    await store.update(scope, backend.id, current.version, { ...frozen.definition, enabled: false })
    await assert.rejects(profiles.resolveAgentProfileDispatch(pool, scope, { issueId, profileId: backend.id }), { code: 'agentProfileDisabled' })
    assert.equal(frozen.definition.enabled, true)
  })

  await t.test('first admission rejects changed source authorization, tampered snapshot and offline device', async () => {
    const frozen = (await profiles.resolveAgentProfileDispatch(pool, scope, { issueId, profileId: ui.id, location: 'local' })).agentProfile!
    await assert.rejects(profiles.assertProfileSelection(pool, foreign, frozen), { code: 'agentProfileScopeNotFound' })
    await assert.rejects(profiles.assertProfileSelection(pool, scope, { ...frozen, instructions: 'Injected privilege' }), { code: 'agentProfileSelectionInvalid' })
    await pool.query('UPDATE byos_connections SET paused=true WHERE id=$1', [exactClaude])
    await assert.rejects(profiles.assertProfileSelection(pool, scope, frozen), { code: 'agentProfileModelUnavailable' })
    await assert.rejects(profiles.resolveAgentProfileDispatch(pool, scope, { issueId, profileId: ui.id }), { code: 'agentProfileUnavailable' })
    await pool.query('UPDATE byos_connections SET paused=false WHERE id=$1', [exactClaude])
    await pool.query('UPDATE devices SET enabled=false WHERE id=$1', [deviceId])
    await assert.rejects(profiles.resolveAgentProfileDispatch(pool, scope, { issueId, profileId: ui.id, location: 'local' }), { code: 'agentProfileUnavailable' })
    await pool.query('UPDATE devices SET enabled=true WHERE id=$1', [deviceId])
    await store.archive(scope, ui.id, 1)
    await assert.rejects(profiles.assertProfileSelection(pool, scope, frozen), { code: 'agentProfileArchived' })
    assert.ok(!(await store.list(scope)).some(row => row.id === ui.id))
    assert.equal((await store.history(scope, ui.id)).at(-1)!.digest, frozen.digest)
  })
  for (const mode of ['fixed', 'inherit', 'legacy'] as const) await t.test(mode === 'legacy' ? 'watchdog preserves historical absence of Profile through queue and first claim on B' : `watchdog ${mode} Profile uses B's real source and retains the started role through queue and first claim`, async () => {
    const [{ createFactoryStore }, { createFactoryDispatch, factoryBinding }, { queueFactoryRun }, { automaticFactoryDispatch },
      { sweepFactoryWatchdog }, { claimLocalRun }, { assertRunProfileClaim, admitProfileSelection }, { profileNativeSessionMatches },
      { DAEMON_PROTOCOL_VERSION }, { workerDefinitionDigest }] = await Promise.all([
      import('./store'), import('./dispatch'), import('../agent-runs'), import('./automatic-dispatch'), import('./watchdog'),
      import('../computer/claim'), import('./profile-admission'), import('./profile-native-session'), import('@mikka/protocol/daemon'), import('../agent-kit/worker-digest'),
    ])
    const who = await person(`watchdog-profile-${mode}`), botId = await seedBot(pool, who.workspaceId, who.ownerId)
    const taskIssue = await seedIssue(pool, who.ownerId), epoch = randomUUID()
    await pool.query('UPDATE issues SET content=$2 WHERE id=$1', [taskIssue, JSON.stringify({ type: 'doc', attrs: { mikka: { number: 1284 } }, content: [] })])
    await pool.query(`INSERT INTO coordinator_events(id,"userId","botId","issueId",kind,"dedupeKey",payload) VALUES ($1,$2,$3,$4,'user_message',$5,'{"text":"Preserve this implementation role on recovery"}')`, [epoch, who.ownerId, botId, taskIssue, `profile-watchdog:${epoch}`])
    const primary = await subscribe(who, 'codex', ['gpt-6-luna']), alternate = await subscribe(who, 'codex', ['gpt-6-luna'])
    await pool.query('UPDATE model_order_settings SET customized=true WHERE "ownerId"=$1 AND "workspaceId"=$2', [who.ownerId, who.workspaceId])
    for (const [position, connection] of [primary, alternate].entries()) await pool.query(`INSERT INTO model_order_entries(id,"ownerId","workspaceId",position,harness,model,"sourceKind","sourceId") VALUES ($1,$2,$3,$4,'codex','gpt-6-luna','subscription',$5)`, [randomUUID(), who.ownerId, who.workspaceId, position, connection])
    const repository = normalizeRepository(`https://github.com/synthetic/profile-watchdog-${randomUUID()}.git`)
    const machines: { id: string; agentId: string; repoId: string }[] = []
    for (const name of ['A', 'B']) {
      const id = randomUUID(), agentId = randomUUID(), repoId = randomUUID()
      await pool.query(`INSERT INTO devices(id,"ownerId",name,kind,enabled,"lastSeenAt",harnesses,"protocolVersion") VALUES ($1,$2,$3,'local',true,now(),$4,$5)`, [id, who.ownerId, name, JSON.stringify([{ harness: 'codex', installed: true, subscriptionBroker: true, models: ['gpt-6-luna'] }]), DAEMON_PROTOCOL_VERSION])
      await pool.query(`INSERT INTO agents(id,"userId","deviceId",name,harness) VALUES ($1,$2,$3,$4,'codex')`, [agentId, who.ownerId, id, name])
      await pool.query(`INSERT INTO device_repos(id,"userId","deviceId","repoPath","remoteUrl","baseBranch") VALUES ($1,$2,$3,$4,$5,'main')`, [repoId, who.ownerId, id, repository.key, repository.remoteUrl])
      machines.push({ id, agentId, repoId })
    }
    const [a, b] = machines
    const profile = mode === 'legacy' ? undefined : await store.create(who, { name: `Frozen ${mode} role`, roles: ['implementation'], harness: 'codex',
      model: mode === 'fixed' ? { mode, harness: 'codex', model: 'gpt-6-luna', source: { kind: 'subscription', connectionId: primary } } : { mode },
      effort: 'high', instructions: 'Keep the original implementation responsibility.', skills: ['systematic-debugging'] })
    const picked = await profiles.resolveAgentProfileDispatch(pool, { ...who, botId }, { issueId: taskIssue, profileId: profile?.id, location: 'local', deviceId: a.id })
    if (picked.target.kind !== 'device') assert.fail('A must be runnable')
    const initialModel = { model: picked.target.model, subscriptionBindingId: picked.target.subscriptionBindingId, ...(profile ? { agentProfile: picked.agentProfile } : {}),
      modelDispatch: { mode: picked.selectionMode!, location: 'local' as const, entry: picked.target.entry } }
    const [{ factoryCheckGates }, { factoryCheckIndependent }] = await Promise.all([import('./checks'), import('./check-independence')])
    const factory = createFactoryStore(pool, async (owner, issue, tx) => (await tx.query('SELECT 1 FROM issues WHERE id=$1 AND "userId"=$2', [issue, owner])).rowCount === 1, botId, { independent: factoryCheckIndependent, gates: factoryCheckGates })
    const routed = await factory.route(who.ownerId, { issueId: taskIssue, sourceEventId: epoch, eventId: randomUUID(), rationale: 'Actual watchdog Profile recovery fixture' })
    const dispatch = createFactoryDispatch(pool, factory, (tx, owner, input, bot, context) => queueFactoryRun(tx, owner, input, bot, context, undefined, initialModel))
    const first = await dispatch(who.ownerId, { binding: factoryBinding(routed.task), agentId: a.agentId, deviceRepoId: a.repoId })
    await pool.query(`UPDATE agent_runs SET status='running',"startedAt"=now()-interval '2 hours',"sessionId"='original-native-session',"leaseExpiresAt"=now()+interval '1 hour' WHERE id=$1`, [first.runId])
    await pool.query(`UPDATE factory_tasks SET "updatedAt"='2000-01-01' WHERE id=$1`, [routed.task.id])
    await pool.query(`UPDATE factory_attempts SET "createdAt"='2000-01-01' WHERE "runId"=$1`, [first.runId])
    const original = (await pool.query('SELECT * FROM agent_runs WHERE id=$1', [first.runId])).rows[0]
    const automatic = automaticFactoryDispatch(pool)
    let rejectInvalidQueue = false
    const recovery = {
      runtime: () => ({ store: factory, reconcile: { run: async () => { throw new Error('No completion reconciliation is needed') } } }),
      dispatch: async (...args: Parameters<typeof automatic>) => {
        if (rejectInvalidQueue) {
          const [tx, , task] = args
          for (const mutation of ['handoff', 'unstarted'] as const) {
            await tx.query('SAVEPOINT invalid_profile_recovery')
            if (mutation === 'handoff') await tx.query(`UPDATE factory_attempts SET output=jsonb_set(output,'{watchdogRecovery,handoffDigest}',$2::jsonb) WHERE id=$1`, [task.attemptId, JSON.stringify('0'.repeat(64))])
            else await tx.query('UPDATE agent_runs SET "startedAt"=NULL WHERE id=$1', [first.runId])
            await assert.rejects(automatic(...args), { message: 'agentProfileUnavailable' }, mutation)
            await tx.query('ROLLBACK TO SAVEPOINT invalid_profile_recovery'); await tx.query('RELEASE SAVEPOINT invalid_profile_recovery')
          }
        }
        return automatic(...args)
      },
      wake: async () => { throw new Error('A host takeover must remain quiet') },
    }
    const stopped = await sweepFactoryWatchdog(pool, recovery, new Date(), Date.now() + 20_000, { userId: who.ownerId, runId: first.runId })
    assert.equal(stopped.blocked, 1); assert.equal(stopped.failed, 0)
    await pool.query(`UPDATE agent_runs SET status='stopped',"stopReason"='cancelled',"finishedAt"=now() WHERE id=$1`, [first.runId])
    if (profile) {
      await store.update(who, profile.id, profile.version, { ...picked.agentProfile!.definition, enabled: false, instructions: 'This later edit applies only to new selections.' })
      await assert.rejects(profiles.resolveAgentProfileDispatch(pool, { ...who, botId }, { issueId: taskIssue, profileId: profile.id, location: 'local' }), { code: 'agentProfileDisabled' })
      await assert.rejects(admitProfileSelection(pool, { ownerId: who.ownerId, workspaceId: who.workspaceId, issueId: taskIssue, harness: 'codex', model: 'gpt-6-luna', selection: picked.agentProfile!, subscriptionBindingId: picked.target.subscriptionBindingId }), { message: 'agentProfileUnavailable' })
    }
    await pool.query('UPDATE model_order_entries SET position=position+10 WHERE "ownerId"=$1', [who.ownerId])
    await pool.query('UPDATE model_order_entries SET position=CASE WHEN "sourceId"=$2 THEN 0 ELSE 1 END WHERE "ownerId"=$1', [who.ownerId, alternate])
    rejectInvalidQueue = Boolean(profile)
    const resumed = await sweepFactoryWatchdog(pool, recovery, new Date(Date.now() + 2 * 60_000), Date.now() + 20_000, { userId: who.ownerId, runId: first.runId })
    assert.equal(resumed.failed, 0); assert.equal(resumed.recovered, 1)
    const task = (await pool.query('SELECT * FROM factory_tasks WHERE id=$1', [routed.task.id])).rows[0]
    const attempt = (await pool.query('SELECT * FROM factory_attempts WHERE id=$1', [task.attemptId])).rows[0]
    const run = (await pool.query('SELECT * FROM agent_runs WHERE id=$1', [attempt.runId])).rows[0]
    assert.equal(run.deviceId, b.id); assert.equal(run.agentId, b.agentId)
    assert.equal(run.retryOf, first.runId); assert.equal(run.continuesRunId, first.runId); assert.equal(run.sessionId, null)
    assert.equal(run.agentDefinition.profileOriginRunId, undefined)
    if (profile) {
      assert.equal(run.agentDefinition.agentProfile.version, 1); assert.equal(run.agentDefinition.agentProfile.effort, 'high')
      assert.deepEqual({ ...run.agentDefinition.agentProfile, targetEntry: undefined }, { ...original.agentDefinition.agentProfile, targetEntry: undefined })
      assert.deepEqual(run.agentDefinition.agentProfile.targetEntry, run.agentDefinition.modelDispatch.entry)
    } else assert.equal(run.agentDefinition.agentProfile, undefined)
    const binding = (await pool.query('SELECT * FROM byos_bindings WHERE id=$1', [run.agentDefinition.subscription.bindingId])).rows[0]
    assert.equal(binding.consumerId, b.agentId); assert.equal(binding.connectionId, mode === 'fixed' ? primary : alternate)
    assert.equal(run.agentDefinition.modelDispatch.entry.source.connectionId, binding.connectionId)
    assert.equal(run.agentDefinition.definitionDigest, workerDefinitionDigest(run.agentDefinition))
    const lease = new Date(Date.now() + 60_000)
    if (!profile) {
      assert.equal(original.agentDefinition.agentProfile, undefined)
      assert.equal(await claimLocalRun(pool, run.id, b.id, lease, binding.id), 'claimed')
      const claimed = (await pool.query('SELECT * FROM agent_runs WHERE id=$1', [run.id])).rows[0]
      assert.equal(claimed.sessionId, null); assert.equal(claimed.agentDefinition.agentProfile, undefined)
      assert.equal(claimed.agentDefinition.profileOriginRunId, undefined)
      return
    }
    assert.equal(profileNativeSessionMatches(original.agentDefinition, run.agentDefinition), false)
    for (const [label, output] of [
      ['missing', { ...attempt.output, watchdogRecovery: undefined }],
      ['wrong source', { ...attempt.output, watchdogRecovery: { ...attempt.output.watchdogRecovery, previousRunId: randomUUID() } }],
      ['stale epoch', { ...attempt.output, watchdogRecovery: { ...attempt.output.watchdogRecovery, requestEpoch: randomUUID() } }],
      ['wrong handoff', { ...attempt.output, watchdogRecovery: { ...attempt.output.watchdogRecovery, handoffDigest: '0'.repeat(64) } }],
    ] as const) {
      await pool.query('UPDATE factory_attempts SET output=$2 WHERE id=$1', [attempt.id, JSON.stringify(output)])
      await assert.rejects(claimLocalRun(pool, run.id, b.id, lease, binding.id), { message: 'agentProfileUnavailable' }, label)
      assert.equal((await pool.query('SELECT status FROM agent_runs WHERE id=$1', [run.id])).rows[0].status, 'queued')
    }
    await pool.query('UPDATE factory_attempts SET output=$2 WHERE id=$1', [attempt.id, JSON.stringify(attempt.output)])
    await pool.query('UPDATE factory_tasks SET "attemptId"=$2 WHERE id=$1', [task.id, original.agentDefinition.factory?.attemptId ?? routed.task.attemptId])
    await assert.rejects(claimLocalRun(pool, run.id, b.id, lease, binding.id), { message: 'agentProfileUnavailable' })
    await pool.query('UPDATE factory_tasks SET "attemptId"=$2 WHERE id=$1', [task.id, attempt.id])
    await pool.query('UPDATE byos_connections SET paused=true WHERE id=$1', [binding.connectionId])
    await assert.rejects(assertRunProfileClaim(pool, run.id), { message: 'agentProfileUnavailable' })
    await pool.query('UPDATE byos_connections SET paused=false WHERE id=$1', [binding.connectionId])
    await pool.query('UPDATE agent_runs SET "startedAt"=NULL WHERE id=$1', [first.runId])
    await assert.rejects(claimLocalRun(pool, run.id, b.id, lease, binding.id), { message: 'agentProfileUnavailable' })
    await pool.query('UPDATE agent_runs SET "startedAt"=$2 WHERE id=$1', [first.runId, original.startedAt])
    assert.equal(await claimLocalRun(pool, run.id, b.id, lease, binding.id), 'claimed')
    const claimed = (await pool.query('SELECT * FROM agent_runs WHERE id=$1', [run.id])).rows[0]
    assert.equal(claimed.status, 'preparing'); assert.equal(claimed.sessionId, null)
    assert.equal(claimed.agentDefinition.profileOriginRunId, undefined)
    assert.deepEqual(claimed.agentDefinition.agentProfile, run.agentDefinition.agentProfile)
  })
  await t.test('suspended workspace members cannot read or change profiles', async () => {
    await pool.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2', [scope.workspaceId, scope.ownerId])
    await assert.rejects(store.list(scope), { code: 'agentProfileScopeNotFound' })
    await assert.rejects(store.create(scope, { name: 'Blocked' }), { code: 'agentProfileScopeNotFound' })
  })
  // Decision 2026-11-05-0400: a Profile (or the Decision API's choice of one) comes first; the per-Agent lists of
  // 优先使用的模型 only order what an inheriting Profile, or a dispatch with no Profile, may run.
  await t.test('per-Agent lists: an inheriting Profile follows 优先使用的 Agent; a fixed-Agent Profile never takes the other list', async () => {
    const who = await person('profiles-per-agent')
    const ownClaude = await subscribe(who, 'claude', ['claude-haiku-5-5']), ownCodex = await subscribe(who, 'codex', ['gpt-6-luna'])
    const machine = randomUUID()
    await pool.query('INSERT INTO devices (id,"ownerId",name,kind,enabled,"lastSeenAt",harnesses) VALUES ($1,$2,\'Per-Agent fixture\',\'local\',true,now(),$3)', [machine, who.ownerId, JSON.stringify([
      { harness: 'claude_code', installed: true, models: ['claude-haiku-5-5'], subscriptionBroker: true }, { harness: 'codex', installed: true, models: ['gpt-6-luna'], subscriptionBroker: true },
    ])])
    for (const harness of ['claude_code', 'codex'] as const) await pool.query('INSERT INTO agents (id,"userId","deviceId",name,harness) VALUES ($1,$2,$3,$4,$4)', [randomUUID(), who.ownerId, machine, harness])
    // The stored list puts Claude Code first; 优先使用的 Agent is Codex.
    await pool.query('UPDATE model_order_settings SET customized=true,"preferredHarness"=\'codex\' WHERE "ownerId"=$1 AND "workspaceId"=$2', [who.ownerId, who.workspaceId])
    for (const [index, harness, model, connection] of [[0, 'claude_code', 'claude-haiku-5-5', ownClaude], [1, 'codex', 'gpt-6-luna', ownCodex]] as const) await pool.query('INSERT INTO model_order_entries (id,"ownerId","workspaceId",position,harness,model,"sourceKind","sourceId") VALUES ($1,$2,$3,$4,$5,$6,\'subscription\',$7)', [randomUUID(), who.ownerId, who.workspaceId, index, harness, model, connection])
    const issue = await seedIssue(pool, who.ownerId)
    const whoStore = new profiles.AgentProfileStore(pool)
    // Inherit + either Agent: Codex's list first, as 优先使用的 Agent says.
    const inherit = await whoStore.create(who, { name: 'Inherits order', harness: 'auto', model: { mode: 'inherit' } })
    const inherited = await profiles.resolveAgentProfileDispatch(pool, who, { issueId: issue, profileId: inherit.id, location: 'local' })
    assert.equal(inherited.agentProfile!.targetEntry.harness, 'codex')
    assert.equal(inherited.agentProfile!.targetEntry.model, 'gpt-6-luna')
    // Its Agent's list empty of runnable models (Codex quota used): the other Agent's list is the fallback.
    await pool.query('UPDATE byos_connections SET quota=$2 WHERE id=$1', [ownCodex, JSON.stringify(quota('codex', 1))])
    const fallback = await profiles.resolveAgentProfileDispatch(pool, who, { issueId: issue, profileId: inherit.id, location: 'local' })
    assert.equal(fallback.agentProfile!.targetEntry.harness, 'claude_code')
    // A fixed-Agent Profile (Codex, inheriting models) never takes Claude Code's list, even with Codex out of quota.
    const codexOnly = await whoStore.create(who, { name: 'Codex only', harness: 'codex', model: { mode: 'inherit' } })
    await assert.rejects(profiles.resolveAgentProfileDispatch(pool, who, { issueId: issue, profileId: codexOnly.id, location: 'local' }))
    await pool.query('UPDATE byos_connections SET quota=$2 WHERE id=$1', [ownCodex, JSON.stringify(quota('codex'))])
    // And a Claude Code Profile runs Claude Code although 优先使用的 Agent is Codex.
    const claudeOnly = await whoStore.create(who, { name: 'Claude only', harness: 'claude_code', model: { mode: 'inherit' } })
    const pinned = await profiles.resolveAgentProfileDispatch(pool, who, { issueId: issue, profileId: claudeOnly.id, location: 'local' })
    assert.equal(pinned.agentProfile!.targetEntry.harness, 'claude_code')
  })
})
