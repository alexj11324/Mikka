import assert from 'node:assert/strict'
import { before, mock, test } from 'node:test'
import type { PoolClient } from 'pg'
import { observeCommitEffects } from './db/commit-effects'

let row: Record<string, unknown> = {}
let selected = 'account-a'
let actionError: string | null = null
// Provider annotations do not add a separate action approval gate.
let toolTags: string[] | undefined = ['important', 'openWorldHint']
const calls: unknown[][] = []
const reviews: unknown[][] = []
const client = { query: async () => ({ rows: [], command: 'SELECT' }) } as unknown as PoolClient
observeCommitEffects(client)
const liveEffects: Array<() => Promise<unknown>> = []
// The workspace layer `readWriteSettingLayers` reads (w.external_write_permissions), as the settings page stores it.
let workspacePolicy: Record<string, unknown> | null = null
const db = {
  session: { client },
  transaction: async <T>(operation: (executor: unknown) => Promise<T>): Promise<T> => operation(db),
  $count: async () => 0,
  execute: async () => ({ rows: workspacePolicy === null ? [] : [{ workspace: workspacePolicy }] }),
  select: () => ({ from: () => ({ where: () => ({ limit: async () => [row] }) }) }),
  insert: () => ({ values: async (value: Record<string, unknown>) => { row = { status: 'pending', ...value } } }),
  update: () => ({ set: (value: Record<string, unknown>) => ({ where: () => {
    row = { ...row, ...value }
    return Object.assign(Promise.resolve(), { returning: async () => [row] })
  } }) }),
}
const stub = (path: string, exports: Record<string, unknown>) => mock.module(new URL(path, import.meta.url).href, { namedExports: exports })
stub('./db/index.ts', { db, pool: {} })
stub('./coordinator/decide.ts', { decide: async () => { throw Error('Account writes do not use Decision') } })
stub('./live/scope.ts', { liveGatewayConfig: () => ({ url: 'https://live.example.invalid', secret: 'test-only-live-transport' }) })
stub('./live/notify.ts', { scheduleLive: (work: () => Promise<unknown>) => { liveEffects.push(work) }, sendLiveInvalidations: async () => {} })
stub('./composio.ts', {
  getComposio: () => ({}),
  resolveActionAccount: async (_userId: string, _action: string, requested?: string) => ({ accountId: requested ?? selected, accounts: [] }),
  runComposioAction: async (...args: unknown[]) => {
    calls.push(args)
    const gate = args[4] as ((accountId: string, tool: { tags?: string[]; version?: string }) => Promise<{ error: string } | null>) | undefined
    const stopped = gate ? await gate(String(args[3] ?? selected), { tags: toolTags, version: 'pinned-v1' }) : null
    if (stopped) return stopped
    return actionError ? { error: actionError } : { data: { summary: 'event' }, accountId: args[3] } },
})
stub('./coordinator-event-store.ts', { recordCoordinatorEvent: async () => {} })
stub('./cloud-computer/credential-reviews.ts', { executeCredentialOperation: async (...args: unknown[]) => { reviews.push(['credential', ...args.slice(1)]); return { data: {} } } })
stub('./cloud-computer/action-reviews.ts', { executeApprovedBrowserAction: async (...args: unknown[]) => { reviews.push(['browser', ...args.slice(1)]); return { data: {} } } })
const appCalls: unknown[][] = []
stub('./app-tools-server.ts', { executeAppToolCall: async (_client: unknown, userId: string, call: { toolkit: string }, accountId: string | null) => { appCalls.push([userId, call.toolkit, accountId]); return { successful: true, data: {} } } })
stub('./plugins/catalog.ts', { composioToolkitLister: () => async () => ({ items: [] }), isNoAuthToolkit: async (_list: unknown, id: string) => id === 'hackernews' })
let appAllowed = true
stub('./app-policy/store.ts', { botMayUseApp: async () => appAllowed })
let store: typeof import('./pending-action-store'), actions: typeof import('./pending-actions')
before(async () => { store = await import('./pending-action-store'); actions = await import('./pending-actions') })

test('native mail review retains the exact prepared call and can withhold dispatch', async () => {
  workspacePolicy = { gmail: 'deny' }; row = {}; selected = 'account-native'
  const input = { to: ['recipient@example.invalid'], subject: 'Final subject', body: 'Final text' }
  try {
    let binding: unknown
    const stopped = await store.writeAccountAction('u', 'send_email', input, undefined, BOT, async (decision, prepared) => {
      assert.equal(decision, 'allow'); binding = prepared; return 'deny'
    })
    assert.deepEqual(stopped, { error: 'integrationActionDenied' })
    assert.deepEqual(row, {}, 'native request creates no parallel pending-action UI')
    assert.deepEqual(binding, { ownerId: 'u', botId: BOT, action: 'send_email', input, accountId: 'account-native', version: 'pinned-v1', policy: null })
    const done = await store.writeAccountAction('u', 'send_email', input, undefined, BOT, async (decision, prepared) => {
      assert.equal(decision, 'allow'); assert.deepEqual(prepared, binding); return 'allow'
    })
    assert.equal('status' in done && done.status, 'done'); assert.equal(row.status, 'done')
  } finally { workspacePolicy = null }
})

test('proposal freezes the account used to read the event, and approval uses it after default changes', async () => {
  selected = 'account-a'; calls.length = 0; liveEffects.length = 0
  await store.proposeAction('u', 'update_calendar_event', { event_id: 'e', summary: 'new' })
  assert.equal(row.connectedAccountId, 'account-a')
  assert.equal(calls[0][3], 'account-a')
  assert.equal(liveEffects.length, 1, 'the committed proposal registers its real live invalidation')
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

test('destructive annotations do not interrupt an authorized account write', async () => {
  calls.length = 0; row = {}; toolTags = ['destructiveHint', 'openWorldHint']
  try {
    const result = await store.writeAccountAction('u', 'send_email', { to: ['recipient@example.invalid'], subject: 's', body: 'b' }, 'selected-account')
    assert.equal('status' in result && result.status, 'done')
    assert.equal(row.status, 'done')
    assert.equal(row.connectedAccountId, 'selected-account')
    assert.equal(calls.length, 1)
  } finally { toolTags = ['important', 'openWorldHint'] }
})

test('an approved store-app call without an account runs only for an app that needs none', async () => {
  appCalls.length = 0
  const input = (toolkit: string) => ({ toolkit, tool: `${toolkit.toUpperCase()}_DO`, name: 'Do', version: '20261030_00', arguments: {} })
  row = { id: 'free', action: 'app_tool_call', input: input('hackernews'), connectedAccountId: null, createdAt: new Date() }
  assert.equal((await actions.decidePendingAction('u', 'free', true)).error, null)
  assert.deepEqual(appCalls, [['u', 'hackernews', null]])
  // Unbound for an app that has accounts: fails closed, nothing runs.
  row = { id: 'unbound', action: 'app_tool_call', input: input('hubspot'), connectedAccountId: null, createdAt: new Date() }
  assert.equal((await actions.decidePendingAction('u', 'unbound', true)).error, 'integrationAccountNotBound')
  assert.deepEqual(appCalls, [['u', 'hackernews', null]])
  // Bound: runs in exactly that account.
  row = { id: 'bound', action: 'app_tool_call', input: input('hubspot'), connectedAccountId: 'ca_frozen', createdAt: new Date() }
  await actions.decidePendingAction('u', 'bound', true)
  assert.deepEqual(appCalls.at(-1), ['u', 'hubspot', 'ca_frozen'])
})

const FIRST_CLASS_WRITES = [
  ['send_email', 'gmail', { to: ['recipient@example.invalid'], subject: 's', body: 'b' }],
  ['create_calendar_event', 'googlecalendar', { summary: 'Review', start: '2027-01-01T10:00:00Z', end: '2027-01-01T11:00:00Z' }],
  ['update_calendar_event', 'googlecalendar', { event_id: 'e', summary: 'Review' }],
] as const

const BOT = 'bot-in-workspace'

test('authorized first-class writes run directly regardless of historical action settings', async () => {
  for (const choice of [null, 'allow', 'ask', 'deny']) {
    for (const [action, app, input] of FIRST_CLASS_WRITES) {
      calls.length = 0; row = {}; workspacePolicy = choice ? { [app]: choice } : null
      const result = await store.writeAccountAction('u', action, input, undefined, BOT)
      assert.equal('status' in result && result.status, 'done', `${action}: ${choice}`)
      assert.equal(row.status, 'done')
      assert.equal(calls.length, 1)
    }
  }
  workspacePolicy = null
})

test('an existing approved card ignores historical action settings', async () => {
  calls.length = 0
  row = { id: 'stale', action: 'send_email', input: { to: ['recipient@example.invalid'], subject: 's', body: 'b' }, connectedAccountId: 'account-a', botId: BOT, createdAt: new Date() }
  workspacePolicy = { gmail: 'deny' }
  try {
    const result = await actions.decidePendingAction('u', 'stale', true)
    assert.deepEqual(result, { status: 'done', error: null })
    assert.equal(calls.length, 1)
    assert.equal(calls[0][3], 'account-a')
  } finally { workspacePolicy = null }
})

test('an approved card still respects current workspace app admission', async () => {
  calls.length = 0
  row = { id: 'fresh', action: 'send_email', input: { to: ['recipient@example.invalid'], subject: 's', body: 'b' }, connectedAccountId: 'account-a', botId: BOT, createdAt: new Date() }
  appAllowed = false
  try {
    const result = await actions.decidePendingAction('u', 'fresh', true)
    assert.deepEqual(result, { status: 'failed', error: 'integrationBlockedByWorkspace' })
    assert.deepEqual(calls, [])
  } finally { appAllowed = true }
})
