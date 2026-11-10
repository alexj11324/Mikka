import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { beforeEach, mock, test } from 'node:test'
import type { Pool } from 'pg'

let afterDiscovery: (() => void) | undefined
const members: string[] = []
mock.module(new URL('../subscription-runtime.ts', import.meta.url).href, { namedExports: {
  authorizeSubscriptionWorkspace: async (owner: string) => { members.push(owner) },
} })
const { nativeRunBinding } = await import('./native-run-binding')
const { SubscriptionRepository } = await import('../subscription-repository')
const userId = 'requester', workspaceId = randomUUID(), agentId = randomUUID()
beforeEach(() => { members.length = 0; afterDiscovery = undefined })

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
      assert.ok(sql.includes('JOIN agents a') && sql.includes('c.epoch=b."connectionRevision"') && sql.includes('(b."ownerId"=$1 AND (b."workspaceId")::text IS NOT NULL)'))
      assert.ok(sql.includes('b."ownerId"=$6') && sql.includes('b."workspaceId"=$5'))
      assert.deepEqual(values, [userId, agentId, 'codex_cli', binding.id, workspaceId, binding.ownerId, 'codex'])
      const valid = binding.ownerId === userId && state.present && state.agentOwned && state.connected && !state.paused && state.epoch === binding.connectionRevision
      return { rows: valid ? [{ ...binding }] : [], rowCount: Number(valid) }
    }
    if (sql.startsWith('SELECT b.id')) {
      const rows = state.present ? [{ id: binding.id, ownerId: binding.ownerId, workspaceId }] : []
      afterDiscovery?.()
      return { rows }
    }
    if (sql.startsWith('select id,')) return { rows: state.present ? [{ ...binding }] : [] }
    assert.ok(sql.startsWith('SELECT 1 FROM byos_connections'))
    return { rows: [], rowCount: Number(state.connected && !state.paused && state.epoch === binding.connectionRevision) }
  }
  return { binding, calls, state, pool: { query } as unknown as Pick<Pool, 'query'> }
}

test('native Owner execution combines its final binding and connection read', async () => {
  const f = fixture(false)
  assert.deepEqual(await nativeRunBinding(f.pool, userId, agentId, 'codex', workspaceId, f.binding.id), f.binding)
  assert.equal(f.calls.length, 2)
  assert.deepEqual(members, [])
})

test('a forged shared binding is refused before any owner catalogue or membership is consulted', async () => {
  const f = fixture(true)
  assert.equal(await nativeRunBinding(f.pool, userId, agentId, 'codex', workspaceId, f.binding.id), null)
  assert.equal(f.calls.length, 1)
  assert.deepEqual(members, [])
})

for (const changed of ['present', 'agentOwned', 'connected', 'epoch'] as const) test(`native Owner execution rereads ${changed} after discovery`, async () => {
  const f = fixture(false)
  afterDiscovery = () => { if (changed === 'epoch') f.state.epoch++; else f.state[changed] = false }
  assert.equal(await nativeRunBinding(f.pool, userId, agentId, 'codex', workspaceId, f.binding.id), null)
  assert.deepEqual(members, [])
  assert.equal(f.calls.length, 2)
})

test('legacy sharing metadata cannot revoke the Owner own subscription', async () => {
  const f = fixture(false)
  afterDiscovery = () => { f.state.share = false }
  assert.deepEqual(await nativeRunBinding(f.pool, userId, agentId, 'codex', workspaceId, f.binding.id), f.binding)
  assert.deepEqual(members, [])
})

test('a native scheduling history read still exposes an unavailable selection for existing callers', async () => {
  const f = fixture(false)
  f.state.connected = false
  assert.deepEqual(await new SubscriptionRepository(f.pool).nativeBinding(userId, agentId, 'codex', f.binding.id, workspaceId), f.binding)
  assert.equal(f.calls.length, 2)
  assert.equal(f.calls.some(sql => sql.includes('JOIN byos_connections c')), false)
})
