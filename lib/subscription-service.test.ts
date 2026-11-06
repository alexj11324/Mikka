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

test('a reset crossed since a recent observation triggers a real provider read before execution', async () => {
  const { use, access } = subscriptionFixture('claude_cpa')
  const now = Date.now()
  access.connection!.quota.observedAt = new Date(now - 2_000).toISOString()
  access.connection!.quota.windows = [{ kind: 'five_hour', used: 1, resetsAt: new Date(now - 1_000).toISOString() }]
  const row = { id: access.connection!.id, ownerId: use.ownerId, workspaceId: use.workspaceId, provider: 'claude', state: 'connected', epoch: '1', quota: access.connection!.quota }
  const methods: string[] = []
  const repository = { binding: async () => ({ ...access.binding!, modelId: 'claude-haiku-5-5' }), connection: async () => row, scope: () => ({}), saveQuota: async (_row: unknown, quota: typeof row.quota) => { row.quota = quota } } as unknown as SubscriptionService['repository']
  const worker = (() => ({ forUse: () => ({ call: async (method: string) => { methods.push(method); return { status: 200, body: { five_hour: { utilization: 20 } } } } }) })) as never
  const service = new SubscriptionService(repository, worker, { ready: () => true, nativeIsolation: 'none' }, undefined, async () => undefined)
  await service.check(use)
  assert.deepEqual(methods, ['prepare', 'quota'])
  assert.equal(row.quota.windows[0].used, .2)
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
