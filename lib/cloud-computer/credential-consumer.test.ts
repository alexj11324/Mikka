import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { before, beforeEach, mock, test } from 'node:test'
import { defaultRunPolicy } from '@mikka/protocol/agent-policy'

const workspaceId = randomUUID(), botId = randomUUID(), subagentId = randomUUID()
const input = { permissionAction: 'computer_use' as const, actor: { userId: 'owner', workspaceId }, botId, subagentId, epoch: 1, targetId: 'target', loaderId: 'document', origin: 'https://example.test', backendNodeId: 10, intent: { targetSelector: '[data-mikka-ref="0"]', role: 'username' as const } }
let policy: unknown, permission = 'ask', status = 'running', loader = 'document'
let outstanding: { input: unknown; status: string }[] = []
const records: Record<string, unknown>[] = [], executed: Record<string, unknown>[] = []
const client = { async query(sql: string, args: unknown[] = []) {
  if (sql.startsWith('SELECT permission,version')) return { rows: [{ permission, version: 3 }] }
  if (sql.startsWith('SELECT * FROM bot_subagents')) return { rows: [{ id: subagentId, ownerId: 'owner', workspaceId, botId, status, epoch: 1, targetId: 'target', runPolicy: policy }] }
  if (sql.startsWith('SELECT input,status FROM pending_actions')) return { rows: outstanding, rowCount: outstanding.length }
  if (sql.startsWith('INSERT INTO pending_actions')) { records.push(JSON.parse(String(args[3]))); return { rows: [{ id: args[0] }], rowCount: 1 } }
  return { rows: [], rowCount: 0 }
}, release() {} }
const pool = { async connect() { return client }, query: client.query }
mock.module(new URL('../db/index.ts', import.meta.url).href, { namedExports: { pool } })
mock.module(new URL('../subscription-runtime.ts', import.meta.url).href, { namedExports: { authorizeSubscriptionWorkspace: async () => {} } })
mock.module(new URL('./subagents.ts', import.meta.url).href, { namedExports: { SubagentStore: class { async machine() { return { sandboxId: 'synthetic' } } } } })
mock.module(new URL('./runtime.ts', import.meta.url).href, { namedExports: { runtimeRequest: async () => ({ targetId: 'target', loaderId: loader, origin: input.origin, backendNodeId: 10, role: 'username' }) } })
mock.module(new URL('./credential-service.ts', import.meta.url).href, { namedExports: {
  executeRecordedCredentialAction: async (action: Record<string, unknown>) => { executed.push(action); return { status: 'guarded' } },
  credentialServiceOutcome: (value: unknown) => value,
} })
let executeCredentialIntent: typeof import('./credential-consumer').executeCredentialIntent
before(async () => { executeCredentialIntent = (await import('./credential-consumer')).executeCredentialIntent })
beforeEach(() => { records.length = 0; executed.length = 0; outstanding = []; permission = 'ask'; status = 'running'; loader = 'document'; policy = { ...defaultRunPolicy(), permissions: { ...defaultRunPolicy().permissions, computer_use: 'allow' } } })

test('missing trusted run policy fails closed', async () => {
  policy = null
  await assert.rejects(executeCredentialIntent(input), { status: 503 })
  assert.equal(records.length, 0)
})
test('ask records one host-generated action without invoking credential service', async () => {
  assert.equal((await executeCredentialIntent(input)).status, 'needs_you')
  assert.equal(records.length, 1)
  assert.equal(records[0].runId, subagentId)
  assert.equal(executed.length, 0)
})
test('allow calls the service with the persisted action and no second approval', async () => {
  permission = 'allow'
  assert.deepEqual(await executeCredentialIntent(input), { status: 'guarded' })
  assert.deepEqual(executed, records)
  assert.equal(executed.length, 1)
})
test('deny, read-only, STOP and changed document cannot reach credential I/O', async () => {
  for (const mode of ['deny', 'readonly', 'stop', 'document']) {
    permission = mode === 'deny' ? 'deny' : 'allow'
    status = mode === 'stop' ? 'stopped' : 'running'
    loader = mode === 'document' ? 'changed' : 'document'
    policy = { ...defaultRunPolicy(), readOnly: mode === 'readonly', permissions: { ...defaultRunPolicy().permissions, computer_use: 'allow' } }
    await assert.rejects(executeCredentialIntent(input))
  }
  assert.equal(executed.length, 0)
  assert.equal(records.length, 0)
})

test('an existing ordinary browser approval cannot race a new credential action', async () => {
  permission = 'allow'
  outstanding = [{ status: 'pending', input: { mutation: { action: 'click', selector: '#existing' } } }]
  await assert.rejects(executeCredentialIntent(input))
  assert.equal(records.length, 0)
  assert.equal(executed.length, 0)
})
