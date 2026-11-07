// Durable provider health uses the same isolated PostgreSQL safety gate as the
// model-order suite. All provider requests below are local function fixtures.
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { test } from 'node:test'
import type { EntrySource, OrderEntry, OrderHarness } from '../lib/model-order-plan'
import { dbUrl, seedAgent, seedBot, seedIssue, seedUser, seedWorkspace } from './support/workspace-admin-db'

test('provider health persists across dispatches without changing credential ownership', { skip: !dbUrl }, async t => {
  const savedKey = process.env.WORKSPACE_SECRETS_KEY
  process.env.WORKSPACE_SECRETS_KEY = randomBytes(32).toString('hex')
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: dbUrl, max: 3 })
  const { pool: appPool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  const order = await import('../lib/model-order')
  const keys = await import('../lib/model-api-keys')
  const { resolveModelDispatch } = await import('../lib/model-dispatch')
  const { entryKey, planDispatch } = await import('../lib/model-order-plan')
  const users: string[] = []
  const workspaces: string[] = []
  const now = Date.now()
  const epoch = now - 3_600_000
  type Person = { ownerId: string; workspaceId: string; botId: string; agentId: string }
  t.after(async () => {
    if (savedKey === undefined) delete process.env.WORKSPACE_SECRETS_KEY
    else process.env.WORKSPACE_SECRETS_KEY = savedKey
    await pool.query('DELETE FROM factory_tasks WHERE "userId"=ANY($1)', [users])
    await pool.query('DELETE FROM agent_runs WHERE "userId"=ANY($1)', [users])
    await pool.query('DELETE FROM issues WHERE "userId"=ANY($1)', [users])
    await pool.query('DELETE FROM model_order_entries WHERE "ownerId"=ANY($1)', [users])
    await pool.query('DELETE FROM model_order_settings WHERE "ownerId"=ANY($1)', [users])
    await pool.query('DELETE FROM model_api_keys WHERE "ownerId"=ANY($1)', [users])
    await pool.query('DELETE FROM byos_bindings WHERE "ownerId"=ANY($1)', [users])
    await pool.query('DELETE FROM byos_connections WHERE "ownerId"=ANY($1)', [users])
    await pool.query('DELETE FROM workspace_subscription_shares WHERE "ownerId"=ANY($1)', [users])
    await pool.query('DELETE FROM agents WHERE "userId"=ANY($1)', [users])
    await pool.query('DELETE FROM devices WHERE "ownerId"=ANY($1)', [users])
    await pool.query('DELETE FROM bots WHERE "ownerId"=ANY($1)', [users])
    await pool.query('DELETE FROM mikka_workspace_members WHERE "workspaceId"=ANY($1)', [workspaces])
    await pool.query('DELETE FROM mikka_workspaces WHERE id=ANY($1)', [workspaces])
    await pool.query('DELETE FROM "user" WHERE id=ANY($1)', [users])
    await Promise.all([pool.end(), appPool.end(), workspacePool.end()])
  })

  const person = async (label: string): Promise<Person> => {
    const ownerId = await seedUser(pool, label)
    users.push(ownerId)
    const workspace = await seedWorkspace(pool, ownerId, [{ userId: ownerId, role: 'admin' }])
    workspaces.push(workspace.id)
    return { ownerId, workspaceId: workspace.id, botId: await seedBot(pool, workspace.id, ownerId), agentId: await seedAgent(pool, ownerId) }
  }
  const fakeProvider = (models: string[]) => (async () => Response.json({ data: models.map(id => ({ id })) })) as typeof fetch
  const key = async (scope: Person, models: string[]) => {
    const saved = await keys.addApiKey(pool, scope.ownerId, {
      provider: 'custom', name: 'Fixture provider', baseUrl: 'https://provider.example.invalid/v1', protocol: 'openai', apiKey: `fixture-${randomUUID()}`,
    }, { fetch: fakeProvider(models), resolve: async () => ['93.184.216.34'] })
    await pool.query('UPDATE model_api_keys SET "updatedAt"=$2 WHERE id=$1', [saved.id, new Date(epoch)])
    return saved
  }
  const run = async (scope: Person, source: Extract<EntrySource, { kind: 'api_key' }> | { kind: 'binding'; bindingId: string }, failure: unknown, at: number, options: { finishedAt?: number; status?: string; stopReason?: string; stopRequestedAt?: number; workspaceId?: string; snapshotWorkspace?: boolean; botId?: string | null; harness?: OrderHarness; model?: string } = {}) => {
    const id = randomUUID()
    const model = options.model ?? 'fixture-model'
    const definition = {
      harness: options.harness ?? (source.kind === 'api_key' ? 'codex' : 'claude_code'),
      ...(source.kind === 'api_key' ? { apiKey: { keyId: source.keyId, model } }
        : { subscription: { bindingId: source.bindingId, modelId: model, route: 'claude_code_cli' } }),
      ...(options.snapshotWorkspace === false ? {} : { executionIdentity: { workspaceId: options.workspaceId ?? scope.workspaceId } }),
    }
    const finishedAt = options.finishedAt ?? at + 1_000
    await pool.query(`INSERT INTO agent_runs (id,"userId","agentId","botId",status,"stopReason","agentDefinition",report,"startedAt","finishedAt","createdAt","updatedAt","stopRequestedAt")
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$9,$10,$11)`,
    [id, scope.ownerId, scope.agentId, options.botId === undefined ? scope.botId : options.botId, options.status ?? (failure ? 'failed' : 'succeeded'), options.stopReason ?? (failure ? 'provider_failure' : 'completed'),
      JSON.stringify(definition), failure ? JSON.stringify({ providerFailure: failure }) : null, new Date(at), new Date(finishedAt), options.stopRequestedAt === undefined ? null : new Date(options.stopRequestedAt)])
    return id
  }
  const read = async (scope: Pick<Person, 'ownerId' | 'workspaceId'>, at = now) => {
    const candidates = await order.orderCandidates(pool, scope)
    const entries = candidates.map((candidate, index) => ({ ...candidate, id: `fixture-entry-${index}` }))
    const states = await order.credentialStates(pool, scope, entries, candidates, at, { probe: false })
    return { entries, candidates, states }
  }

  await t.test('a paid request failure blocks every model on the key and later tasks take the next preference', async () => {
    const scope = await person('provider-balance')
    const empty = await key(scope, ['fixture-first', 'fixture-second'])
    const ready = await key(scope, ['fixture-next'])
    await run(scope, { kind: 'api_key', keyId: empty.id }, { kind: 'balance', retryable: false, status: 402, code: 'insufficient_balance' }, now - 20_000)
    const first = await read(scope)
    for (const entry of first.entries.filter(entry => entry.source.kind === 'api_key' && entry.source.keyId === empty.id)) {
      assert.deepEqual(first.states.get(entry.id)?.credential, { usable: false, reason: 'balance' })
    }
    assert.ok(first.entries.some(entry => entry.source.kind === 'api_key' && entry.source.keyId === ready.id && first.states.get(entry.id)?.credential.usable))
    const deviceId = randomUUID()
    await pool.query(`INSERT INTO devices (id,"ownerId",name,kind,enabled,"lastSeenAt",harnesses) VALUES ($1,$2,'Fixture device','local',true,now(),$3)`,
      [deviceId, scope.ownerId, JSON.stringify([{ harness: 'codex', installed: true }])])
    await pool.query('UPDATE agents SET "deviceId"=$2 WHERE id=$1', [scope.agentId, deviceId])
    const fallback = first.candidates.find(candidate => candidate.source.kind === 'api_key' && candidate.source.keyId === ready.id)!
    await order.changeOrder(pool, scope, { kind: 'add', entries: [fallback] })
    for (let task = 0; task < 2; task++) {
      const dispatch = await resolveModelDispatch(pool, scope, undefined, 'local')
      assert.equal(dispatch.kind, 'device')
      assert.ok(dispatch.kind === 'device' && dispatch.entry.source.kind === 'api_key' && dispatch.entry.source.keyId === ready.id)
    }
    const later = await read(scope, now + 86_400_000)
    assert.equal(later.states.get(later.entries[0].id)?.credential.usable, false, 'balance does not expire like an outage')
    await keys.refreshApiKeyModels(pool, scope.ownerId, empty.id, { fetch: fakeProvider(['fixture-first', 'fixture-second']), resolve: async () => ['93.184.216.34'] })
    const refreshed = await read(scope)
    assert.ok([...refreshed.states.values()].every(state => state.credential.usable), 'an explicit user refresh allows another paid request')
    await run(scope, { kind: 'api_key', keyId: empty.id }, { kind: 'auth', retryable: false, status: 401 }, now - 10_000, { finishedAt: now + 10_000 })
    assert.ok([...(await read(scope)).states.values()].every(state => state.credential.usable), 'a run started before refresh cannot poison the refreshed key by finishing late')
  })

  await t.test('an already selected Agent skips failed preferences without changing Agent, device or an explicit model', async () => {
    const scope = await person('provider-selected-agent')
    const empty = await key(scope, ['fixture-failed'])
    const ready = await key(scope, ['fixture-next'])
    await key(scope, ['fixture-not-preferred'])
    const other = await keys.addApiKey(pool, scope.ownerId, { provider: 'anthropic', apiKey: `fixture-${randomUUID()}` },
      { fetch: fakeProvider(['fixture-other-agent']) })
    const wanted = [
      { harness: 'claude_code', model: 'fixture-other-agent', source: { kind: 'api_key', keyId: other.id } },
      { harness: 'codex', model: 'fixture-failed', source: { kind: 'api_key', keyId: empty.id } },
      { harness: 'codex', model: 'fixture-next', source: { kind: 'api_key', keyId: ready.id } },
    ] satisfies Omit<OrderEntry, 'id'>[]
    await order.changeOrder(pool, scope, { kind: 'add', entries: wanted })
    for (const entry of (await order.readOrder(pool, scope)).entries) {
      if (!wanted.some(item => entryKey(item) === entryKey(entry))) await order.changeOrder(pool, scope, { kind: 'remove', id: entry.id })
    }
    const entries = (await order.readOrder(pool, scope)).entries
    await order.changeOrder(pool, scope, { kind: 'reorder', ids: wanted.map(item => entries.find(entry => entryKey(entry) === entryKey(item))!.id) })
    const deviceId = randomUUID(), alternateDeviceId = randomUUID()
    for (const id of [deviceId, alternateDeviceId]) await pool.query(`INSERT INTO devices (id,"ownerId",name,kind,enabled,"lastSeenAt",harnesses)
      VALUES ($1,$2,'Fixture device','local',true,now(),$3)`, [id, scope.ownerId,
      JSON.stringify([{ harness: 'codex', installed: true }, { harness: 'claude_code', installed: true }])])
    await pool.query('UPDATE agents SET "deviceId"=$2 WHERE id=$1', [scope.agentId, deviceId])
    for (const [id, harness] of [[deviceId, 'claude_code'], [alternateDeviceId, 'codex'], [alternateDeviceId, 'claude_code']]) {
      const agentId = await seedAgent(pool, scope.ownerId, harness)
      await pool.query('UPDATE agents SET "deviceId"=$2 WHERE id=$1', [agentId, id])
    }
    await run(scope, { kind: 'api_key', keyId: empty.id }, { kind: 'balance', retryable: false, status: 402 }, now - 20_000, { model: 'fixture-failed' })
    const { chooseLocalRunModel } = await import('../lib/computer/run-model')
    const agent = { id: scope.agentId, deviceId, harness: 'codex' as const }
    for (let task = 0; task < 2; task++) {
      const chosen = await chooseLocalRunModel(pool, scope, agent)
      assert.ok(!('error' in chosen), JSON.stringify(chosen))
      assert.equal(chosen.model, 'fixture-next')
      assert.equal(chosen.apiKeyId, ready.id)
      assert.equal(chosen.modelDispatch?.mode, 'preference')
      assert.equal(chosen.modelDispatch?.entry?.harness, 'codex')
    }
    const picked = await chooseLocalRunModel(pool, scope, agent, 'fixture-failed')
    assert.deepEqual(picked, { error: 'machineUnavailable', reason: 'pickedUnavailable' }, 'an explicit failed model never chooses the healthy preference')

    await pool.query('UPDATE devices SET enabled=false WHERE id=$1', [deviceId])
    const elsewhere = await resolveModelDispatch(pool, scope, null, 'local')
    assert.ok(elsewhere.kind === 'device' && elsewhere.deviceId === alternateDeviceId, 'another owned device can run the task')
    assert.ok('error' in await chooseLocalRunModel(pool, scope, agent), 'an already selected device stays fixed')
    await pool.query('UPDATE devices SET enabled=true WHERE id=$1', [deviceId])

    await order.changeOrder(pool, scope, { kind: 'remove', id: entries.find(entry => entry.model === 'fixture-next')!.id })
    const unconstrained = await resolveModelDispatch(pool, scope, null, 'local')
    assert.ok(unconstrained.kind === 'device' && unconstrained.entry.harness === 'claude_code', 'a different Agent is still usable')
    assert.deepEqual(await chooseLocalRunModel(pool, scope, agent), { error: 'machineUnavailable', reason: 'unavailable' },
      'no usable Codex preference: do not borrow another Agent or an unlisted model')
  })

  await t.test('outages expire, while an outage cannot clear an unresolved permanent failure', async () => {
    const scope = await person('provider-outage')
    const saved = await key(scope, ['fixture-outage'])
    const source = { kind: 'api_key' as const, keyId: saved.id }
    await run(scope, source, { kind: 'unavailable', retryable: true, status: 503 }, now - 1_000, { finishedAt: now, status: 'finishing', model: 'fixture-outage' })
    const blocked = await read(scope, now + 119_999)
    assert.deepEqual(blocked.states.get(blocked.entries[0].id)?.credential, { usable: false, reason: 'providerUnavailable', resetsAt: new Date(now + 120_000).toISOString() })
    assert.ok([...(await read(scope, now + 120_000)).states.values()].every(state => state.credential.usable))
    await run(scope, source, { kind: 'balance', retryable: false }, now - 2_000)
    assert.deepEqual([...(await read(scope, now + 120_000)).states.values()][0].credential, { usable: false, reason: 'balance' })
  })

  await t.test('cancelled and non-provider results cannot leave provider health behind', async () => {
    const scope = await person('provider-cancelled')
    const saved = await key(scope, ['fixture-cancelled'])
    const source = { kind: 'api_key' as const, keyId: saved.id }
    await run(scope, source, { kind: 'balance', retryable: false }, now - 40_000, { status: 'stopped', stopReason: 'cancelled' })
    assert.ok([...(await read(scope)).states.values()].every(state => state.credential.usable), 'a cancelled result does not block the credential')
    await run(scope, source, { kind: 'auth', retryable: false }, now - 30_000, { stopReason: 'error' })
    assert.ok([...(await read(scope)).states.values()].every(state => state.credential.usable), 'an unrelated error result does not block the credential')
    await run(scope, source, { kind: 'balance', retryable: false }, now - 20_000, { stopRequestedAt: now - 21_000 })
    assert.ok([...(await read(scope)).states.values()].every(state => state.credential.usable), 'a stop request wins even if provider metadata remains')
    await run(scope, source, { kind: 'auth', retryable: false }, now - 10_000, { status: 'succeeded', stopReason: 'completed' })
    assert.ok([...(await read(scope)).states.values()].every(state => state.credential.usable), 'stale successful metadata is not failure evidence')
    await run(scope, source, { kind: 'unavailable', retryable: true }, now - 1_000, { status: 'finishing', finishedAt: now, model: 'fixture-cancelled' })
    assert.deepEqual([...(await read(scope)).states.values()][0].credential, { usable: false, reason: 'providerUnavailable', resetsAt: new Date(now + 120_000).toISOString() }, 'a genuine provider stop remains visible while completion is finishing')
  })

  await t.test('a model outage leaves the next model on the same key runnable and needs its own later success', async () => {
    const scope = await person('provider-model-outage')
    const saved = await key(scope, ['fixture-outage', 'fixture-ready'])
    const source = { kind: 'api_key' as const, keyId: saved.id }
    await run(scope, source, { kind: 'unavailable', retryable: true, status: 502 }, now - 10_000, { model: 'fixture-outage' })
    await run(scope, source, null, now - 8_000, { model: 'fixture-ready' })
    const first = await read(scope)
    const outage = first.entries.find(entry => entry.model === 'fixture-outage')!
    const ready = first.entries.find(entry => entry.model === 'fixture-ready')!
    assert.equal(first.states.get(outage.id)?.credential.usable, false, 'success on another model does not clear this outage')
    assert.deepEqual(first.states.get(ready.id)?.credential, { usable: true })
    // The untouched default contains one Codex model, not the entire /models
    // catalogue. Explicitly append the person's second preference.
    await order.changeOrder(pool, scope, { kind: 'add', entries: [ready] })
    const deviceId = randomUUID()
    await pool.query(`INSERT INTO devices (id,"ownerId",name,kind,enabled,"lastSeenAt",harnesses) VALUES ($1,$2,'Fixture device','local',true,now(),$3)`,
      [deviceId, scope.ownerId, JSON.stringify([{ harness: 'codex', installed: true }])])
    await pool.query('UPDATE agents SET "deviceId"=$2 WHERE id=$1', [scope.agentId, deviceId])
    const dispatch = await resolveModelDispatch(pool, scope, undefined, 'local')
    assert.ok(dispatch.kind === 'device' && dispatch.entry.model === 'fixture-ready' && dispatch.entry.source.kind === 'api_key' && dispatch.entry.source.keyId === saved.id)
    await run(scope, source, null, now - 5_000, { model: 'fixture-outage' })
    await run(scope, source, { kind: 'unavailable', retryable: true }, now - 7_000, { model: 'fixture-outage', finishedAt: now })
    assert.ok([...(await read(scope)).states.values()].every(state => state.credential.usable), 'same-entry success clears the outage despite a late older completion')
    await run(scope, source, { kind: 'balance', retryable: false }, now - 3_000, { model: 'fixture-outage' })
    assert.ok([...(await read(scope)).states.values()].every(state => !state.credential.usable && state.credential.reason === 'balance'), 'account balance still blocks all models on its key')
    await run(scope, source, null, now - 1_000, { model: 'fixture-ready' })
    assert.ok([...(await read(scope)).states.values()].every(state => state.credential.usable), 'a later paid success on any model proves the account recovered')
  })

  await t.test('a newer success clears older failures and late old runs do not reverse recovery', async () => {
    const scope = await person('provider-recovery')
    const saved = await key(scope, ['fixture-recovery'])
    const source = { kind: 'api_key' as const, keyId: saved.id }
    await run(scope, source, { kind: 'auth', retryable: false }, now - 10_000)
    await run(scope, source, null, now - 5_000)
    await run(scope, source, { kind: 'balance', retryable: false }, now - 8_000, { finishedAt: now + 5_000 })
    assert.ok([...(await read(scope)).states.values()].every(state => state.credential.usable))
    await run(scope, source, { kind: 'auth', retryable: false }, now - 2_000)
    assert.deepEqual([...(await read(scope)).states.values()][0].credential, { usable: false, reason: 'keyRefused' })
  })

  await t.test('history is scoped to the requesting owner and workspace; order entries cannot grant a key', async () => {
    const scope = await person('provider-owner')
    const stranger = await person('provider-stranger')
    await pool.query(`INSERT INTO mikka_workspace_members ("workspaceId","userId",name,email,role,status) VALUES ($1,$2,'Fixture member',$3,'member','active')`,
      [scope.workspaceId, stranger.ownerId, `${stranger.ownerId}@example.invalid`])
    const mine = await key(scope, ['fixture-mine'])
    const theirs = await key(stranger, ['fixture-theirs'])
    await assert.rejects(run(stranger, { kind: 'api_key', keyId: mine.id }, { kind: 'balance', retryable: false }, now - 20_000, { workspaceId: scope.workspaceId }), /taskWorkspaceMismatch/)
    // A foreign-workspace receipt may be botless; it cannot carry a Bot from another tenant.
    await run(stranger, { kind: 'api_key', keyId: mine.id }, { kind: 'balance', retryable: false }, now - 20_000, { botId: null, workspaceId: scope.workspaceId })
    await run(scope, { kind: 'api_key', keyId: mine.id }, { kind: 'auth', retryable: false }, now - 10_000, { botId: null, workspaceId: stranger.workspaceId })
    const allowed = await read(scope)
    assert.ok([...allowed.states.values()].every(state => state.credential.usable))
    const foreign: OrderEntry = { id: 'forged', harness: 'codex', model: 'fixture-theirs', source: { kind: 'api_key', keyId: theirs.id } }
    await pool.query('UPDATE model_api_keys SET "modelsError"=\'invalid\' WHERE id=$1', [theirs.id])
    for (const candidates of [allowed.candidates, [{ ...foreign, name: foreign.model, provider: 'custom' }], [{ ...foreign, name: foreign.model, provider: 'custom', credentialOwnerId: stranger.ownerId }]]) {
      const states = await order.credentialStates(pool, scope, [foreign], candidates, now, { probe: false })
      assert.deepEqual(states.get(foreign.id)?.credential, { usable: false, reason: 'missing' })
    }
    await pool.query('INSERT INTO model_api_key_shares ("keyId","workspaceId") VALUES ($1,$2)', [theirs.id, scope.workspaceId])
    await pool.query('UPDATE model_api_keys SET "modelsError"=NULL WHERE id=$1', [theirs.id])
    const shared = await read(scope)
    const sharedEntry = shared.entries.find(entry => entry.source.kind === 'api_key' && entry.source.keyId === theirs.id)!
    assert.ok(shared.states.get(sharedEntry.id)?.credential.usable)
    await run(scope, { kind: 'api_key', keyId: theirs.id }, { kind: 'balance', retryable: false }, now - 3_000, { snapshotWorkspace: false })
    assert.equal([...(await read(scope)).states.values()].some(state => !state.credential.usable && state.credential.reason === 'balance'), true, 'legacy snapshots use the owned bot workspace')
    await pool.query('DELETE FROM model_api_key_shares WHERE "keyId"=$1 AND "workspaceId"=$2', [theirs.id, scope.workspaceId])
    const revoked = await order.credentialStates(pool, scope, [sharedEntry], shared.candidates, now, { probe: false })
    assert.deepEqual(revoked.get(sharedEntry.id)?.credential, { usable: false, reason: 'missing' }, 'withdrawal takes precedence over remembered runtime health, even with old candidates')
  })

  await t.test('subscription failures follow the frozen binding revision; pause and missing authority win', async () => {
    const scope = await person('provider-subscription')
    const connectionId = randomUUID()
    const catalogueId = randomUUID()
    const bindingId = randomUUID()
    const quota = { vendor: 'claude_code', source: 'official', status: 'ok', plan: null, observedAt: new Date(now).toISOString(), windows: [{ kind: 'five_hour', used: .1, resetsAt: new Date(now + 3_600_000).toISOString() }] }
    await pool.query(`INSERT INTO byos_connections (id,"ownerId","workspaceId",provider,state,epoch,"secretName","secretDigest","providerSubject","modelCatalog",quota)
      VALUES ($1,$2,$3,'claude','connected',1,$4,$5,'fixture-subject',$6,$7)`,
    [connectionId, scope.ownerId, scope.workspaceId, `fixture-${connectionId}`, 'a'.repeat(64), JSON.stringify({ revision: '1', models: ['fixture-subscription'] }), JSON.stringify(quota)])
    for (const [id, route] of [[catalogueId, 'claude_cpa'], [bindingId, 'claude_code_cli']]) {
      await pool.query(`INSERT INTO byos_bindings (id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision",route,"modelId") VALUES ($1,$2,$3,$4,$5,1,$6,'fixture-subscription')`,
        [id, scope.ownerId, scope.workspaceId, scope.agentId, connectionId, route])
    }
    await run(scope, { kind: 'binding', bindingId }, { kind: 'auth', retryable: false, status: 401 }, now - 10_000)
    const rejected = await read(scope)
    assert.deepEqual(rejected.states.get(rejected.entries[0].id)?.credential, { usable: false, reason: 'expired' })
    const blockedPlan = planDispatch({ entries: rejected.entries, location: 'local', devices: [], credential: entry => rejected.states.get(entry.id)!.credential, cloudReady: false })
    assert.equal(blockedPlan.kind, 'none')
    assert.ok(blockedPlan.kind === 'none' && blockedPlan.reason === 'unavailable')
    await pool.query('UPDATE byos_connections SET paused=true WHERE id=$1', [connectionId])
    const paused = await order.credentialStates(pool, scope, rejected.entries, rejected.candidates, now, { probe: false })
    assert.deepEqual(paused.get(rejected.entries[0].id)?.credential, { usable: false, reason: 'paused' })
    await pool.query(`UPDATE byos_connections SET paused=false,epoch=2,"modelCatalog"=$2 WHERE id=$1`, [connectionId, JSON.stringify({ revision: '2', models: ['fixture-subscription'] })])
    await pool.query(`INSERT INTO byos_bindings (id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision",route,"modelId")
      SELECT $2,"ownerId","workspaceId","consumerId","connectionId",2,route,"modelId" FROM byos_bindings WHERE id=$1`, [catalogueId, randomUUID()])
    assert.ok([...(await read(scope)).states.values()].every(state => state.credential.usable), 'reconnect discards the prior revision fault without rewriting the run binding')
    const denied = await order.credentialStates(pool, scope, rejected.entries, [], now, { probe: false })
    assert.deepEqual(denied.get(rejected.entries[0].id)?.credential, { usable: false, reason: 'missing' })
  })

  await t.test('botless history uses its frozen workspace and does not borrow the requesting scope', async () => {
    const scope = await person('provider-botless')
    const otherWorkspace = await seedWorkspace(pool, scope.ownerId, [{ userId: scope.ownerId, role: 'admin' }])
    workspaces.push(otherWorkspace.id)
    const saved = await key(scope, ['fixture-botless'])
    const source = { kind: 'api_key' as const, keyId: saved.id }
    await run(scope, source, { kind: 'balance', retryable: false }, now - 30_000, { botId: null, snapshotWorkspace: false })
    await run(scope, source, { kind: 'auth', retryable: false }, now - 20_000, { botId: null, workspaceId: otherWorkspace.id })
    assert.ok([...(await read(scope)).states.values()].every(state => state.credential.usable), 'unknown and other-workspace history cannot block this workspace')
    assert.deepEqual([...(await read({ ownerId: scope.ownerId, workspaceId: otherWorkspace.id })).states.values()][0].credential, { usable: false, reason: 'keyRefused' })
    await run(scope, source, { kind: 'balance', retryable: false }, now - 10_000, { botId: null })
    assert.deepEqual([...(await read(scope)).states.values()][0].credential, { usable: false, reason: 'balance' }, 'the frozen dispatch workspace is enough without a bot')
  })

  await t.test('thread feedback reads owner-bound receipts only within the authorized chain', async () => {
    const scope = await person('provider-feedback')
    const stranger = await person('provider-feedback-stranger')
    const saved = await key(scope, ['fixture-feedback'])
    const source = { kind: 'api_key' as const, keyId: saved.id }
    const sourceId = await run(scope, source, { kind: 'balance', retryable: false }, now - 20_000)
    const retryId = await run(scope, source, null, now - 10_000)
    const unrelatedId = await run(stranger, source, null, now - 5_000)
    const from = { harness: 'codex', model: 'fixture-feedback', source: 'api_key' }
    const receipt = { state: 'switched', fallback: 'balance', from, to: { ...from, model: 'fixture-next' }, retryRunId: retryId, attempted: ['private-entry'], nextDefinitionDigest: 'a'.repeat(64) }
    await pool.query(`UPDATE agent_runs SET report=jsonb_set(report,'{modelFallback}',$2) WHERE id=$1`, [sourceId, JSON.stringify(receipt)])
    const { threadModelFallbackView } = await import('../lib/run-quota-view')
    const view = await threadModelFallbackView(scope.ownerId, [sourceId, retryId])
    assert.equal(view.length, 1)
    assert.equal(view[0].state, 'switched')
    assert.ok(!JSON.stringify(view).includes('private-entry'))
    assert.deepEqual(await threadModelFallbackView(stranger.ownerId, [sourceId, retryId]), [])
    assert.deepEqual(await threadModelFallbackView(scope.ownerId, [sourceId]), [], 'a continuation outside the requested chain is not claimed')
    await pool.query(`UPDATE agent_runs SET report=jsonb_set(report,'{modelFallback,retryRunId}',to_jsonb($2::text)) WHERE id=$1`, [sourceId, unrelatedId])
    assert.deepEqual(await threadModelFallbackView(scope.ownerId, [sourceId, unrelatedId]), [], 'even a supplied id must be owned before it can confirm a continuation')
    await pool.query(`UPDATE agent_runs SET report=jsonb_set(report,'{modelFallback,state}','"pending"'::jsonb) WHERE id=$1`, [sourceId])
    const { threadModelFallbackState } = await import('../lib/run-quota-view')
    assert.deepEqual(await threadModelFallbackState(scope.ownerId, [sourceId], sourceId), { notices: [], pending: true }, 'a terminal run keeps polling while its host continuation is pending, without displaying a switch')
    assert.equal((await threadModelFallbackState(scope.ownerId, [sourceId, retryId], retryId)).pending, false, 'an old pending receipt cannot keep a later run polling')
    assert.deepEqual(await threadModelFallbackState(stranger.ownerId, [sourceId], sourceId), { notices: [], pending: false })
    await pool.query(`UPDATE agent_runs SET report=jsonb_set(report,'{modelFallback,state}','"stopped"'::jsonb) WHERE id=$1`, [sourceId])
    assert.deepEqual(await threadModelFallbackState(scope.ownerId, [sourceId], sourceId), { notices: [], pending: false }, 'obsolete recovery stops polling without inventing an unavailable-model card')
  })

  await t.test('an independent check switch needs its host event, matching definition and same owned task', async () => {
    const scope = await person('provider-check-feedback')
    const stranger = await person('provider-check-stranger')
    const issueId = await seedIssue(pool, scope.ownerId, scope.workspaceId)
    const saved = await key(scope, ['fixture-check'])
    const source = { kind: 'api_key' as const, keyId: saved.id }
    const sourceId = await run(scope, source, { kind: 'unavailable', retryable: true }, now - 20_000)
    const childId = await run(scope, source, null, now - 10_000)
    await pool.query('UPDATE agent_runs SET "issueId"=$2 WHERE id=ANY($1::uuid[])', [[sourceId, childId], issueId])
    await pool.query(`UPDATE agent_runs SET "agentDefinition"=jsonb_set("agentDefinition",'{definitionDigest}',to_jsonb($2::text)) WHERE id=$1`, [childId, 'b'.repeat(64)])
    const from = { harness: 'codex', model: 'fixture-check', source: 'api_key' }
    const receipt = { state: 'switched', fallback: 'unavailable', from, to: { ...from, model: 'fixture-next' }, retryRunId: childId, nextDefinitionDigest: 'a'.repeat(64) }
    await pool.query(`UPDATE agent_runs SET report=jsonb_set(report,'{modelFallback}',$2) WHERE id=$1`, [sourceId, JSON.stringify(receipt)])
    const { threadModelFallbackView } = await import('../lib/run-quota-view')
    assert.deepEqual(await threadModelFallbackView(scope.ownerId, [sourceId]), [], 'a host intent alone does not prove a separate check was adopted')
    const taskId = randomUUID(), priorAttemptId = randomUUID(), childAttemptId = randomUUID(), sourceEventId = randomUUID()
    const { factoryEventId } = await import('../lib/factory/event-id')
    const eventId = factoryEventId('provider-check-continuation', sourceId)
    const tx = await pool.connect()
    try {
      await tx.query('BEGIN')
      await tx.query(`INSERT INTO coordinator_events (id,"userId","botId","issueId",kind,"dedupeKey",payload) VALUES ($1,$2,$3,$4,'user_message',$5,'{}')`,
        [sourceEventId, scope.ownerId, scope.botId, issueId, `fixture:${sourceEventId}`])
      await tx.query(`INSERT INTO factory_tasks (id,"userId","botId","issueId","sourceEventId",route,stage,status,"attemptId",reason)
        VALUES ($1,$2,$3,$4,$5,'{}','review','running',$6,'Fixture')`, [taskId, scope.ownerId, scope.botId, issueId, sourceEventId, childAttemptId])
      for (const [index, [id, runId]] of [[priorAttemptId, sourceId], [childAttemptId, childId]].entries()) {
        await tx.query(`INSERT INTO factory_attempts (id,"taskId",stage,ordinal,position,status,"runId",reason)
          VALUES ($1,$2,'review',$3,$3,$4,$5,'Fixture')`, [id, taskId, index + 1, index === 0 ? 'failed' : 'running', runId])
      }
      await tx.query('INSERT INTO factory_events ("taskId","eventId",request,result) VALUES ($1,$2,$3,$4)',
        [taskId, eventId, JSON.stringify({ priorRunId: sourceId }), JSON.stringify({ runId: childId })])
      await tx.query('COMMIT')
    } catch (error) { await tx.query('ROLLBACK'); throw error } finally { tx.release() }
    assert.deepEqual(await threadModelFallbackView(scope.ownerId, [sourceId]), [], 'the adopted child must still match the frozen definition receipt')
    await pool.query(`UPDATE agent_runs SET "agentDefinition"=jsonb_set("agentDefinition",'{definitionDigest}',to_jsonb($2::text)) WHERE id=$1`, [childId, 'a'.repeat(64)])
    assert.equal((await threadModelFallbackView(scope.ownerId, [sourceId]))[0]?.state, 'switched', 'an independent check remains visible after retryOf is cleared')
    await pool.query('UPDATE factory_tasks SET "userId"=$2 WHERE id=$1', [taskId, stranger.ownerId])
    assert.deepEqual(await threadModelFallbackView(scope.ownerId, [sourceId]), [], 'another owner task cannot prove a continuation')
    await pool.query('UPDATE factory_tasks SET "userId"=$2 WHERE id=$1', [taskId, scope.ownerId])
    await pool.query(`UPDATE factory_events SET request='{}' WHERE "taskId"=$1 AND "eventId"=$2`, [taskId, eventId])
    assert.deepEqual(await threadModelFallbackView(scope.ownerId, [sourceId]), [], 'the matching source event payload is required')
  })
})
