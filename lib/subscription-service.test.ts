import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SubscriptionService } from './subscription-service'
import { subscriptionFixture } from '../tests/fixtures/subscription'

for (const route of ['claude_cpa', 'codex_cpa'] as const) {
  test(`${route}: model construction reuses its checked connection scope without weakening later access`, async () => {
    const { use, access } = subscriptionFixture(route)
    access.connection!.quota.observedAt = new Date().toISOString()
    const provider = route === 'claude_cpa' ? 'claude' as const : 'codex' as const
    const row = { id: access.connection!.id, ownerId: use.ownerId, workspaceId: 'custody-workspace', provider, state: 'connected', epoch: '1', quota: access.connection!.quota }
    let bindings = 0, connections = 0, memberships = 0, admissions = 0, streams = 0
    const scopes: Array<Parameters<SubscriptionService['worker']>[0]> = []
    const repository = {
      binding: async () => { bindings++; return { ...access.binding!, modelId: 'fixture-model' } },
      connection: async () => { connections++; return structuredClone(row) },
      scope: (connection: typeof row) => ({ ownerId: connection.ownerId, workspaceId: connection.workspaceId, connectionId: connection.id, provider: connection.provider }),
    } as unknown as SubscriptionService['repository']
    const worker = { forUse() { return this }, stream() { streams++; throw new Error('revoked model reached provider') } }
    const service = new SubscriptionService(repository, scope => { scopes.push(scope); return worker as never },
      { ready: () => true, nativeIsolation: 'none' }, undefined, async () => { memberships++ }, async () => { admissions++ })
    const model = await service.model(use)
    assert.deepEqual({ bindings, connections, memberships, admissions }, { bindings: 2, connections: 2, memberships: 1, admissions: 1 })
    assert.deepEqual(scopes, [{ ownerId: use.ownerId, workspaceId: 'custody-workspace', connectionId: row.id, provider }])

    row.state = 'disconnected'
    await assert.rejects(async () => model.doStream({ prompt: [] }), { code: 'disconnected' })
    assert.deepEqual({ bindings, connections, memberships, admissions, streams }, { bindings: 3, connections: 4, memberships: 2, admissions: 1, streams: 0 })
  })
}

test('the trusted actual native model checks its own allowance instead of the saved binding model', async () => {
  const { use, access } = subscriptionFixture('claude_code_cli')
  access.connection!.quota.observedAt = new Date().toISOString()
  access.connection!.quota.windows.push({ kind: 'weekly', model: 'Opus', used: 1, resetsAt: null })
  const row = { id: access.connection!.id, ownerId: use.ownerId, workspaceId: use.workspaceId, provider: 'claude', state: 'connected', epoch: '1', quota: access.connection!.quota }
  const repository = { binding: async () => ({ ...access.binding!, modelId: 'claude-opus-5-5' }), connection: async () => row } as unknown as SubscriptionService['repository']
  const service = new SubscriptionService(repository, () => { throw new Error('fresh model-scoped quota needs no worker') }, { ready: () => true, nativeIsolation: 'verified_runtime' }, undefined, async () => undefined)
  await service.check(use, undefined, 'claude-haiku-5-5')
  await service.check(use, undefined, 'claude-sonnet-5-5')
  await assert.rejects(service.check(use, undefined, 'claude-opus-5-5'), { code: 'quota_exhausted' })
})

for (const sample of [
  { name: 'hosted model', route: 'claude_cpa', preparation: 'prepareStream' },
  { name: 'native execution', route: 'claude_code_cli', preparation: 'prepare' },
  { name: 'run-bound model', route: 'claude_cpa', preparation: 'prepare', runId: 'fixture-run' },
] as const) test(`${sample.name}: a crossed quota reset refreshes allowance with its supported preparation`, async () => {
  const { use, access } = subscriptionFixture(sample.route)
  if ('runId' in sample) use.runId = sample.runId
  const now = Date.now()
  access.connection!.quota.observedAt = new Date(now - 2_000).toISOString()
  access.connection!.quota.windows = [{ kind: 'five_hour', used: 1, resetsAt: new Date(now - 1_000).toISOString() }]
  const row = { id: access.connection!.id, ownerId: use.ownerId, workspaceId: use.workspaceId, provider: 'claude', state: 'connected', epoch: '1', quota: access.connection!.quota }
  const methods: string[] = []
  const repository = { binding: async () => ({ ...access.binding!, modelId: 'claude-haiku-5-5' }), connection: async () => row, scope: () => ({}), saveQuota: async (_row: unknown, quota: typeof row.quota) => { row.quota = quota } } as unknown as SubscriptionService['repository']
  const worker = (() => ({ forUse: (actual: typeof use) => {
    assert.deepEqual(actual, use)
    return { call: async (method: string) => { methods.push(method); return { status: 200, body: { five_hour: { utilization: 20 } } } } }
  } })) as never
  const service = new SubscriptionService(repository, worker, { ready: () => true, nativeIsolation: 'verified_runtime' }, undefined, async () => undefined)
  await service.check(use)
  assert.deepEqual(methods, [sample.preparation, 'quota'])
  assert.equal(row.quota.windows[0].used, .2)
  await service.check(use)
  assert.deepEqual(methods, [sample.preparation, 'quota'], 'fresh allowance does not repeat custody or provider reads')
})

for (const route of ['codex_cpa', 'claude_cpa', 'codex_cli', 'claude_code_cli'] as const) {
  test(`${route}: the owner's subscription works in another authorized workspace without moving its custody scope`, async () => {
    const { use, access } = subscriptionFixture(route)
    access.connection!.quota.observedAt = new Date().toISOString()
    const connection = {
      id: access.connection!.id, ownerId: use.ownerId, workspaceId: 'original-workspace',
      provider: route.startsWith('codex') ? 'codex' : 'claude', state: 'connected', epoch: '1',
      quota: access.connection!.quota,
    }
    const membership: unknown[][] = []
    let revoked = false
    const repository = {
      binding: async () => ({ ...access.binding!, modelId: 'fixture-model' }),
      connection: async () => connection,
    } as unknown as SubscriptionService['repository']
    const service = new SubscriptionService(repository, () => { throw new Error('fresh quota needs no worker') },
      { ready: () => true, nativeIsolation: 'verified_runtime' }, undefined,
      async (...scope) => { if (revoked) throw new Error('membership revoked'); membership.push(scope) })

    const result = await service.check(use)
    assert.equal(result.binding.workspaceId, use.workspaceId)
    assert.equal(result.connection.workspaceId, 'original-workspace')
    assert.equal(result.backend.workspaceId, 'original-workspace')
    assert.equal(connection.workspaceId, 'original-workspace', 'never rewrite the vault-bound connection scope')
    assert.deepEqual(membership, [[use.ownerId, use.workspaceId, use.consumerId]])

    await assert.rejects(service.check({ ...use, workspaceId: 'unbound-workspace' }), { code: 'binding_mismatch' })
    revoked = true
    await assert.rejects(service.check(use), /membership revoked/)
  })
}

for (const route of ['codex_cli', 'claude_code_cli'] as const) {
  test(`${route}: initial lease preserves admission and uses one custody handoff with natural expiry`, async () => {
    const { use, access } = subscriptionFixture(route)
    access.connection!.quota.observedAt = new Date().toISOString()
    const row = { id: access.connection!.id, ownerId: use.ownerId, workspaceId: use.workspaceId,
      provider: route === 'codex_cli' ? 'codex' : 'claude', state: 'connected', epoch: '1', quota: access.connection!.quota }
    const repository = { binding: async () => ({ ...access.binding!, modelId: 'fixture-model' }), connection: async () => row, scope: () => ({}) } as unknown as SubscriptionService['repository']
    const methods: string[] = [], admissions: boolean[] = []
    let denyAt = 0
    const refusal = new Error('fixture policy revoked')
    const worker = { forUse() { return this }, async call(method: string) {
      methods.push(method)
      return { accessToken: 'fixture-access', expiresAt: '2030-01-01T00:00:00.000Z',
        ...(route === 'codex_cli' ? { chatgptAccountId: 'fixture-account', chatgptPlanType: 'pro' } : { accountId: 'fixture-account' }) }
    } }
    const service = new SubscriptionService(repository, () => worker as never,
      { ready: () => true, nativeIsolation: 'verified_runtime' }, undefined, async () => undefined,
      async (_scope, _model, _route, _signal, auditAllowed) => {
        admissions.push(auditAllowed !== false)
        if (admissions.length === denyAt) throw refusal
      })
    const lease = await service.nativeLease(use)
    assert.equal(lease.accessToken, 'fixture-access')
    assert.equal(lease.accountId, 'fixture-account')
    assert.equal(lease.expiresAt, '2030-01-01T00:00:00.000Z')
    assert.equal(lease.route, route)
    assert.deepEqual(methods, ['nativeAuth'], 'credential preparation must not spawn redundant prepare/context workers')
    assert.deepEqual(admissions, [false, false])
    Object.assign(row, { modelCatalog: { revision: 1, models: ['fixture-model'] } })
    const negotiated = await service.nativeLease(use, undefined, true)
    assert.equal(negotiated.modelCatalogueVerified, route === 'claude_code_cli' ? true : undefined,
      'catalogue evidence never broadens Codex beyond its official CLI report')
    for (denyAt of [1, 2]) {
      methods.length = 0; admissions.length = 0
      await assert.rejects(service.nativeLease(use), error => error === refusal)
      assert.deepEqual(methods, [])
    }
  })

  test(`${route}: context checks both admissions without generation audit; actual requests retain audit`, async () => {
    const { use, access } = subscriptionFixture(route)
    access.connection!.quota.observedAt = new Date().toISOString()
    const row = { id: access.connection!.id, ownerId: use.ownerId, workspaceId: use.workspaceId,
      provider: route === 'codex_cli' ? 'codex' : 'claude', state: 'connected', epoch: '1', quota: access.connection!.quota }
    const repository = { binding: async () => ({ ...access.binding!, modelId: 'fixture-model' }),
      connection: async () => row, scope: () => ({}) } as unknown as SubscriptionService['repository']
    const admissions: Array<boolean | undefined> = [], methods: string[] = []
    let denyAt = 0
    const refusal = new Error('modelPolicyRevoked')
    const worker = { forUse() { return this }, async call(method: string) {
      methods.push(method)
      return { accountId: 'fixture-account', expiresAt: new Date(Date.now() + 60_000).toISOString() }
    }, async nativeRequest() { methods.push('request'); return { contentType: 'text/event-stream', body: new ReadableStream() } } }
    const service = new SubscriptionService(repository, () => worker as never,
      { ready: () => true, nativeIsolation: 'verified_runtime' }, undefined, async () => undefined,
      async (_scope, _model, _route, _signal, auditAllowed?: boolean) => {
        admissions.push(auditAllowed)
        if (admissions.length === denyAt) throw refusal
      })
    await service.nativeContext(use)
    await service.nativeContext(use)
    assert.deepEqual(admissions, [false, false, false, false])
    assert.deepEqual(methods, ['prepare', 'nativeContext', 'prepare', 'nativeContext'])
    admissions.length = 0; methods.length = 0
    await service.nativeRequest(use, { path: route === 'codex_cli' ? '/responses' : '/v1/messages', headers: {}, body: { model: 'fixture-model' } })
    assert.deepEqual(admissions, [undefined, undefined], 'real generation keeps default audit semantics')
    assert.deepEqual(methods, ['request'])
    for (denyAt of [1, 2]) {
      admissions.length = 0; methods.length = 0
      await assert.rejects(service.nativeContext(use), error => error === refusal)
      assert.equal(admissions.length, denyAt, 'neither pre-access nor post-access admission can be skipped')
      assert.ok(admissions.every(value => value === false))
      assert.deepEqual(methods, [], 'a denied context cannot prepare or invoke the provider worker')
    }
  })
}

test('a full Claude model ID is admitted only by the authorized connection catalogue at its current epoch', async () => {
  const { use, access } = subscriptionFixture('claude_code_cli')
  access.connection!.quota.observedAt = new Date().toISOString()
  const row = { id: access.connection!.id, ownerId: use.ownerId, workspaceId: use.workspaceId,
    provider: 'claude', state: 'connected', epoch: '1', quota: access.connection!.quota,
    modelCatalog: { revision: 1, models: ['claude-sonnet-5'] } as { revision: number; models: string[] } | null }
  const repository = { binding: async () => ({ ...access.binding!, modelId: 'claude-sonnet-5' }), connection: async () => row, scope: () => ({}) } as unknown as SubscriptionService['repository']
  const calls: string[] = []
  const worker = { forUse() { return this }, async call(method: string) {
    calls.push(method)
    return { accountId: 'fixture-account', expiresAt: new Date(Date.now() + 60_000).toISOString() }
  } }
  const service = new SubscriptionService(repository, () => worker as never,
    { ready: () => true, nativeIsolation: 'verified_runtime' }, undefined, async () => undefined, async () => undefined)
  const context = await service.nativeContext(use, undefined, true)
  assert.equal(context.modelId, 'claude-sonnet-5')
  assert.deepEqual(Object.keys(context).sort(), ['accountId', 'expiresAt', 'modelId', 'revision', 'route'], 'existing daemons keep the same strict response shape')
  for (const catalogue of [null, { revision: 0, models: ['claude-sonnet-5'] }, { revision: 1, models: ['another-model'] }]) {
    row.modelCatalog = catalogue
    calls.length = 0
    await assert.rejects(service.nativeContext(use, undefined, true), { code: 'binding_mismatch' })
    assert.deepEqual(calls, [], 'unknown or stale evidence cannot prepare a provider session')
  }
  await service.nativeContext(use)
  assert.deepEqual(calls, ['prepare', 'nativeContext'], 'legacy model-probe contexts keep their original behavior')
})

test('prepared Claude leases carry only negotiated current-account evidence for the actual selected model', async () => {
  const { use, access } = subscriptionFixture('claude_code_cli')
  use.runId = 'fixture-run'
  access.connection!.quota.observedAt = new Date().toISOString()
  const model = 'claude-haiku-5-5', boundModel = 'claude-sonnet-5'
  const row = { id: access.connection!.id, ownerId: use.ownerId, workspaceId: use.workspaceId,
    provider: 'claude', state: 'connected', epoch: '1', quota: access.connection!.quota,
    modelCatalog: { revision: 1, models: [model] } as { revision: number; models: string[] } | null }
  const repository = {
    pool: { query: async () => ({ rows: [{ userId: use.ownerId, agentDefinition: { cliModelSelection: 'explicit', model } }] }) },
    binding: async () => ({ ...access.binding!, modelId: boundModel }),
    connection: async (ownerId: string, connectionId: string) => {
      assert.equal(ownerId, use.ownerId)
      assert.equal(connectionId, access.binding!.connectionId, 'only the selected account can provide evidence')
      return row
    },
    scope: () => ({}),
  } as unknown as SubscriptionService['repository']
  const calls: string[] = []
  const worker = { forUse() { return this }, async call(method: string) {
    calls.push(method)
    return { accessToken: 'fixture-access', accountId: 'fixture-account', expiresAt: '2030-01-01T00:00:00.000Z' }
  } }
  const service = new SubscriptionService(repository, () => worker as never,
    { ready: () => true, nativeIsolation: 'verified_runtime' }, undefined, async () => undefined, async () => undefined)
  const oldLease = await service.nativeLease(use)
  assert.equal(oldLease.modelId, model)
  assert.equal(Object.hasOwn(oldLease, 'modelCatalogueVerified'), false, 'old strict clients keep the exact original shape')
  assert.deepEqual(Object.keys(oldLease).sort(), ['accessToken', 'accountId', 'expiresAt', 'modelId', 'revision', 'route'])
  const verified = await service.nativeLease(use, undefined, true)
  assert.equal(verified.modelCatalogueVerified, true)
  assert.equal(verified.modelId, model, 'catalogue evidence follows the frozen run model, not the saved binding default')
  for (const catalogue of [null, { revision: 0, models: [model] }, { revision: 1, models: [boundModel] }]) {
    row.modelCatalog = catalogue
    const unverified = await service.nativeLease(use, undefined, true)
    assert.equal(unverified.modelCatalogueVerified, undefined)
  }
  assert.deepEqual(calls, Array(5).fill('nativeAuth'), 'no extra context, preparation, model probe or provider call')
})
