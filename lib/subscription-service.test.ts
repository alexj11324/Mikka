import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SubscriptionService } from './subscription-service'
import { subscriptionFixture } from '../tests/fixtures/subscription'

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
