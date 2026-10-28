import assert from 'node:assert/strict'
import { before, mock, test } from 'node:test'

let row: Record<string, unknown> = {}
let selected = 'account-a'
const calls: unknown[][] = []
const db = {
  $count: async () => 0,
  insert: () => ({ values: async (value: Record<string, unknown>) => { row = { ...value, status: 'pending' } } }),
  update: () => ({ set: (value: Record<string, unknown>) => ({ where: () => Object.assign(Promise.resolve(), { returning: async () => { row = { ...row, ...value }; return [row] } }) }) }),
}
const stub = (path: string, exports: Record<string, unknown>) => mock.module(new URL(path, import.meta.url).href, { exports })
stub('./db/index.ts', { db })
stub('./composio.ts', {
  resolveActionAccount: async (_userId: string, _action: string, requested?: string) => ({ accountId: requested ?? selected, accounts: [] }),
  runComposioAction: async (...args: unknown[]) => { calls.push(args); return { data: { summary: 'event' }, accountId: args[3] } },
})
stub('./coordinator-event-store.ts', { recordCoordinatorEvent: async () => {} })
stub('./coordinator/wake.ts', { wakeCoordinator: async () => {} })
let store: typeof import('./pending-action-store'), actions: typeof import('./pending-actions')
before(async () => { store = await import('./pending-action-store'); actions = await import('./pending-actions') })

test('proposal freezes the account used to read the event, and approval uses it after default changes', async () => {
  selected = 'account-a'; calls.length = 0
  await store.proposeAction('u', 'update_calendar_event', { event_id: 'e', summary: 'new' })
  assert.equal(row.connectedAccountId, 'account-a')
  assert.equal(calls[0][3], 'account-a')
  selected = 'account-b'
  await actions.decidePendingAction('u', String(row.id), true)
  assert.equal(calls[1][3], 'account-a')
})

test('an old unbound proposal fails closed without a provider call', async () => {
  calls.length = 0
  row = { id: 'old', action: 'send_email', input: {}, connectedAccountId: null }
  const result = await actions.decidePendingAction('u', 'old', true)
  assert.equal(result.error, 'integrationAccountNotBound')
  assert.deepEqual(calls, [])
})


test('a model-selected account is frozen in the proposal', async () => {
  selected = 'default-account'
  await store.proposeAction('u', 'send_email', { to: ['recipient@example.invalid'], subject: 's', body: 'b' }, 'selected-account')
  assert.equal(row.connectedAccountId, 'selected-account')
})
