import assert from 'node:assert/strict'
import { beforeEach, mock, test } from 'node:test'
import type { Pool } from 'pg'
import type { OrderCandidate, OrderEntry } from './model-order-plan'

const scope = { ownerId: 'requester', workspaceId: 'workspace' }
const entry: OrderEntry = { id: 'selected', harness: 'claude_code', model: 'claude-haiku-5-5',
  source: { kind: 'subscription', connectionId: 'connection' } }
let credentialOwner = scope.ownerId, memberAllowed = true, shareAllowed = true, stale = true
const calls: string[] = []
const quota = () => ({ vendor: 'claude_code', source: 'official', status: 'ok', plan: 'Pro',
  observedAt: new Date(Date.now() - (stale ? 61_000 : 0)).toISOString(),
  windows: [{ kind: 'five_hour', used: .2, resetsAt: '2030-01-01T00:00:00Z' }] })
mock.module(new URL('./subscription-runtime.ts', import.meta.url).href, { namedExports: { subscriptionRuntime: () => ({
  member: async (owner: string, workspace: string) => { calls.push('member'); assert.deepEqual([owner, workspace], [scope.ownerId, scope.workspaceId]); if (!memberAllowed) throw new Error('fixture membership revoked') },
  workspace: async (owner: string, workspace: string) => { calls.push('workspace'); assert.deepEqual([owner, workspace], [credentialOwner, scope.workspaceId]) },
  usage: async () => { calls.push('settings-usage'); stale = false },
  allowance: async (owner: string, connection: string, signal: AbortSignal) => {
    calls.push('allowance'); assert.deepEqual([owner, connection], [credentialOwner, 'connection'])
    assert.equal(signal.aborted, false); stale = false
  },
}) } })
mock.module(new URL('./personal-policy.ts', import.meta.url).href, { namedExports: {
  othersMayUse: async () => { calls.push('share'); return shareAllowed },
} })
mock.module(new URL('./model-provider-health.ts', import.meta.url).href, { namedExports: {
  providerHealthStates: async () => new Map(), providerSourceKey: () => 'subscription:connection',
} })
const { credentialStates } = await import('./model-order')
const query = { query: async (sql: string) => {
  assert.ok(sql.startsWith('SELECT c.id::text AS id,'))
  return { rows: [{ id: 'connection', ownerId: credentialOwner, provider: 'claude', epoch: '1',
    state: 'connected', paused: false, removed: false, quota: quota() }] }
} } as unknown as Pool
const read = () => credentialStates(query, scope, [entry],
  [{ ...entry, name: entry.model, provider: 'claude', credentialOwnerId: credentialOwner } as OrderCandidate & { provider: string; credentialOwnerId: string }], undefined, { probe: 'always' })
beforeEach(() => { calls.length = 0; credentialOwner = scope.ownerId; memberAllowed = true; shareAllowed = true; stale = true })

test('forced startup refresh uses allowance after its original owner checks', async () => {
  const state = await read()
  assert.equal(state.get(entry.id)?.credential.usable, true)
  assert.deepEqual([...calls], ['member', 'workspace', 'allowance'])
})

test('a legacy shared startup cannot inspect the lender allowance', async () => {
  credentialOwner = 'payer'
  const state = await read()
  assert.equal(state.get(entry.id)?.credential.usable, false)
  assert.deepEqual([...calls], [])
})

test('membership denial cannot start either allowance or Settings usage', async () => {
  memberAllowed = false
  const state = await read()
  assert.equal(state.get(entry.id)?.credential.usable, false)
  assert.deepEqual([...calls], ['member'])
})

test('share withdrawal cannot start allowance or switch to the requester account', async () => {
  credentialOwner = 'payer'; shareAllowed = false
  const state = await read()
  assert.equal(state.get(entry.id)?.credential.usable, false)
  assert.deepEqual([...calls], [])
})

test('each completed forced refresh still performs a fresh allowance call', async () => {
  await read(); await read()
  assert.equal(calls.filter(call => call === 'allowance').length, 2)
  assert.equal(calls.includes('settings-usage'), false)
})
