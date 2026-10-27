import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { enrollmentBindHTTP } from './subscription-enrollment-bind'

test('binding requires both source operator and real session and derives owner before workspace authorization', async () => {
  const calls: unknown[] = []
  let operator: string | null = null, userId: string | null = null, allowed = false
  const route = enrollmentBindHTTP({
    operator: async () => operator,
    session: async () => userId ? { userId } : null,
    workspace: async (owner, workspaceId) => { calls.push(['workspace', owner, workspaceId]); if (!allowed) throw new Error('denied') },
    client: () => ({ async bind(...args) { calls.push(['bind', ...args]); return { id: randomUUID(), provider: 'claude', state: 'connected', revision: 2, credentialVersion: 1 } } }),
  })
  const id = randomUUID(), workspaceId = randomUUID()
  const post = (body: unknown, origin?: string) => route(new Request('https://mikka.example/api/subscriptions/enrollments/bind', { method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify(body) }))
  assert.equal((await post({ id, workspaceId })).status, 401)
  operator = 'operator:fixture-principal'
  assert.equal((await post({ id, workspaceId })).status, 401)
  userId = 'actual-session-user'
  assert.equal((await post({ id, workspaceId })).status, 409)
  assert.deepEqual(calls, [['workspace', userId, workspaceId]])
  calls.length = 0; allowed = true
  assert.equal((await post({ id, workspaceId, ownerId: 'invented-owner' })).status, 409)
  assert.equal((await post({ id, workspaceId }, 'https://foreign.example')).status, 403)
  assert.equal(calls.length, 0)
  assert.equal((await post({ id, workspaceId })).status, 200)
  assert.deepEqual(calls, [['workspace', userId, workspaceId], ['bind', operator, id, userId, workspaceId]])
})
