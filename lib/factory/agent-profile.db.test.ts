import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { Pool } from 'pg'
import { dbUrl, seedUser, seedWorkspace, seedIssue, seedBot, seedPersonalWorkspace, seedAgent } from '../../tests/support/workspace-admin-db'
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
    await pool.query('DELETE FROM workspace_subscription_shares WHERE "ownerId"=ANY($1)', [owners])
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
  const issueId = await seedIssue(pool, scope.ownerId, scope.workspaceId)
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

  // The two real 21-second waits must not age shared fixtures out of unrelated
  // admission tests. Preserve quota usage and authorization; stale-quota cases own separate sources.
  t.beforeEach(async () => {
    await pool.query(`UPDATE byos_connections SET quota=jsonb_set(quota,'{observedAt}',to_jsonb($2::text),false) WHERE id=ANY($1::uuid[])`,
      [[claude, exactClaude, codex, foreignSource], new Date().toISOString()])
    await pool.query('UPDATE devices SET "lastSeenAt"=now() WHERE id=$1', [deviceId])
  })

  await t.test('fixed Profile source filtering matches the complete catalogue on real rows and keeps its source lock', async t => {
    const who = await person('fixed-entry-owner'), payor = await person('fixed-entry-payor'), unrelated = await person('fixed-entry-unrelated')
    for (const member of [payor, unrelated]) {
      await pool.query(`INSERT INTO mikka_workspace_members ("workspaceId","userId",name,email,role,status) VALUES ($1,$2,'Fixed entry fixture',$3,'member','active')`, [who.workspaceId, member.ownerId, `${member.ownerId}@example.invalid`])
      await pool.query('INSERT INTO workspace_subscription_shares ("ownerId","workspaceId","allowOthers") VALUES ($1,$2,false)', [member.ownerId, who.workspaceId])
    }
    const own = await subscribe(who, 'codex', ['fixed-entry-model', 'unrelated-model'])
    const shared = await subscribe(payor, 'codex', ['fixed-entry-model', 'unrelated-model'])
    await subscribe(who, 'claude', ['unrelated-model'])
    await subscribe(unrelated, 'codex', ['unrelated-model'])
    const { sealSecret } = await import('../secrets/crypto')
    const keys: string[] = []
    for (const owner of [who, payor, unrelated]) {
      const id = randomUUID(), sealed = sealSecret('synthetic-fixed-entry-key', ['model_api_key', id, owner.ownerId].join('\0'), { WORKSPACE_SECRETS_KEY: randomBytes(32).toString('hex') })
      await pool.query(`INSERT INTO model_api_keys (id,"ownerId",provider,protocol,ciphertext,iv,"keyVersion",last4,models,"responsesApi") VALUES ($1,$2,'deepseek','openai',$3,$4,$5,'fake','["fixed-entry-model","unrelated-model"]',true)`, [id, owner.ownerId, sealed.ciphertext, sealed.iv, sealed.keyVersion])
      if (owner !== who) await pool.query('INSERT INTO model_api_key_shares ("keyId","workspaceId") VALUES ($1,$2)', [id, who.workspaceId])
      keys.push(id)
    }
    const selected = (source: OrderEntry['source']) => {
      const entry: OrderEntry = { id: randomUUID(), harness: 'codex', model: 'fixed-entry-model', source }
      const definition = profiles.parseAgentProfile({ name: 'Exact source fixture', harness: 'codex', model: { mode: 'fixed', harness: 'codex', model: entry.model, source } })
      return { profileId: randomUUID(), version: 1, digest: profiles.agentProfileDigest(definition, []), name: definition.name, source: 'explicit' as const, reason: 'explicit', scope: who, definition, skills: [], instructions: '', targetEntry: entry }
    }
    const ownSelection = selected({ kind: 'subscription', connectionId: own }), sharedSelection = selected({ kind: 'subscription', connectionId: shared })
    const ownKey = selected({ kind: 'api_key', keyId: keys[0] }), sharedKey = selected({ kind: 'api_key', keyId: keys[1] })
    const healthAgentId = await seedAgent(pool, who.ownerId)
    const outcome = async (operation: () => Promise<void>) => {
      try { await operation(); return { ok: true } } catch (error) {
        if (!(error instanceof profiles.AgentProfileError)) throw error
        return { code: error.code, detail: error.detail }
      }
    }
    const inspect = async (selection: typeof ownSelection, full: boolean) => {
      const statements: { text: string; rows: number }[] = []
      const measured = { query: async (text: string, params?: unknown[]) => {
        const result = await pool.query(text, params); statements.push({ text, rows: result.rows.length }); return result
      } } as unknown as Pick<Pool, 'query'>
      const result = await outcome(() => full ? profiles.assertFrozenModelTarget(measured, who, selection.targetEntry) : profiles.assertProfileTarget(measured, who, selection))
      return { result, statements }
    }
    let providerCalls = 0
    const fetch = globalThis.fetch
    globalThis.fetch = async () => { providerCalls++; throw new Error('fixed target must not call a provider') }
    try {
      for (const [name, selection, expectedQueries] of [['own subscription', ownSelection, 5], ['own key', ownKey, 5], ['shared key', sharedKey, 6]] as const) await t.test(name, async t => {
        const original = await inspect(selection, true), fixed = await inspect(selection, false)
        assert.deepEqual(original.result, { ok: true }); assert.deepEqual(fixed.result, original.result)
        assert.equal(fixed.statements.length, expectedQueries)
        assert.ok(fixed.statements.length < original.statements.length)
        if (selection.targetEntry.source.kind === 'subscription') {
          assert.equal(original.statements.some(row => /\bFROM model_api_keys WHERE\b|\bFROM model_api_key_shares s\b/.test(row.text)), true)
          assert.equal(fixed.statements.some(row => /\bFROM model_api_keys WHERE\b|\bFROM model_api_key_shares s\b/.test(row.text)), false)
          assert.deepEqual(fixed.statements.filter(row => row.text.includes('WITH choices AS')).map(row => row.rows), [1])
        } else assert.equal(fixed.statements.some(row => row.text.includes('WITH choices AS')), false)
        assert.equal(providerCalls, 0)
        t.diagnostic(JSON.stringify({ name, appQueryInvocations: { full: original.statements.length, selected: fixed.statements.length }, providerCalls, workspaceMembershipTransactionsCounted: false }))
      })
      const compare = async (selection: typeof ownSelection, expected: 'accepted' | 'denied' = 'denied') => {
        const original = await inspect(selection, true), fixed = await inspect(selection, false)
        assert.deepEqual(fixed.result, original.result)
        assert.equal(original.result.ok === true, expected === 'accepted')
        assert.equal(providerCalls, 0)
      }
      await t.test('a legacy teammate subscription never enters either full or exact-source catalogue', async () => {
        await compare(sharedSelection)
        assert.equal(providerCalls, 0)
      })
      for (const [name, sql, params, restore, restoreParams] of [
        ['paused', 'UPDATE byos_connections SET paused=true WHERE id=$1', [own], 'UPDATE byos_connections SET paused=false WHERE id=$1', [own]],
        ['removed', `UPDATE byos_connections SET state='disconnected',"removedAt"=now() WHERE id=$1`, [own], `UPDATE byos_connections SET state='connected',"removedAt"=NULL WHERE id=$1`, [own]],
        ['epoch', 'UPDATE byos_connections SET epoch=2 WHERE id=$1', [own], 'UPDATE byos_connections SET epoch=1 WHERE id=$1', [own]],
        ['binding route', "UPDATE byos_bindings SET route='codex_cli' WHERE \"connectionId\"=$1", [own], "UPDATE byos_bindings SET route='codex_cpa' WHERE \"connectionId\"=$1", [own]],
        ['catalogue model removed', 'UPDATE byos_connections SET "modelCatalog"=$2 WHERE id=$1', [own, JSON.stringify({ revision: '1', models: ['unrelated-model'] })], 'UPDATE byos_connections SET "modelCatalog"=$2 WHERE id=$1', [own, JSON.stringify({ revision: '1', models: ['fixed-entry-model', 'unrelated-model'] })]],
        ['quota', 'UPDATE byos_connections SET quota=$2 WHERE id=$1', [own, JSON.stringify(quota('codex', 1))], 'UPDATE byos_connections SET quota=$2 WHERE id=$1', [own, JSON.stringify(quota('codex'))]],
      ] as const) await t.test(`same own subscription denial: ${name}`, async () => {
        await pool.query(sql, [...params]); try { await compare(ownSelection) } finally { await pool.query(restore, [...restoreParams]) }
      })
      await t.test('a stale catalogue revision retains the original binding fallback', async () => {
        await pool.query('UPDATE byos_connections SET "modelCatalog"=$2 WHERE id=$1', [own, JSON.stringify({ revision: '0', models: ['unrelated-model'] })])
        try { await compare(ownSelection, 'accepted') } finally { await pool.query('UPDATE byos_connections SET "modelCatalog"=$2 WHERE id=$1', [own, JSON.stringify({ revision: '1', models: ['fixed-entry-model', 'unrelated-model'] })]) }
      })
      await t.test('the shared owner must still be an active member', async () => {
        await pool.query(`UPDATE mikka_workspace_members SET status='suspended' WHERE "workspaceId"=$1 AND "userId"=$2`, [who.workspaceId, payor.ownerId])
        try { await compare(sharedSelection) } finally { await pool.query(`UPDATE mikka_workspace_members SET status='active' WHERE "workspaceId"=$1 AND "userId"=$2`, [who.workspaceId, payor.ownerId]) }
      })
      await t.test('withdrawn subscription or key shares cannot be replaced by another same-model source', async () => {
        await pool.query('UPDATE workspace_subscription_shares SET "allowOthers"=false WHERE "ownerId"=$1 AND "workspaceId"=$2', [payor.ownerId, who.workspaceId])
        await pool.query('DELETE FROM model_api_key_shares WHERE "keyId"=$1 AND "workspaceId"=$2', [keys[1], who.workspaceId])
        try { await compare(sharedSelection); await compare(sharedKey) } finally {
          await pool.query('UPDATE workspace_subscription_shares SET "allowOthers"=false WHERE "ownerId"=$1 AND "workspaceId"=$2', [payor.ownerId, who.workspaceId])
          await pool.query('INSERT INTO model_api_key_shares ("keyId","workspaceId") VALUES ($1,$2)', [keys[1], who.workspaceId])
        }
      })
      await t.test('the admin share switch refuses others without refusing own sources', async () => {
        await pool.query('INSERT INTO workspace_personal_policies ("workspaceId",subscriptions) VALUES ($1,false)', [who.workspaceId])
        try { await compare(sharedSelection); await compare(sharedKey); await compare(ownSelection, 'accepted'); await compare(ownKey, 'accepted') }
        finally { await pool.query('DELETE FROM workspace_personal_policies WHERE "workspaceId"=$1', [who.workspaceId]) }
      })
      for (const [field, value, original] of [['modelsError', 'invalid', null], ['responsesApi', false, true], ['models', JSON.stringify(['unrelated-model']), JSON.stringify(['fixed-entry-model', 'unrelated-model'])]] as const) await t.test(`same API-key refusal: ${field}`, async () => {
        await pool.query(`UPDATE model_api_keys SET "${field}"=$2 WHERE id=$1`, [keys[0], value])
        try { await compare(ownKey) } finally { await pool.query(`UPDATE model_api_keys SET "${field}"=$2 WHERE id=$1`, [keys[0], original]) }
      })
      for (const selection of [ownSelection, ownKey]) await t.test(`the selected ${selection.targetEntry.source.kind} retains durable provider-health evidence`, async () => {
        const entry = selection.targetEntry, id = randomUUID()
        const binding = (await pool.query('SELECT id FROM byos_bindings WHERE "connectionId"=$1 AND "modelId"=$2', [own, entry.model])).rows[0]
        await pool.query('UPDATE model_api_keys SET "updatedAt"=now()-interval \'1 hour\' WHERE id=$1', [keys[0]])
        await pool.query(`INSERT INTO agent_runs (id,"userId","agentId","workspaceId",status,"stopReason","agentDefinition",report,"startedAt","finishedAt")
          VALUES ($1,$2,$3,$4,'failed','provider_failure',$5,$6,now()-interval '1 second',now())`,
        [id, who.ownerId, healthAgentId, who.workspaceId, JSON.stringify({ harness: entry.harness, executionIdentity: { workspaceId: who.workspaceId },
          ...(entry.source.kind === 'subscription' ? { subscription: { bindingId: binding.id, modelId: entry.model } } : { apiKey: { keyId: entry.source.keyId, model: entry.model } }) }),
        JSON.stringify({ providerFailure: { kind: 'balance', retryable: false, status: 402, code: 'payment_required' } })])
        try { await compare(selection) } finally { await pool.query('DELETE FROM agent_runs WHERE id=$1', [id]) }
      })
      await t.test('the same FOR SHARE lock still prevents a concurrent source disconnect', async () => {
        const holding = await pool.connect(), writer = await pool.connect()
        try {
          await holding.query('BEGIN'); await writer.query('BEGIN'); await writer.query("SET LOCAL lock_timeout='100ms'")
          await profiles.assertProfileTarget(holding, who, ownSelection)
          await assert.rejects(writer.query('UPDATE byos_connections SET paused=true WHERE id=$1', [own]), { code: '55P03' })
        } finally { await holding.query('ROLLBACK'); await writer.query('ROLLBACK'); holding.release(); writer.release() }
      })
    } finally { globalThis.fetch = fetch }
  })

  await t.test('default dispatch survives a 21-second catalogue wait before final membership admission', { timeout: 45_000 }, async () => {
    const selected = await profiles.resolveAgentProfileDispatch(pool, scope, { issueId, location: 'local' }, {
      modelDecision: async () => null,
      resolve: async (...args) => {
        await new Promise(resolve => setTimeout(resolve, 21_000))
        // The real daemon keeps reporting presence while catalogue work waits.
        await pool.query('UPDATE devices SET "lastSeenAt"=now() WHERE id=$1', [deviceId])
        return resolveModelDispatch(...args)
      },
    })
    assert.equal(selected.agentProfile?.source, 'default')
    assert.ok(selected.agentProfile)
    if (selected.target.kind !== 'device') assert.fail('the delayed default still selects its authorized local device')
    assert.equal(selected.target.agentId, agents[selected.target.entry.harness])
    const { routing, ...target } = selected.target
    assert.deepEqual(target, await resolveModelDispatch(pool, scope, undefined, 'local'))
    assert.deepEqual(routing, { version: 2, required: 'unknown', model: 'claude-haiku-5-5',
      harness: 'claude_code', tier: 'light', reason: 'decision_unavailable' })
    assert.deepEqual(selected.agentProfile.targetEntry, selected.target.entry)
    const binding = (await pool.query('SELECT "consumerId","connectionId","modelId" FROM byos_bindings WHERE id=$1', [selected.target.subscriptionBindingId])).rows[0]
    assert.equal(binding.consumerId, selected.target.agentId)
    if (selected.target.entry.source.kind !== 'subscription') assert.fail('the default fixture uses a subscription')
    assert.equal(binding.connectionId, selected.target.entry.source.connectionId)
    assert.equal(binding.modelId, selected.target.model)
  })

  await t.test('zero configuration preserves the existing model resolver', async () => {
    const decisionPurposes: string[] = []
    const unavailableDecision = async (purpose: string) => { decisionPurposes.push(purpose); return null }
    const actual = await profiles.resolveAgentProfileDispatch(pool, scope, { issueId, location: 'local' }, { modelDecision: unavailableDecision })
    const expected = await resolveModelDispatch(pool, scope, undefined, 'local')
    if (actual.target.kind !== 'device') assert.fail('local default must select the fixture device')
    const { routing, ...target } = actual.target
    assert.deepEqual(target, expected, 'an unavailable routing Decision preserves every original execution target field')
    assert.deepEqual(routing, { version: 2, required: 'unknown', model: 'claude-haiku-5-5',
      harness: 'claude_code', tier: 'light', reason: 'decision_unavailable' })
    assert.deepEqual(decisionPurposes, ['task-model-routing'])
    const { changeOrder } = await import('@/lib/model-order')
    await changeOrder(pool, scope, { kind: 'autoRouting', enabled: false })
    try {
      const disabled = await profiles.resolveAgentProfileDispatch(pool, scope, { issueId, location: 'local' }, { modelDecision: unavailableDecision })
      assert.deepEqual(disabled, { target: expected, agentProfile: actual.agentProfile, selectionMode: 'preference' }, 'routing off returns the complete legacy result without a routing snapshot')
      assert.deepEqual(decisionPurposes, ['task-model-routing'], 'routing off never calls the judge')
    } finally { await changeOrder(pool, scope, { kind: 'autoRouting', enabled: true }) }
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
    const taskId = await seedIssue(pool, who.ownerId, who.workspaceId)
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

    for (const choice of [
      { name: 'new default', profileId: undefined, defaultOnly: false },
      { name: 'default-only', profileId: undefined, defaultOnly: true },
      { name: 'task-form Default', profileId: 'default', defaultOnly: false },
      { name: 'task-form Default continuation', profileId: 'default', defaultOnly: true },
    ]) await t.test(`${choice.name} dispatch keeps the same harness and skips its failed first preference`, async () => {
      const selected = await profiles.resolveAgentProfileDispatch(pool, who, { ...request, profileId: choice.profileId, defaultOnly: choice.defaultOnly })
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
      assert.deepEqual(await profiles.agentProfileDispatchAvailability(pool, who, { ...request, profileId: 'default' }), { available: true })
      assert.deepEqual((await pool.query('SELECT * FROM byos_bindings WHERE "ownerId"=$1 ORDER BY id', [who.ownerId])).rows, before.rows)
    })

    await t.test('Default management keeps stale allowance checking while real dispatch refreshes without losing provider-failure memory', async () => {
      // A pure preview must not refresh credentials or pretend a stale quota is
      // available. The task form may submit that unresolved Default intent;
      // only the actual dispatcher can check it and admit a source.
      await order.changeOrder(pool, who, { kind: 'preferred', harness: 'claude_code' })
      const stale = () => ({ ...quota('claude'), observedAt: new Date(Date.now() - 60_001).toISOString() })
      await pool.query('UPDATE byos_connections SET quota=$2 WHERE id=$1', [claudeSource, JSON.stringify(stale())])
      const authority = async () => ({
        order: (await pool.query('SELECT * FROM model_order_entries WHERE "ownerId"=$1 ORDER BY id', [who.ownerId])).rows,
        settings: (await pool.query('SELECT * FROM model_order_settings WHERE "ownerId"=$1', [who.ownerId])).rows,
        key: (await pool.query('SELECT id,"updatedAt",models,"modelsError" FROM model_api_keys WHERE id=$1', [key.id])).rows,
        sources: (await pool.query('SELECT id,epoch,state,paused,"modelCatalog" FROM byos_connections WHERE "ownerId"=$1 ORDER BY id', [who.ownerId])).rows,
        failure: (await pool.query('SELECT status,"stopReason",report,"startedAt","finishedAt" FROM agent_runs WHERE id=$1', [priorRunId])).rows,
      })
      const bindings = async () => (await pool.query('SELECT * FROM byos_bindings WHERE "ownerId"=$1 ORDER BY id', [who.ownerId])).rows
      const snapshot = await authority(), beforeBindings = await bindings()
      const beforeQuota = (await pool.query('SELECT quota FROM byos_connections WHERE id=$1', [claudeSource])).rows
      const preview = await profiles.readAgentProfileManagement(pool, who, { location: 'local', deviceId: device })
      assert.deepEqual(preview.defaultAvailability, { available: false, reason: 'checking' })
      const settings = await order.orderView(pool, who)
      assert.equal(settings.entries.find(entry => entry.id === preferred[2].id)?.block, null, 'Settings retains its last positive allowance display')
      assert.deepEqual(await authority(), snapshot)
      assert.deepEqual(await bindings(), beforeBindings)
      assert.deepEqual((await pool.query('SELECT quota FROM byos_connections WHERE id=$1', [claudeSource])).rows, beforeQuota, 'opening the form is not a quota/source refresh')
      const calls: string[] = []
      const dispatchWithUsage = (usage: () => Promise<void>) => profiles.resolveAgentProfileDispatch(pool, who,
        { ...request, profileId: 'default' }, {
          resolve: (query, scope, asked, location, requestedDevice, dependencies) => resolveModelDispatch(query, scope, asked, location, requestedDevice, {
            ...dependencies, refreshQuota: async (requester, connectionId, _signal, credentialOwnerId) => {
              assert.equal(requester.ownerId, who.ownerId); assert.equal(requester.workspaceId, who.workspaceId)
              assert.equal(credentialOwnerId, who.ownerId); assert.equal(connectionId, claudeSource)
              calls.push(connectionId); await usage()
            },
          }),
        })
      try {
        const selected = await dispatchWithUsage(async () => {
          await pool.query('UPDATE byos_connections SET quota=$2 WHERE id=$1', [claudeSource, JSON.stringify(quota('claude'))])
        })
        assert.deepEqual(calls, [claudeSource], 'only the already authorized subscription is checked')
        if (selected.target.kind !== 'device') assert.fail(JSON.stringify(selected.target))
        assert.deepEqual(selected.target.entry, preferred[2]); assert.equal(selected.selectionMode, 'preference')
        assert.equal(selected.target.agentId, runtimeAgents.claude_code)
        assert.deepEqual(await authority(), snapshot, 'quota preparation does not reset key health or change source generation/order')
        assert.deepEqual((await order.credentialStates(pool, who, preferred, candidates, undefined, { probe: false })).get(preferred[0].id)?.credential,
          { usable: false, reason: 'balance' })
        const admittedBindings = await bindings()
        for (const outcome of ['unknown', 'exhausted'] as const) {
          await pool.query('UPDATE byos_connections SET quota=$2 WHERE id=$1', [claudeSource, JSON.stringify(stale())])
          const denied = await dispatchWithUsage(async () => {
            if (outcome === 'unknown') throw new Error('Synthetic quota transport unavailable')
            await pool.query('UPDATE byos_connections SET quota=$2 WHERE id=$1', [claudeSource, JSON.stringify(quota('claude', 1))])
          })
          assert.equal(denied.target.kind, 'none', outcome)
          assert.equal(denied.agentProfile, undefined, outcome)
          assert.deepEqual(await bindings(), admittedBindings, outcome)
          assert.deepEqual(await authority(), snapshot, outcome)
        }
        await pool.query('UPDATE byos_connections SET paused=true WHERE id=ANY($1::uuid[])', [[claudeSource, codexSource]])
        const unavailable = await profiles.readAgentProfileManagement(pool, who, { location: 'local', deviceId: device })
        assert.equal(unavailable.defaultAvailability.available, false)
        assert.notEqual(unavailable.defaultAvailability.reason, 'checking', 'known unavailable sources are not pending allowance')
        const beforePauseCalls = calls.length
        const stopped = await dispatchWithUsage(async () => { assert.fail('Paused sources cannot be probed or admitted') })
        assert.equal(stopped.target.kind, 'none')
        assert.equal(calls.length, beforePauseCalls, 'paused sources are not probed')
        assert.deepEqual(await bindings(), admittedBindings)
      } finally {
        await pool.query('UPDATE byos_connections SET paused=false,quota=$2 WHERE id=$1', [claudeSource, JSON.stringify(quota('claude'))])
        await pool.query('UPDATE byos_connections SET paused=false,quota=$2 WHERE id=$1', [codexSource, JSON.stringify(quota('codex'))])
        await order.changeOrder(pool, who, { kind: 'preferred', harness: 'codex' })
      }
    })

    for (const profileId of [undefined, 'default']) await t.test(`an explicitly named failed model stays unavailable on ${profileId ?? 'automatic'} instead of selecting Haiku`, async () => {
      const picked = { ...request, profileId, asked: { harness: 'claude_code' as const, model: 'deepseek-flash' } }
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

  await t.test('a persisted task-form Default choice uses preferred models with custom roles present and retains its continuation pin', async () => {
    const [{ db }, { recordPersonalSubmission }, { requestedAgentProfile }] = await Promise.all([
      import('../db'), import('../coordinator-submission'), import('./profile-request'),
    ])
    const botId = await seedBot(pool, scope.workspaceId, scope.ownerId), owner = { ...scope, botId }
    const receipt = await recordPersonalSubmission(db, scope.ownerId, 'Use the preferred models for this task.', { botId, submissionId: randomUUID(), profileId: 'default' })
    assert.equal((await pool.query('SELECT payload FROM coordinator_events WHERE id=$1', [receipt.eventId])).rows[0].payload.profileId, 'default')
    const profileId = await requestedAgentProfile(pool, owner, receipt.eventId, review.id)
    assert.equal(profileId, 'default', 'the stored task choice wins over the model-proposed review role')
    await assert.rejects(requestedAgentProfile(pool, { ...owner, ownerId: foreign.ownerId }, receipt.eventId, 'default'), { code: 'agentProfilePinConflict' })
    await assert.rejects(requestedAgentProfile(pool, { ...owner, botId: randomUUID() }, receipt.eventId, 'default'), { code: 'agentProfilePinConflict' })
    const beforeBindings = (await pool.query('SELECT * FROM byos_bindings WHERE "ownerId"=$1 ORDER BY id', [scope.ownerId])).rows
    assert.deepEqual(await profiles.agentProfileDispatchAvailability(pool, owner, { profileId, asked: { harness: 'codex' }, location: 'local' }), { available: true })
    assert.deepEqual((await pool.query('SELECT * FROM byos_bindings WHERE "ownerId"=$1 ORDER BY id', [scope.ownerId])).rows, beforeBindings, 'preview remains read-only')
    const decision = async () => { throw new Error('A real task-form Default pin must not ask Decision for another role') }
    for (const request of [
      { asked: { harness: 'codex' as const } },
      { asked: { harness: 'codex' as const }, defaultOnly: true },
      { asked: { harness: 'codex' as const, model: 'gpt-6-luna' } },
    ]) {
      const purposes: string[] = []
      const result = await profiles.resolveAgentProfileDispatch(pool, owner, { issueId, profileId, location: 'local', ...request }, {
        decision, modelDecision: async purpose => { purposes.push(purpose); return null },
      })
      if (result.target.kind !== 'device') assert.fail('the explicit Default choice must retain its authorized local target')
      assert.equal(result.target.agentId, agents.codex)
      assert.equal(result.target.model, 'gpt-6-luna')
      assert.deepEqual(result.target.entry.source, { kind: 'subscription', connectionId: codex })
      assert.equal(result.selectionMode, request.asked.model ? 'picked' : 'preference')
      assert.deepEqual(purposes, request.asked.model ? [] : ['task-model-routing'], 'the existing model routing path remains independent of Profile selection')
      const selection = result.agentProfile!
      assert.equal(selection.profileId, 'default'); assert.equal(selection.source, 'default'); assert.equal(selection.reason, 'default')
      assert.equal(selection.version, 1); assert.equal(selection.decision, undefined); assert.equal(selection.instructions, '')
      assert.deepEqual(selection.skills, []); assert.deepEqual(selection.definition.roles, [])
      await profiles.assertProfileSelection(pool, owner, selection)
    }
    await assert.rejects(profiles.resolveAgentProfileDispatch(pool, owner, { issueId, profileId: review.id, defaultOnly: true }), { code: 'agentProfilePinConflict' })
    assert.equal((await store.list(scope)).length, 3, 'selecting Default does not create or modify a custom Profile')
  })

  await t.test('public Factory Default dispatch requires the original user pin without changing UUID or host-selected paths', async () => {
    const [{ db }, { recordPersonalSubmission }, { createFactoryStore }, { createFactoryDispatch, factoryBinding }, { queueFactoryRun }, order] = await Promise.all([
      import('../db'), import('../coordinator-submission'), import('./store'), import('./dispatch'), import('../agent-runs'), import('../model-order'),
    ])
    const botId = await seedBot(pool, scope.workspaceId, scope.ownerId), repoId = randomUUID()
    const repository = normalizeRepository(`https://github.com/synthetic/default-task-${randomUUID()}.git`)
    await pool.query(`INSERT INTO device_repos(id,"userId","deviceId","repoPath","remoteUrl","baseBranch") VALUES ($1,$2,$3,$4,$5,'main')`, [repoId, scope.ownerId, deviceId, repository.key, repository.remoteUrl])
    const [{ factoryCheckGates }, { factoryCheckIndependent }] = await Promise.all([import('./checks'), import('./check-independence')])
    const factory = createFactoryStore(pool, async (owner, issue, tx) => (await tx.query('SELECT 1 FROM issues WHERE id=$1 AND "userId"=$2', [issue, owner])).rowCount === 1, botId, { independent: factoryCheckIndependent, gates: factoryCheckGates })
    const dispatch = createFactoryDispatch(pool, factory, (tx, owner, input, bot, context) => queueFactoryRun(tx, owner, input, bot, context))
    // Source-pin admission is independent of the existing difficulty-routing toggle.
    await order.changeOrder(pool, scope, { kind: 'autoRouting', enabled: false })
    let taskNumber = 1225
    try {
      for (const [pin, offered, expected] of [
        ['default', undefined, 'default'], ['default', review.id, 'default'],
        [backend.id, 'default', backend.id], [backend.id, review.id, review.id],
        [undefined, 'default', null],
      ] as const) {
        const taskIssue = await seedIssue(pool, scope.ownerId, scope.workspaceId)
        await pool.query('UPDATE issues SET content=$2 WHERE id=$1', [taskIssue, JSON.stringify({ type: 'doc', attrs: { mikka: { number: taskNumber++ } }, content: [] })])
        const receipt = await recordPersonalSubmission(db, scope.ownerId, 'Run this task with the default Profile.', { botId, submissionId: randomUUID(), ...(pin ? { profileId: pin } : {}) })
        const routed = await factory.route(scope.ownerId, { issueId: taskIssue, sourceEventId: receipt.eventId, eventId: randomUUID(), rationale: 'Task-form Profile admission fixture' })
        const input = { binding: factoryBinding(routed.task), agentId: agents.codex, deviceRepoId: repoId, ...(offered ? { profileId: offered } : {}) }
        if (expected === null) {
          await assert.rejects(dispatch(scope.ownerId, input), { code: 'runInvalid' })
          assert.equal((await pool.query('SELECT 1 FROM agent_runs WHERE "issueId"=$1', [taskIssue])).rowCount, 0, 'a tool-only Default cannot queue a run even when the user text contains its name')
          assert.equal((await factory.read(scope.ownerId, routed.task.id)).task.status, 'pending')
          continue
        }
        const queued = await dispatch(scope.ownerId, input)
        const run = (await pool.query('SELECT * FROM agent_runs WHERE id=$1', [queued.runId])).rows[0]
        assert.equal(run.agentDefinition.agentProfile.profileId, expected)
        assert.equal(run.agentDefinition.agentProfile.source, expected === 'default' ? 'default' : 'explicit')
        assert.equal(run.agentDefinition.model, 'gpt-6-luna')
        assert.equal((await dispatch(scope.ownerId, input)).runId, queued.runId, 'the same request replays its frozen selection')
        await pool.query("UPDATE agent_runs SET status='succeeded',\"finishedAt\"=now() WHERE id=$1", [queued.runId])
      }
    } finally { await order.changeOrder(pool, scope, { kind: 'autoRouting', enabled: true }) }
  })

  await t.test('custom Profile survives a 21-second Decision wait and binds its exact authorized source', { timeout: 45_000 }, async () => {
    const selected = await profiles.resolveAgentProfileDispatch(pool, scope, { issueId, location: 'local' }, {
      decision: async () => {
        await new Promise(resolve => setTimeout(resolve, 21_000))
        await pool.query('UPDATE devices SET "lastSeenAt"=now() WHERE id=$1', [deviceId])
        return { answers: new Map<string, Exclude<DecisionAnswer, { type: 'refusal' }>>([['profile', { name: 'profile', type: 'choice', choice: `${ui.id}:capability_fit`, confidence: .95 }]]), execution: { executionId: randomUUID(), modelId: 'openai/gpt-6-luna-decisions', providerGenerationId: 'fixture-delayed-decision', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), requestDigest: 'a'.repeat(64), imageDigests: [], vision: 'no-image-input' } }
      },
    })
    assert.equal(selected.agentProfile?.profileId, ui.id)
    assert.equal(selected.agentProfile?.version, ui.version)
    assert.equal(selected.agentProfile?.digest, ui.digest)
    assert.equal(selected.agentProfile?.source, 'decision')
    assert.ok(selected.agentProfile)
    if (selected.target.kind !== 'device') assert.fail('the delayed Decision still selects its authorized local device')
    assert.deepEqual(selected.agentProfile.targetEntry, selected.target.entry)
    assert.equal(selected.target.agentId, agents.claude_code)
    const binding = (await pool.query('SELECT "consumerId","connectionId","modelId" FROM byos_bindings WHERE id=$1', [selected.target.subscriptionBindingId])).rows[0]
    assert.equal(binding.consumerId, selected.target.agentId)
    assert.equal(binding.connectionId, exactClaude)
    assert.equal(binding.modelId, selected.target.model)
  })

  const factoryBoundary = await import('./transaction')
  const outerFixture = async (name: string, custom = false) => {
    const who = await person(`profiles-outer-${name}`), sourceId = await subscribe(who, 'codex', ['gpt-6-luna'])
    const device = randomUUID(), agentId = randomUUID(), taskIssue = await seedIssue(pool, who.ownerId, who.workspaceId)
    await pool.query(`INSERT INTO devices (id,"ownerId",name,kind,enabled,"lastSeenAt",harnesses) VALUES ($1,$2,'Outer transaction','local',true,now(),$3)`, [device, who.ownerId, JSON.stringify([{ harness: 'codex', installed: true, models: ['gpt-6-luna'], subscriptionBroker: true }])])
    await pool.query(`INSERT INTO agents (id,"userId","deviceId",name,harness) VALUES ($1,$2,$3,'Outer transaction','codex')`, [agentId, who.ownerId, device])
    const profile = custom ? await store.create(who, definition('Outer role', 'codex', sourceId, 'gpt-6-luna')) : undefined
    const select = (tx: import('pg').PoolClient) => profiles.resolveAgentProfileDispatch(new Proxy(pool, { get(target, key) {
      if (key === 'connect') return () => assert.fail('borrowed Profile finalization must not check out a second APP connection')
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    } }), who, { issueId: taskIssue, location: 'local', profileId: profile?.id }, { transaction: tx })
    const bindings = async () => (await pool.query('SELECT 1 FROM byos_bindings WHERE "consumerId"=$1', [agentId])).rowCount
    const runs = async () => (await pool.query('SELECT 1 FROM agent_runs WHERE "userId"=$1', [who.ownerId])).rowCount
    const queueMarker = async (tx: import('pg').PoolClient, selected: Awaited<ReturnType<typeof select>>) => {
      assert.equal(selected.target.kind, 'device')
      if (selected.target.kind !== 'device') assert.fail('authorized local target required')
      // A synthetic caller write proves that finalization cannot commit either
      // the source binding or its enclosing run before the real owner commits.
      await tx.query(`INSERT INTO agent_runs (id,"userId","agentId","deviceId","issueId",status,prompt,"agentDefinition") VALUES ($1,$2,$3,$4,$5,'queued','Outer transaction fixture',$6)`, [randomUUID(), who.ownerId, agentId, device, taskIssue, JSON.stringify({ agentProfile: selected.agentProfile })])
    }
    return { who, sourceId, profile, select, bindings, runs, queueMarker }
  }

  for (const kind of ['default', 'custom'] as const) await t.test(`Factory ${kind} finalization shares the outer transaction and pins membership through its real COMMIT`, async () => {
    const f = await outerFixture(kind, kind === 'custom'), raw = await pool.connect(), writer = await pool.connect()
    let commitObserved = false, committed = false
    const tx = new Proxy(raw, { get(target, key) {
      if (key === 'query') return async (...args: unknown[]) => {
        if (args[0] === 'COMMIT') {
          await writer.query('BEGIN')
          try {
            await assert.rejects(writer.query('SELECT 1 FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=$2 FOR UPDATE NOWAIT', [f.who.workspaceId, f.who.ownerId]), { code: '55P03' })
            commitObserved = true
          } finally { await writer.query('ROLLBACK') }
        }
        return Reflect.apply(target.query, target, args)
      }
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    } })
    try {
      await factoryBoundary.beginFactoryTransaction(tx)
      const before = (await tx.query('SELECT txid_current()::text AS id')).rows[0].id
      const selected = await f.select(tx)
      await f.queueMarker(tx, selected)
      assert.equal((await tx.query('SELECT txid_current()::text AS id')).rows[0].id, before)
      assert.equal(await f.bindings(), 0); assert.equal(await f.runs(), 0)
      await factoryBoundary.commitFactoryTransaction(tx); committed = true
      assert.equal(commitObserved, true)
      assert.equal(await f.bindings(), 1); assert.equal(await f.runs(), 1)
      assert.throws(() => factoryBoundary.assertFactoryTransaction(tx), /factoryTransactionNotOwned/)
      await writer.query('BEGIN')
      try { await writer.query('SELECT 1 FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=$2 FOR UPDATE NOWAIT', [f.who.workspaceId, f.who.ownerId]) }
      finally { await writer.query('ROLLBACK') }
    } finally {
      if (!committed) await factoryBoundary.rollbackFactoryTransaction(tx)
      factoryBoundary.forgetFactoryTransaction(tx); raw.release(); writer.release()
    }
  })

  await t.test('membership cleanup failure cannot reclassify a confirmed Factory COMMIT', async () => {
    const f = await outerFixture('cleanup'), tx = await pool.connect()
    let committed = false, startCalls = 0
    const diagnostics: unknown[][] = []
    const warning = t.mock.method(console, 'warn', (...args: unknown[]) => { diagnostics.push(args) })
    let checkout: ReturnType<typeof t.mock.method> | undefined
    try {
      await factoryBoundary.beginFactoryTransaction(tx)
      await f.queueMarker(tx, await f.select(tx))
      const connect = workspacePool.connect.bind(workspacePool)
      checkout = t.mock.method(workspacePool, 'connect', ((callback?: Parameters<typeof workspacePool.connect>[0]) => {
        if (callback) return connect(callback)
        return connect().then(client => new Proxy(client, { get(target, key) {
          if (key === 'release') return (...args: unknown[]) => {
            Reflect.apply(target.release, target, args)
            throw new Error('synthetic membership cleanup failure')
          }
          const value = Reflect.get(target, key, target)
          return typeof value === 'function' ? value.bind(target) : value
        } }))
      }) as typeof workspacePool.connect)
      await factoryBoundary.commitFactoryTransaction(tx); committed = true
      startCalls++
      assert.equal(startCalls, 1)
      assert.equal(await f.bindings(), 1); assert.equal(await f.runs(), 1)
      assert.ok(diagnostics.some(args => args[0] === JSON.stringify({ msg: 'factory_profile_membership_cleanup_failed', committed: true })))
      assert.throws(() => factoryBoundary.assertFactoryTransaction(tx), /factoryTransactionNotOwned/)
    } finally {
      checkout?.mock.restore(); warning.mock.restore()
      if (!committed) await factoryBoundary.rollbackFactoryTransaction(tx)
      factoryBoundary.forgetFactoryTransaction(tx); tx.release()
    }
  })

  await t.test('Factory final membership revocation rolls back its selected binding and caller run', async () => {
    const f = await outerFixture('revoked', true), tx = await pool.connect()
    try {
      await factoryBoundary.beginFactoryTransaction(tx)
      await f.queueMarker(tx, await f.select(tx))
      await pool.query(`UPDATE mikka_workspace_members SET status='suspended' WHERE "workspaceId"=$1 AND "userId"=$2`, [f.who.workspaceId, f.who.ownerId])
      await assert.rejects(factoryBoundary.commitFactoryTransaction(tx), { code: 'agentProfileScopeNotFound' })
      await factoryBoundary.rollbackFactoryTransaction(tx)
      assert.equal(await f.bindings(), 0); assert.equal(await f.runs(), 0)
      assert.throws(() => factoryBoundary.assertFactoryTransaction(tx), /factoryTransactionNotOwned/)
    } finally { await factoryBoundary.rollbackFactoryTransaction(tx); tx.release() }
  })

  await t.test('Factory savepoint rollback discards only its uncommitted Profile authority', async () => {
    const f = await outerFixture('savepoint'), tx = await pool.connect()
    let committed = false
    try {
      await factoryBoundary.beginFactoryTransaction(tx)
      const restore = factoryBoundary.factoryAuthorizationCheckpoint(tx)
      await tx.query('SAVEPOINT profile_selection')
      await f.queueMarker(tx, await f.select(tx))
      await tx.query('ROLLBACK TO SAVEPOINT profile_selection'); restore()
      await tx.query('RELEASE SAVEPOINT profile_selection')
      await pool.query(`UPDATE mikka_workspace_members SET status='suspended' WHERE "workspaceId"=$1 AND "userId"=$2`, [f.who.workspaceId, f.who.ownerId])
      await factoryBoundary.commitFactoryTransaction(tx); committed = true
      assert.equal(await f.bindings(), 0); assert.equal(await f.runs(), 0)
      await factoryBoundary.beginFactoryTransaction(tx)
      await factoryBoundary.commitFactoryTransaction(tx)
    } finally {
      if (!committed) await factoryBoundary.rollbackFactoryTransaction(tx)
      factoryBoundary.forgetFactoryTransaction(tx); tx.release()
    }
  })

  await t.test('an unregistered APP client cannot borrow Profile finalization authority', async () => {
    const f = await outerFixture('unregistered'), tx = await pool.connect()
    try {
      await tx.query('BEGIN')
      await assert.rejects(f.select(tx), /factoryTransactionNotOwned/)
      assert.equal(await f.bindings(), 0); assert.equal(await f.runs(), 0)
    } finally { await tx.query('ROLLBACK'); tx.release() }
  })

  for (const change of ['default-member', 'custom-member', 'default-source', 'custom-source', 'disabled', 'edited'] as const) await t.test(`planning ${change} change leaves no committed binding or run`, async () => {
    const who = await person(`profiles-planning-${change}`)
    const sourceId = await subscribe(who, 'codex', ['gpt-6-luna'])
    const device = randomUUID(), agentId = randomUUID(), taskIssue = await seedIssue(pool, who.ownerId, who.workspaceId)
    await pool.query(`INSERT INTO devices (id,"ownerId",name,kind,enabled,"lastSeenAt",harnesses) VALUES ($1,$2,'Planning boundary','local',true,now(),$3)`, [device, who.ownerId, JSON.stringify([{ harness: 'codex', installed: true, models: ['gpt-6-luna'], subscriptionBroker: true }])])
    await pool.query(`INSERT INTO agents (id,"userId","deviceId",name,harness) VALUES ($1,$2,$3,'Planning boundary','codex')`, [agentId, who.ownerId, device])
    const input = definition('Planning role', 'codex', sourceId, 'gpt-6-luna')
    const profile = change.startsWith('default-') ? undefined : await store.create(who, input)
    let planned = false
    await assert.rejects(profiles.resolveAgentProfileDispatch(pool, who, { issueId: taskIssue, location: 'local', profileId: profile?.id }, {
      resolve: async (...args) => {
        assert.equal(args[5]?.bindSubscription, false, 'planning must not write the chosen executor binding')
        const target = await resolveModelDispatch(...args)
        assert.equal(target.kind, 'device')
        planned = true
        if (change.endsWith('-member')) {
          const writer = await pool.connect()
          try {
            await writer.query('BEGIN')
            // NOWAIT proves the initial membership lease was released before planning.
            await writer.query('SELECT 1 FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=$2 FOR UPDATE NOWAIT', [who.workspaceId, who.ownerId])
            await writer.query("UPDATE mikka_workspace_members SET status='suspended' WHERE \"workspaceId\"=$1 AND \"userId\"=$2", [who.workspaceId, who.ownerId])
            await writer.query('COMMIT')
          } catch (error) { await writer.query('ROLLBACK'); throw error }
          finally { writer.release() }
        } else if (change.endsWith('-source')) await pool.query('UPDATE byos_connections SET paused=true WHERE id=$1', [sourceId])
        else await store.update(who, profile!.id, profile!.version, change === 'disabled' ? { ...input, enabled: false } : { ...input, instructions: 'Changed during planning.' })
        return target
      },
    }), { code: change.endsWith('-member') ? 'agentProfileScopeNotFound' : change.endsWith('-source') ? 'agentProfileModelUnavailable' : change === 'disabled' ? 'agentProfileDisabled' : 'agentProfileVersionConflict' })
    assert.equal(planned, true)
    assert.equal((await pool.query('SELECT 1 FROM byos_bindings WHERE "ownerId"=$1 AND "consumerId"=$2', [who.ownerId, agentId])).rowCount, 0)
    assert.equal((await pool.query('SELECT 1 FROM agent_runs WHERE "userId"=$1', [who.ownerId])).rowCount, 0)
  })

  for (const mode of ['default', 'custom', 'edited-concurrently'] as const) await t.test(mode === 'edited-concurrently' ? 'personal-source dispatch and Profile edits serialize without membership lock cycles' : `${mode} dispatch authorizes its personal source without holding a conflicting membership lease`, async () => {
    const who = await person(`profiles-shared-${mode}`)
    const sourceOwner = who.ownerId
    const connectionId = await subscribe({ ...who, ownerId: sourceOwner }, 'codex', ['gpt-6-luna'])
    await pool.query('INSERT INTO workspace_subscription_shares ("ownerId","workspaceId","allowOthers") VALUES ($1,$2,false)', [sourceOwner, who.workspaceId])
    const device = randomUUID(), agentId = randomUUID(), taskIssue = await seedIssue(pool, who.ownerId, who.workspaceId)
    await pool.query(`INSERT INTO devices (id,"ownerId",name,kind,enabled,"lastSeenAt",harnesses) VALUES ($1,$2,'Shared source','local',true,now(),$3)`, [device, who.ownerId, JSON.stringify([{ harness: 'codex', installed: true, models: ['gpt-6-luna'], subscriptionBroker: true }])])
    await pool.query(`INSERT INTO agents (id,"userId","deviceId",name,harness) VALUES ($1,$2,$3,'Shared source','codex')`, [agentId, who.ownerId, device])
    const input = definition('Shared role', 'codex', connectionId, 'gpt-6-luna')
    const profile = mode === 'default' ? undefined : await store.create(who, input)
    if (mode === 'edited-concurrently') {
      const { acquireWorkspaceMembership } = await import('../workspace-membership-guard')
      // Only the editor's APP statement is bounded for failure cleanup. The
      // production membership guard retains its real 20-second deadline.
      const editorPool = new Pool({ connectionString: dbUrl, max: 1, options: '-c lock_timeout=1000' })
      let memberReady!: (pid: number) => void, releaseEditor!: () => void
      const acquired = new Promise<number>(resolve => { memberReady = resolve })
      const proceed = new Promise<void>(resolve => { releaseEditor = resolve })
      const editor = new profiles.AgentProfileStore(editorPool, { membership: async identity => {
        const member = await acquireWorkspaceMembership(workspacePool, { workspaceId: identity.workspaceId, userId: identity.ownerId })
        assert.ok(member.workspaceClient)
        const { rows: [backend] } = await member.workspaceClient.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
        memberReady(backend.pid)
        await proceed
        return member
      } })
      let editing: ReturnType<typeof editor.update> | undefined
      const dispatch = profiles.resolveAgentProfileDispatch(pool, who, { issueId: taskIssue, location: 'local', profileId: profile!.id }, {
        resolve: async (...args) => {
          const target = await resolveModelDispatch(...args)
          editing = editor.update(who, profile!.id, profile!.version, { ...input, instructions: 'Edited while shared-source admission is authorizing membership.' })
          void editing.catch(() => {})
          await acquired
          return target
        },
      })
      let dispatchFinished = false
      const result = dispatch.then(value => ({ value, error: undefined }), (error: unknown) => ({ value: undefined, error })).finally(() => { dispatchFinished = true })
      try {
        const memberPid = await acquired
        let blocked = false
        for (let attempt = 0; attempt < 200; attempt++) {
          blocked = (await pool.query<{ blocked: boolean }>('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1::int=ANY(pg_blocking_pids(pid))) AS blocked', [memberPid])).rows[0].blocked
          if (blocked || dispatchFinished) break
          await new Promise(resolve => setTimeout(resolve, 10))
        }
        assert.equal(blocked || dispatchFinished, true, 'shared admission reaches either its authorization boundary or a completed result')
        releaseEditor()
        const updated = await editing!
        assert.equal(updated.version, profile!.version + 1)
        const outcome = await result
        if (outcome.error) {
          assert.ok(outcome.error instanceof profiles.AgentProfileError)
          assert.equal(outcome.error.code, 'agentProfileVersionConflict')
          assert.equal((await pool.query('SELECT 1 FROM byos_bindings WHERE "consumerId"=$1', [agentId])).rowCount, 0)
        } else {
          const selected = outcome.value; assert.ok(selected)
          assert.equal(selected.agentProfile?.version, profile!.version)
          assert.equal(selected.agentProfile?.digest, profile!.digest)
          if (selected.target.kind !== 'device') assert.fail('the serialized dispatch selects the authorized device')
          const binding = (await pool.query('SELECT "ownerId","consumerId","connectionId","modelId" FROM byos_bindings WHERE id=$1', [selected.target.subscriptionBindingId])).rows[0]
          assert.equal(binding.ownerId, sourceOwner)
          assert.equal(binding.consumerId, agentId)
          assert.equal(binding.connectionId, connectionId)
          assert.equal(binding.modelId, selected.target.model)
          await assert.rejects(profiles.assertProfileSelection(pool, who, selected.agentProfile!), { code: 'agentProfileVersionConflict' })
        }
        assert.equal((await pool.query('SELECT 1 FROM agent_runs WHERE "userId"=$1', [who.ownerId])).rowCount, 0)
      } finally {
        releaseEditor()
        await Promise.allSettled([editing, result])
        await editorPool.end()
      }
      return
    }
    const selected = await profiles.resolveAgentProfileDispatch(pool, who, { issueId: taskIssue, location: 'local', profileId: profile?.id })
    if (selected.target.kind !== 'device') assert.fail('the shared source should select the authorized executor')
    assert.equal(selected.agentProfile?.source, mode === 'default' ? 'default' : 'explicit')
    assert.deepEqual(selected.target.entry.source, { kind: 'subscription', connectionId })
    const binding = (await pool.query('SELECT "ownerId","workspaceId","consumerId","connectionId","modelId" FROM byos_bindings WHERE id=$1', [selected.target.subscriptionBindingId])).rows[0]
    assert.equal(binding.ownerId, sourceOwner)
    assert.equal(binding.workspaceId, who.workspaceId)
    assert.equal(binding.consumerId, agentId)
    assert.equal(binding.connectionId, connectionId)
    assert.equal(binding.modelId, selected.target.model)
  })

  await t.test('subscription authorization requires the parent workspace and an active matching member', async () => {
    const { authorizeSubscriptionWorkspace } = await import('../subscription-runtime')
    const who = await person('profiles-authorization')
    await authorizeSubscriptionWorkspace(who.ownerId, who.workspaceId)
    await assert.rejects(authorizeSubscriptionWorkspace(foreign.ownerId, who.workspaceId), { code: 'workspaceAccessDenied' })
    await assert.rejects(authorizeSubscriptionWorkspace(who.ownerId, 'invalid-workspace-id'), { name: 'ZodError' })
    await pool.query("UPDATE mikka_workspace_members SET status='suspended' WHERE \"workspaceId\"=$1 AND \"userId\"=$2", [who.workspaceId, who.ownerId])
    await assert.rejects(authorizeSubscriptionWorkspace(who.ownerId, who.workspaceId), { code: 'workspaceAccessDenied' })
    await pool.query('DELETE FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=$2', [who.workspaceId, who.ownerId])
    await assert.rejects(authorizeSubscriptionWorkspace(who.ownerId, who.workspaceId), { code: 'workspaceAccessDenied' })
    const orphan = await seedWorkspace(pool, who.ownerId, [{ userId: who.ownerId, role: 'admin' }]); workspaces.push(orphan.id)
    await pool.query('DELETE FROM mikka_workspaces WHERE id=$1', [orphan.id])
    assert.equal((await pool.query('SELECT 1 FROM mikka_workspace_members WHERE "workspaceId"=$1 AND status=\'active\'', [orphan.id])).rowCount, 1)
    await assert.rejects(authorizeSubscriptionWorkspace(who.ownerId, orphan.id), { code: 'workspaceAccessDenied' })
  })

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
          return { answers: new Map<string, Exclude<DecisionAnswer, { type: 'refusal' }>>([['profile', { name: 'profile', type: 'choice', choice: `${selected.id}:capability_fit`, confidence: .95 }]]), execution: { executionId: randomUUID(), modelId: 'openai/gpt-6-luna-decisions', providerGenerationId: 'fixture-decision', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), requestDigest: 'a'.repeat(64), imageDigests: [], vision: 'no-image-input' } }
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
        return { answers: new Map<string, Exclude<DecisionAnswer, { type: 'refusal' }>>([['profile', { name: 'profile', type: 'choice', choice: `${current.id}:stage_fit`, confidence: .95 }]]), execution: { executionId: randomUUID(), modelId: 'openai/gpt-6-luna-decisions', providerGenerationId: 'fixture-racing-decision', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), requestDigest: 'b'.repeat(64), imageDigests: [], vision: 'no-image-input' } }
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
  for (const mode of ['fixed', 'inherit', 'legacy', 'botless'] as const) await t.test(mode === 'legacy' ? 'watchdog preserves historical absence of Profile through queue and first claim on B' : `watchdog ${mode} Profile uses B's real source and retains the started role through queue and first claim`, async () => {
    const [{ createFactoryStore }, { createFactoryDispatch, factoryBinding }, { queueFactoryRun }, { automaticFactoryDispatch },
      { sweepFactoryWatchdog }, { claimLocalRun }, { assertRunProfileClaim, admitProfileSelection }, { profileNativeSessionMatches },
      { DAEMON_PROTOCOL_VERSION }, { workerDefinitionDigest }] = await Promise.all([
      import('./store'), import('./dispatch'), import('../agent-runs'), import('./automatic-dispatch'), import('./watchdog'),
      import('../computer/claim'), import('./profile-admission'), import('./profile-native-session'), import('@mikka/protocol/daemon'), import('../agent-kit/worker-digest'),
    ])
    const who = await person(`watchdog-profile-${mode}`)
    const botId = mode === 'botless' ? null : await seedBot(pool, who.workspaceId, who.ownerId)
    if (mode === 'botless') {
      const personal = await seedPersonalWorkspace(pool, who.ownerId); workspaces.push(personal)
      await pool.query('UPDATE mikka_workspaces SET "createdAt"=\'2000-01-01\' WHERE id=$1', [personal])
    }
    const taskIssue = await seedIssue(pool, who.ownerId, who.workspaceId), epoch = randomUUID()
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
      model: mode === 'fixed' ? { mode, harness: 'codex', model: 'gpt-6-luna', source: { kind: 'subscription', connectionId: primary } } : { mode: 'inherit' },
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
    assert.equal(run.workspaceId, who.workspaceId)
    assert.equal(run.agentDefinition.executionIdentity.workspaceId, who.workspaceId)
    assert.equal(run.botId, botId)
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
    const issue = await seedIssue(pool, who.ownerId, who.workspaceId)
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
