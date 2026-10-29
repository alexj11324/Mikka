import assert from 'node:assert/strict'
import { before, beforeEach, mock, test } from 'node:test'
import type { Pool } from 'pg'
import { credentialPlanSchema, credentialPlanDigest, credentialReviewSummary, type CredentialPlan } from './credential-plan'

const userId = 'owner'
const plan = (): CredentialPlan => ({ actionId: '32000000-0000-4000-8000-000000000001', workspaceId: '32000000-0000-4000-8000-000000000002', botId: '32000000-0000-4000-8000-000000000003', subagentId: '32000000-0000-4000-8000-000000000004', epoch: 2, permissionVersion: 3, targetId: 'observed-target', origin: 'https://example.invalid', loaderId: 'observed-document', inputs: [{ backendNodeId: 11, credentialRole: 'username' }, { backendNodeId: 12, credentialRole: 'password' }], operation: 'submit', summary: credentialReviewSummary('submit', 'https://example.invalid'), expiresAt: Date.now() + 60_000 })
const envelope = (p = plan()) => ({ ...p, digest: credentialPlanDigest(userId, p) })
let saved: ReturnType<typeof envelope>, row: Record<string, unknown>, authorized: boolean, ledgerStatus: string, grants: unknown[], updates: unknown[], requests: number, leaseCalls: number, freshTarget: unknown
const pool = {
  async query(sql: string, args: unknown[]) {
    assert.match(sql, /SELECT 1 FROM pending_actions/)
    assert.match(sql, /"userId"=\$2/)
    assert.match(sql, /input=\$4::jsonb/)
    return { rowCount: args[0] === saved.actionId && args[1] === userId && args[2] === ledgerStatus && args[3] === JSON.stringify(saved) ? 1 : 0 }
  },
  async connect() { return {
    async query(sql: string) { return { rows: sql.includes('SELECT s.*') ? [row] : [] } },
    release() {},
  } },
} as unknown as Pool
let execute: typeof import('./credential-reviews').executeCredentialOperation
before(async () => {
  mock.module('@/lib/subscription-runtime', { namedExports: { authorizeSubscriptionWorkspace: async (owner: string, workspace: string) => { if (!authorized || owner !== userId || workspace !== saved.workspaceId) throw new Error('denied') } } })
  mock.module('./subagents', { namedExports: { SubagentStore: class {
    async get() { return row }
    async update(...args: unknown[]) { updates.push(args) }
    async stop(...args: unknown[]) { updates.push(args) }
  } } })
  mock.module('@/lib/credentials/runtime', { namedExports: {
    credentialStore: { authorize: async () => {}, lease: async () => { leaseCalls++; return { status: 'needs_login' } } },
    executeCredentialLease: async () => { throw new Error('unexpected fill') },
  } })
  mock.module('./subagent-browser', { namedExports: { resolveSubagentBrowserTarget: async () => freshTarget } })
  mock.module('@/lib/computer/e2b-provider', { namedExports: { connectComputer: async () => ({}) } })
  mock.module('./runtime', { namedExports: {
    grant: async (...args: unknown[]) => { grants.push(args); return { endpoint: 'https://gateway.invalid/agents/case' } },
    endpointPath: (endpoint: string, path: string) => endpoint + path,
  } })
  execute = (await import('./credential-reviews')).executeCredentialOperation
})
beforeEach(() => {
  saved = envelope(); authorized = true; ledgerStatus = 'running'; grants = []; updates = []; requests = 0; leaseCalls = 0
  row = { id: saved.subagentId, ownerId: userId, workspaceId: saved.workspaceId, botId: saved.botId, status: 'needs_you', epoch: saved.epoch, targetId: saved.targetId, needs: { kind: 'approval', actionId: saved.actionId }, permissionVersion: saved.permissionVersion, permission: 'ask', sandboxId: 'synthetic' }
  freshTarget = null
  mock.method(globalThis, 'fetch', async () => { requests++; return Response.json({ resumed: true, operation: saved.operation }) })
})
test('digest binds the owner, exact nodes, epoch, policy, origin, operation and shown summary', () => {
  const p = plan(), digest = credentialPlanDigest(userId, p)
  const changes = [{ actionId: '32000000-0000-4000-8000-000000000005' }, { targetId: 'other' }, { loaderId: 'other' }, { epoch: 3 }, { permissionVersion: 4 }, { origin: 'https://other.invalid' }, { operation: 'clear' }, { summary: 'a different action' }, { inputs: [{ backendNodeId: 20, credentialRole: 'password' }] }]
  for (const change of changes) assert.notEqual(credentialPlanDigest(userId, credentialPlanSchema.parse({ ...p, ...change })), digest)
  assert.notEqual(credentialPlanDigest('another-owner', p), digest)
  for (const change of [{ origin: 'http://example.invalid' }, { origin: 'https://example.invalid/path' }, { inputs: [{ backendNodeId: 11, credentialRole: 'username' }] }, { arbitrary: 'field' }]) assert.equal(credentialPlanSchema.safeParse({ ...p, ...change }).success, false)
})
test('an exact owner-consumed pending action can mint only the bound continuation', async () => {
  assert.deepEqual(await execute(pool, userId, saved, true), { data: { status: 'resumed' } })
  assert.equal(grants.length, 1); assert.equal(requests, 1)
  const args = grants[0] as unknown[]
  assert.equal(args[2], 'credential-continuation')
  assert.deepEqual(args[3], { actionId: saved.actionId, operation: 'submit', targetId: saved.targetId, origin: saved.origin, loaderId: saved.loaderId, inputs: saved.inputs })
})
test('pending, replayed, other-owner, changed summary or recomputed forged plan cannot reach gateway', async () => {
  for (const status of ['pending', 'done', 'failed', 'declined']) { ledgerStatus = status; assert.ok('error' in await execute(pool, userId, saved, true)) }
  ledgerStatus = 'running'
  assert.ok('error' in await execute(pool, 'other-owner', saved, true))
  assert.ok('error' in await execute(pool, userId, { ...saved, summary: 'Submit somewhere else' }, true))
  const forged = plan(); forged.summary = 'recomputed but not approved'
  assert.ok('error' in await execute(pool, userId, envelope(forged), true))
  assert.equal(grants.length, 0); assert.equal(requests, 0)
})
test('revoked workspace, stop, new epoch, new target, policy revision or deny fails closed', async () => {
  authorized = false; assert.ok('error' in await execute(pool, userId, saved, true)); authorized = true
  for (const change of [{ status: 'stopped' }, { epoch: 4 }, { targetId: 'other' }, { needs: { kind: 'approval', actionId: 'different' } }, { permissionVersion: 4 }, { permission: 'deny' }]) {
    const previous = row; row = { ...row, ...change }
    assert.ok('error' in await execute(pool, userId, saved, true)); row = previous
  }
  assert.equal(grants.length, 0); assert.equal(requests, 0)
})
test('declining Submit consumes a separate clear authority rather than submitting', async () => {
  ledgerStatus = 'declined'
  mock.method(globalThis, 'fetch', async () => { requests++; return Response.json({ resumed: true, operation: 'clear' }) })
  assert.deepEqual(await execute(pool, userId, saved, false), { data: { status: 'resumed' } })
  assert.equal((grants[0] as unknown[])[2], 'credential-continuation')
  assert.equal(((grants[0] as unknown[])[3] as { operation: string }).operation, 'clear')
})
test('fill approval requires the same freshly observed nodes before creating a lease', async () => {
  saved = envelope({ ...plan(), operation: 'fill', summary: credentialReviewSummary('fill', plan().origin) })
  freshTarget = { targetId: saved.targetId, origin: saved.origin, observedInputs: saved.inputs.map(input => ({ ...input, loaderId: 'new-document', epoch: saved.epoch, permissionVersion: saved.permissionVersion })) }
  assert.ok('error' in await execute(pool, userId, saved, true))
  assert.equal(leaseCalls, 0); assert.equal(grants.length, 0)
})
test('unknown external continuation outcome never retries or claims resumed', async () => {
  mock.method(globalThis, 'fetch', async () => { requests++; throw new Error('unknown') })
  assert.deepEqual(await execute(pool, userId, saved, true), { error: 'browserActionOutcomeUnknown' })
  assert.equal(requests, 1); assert.equal(grants.length, 1)
  assert.ok(JSON.stringify(updates).includes('Credential action outcome unknown'))
})
