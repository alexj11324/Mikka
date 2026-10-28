import assert from 'node:assert/strict'
import { before, mock, test } from 'node:test'
import { prepareRepositoryApproval } from './repository-approval-proposal'

const input = prepareRepositoryApproval({ repo: 'team/repo' })!
const request = { id: 'proposal', userId: 'owner', action: 'approve_repository_push', input }
let approved = false, status = 'pending', failEvent = false
const query = (value: unknown) => ({ from: () => ({ where: () => ({ limit: async () => [value] }) }) })
const tx = {
  select: () => query({ input }), execute: async () => {},
  update: () => ({ set: () => ({ where: () => ({ returning: async () => {
    if (status !== 'pending') return []
    status = 'done'
    return [request]
  } }) }) }),
  insert: () => ({ values: () => ({ onConflictDoUpdate: async () => { approved = true } }) }),
}
const db = {
  select: () => query({ action: request.action }),
  transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
    const prior = { approved, status }
    try { return await fn(tx) } catch (error) { approved = prior.approved; status = prior.status; throw error }
  },
}
mock.module('@/lib/db', { namedExports: { db } })
mock.module('@/lib/composio', { namedExports: { runComposioAction: async () => ({}) } })
mock.module('@/lib/coordinator-event-store', { namedExports: { recordCoordinatorEvent: async (executor: unknown) => {
  assert.equal(executor, tx, 'the event uses the same transaction as the permission')
  if (failEvent) throw new Error('synthetic event insert failure')
} } })
mock.module('@/lib/coordinator/wake', { namedExports: { wakeCoordinator: async () => {} } })
let decide: typeof import('./pending-actions').decidePendingAction
before(async () => { decide = (await import('./pending-actions')).decidePendingAction })

test('an event write failure rolls back the permission and keeps the request retryable', async () => {
  failEvent = true
  await assert.rejects(decide('owner', 'proposal', true), /synthetic event insert failure/)
  assert.equal(approved, false)
  assert.equal(status, 'pending')
  failEvent = false
  assert.equal((await decide('owner', 'proposal', true)).status, 'done')
  assert.equal(approved, true)
  assert.equal(status, 'done')
})
