import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { before, beforeEach, mock, test } from 'node:test'

const actor = { userId: 'owner', workspaceId: 'workspace' }
const calls: Record<string, unknown>[] = []
const updates: unknown[][] = []
const authorityCalls: Record<string, unknown>[] = []
const executed: Record<string, unknown>[] = []
let status = 'running'
let pendingId = ''
let approvalChecks = 0
let authority: { decision: 'allow' | 'ask' | 'deny'; policyVersion: number; expiresAt: number; readOnly: boolean; review?: { actionId: string; digest: string; summary: string } } | undefined
class FakeStore {
  async get() { return { status, epoch: 7, needs: { kind: 'approval', actionId: pendingId } } }
  async action(_actor: unknown, _bot: string, _id: string, action: Record<string, unknown>) {
    calls.push(action)
    return action.action === 'inspectMutation' ? { loaderId: 'document', origin: 'https://example.test' } : { accepted: true }
  }
  async update(...args: unknown[]) { updates.push(args) }
}
mock.module(new URL('./subagents.ts', import.meta.url).href, { namedExports: { SubagentStore: FakeStore } })
mock.module(new URL('./browser-authority.ts', import.meta.url).href, { namedExports: {
  authorizeBrowserAction: async (input: Record<string, unknown>) => { authorityCalls.push(input); if (!authority) throw new Error('authority unavailable'); return authority },
  executeAuthorizedBrowserAction: async (input: Record<string, unknown>) => { executed.push(input); return { accepted: true } },
  executeReviewedBrowserAction: async () => { approvalChecks++; throw new Error('authority unavailable') },
} })
mock.module(new URL('../subscription-runtime.ts', import.meta.url).href, { namedExports: { authorizeSubscriptionWorkspace: async () => {} } })
let browserAction: typeof import('./action-reviews').browserAction
let executeApprovedBrowserAction: typeof import('./action-reviews').executeApprovedBrowserAction
before(async () => { const module = await import('./action-reviews'); browserAction = module.browserAction; executeApprovedBrowserAction = module.executeApprovedBrowserAction })
const queries: { sql: string; args: unknown[] }[] = []
const pool = { async query(sql: string, args: unknown[]) { queries.push({ sql, args }); return { rows: [] } } } as unknown as Parameters<typeof browserAction>[0]
beforeEach(() => { calls.length = 0; updates.length = 0; queries.length = 0; authorityCalls.length = 0; executed.length = 0; status = 'running'; pendingId = ''; approvalChecks = 0; authority = { decision: 'allow', policyVersion: 2, expiresAt: Date.now() + 60_000, readOnly: false, review: { actionId: randomUUID(), digest: 'a'.repeat(64), summary: 'Confirm task' } } })

test('model-selected ordinary action executes without a metadata business classifier', async () => {
  const mutation = { action: 'click' as const, selector: '#continue' }
  const result = await browserAction(pool, actor, 'bot', 'subagent', mutation, 'Continue', false)
  assert.equal(result.state, 'running')
  assert.deepEqual(calls, [{ action: 'inspectMutation', mutation }])
  assert.deepEqual(executed[0], { actor, botId: 'bot', subagentId: 'subagent', epoch: 7, policyVersion: 2, expiresAt: authority!.expiresAt, loaderId: 'document', origin: 'https://example.test', mutation })
  assert.equal(queries.length, 0)
})

test('host ask reuses the authority review without a second pending action', async () => {
  authority!.decision = 'ask'
  const mutation = { action: 'click' as const, selector: '#confirm' }
  const result = await browserAction(pool, actor, 'bot', 'subagent', mutation, 'Confirm task', true)
  assert.equal(result.state, 'needs_you')
  assert.deepEqual(calls, [{ action: 'inspectMutation', mutation }])
  assert.equal(queries.length, 0)
  assert.equal(result.actionId, authority!.review!.actionId)
  assert.equal(result.digest, authority!.review!.digest)
  assert.deepEqual(authorityCalls[0], { permissionAction: 'computer_use', actor, botId: 'bot', subagentId: 'subagent', epoch: 7, loaderId: 'document', origin: 'https://example.test', mutation, summary: 'Confirm task' })
  assert.equal(updates.length, 1)
})

test('trusted allow applies even when the model flags an action irreversible', async () => {
  const result = await browserAction(pool, actor, 'bot', 'subagent', { action: 'click', selector: '#confirm' }, 'Confirm task', true)
  assert.equal(result.state, 'running')
  assert.equal(queries.length, 0)
})

test('trusted ask applies even when the model does not flag an action irreversible', async () => {
  authority!.decision = 'ask'
  const result = await browserAction(pool, actor, 'bot', 'subagent', { action: 'click', selector: '#continue' }, 'Continue', false)
  assert.equal(result.state, 'needs_you')
})

test('ask without the authority review fails closed rather than creating another approval', async () => {
  authority!.decision = 'ask'; authority!.review = undefined
  await assert.rejects(browserAction(pool, actor, 'bot', 'subagent', { action: 'click', selector: '#continue' }, 'Continue', false))
  assert.equal(queries.length, 0)
  assert.equal(updates.length, 0)
})

for (const condition of ['deny', 'expired', 'readonly', 'unavailable', 'stopped'] as const) {
  test(`${condition} never executes a browser mutation`, async () => {
    if (condition === 'deny') authority!.decision = 'deny'
    if (condition === 'expired') authority!.expiresAt = Date.now() - 1
    if (condition === 'readonly') authority!.readOnly = true
    if (condition === 'unavailable') authority = undefined
    if (condition === 'stopped') status = 'stopped'
    await assert.rejects(browserAction(pool, actor, 'bot', 'subagent', { action: 'click', selector: '#continue' }, 'Continue', false))
    assert.ok(calls.every(call => call.action === 'inspectMutation'))
    assert.equal(executed.length, 0)
    assert.equal(queries.length, 0)
  })
}

test('approved replay fails closed without live authority and cannot execute after expiry or stop', async () => {
  pendingId = randomUUID(); status = 'needs_you'
  const signed = { actionId: pendingId, workspaceId: randomUUID(), botId: randomUUID(), subagentId: randomUUID(), epoch: 7, policyVersion: 2, expiresAt: Date.now() + 60_000, loaderId: 'document', origin: 'https://example.test', mutation: { action: 'click' as const, selector: '#submit' }, summary: 'Submit' }
  const bind = (input: typeof signed) => ({ ...input, digest: createHash('sha256').update(JSON.stringify(['owner', input])).digest('hex') })
  assert.deepEqual(await executeApprovedBrowserAction(pool, 'owner', bind(signed), true), { error: 'browserActionOutcomeUnknown' })
  assert.equal(approvalChecks, 1)
  assert.deepEqual(await executeApprovedBrowserAction(pool, 'owner', bind({ ...signed, expiresAt: Date.now() - 1 }), true), { error: 'browserActionExpired' })
  status = 'stopped'
  assert.deepEqual(await executeApprovedBrowserAction(pool, 'owner', bind(signed), true), { error: 'browserActionExpired' })
  assert.equal(approvalChecks, 1)
  assert.equal(calls.length, 0)
})
