import assert from 'node:assert/strict'
import { before, mock, test } from 'node:test'

let row: Record<string, unknown> = {}
let selected = 'account-a'
let actionError: string | null = null
// The tool tags the provider reports for the action; see lib/composio-tool-hints.ts.
let toolTags: string[] | undefined = ['important', 'openWorldHint']
const calls: unknown[][] = []
const reviews: unknown[][] = []
const db = {
  $count: async () => 0,
  select: () => ({ from: () => ({ where: () => ({ limit: async () => [row] }) }) }),
  insert: () => ({ values: async (value: Record<string, unknown>) => { row = { status: 'pending', ...value } } }),
  update: () => ({ set: (value: Record<string, unknown>) => ({ where: () => {
    row = { ...row, ...value }
    return Object.assign(Promise.resolve(), { returning: async () => [row] })
  } }) }),
}
const stub = (path: string, exports: Record<string, unknown>) => mock.module(new URL(path, import.meta.url).href, { exports })
stub('./db/index.ts', { db, pool: {} })
stub('./composio.ts', {
  resolveActionAccount: async (_userId: string, _action: string, requested?: string) => ({ accountId: requested ?? selected, accounts: [] }),
  runComposioAction: async (...args: unknown[]) => {
    calls.push(args)
    const gate = args[4] as ((accountId: string, tool: { tags?: string[] }) => Promise<{ error: string } | null>) | undefined
    const stopped = gate ? await gate(String(args[3] ?? selected), { tags: toolTags }) : null
    if (stopped) return stopped
    return actionError ? { error: actionError } : { data: { summary: 'event' }, accountId: args[3] } },
})
stub('./coordinator-event-store.ts', { recordCoordinatorEvent: async () => {} })
stub('./coordinator/wake.ts', { wakeCoordinator: async () => {} })
stub('./cloud-computer/credential-reviews.ts', { executeCredentialOperation: async (...args: unknown[]) => { reviews.push(['credential', ...args.slice(1)]); return { data: {} } } })
stub('./cloud-computer/action-reviews.ts', { executeApprovedBrowserAction: async (...args: unknown[]) => { reviews.push(['browser', ...args.slice(1)]); return { data: {} } } })
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

test('an unknown dispatched outcome keeps the consumed proposal running instead of reporting a failed effect', async () => {
  row = { id: 'unknown', action: 'send_email', input: {}, connectedAccountId: 'account-a' }
  actionError = 'operationUncertain'
  try {
    const result = await actions.decidePendingAction('u', 'unknown', true)
    assert.deepEqual(result, { status: 'running', error: 'operationUncertain' })
    assert.equal(row.status, 'running')
    assert.equal(row.error, 'operationUncertain')
  } finally { actionError = null }
})


test('a model-selected account is frozen in the proposal', async () => {
  selected = 'default-account'
  await store.proposeAction('u', 'send_email', { to: ['recipient@example.invalid'], subject: 's', body: 'b' }, 'selected-account')
  assert.equal(row.connectedAccountId, 'selected-account')
})

test('computer and credential reviews retain their own approval authority without a Composio account', async () => {
  calls.length = 0; reviews.length = 0
  for (const [action, kind] of [['credential_operation', 'credential'], ['browser_operation', 'browser']]) {
    for (const approve of [true, false]) {
      row = { id: 'review', action, input: { summary: 'Review' }, connectedAccountId: null, createdAt: new Date() }
      const result = await actions.decidePendingAction('u', 'review', approve)
      assert.equal(result.status, approve ? 'done' : 'declined')
      assert.deepEqual(reviews.at(-1), [kind, 'u', { summary: 'Review' }, approve])
    }
  }
  assert.deepEqual(calls, [])
})

test('a mail send or calendar write runs at once in the connected account and stays as a record, not a card', async () => {
  selected = 'account-a'; calls.length = 0; row = {}
  const result = await store.writeAccountAction('u', 'send_email', { to: ['recipient@example.invalid'], subject: 's', body: 'b' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0][1], 'send_email')
  assert.equal('status' in result && result.status, 'done')
  assert.equal(row.status, 'done')
  assert.equal(row.connectedAccountId, 'account-a')
  assert.equal(row.decidedAt, undefined, 'no person decided it, so it never reads as an approval')
})

test('a direct write with an unknown outcome stays running and is reported uncertain', async () => {
  calls.length = 0; row = {}; actionError = 'operationUncertain'
  try {
    const result = await store.writeAccountAction('u', 'create_calendar_event', { summary: 'Review', start: '2027-01-01T10:00:00Z', end: '2027-01-01T11:00:00Z' })
    assert.deepEqual(result, { error: 'operationUncertain' })
    assert.equal(row.status, 'running')
    assert.equal(row.error, 'operationUncertain')
  } finally { actionError = null }
})

test('a write whose tool is marked destructive becomes an approval card instead of running', async () => {
  calls.length = 0; row = {}; toolTags = ['destructiveHint', 'openWorldHint']
  try {
    const result = await store.writeAccountAction('u', 'send_email', { to: ['recipient@example.invalid'], subject: 's', body: 'b' }, 'selected-account')
    assert.equal('status' in result && result.status, 'awaiting_approval')
    assert.equal(row.status, 'pending')
    assert.equal(row.connectedAccountId, 'selected-account')
    assert.equal(calls.length, 1, 'stopped at the gate: no dispatch')
  } finally { toolTags = ['important', 'openWorldHint'] }
})
