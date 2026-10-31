import assert from 'node:assert/strict'
import test from 'node:test'
import { SubscriptionService } from './subscription-service'
import { SubscriptionRepository, type ConnectionRow } from './subscription-repository'

const base: ConnectionRow = { id: 'connection', ownerId: 'owner', workspaceId: 'workspace', provider: 'claude', state: 'connected', epoch: '3', quota: null }
function fixture(result: unknown, after?: Partial<ConnectionRow>) {
  let reads = 0
  const calls: unknown[][] = []
  const repository = Object.assign(new SubscriptionRepository({ query: async () => ({ rows: [] }) } as never), {
    connection: async (ownerId: string, id: string) => { assert.equal(ownerId, 'owner'); assert.equal(id, base.id); return reads++ ? { ...base, ...after } : base },
  })
  const worker = () => ({ call: async (...args: unknown[]) => { calls.push(args); return result } }) as never
  const service = new SubscriptionService(repository, worker, { ready: () => false, nativeIsolation: 'none' }, undefined, async (ownerId, workspaceId) => { assert.equal(ownerId, 'owner'); assert.equal(workspaceId, 'workspace') })
  return { service, calls }
}
test('models refresh calls one account and projects/deduplicates the provider list', async () => {
  const { service, calls } = fixture([{ id: 'provider-model', name: 'Provider model', description: 'excluded' }, { id: 'provider-model', name: 'duplicate' }])
  assert.deepEqual(await service.models('owner', 'connection'), [{ id: 'provider-model', name: 'Provider model' }])
  assert.deepEqual(calls, [['models', { revision: 3 }, undefined]])
})
test('models refuse reconnect races and malformed worker catalogues', async () => {
  for (const after of [{ state: 'disconnected' }, { epoch: '4' }]) await assert.rejects(fixture([], after).service.models('owner', 'connection'), { code: 'stale_binding' })
  for (const result of [{}, [{ id: 'invalid id', name: 'x' }], [{ id: 'model', name: 'bad\nname' }]]) await assert.rejects(fixture(result).service.models('owner', 'connection'), { code: 'backend_unavailable' })
})
