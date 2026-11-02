import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SubscriptionService } from './subscription-service'
import { subscriptionFixture } from '../tests/fixtures/subscription'

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
