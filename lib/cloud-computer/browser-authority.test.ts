import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { before, beforeEach, mock, test } from 'node:test'
import { defaultRunPolicy } from '@mikka/protocol/agent-policy'

const workspaceId = randomUUID(), botId = randomUUID(), subagentId = randomUUID()
let permission = 'allow', version = 1, status = 'running', readOnly = false
let context: unknown, stored: Record<string, any> | undefined, calls: unknown[] = []
const client = { async query(sql: string, args: unknown[] = []) {
  if (sql.startsWith('SELECT permission,version')) return { rows: [{ permission, version }] }
  if (sql.startsWith('SELECT * FROM bot_subagents')) return { rows: [{ id: subagentId, ownerId: 'owner', workspaceId, botId, status, epoch: 1, needs: { kind: 'approval', actionId: stored?.actionId }, runPolicy: { ...defaultRunPolicy(), readOnly, permissions: { ...defaultRunPolicy().permissions, computer_use: 'allow' } } }] }
  if (sql.startsWith('SELECT id FROM pending_actions')) return { rows: stored ? [{ id: stored.actionId }] : [], rowCount: stored ? 1 : 0 }
  if (sql.startsWith('INSERT INTO pending_actions')) { stored = JSON.parse(String(args[3])); return { rows: [{ id: args[0] }], rowCount: 1 } }
  if (sql.startsWith('SELECT input FROM pending_actions')) return { rows: stored && !context ? [{ input: stored }] : [] }
  if (sql.startsWith('UPDATE pending_actions SET context=')) {
    if (!stored || context || stored.actionId !== args[0] || JSON.stringify(JSON.parse(String(args[2]))) !== JSON.stringify(stored)) return { rowCount: 0, rows: [] }
    context = { browserExecuting: true }; return { rowCount: 1, rows: [{ id: args[0] }] }
  }
  return { rows: [], rowCount: 0 }
}, release() {} }
const pool = { async connect() { return client }, query: client.query }
mock.module(new URL('../db/index.ts', import.meta.url).href, { namedExports: { pool } })
mock.module(new URL('../subscription-runtime.ts', import.meta.url).href, { namedExports: { authorizeSubscriptionWorkspace: async () => {} } })
mock.module(new URL('./subagents.ts', import.meta.url).href, { namedExports: { SubagentStore: class { async machine() { return { sandboxId: 'synthetic' } } } } })
mock.module(new URL('./runtime.ts', import.meta.url).href, { namedExports: { runtimeRequest: async (...args: unknown[]) => { calls.push(args); return { accepted: true } } } })
let authority: typeof import('./browser-authority')
before(async () => { authority = await import('./browser-authority') })
beforeEach(() => { permission = 'allow'; version = 1; status = 'running'; readOnly = false; stored = undefined; context = undefined; calls = [] })
const base = { permissionAction: 'computer_use' as const, actor: { userId: 'owner', workspaceId }, botId, subagentId, epoch: 1, loaderId: 'document', origin: 'https://example.test', mutation: { action: 'click' as const, selector: '[data-mikka-ref="0"]' }, summary: 'Submit selected form' }
async function admit() {
  const grant = await authority.authorizeBrowserAction(base)
  return { ...base, policyVersion: grant.policyVersion, expiresAt: grant.expiresAt, actionId: grant.review!.actionId, digest: grant.review!.digest }
}
test('allow persists one exact action and consumes it once without a review', async () => {
  const execution = await admit()
  assert.equal(calls.length, 0)
  assert.deepEqual(await authority.executeAuthorizedBrowserAction(execution), { accepted: true })
  await assert.rejects(authority.executeAuthorizedBrowserAction(execution))
  assert.equal(calls.length, 1)
})
test('ask uses the original pending action and executes only its approved receipt', async () => {
  permission = 'ask'
  const execution = await admit()
  await assert.rejects(authority.executeAuthorizedBrowserAction(execution))
  status = 'needs_you'
  assert.deepEqual(await authority.executeReviewedBrowserAction(execution), { accepted: true })
  assert.equal(calls.length, 1)
})
test('STOP, deny, policy changes, read-only, changed operation and expiry reject before I/O', async () => {
  for (const change of ['stop', 'deny', 'version', 'readonly', 'mutation', 'expired']) {
    stored = undefined; context = undefined; status = 'running'; permission = 'allow'; version = 1; readOnly = false
    const execution = await admit()
    if (change === 'stop') status = 'stopped'
    if (change === 'deny') permission = 'deny'
    if (change === 'version') version++
    if (change === 'readonly') readOnly = true
    if (change === 'mutation') execution.mutation = { action: 'click', selector: '#other' }
    if (change === 'expired') execution.expiresAt = 0
    await assert.rejects(authority.executeAuthorizedBrowserAction(execution))
  }
  assert.equal(calls.length, 0)
})
