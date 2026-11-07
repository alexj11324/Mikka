import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { beforeEach, mock, test } from 'node:test'
import type { Pool } from 'pg'

let afterMember: (() => void) | undefined
const members: string[] = []
mock.module(new URL('../subscription-runtime.ts', import.meta.url).href, { namedExports: {
  authorizeSubscriptionWorkspace: async (owner: string) => { members.push(owner); afterMember?.() },
} })
const { nativeRunBinding } = await import('./native-run-binding')
const { SubscriptionRepository } = await import('../subscription-repository')
const userId = 'requester', workspaceId = randomUUID(), agentId = randomUUID()
beforeEach(() => { members.length = 0; afterMember = undefined })

// Query-boundary sequencing only; the actual joined predicates run against
// PostgreSQL in subscription-repository.db.test.ts and backend.db.test.ts.
function fixture(shared: boolean) {
  const binding = { id: randomUUID(), ownerId: shared ? 'payor' : userId, workspaceId, consumerId: agentId,
    connectionId: randomUUID(), connectionRevision: 3, route: 'codex_cli', modelId: 'fixture-model' }
  const calls: string[] = []
  const state = { present: true, share: true, agentOwned: true, connected: true, paused: false, epoch: 3 }
  const query = async (sql: string, values: unknown[]) => {
    calls.push(sql)
    if (sql.includes('JOIN byos_connections c')) {
      assert.ok(sql.includes('JOIN agents a') && sql.includes('c.epoch=b."connectionRevision"') && sql.includes('workspace_subscription_shares'))
      assert.ok(sql.includes('b."ownerId"=$6') && sql.includes('b."workspaceId"=$5'))
      assert.deepEqual(values, [userId, agentId, 'codex_cli', binding.id, workspaceId, binding.ownerId, 'codex'])
      const valid = state.present && state.share && state.agentOwned && state.connected && !state.paused && state.epoch === binding.connectionRevision
      return { rows: valid ? [{ ...binding }] : [], rowCount: Number(valid) }
    }
    if (sql.startsWith('SELECT b.id')) return { rows: state.present ? [{ id: binding.id, ownerId: binding.ownerId, workspaceId }] : [] }
    if (sql.startsWith('select id,')) return { rows: state.present ? [{ ...binding }] : [] }
    assert.ok(sql.startsWith('SELECT 1 FROM byos_connections'))
    return { rows: [], rowCount: Number(state.connected && !state.paused && state.epoch === binding.connectionRevision) }
  }
  return { binding, calls, state, pool: { query } as unknown as Pick<Pool, 'query'> }
}

for (const shared of [false, true]) test(`native ${shared ? 'shared' : 'own'} execution combines its final binding and connection read`, async () => {
  const f = fixture(shared)
  assert.deepEqual(await nativeRunBinding(f.pool, userId, agentId, 'codex', workspaceId, f.binding.id), f.binding)
  assert.equal(f.calls.length, 2)
  assert.deepEqual(members, shared ? [userId, 'payor'] : [])
})

for (const changed of ['present', 'share', 'agentOwned', 'connected', 'epoch'] as const) test(`native execution rereads ${changed} after both membership checks`, async () => {
  const f = fixture(true)
  afterMember = () => { if (members.length === 2) { if (changed === 'epoch') f.state.epoch++; else f.state[changed] = false } }
  assert.equal(await nativeRunBinding(f.pool, userId, agentId, 'codex', workspaceId, f.binding.id), null)
  assert.deepEqual(members, [userId, 'payor'])
  assert.equal(f.calls.length, 2)
})

test('a native scheduling history read still exposes an unavailable selection for existing callers', async () => {
  const f = fixture(false)
  f.state.connected = false
  assert.deepEqual(await new SubscriptionRepository(f.pool).nativeBinding(userId, agentId, 'codex', f.binding.id, workspaceId), f.binding)
  assert.equal(f.calls.length, 2)
  assert.equal(f.calls.some(sql => sql.includes('JOIN byos_connections c')), false)
})
