import assert from 'node:assert/strict'
import { before, beforeEach, mock, test } from 'node:test'
import type { Pool } from 'pg'
import { credentialPlanSchema, credentialPlanDigest, credentialReviewSummary, type CredentialPlan } from './credential-plan'

const userId = 'owner'
const plan = (): CredentialPlan => ({ actionId: '32000000-0000-4000-8000-000000000001', workspaceId: '32000000-0000-4000-8000-000000000002', botId: '32000000-0000-4000-8000-000000000003', subagentId: '32000000-0000-4000-8000-000000000004', epoch: 2, permissionVersion: 3, targetId: 'observed-target', origin: 'https://example.invalid', loaderId: 'observed-document', inputs: [{ backendNodeId: 11, credentialRole: 'username' }, { backendNodeId: 12, credentialRole: 'password' }], operation: 'login', summary: credentialReviewSummary('https://example.invalid'), credentialId: '32000000-0000-4000-8000-000000000005', credentialRevision: 'secret-version-1', expiresAt: Date.now() + 60_000 })
const envelope = (p = plan()) => ({ ...p, digest: credentialPlanDigest(userId, p) })
let saved: ReturnType<typeof envelope>, row: Record<string, unknown>, authorized: boolean, consented: boolean, claimed: boolean, grants: unknown[], updates: unknown[], requests: number, leaseCalls: number, leaseStatus: unknown, freshTarget: unknown
const pool = {
  async query(sql: string, args: unknown[]) {
    if (/SELECT 1 FROM pending_actions/.test(sql)) {
      assert.match(sql, /"userId"=\$2/)
      assert.match(sql, /input=\$3::jsonb/)
      return { rowCount: args[0] === saved.actionId && args[1] === userId && args[2] === JSON.stringify(saved) ? 1 : 0 }
    }
    if (/SELECT 1 FROM credentials/.test(sql)) return { rowCount: consented ? 1 : 0 }
    if (/UPDATE pending_actions SET result/.test(sql)) return { rowCount: claimed ? 1 : 0 }
    if (/UPDATE pending_actions SET status='done'/.test(sql)) return { rows: [] }
    if (/UPDATE bot_subagents SET "activeActionId"=NULL/.test(sql)) return { rows: [] }
    throw new Error(`unexpected pool query: ${sql}`)
  },
  async connect() { return {
    async query(sql: string) {
      if (/SELECT s\.\*/.test(sql)) return { rows: [row] }
      if (/SELECT 1 FROM credentials/.test(sql)) return { rows: consented ? [{}] : [], rowCount: consented ? 1 : 0 }
      if (/pg_advisory_xact_lock|BEGIN|COMMIT|ROLLBACK/.test(sql)) return { rows: [] }
      throw new Error(`unexpected transaction query: ${sql}`)
    },
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
    credentialStore: { authorize: async () => {}, lease: async () => { leaseCalls++; return leaseStatus } },
    executeCredentialLease: async () => ({ status: 'guarded' }),
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
  saved = envelope(); authorized = true; consented = true; claimed = true; grants = []; updates = []; requests = 0; leaseCalls = 0
  leaseStatus = { status: 'ready', lease: 'synthetic-lease' }
  row = { id: saved.subagentId, ownerId: userId, workspaceId: saved.workspaceId, botId: saved.botId, status: 'running', epoch: saved.epoch, targetId: saved.targetId, needs: null, activeActionId: saved.actionId, permissionVersion: saved.permissionVersion, permission: 'ask', sandboxId: 'synthetic' }
  freshTarget = { targetId: saved.targetId, origin: saved.origin, observedInputs: saved.inputs.map(input => ({ ...input, loaderId: saved.loaderId, epoch: saved.epoch, permissionVersion: saved.permissionVersion })) }
  mock.method(globalThis, 'fetch', async () => { requests++; return Response.json({ resumed: true, operation: 'submit' }) })
})
test('digest binds the owner, exact nodes, epoch, policy, origin and shown summary', () => {
  const p = plan(), digest = credentialPlanDigest(userId, p)
  const changes = [{ actionId: '32000000-0000-4000-8000-000000000006' }, { targetId: 'other' }, { loaderId: 'other' }, { epoch: 3 }, { permissionVersion: 4 }, { origin: 'https://other.invalid' }, { summary: 'a different action' }, { inputs: [{ backendNodeId: 20, credentialRole: 'password' }] }]
  for (const change of changes) assert.notEqual(credentialPlanDigest(userId, credentialPlanSchema.parse({ ...p, ...change })), digest)
  assert.notEqual(credentialPlanDigest('another-owner', p), digest)
  for (const change of [{ origin: 'http://example.invalid' }, { origin: 'https://example.invalid/path' }, { inputs: [{ backendNodeId: 11, credentialRole: 'username' }] }, { operation: 'fill' }, { operation: 'submit' }, { operation: 'clear' }, { arbitrary: 'field' }]) assert.equal(credentialPlanSchema.safeParse({ ...p, ...change }).success, false)
})
test('an exact owner-consumed receipt can mint only the bound same-document submission', async () => {
  assert.deepEqual(await execute(pool, userId, saved), { data: { status: 'resumed' } })
  assert.equal(leaseCalls, 1); assert.equal(grants.length, 1); assert.equal(requests, 1)
  const args = grants[0] as unknown[]
  assert.equal(args[2], 'credential-continuation')
  assert.deepEqual(args[3], { actionId: saved.actionId, operation: 'submit', targetId: saved.targetId, origin: saved.origin, loaderId: saved.loaderId, inputs: saved.inputs })
})
test('replayed, other-owner, changed summary or recomputed forged plan cannot reach the lease', async () => {
  assert.ok('error' in await execute(pool, 'other-owner', saved))
  assert.ok('error' in await execute(pool, userId, { ...saved, summary: 'Submit somewhere else' }))
  const forged = plan(); forged.summary = 'recomputed but not consented'
  assert.ok('error' in await execute(pool, userId, envelope(forged)))
  assert.equal(leaseCalls, 0); assert.equal(grants.length, 0); assert.equal(requests, 0)
})
test('revoked workspace, stopped task, new epoch, new target, policy revision or deny fails closed', async () => {
  authorized = false; assert.ok('error' in await execute(pool, userId, saved)); authorized = true
  for (const change of [{ status: 'stopped' }, { epoch: 4 }, { targetId: 'other' }, { activeActionId: 'different' }]) {
    const previous = row; row = { ...row, ...change }
    assert.ok('error' in await execute(pool, userId, saved)); row = previous
  }
  assert.equal(leaseCalls, 0)
  // A policy revision or deny is caught under the policy lock in the
  // continuation transaction: the fill may run, the grant never does.
  for (const change of [{ permissionVersion: 4 }, { permission: 'deny' }]) {
    const previous = row; row = { ...row, ...change }
    assert.ok('error' in await execute(pool, userId, saved)); row = previous
  }
  assert.equal(grants.length, 0); assert.equal(requests, 0)
})
test('a revoked or rotated saved login fails closed before touching the page', async () => {
  consented = false
  assert.deepEqual(await execute(pool, userId, saved), { error: 'credentialGrantRevoked' })
  assert.equal(leaseCalls, 0); assert.equal(grants.length, 0); assert.equal(requests, 0)
})
test('a concurrently consumed receipt never starts a second fill', async () => {
  claimed = false
  assert.deepEqual(await execute(pool, userId, saved), { error: 'browserActionOutcomeUnknown' })
  assert.equal(leaseCalls, 0); assert.equal(grants.length, 0); assert.equal(requests, 0)
})
test('a stale freshly-observed page cannot reach the lease', async () => {
  freshTarget = { targetId: saved.targetId, origin: saved.origin, observedInputs: saved.inputs.map(input => ({ ...input, loaderId: 'new-document', epoch: saved.epoch, permissionVersion: saved.permissionVersion })) }
  assert.ok('error' in await execute(pool, userId, saved))
  assert.equal(leaseCalls, 0); assert.equal(grants.length, 0)
})
test('no usable saved login marks the task needs_you and records needs_login', async () => {
  leaseStatus = { status: 'needs_login' }
  assert.deepEqual(await execute(pool, userId, saved), { data: { status: 'needs_login' } })
  assert.equal(grants.length, 0); assert.equal(requests, 0)
  assert.ok(JSON.stringify(updates).includes('login unavailable'))
})
test('unknown external continuation outcome never retries or claims resumed', async () => {
  mock.method(globalThis, 'fetch', async () => { requests++; throw new Error('unknown') })
  assert.deepEqual(await execute(pool, userId, saved), { error: 'browserActionOutcomeUnknown' })
  assert.equal(requests, 1); assert.equal(grants.length, 1)
  assert.ok(JSON.stringify(updates).includes('Credential action outcome unknown'))
})
