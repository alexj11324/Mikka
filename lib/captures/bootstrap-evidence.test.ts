import assert from 'node:assert/strict'
import { beforeEach, mock, test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { resolveAgentSettings } from '@mikka/protocol/agent-policy'

const runId = randomUUID(), deviceId = randomUUID(), workspaceId = randomUUID(), botId = randomUUID(), bindingId = randomUUID()
const digest = 'a'.repeat(64), owner = 'bootstrap-fixture-owner'
let signedIn = true, visible = true, outside = false, reads = 0, queries = 0
let row: Record<string, unknown>
const ordinary = { run: { id: runId }, captures: [], artifacts: [], recording: false }
mock.module(new URL('../api-auth.ts', import.meta.url).href, { namedExports: {
  auth: { api: { getSession: async () => signedIn ? { user: { id: owner } } : null } },
} })
mock.module(new URL('./store.ts', import.meta.url).href, { namedExports: {
  runEvidence: async (userId: string, id: string) => { reads++; assert.equal(userId, owner); assert.equal(id, runId); return visible ? ordinary : null },
} })
mock.module(new URL('../tokens/scope.ts', import.meta.url).href, { namedExports: { runOutsideToken: async () => outside } })
mock.module(new URL('../db/index.ts', import.meta.url).href, { namedExports: {
  pool: { query: async (_sql: string, values: unknown[]) => {
    queries++; assert.deepEqual(values, [runId, owner, deviceId, workspaceId])
    return { rows: [row] }
  } },
} })
const { GET } = await import('../../app/api/runs/[runId]/evidence/route')
const query = new URLSearchParams({ bootstrap: '1', deviceId, workspaceId, bootstrapSha256: digest })
const call = async (suffix = '') => GET(new Request('https://app.example/mikka/api/runs/' + runId + '/evidence' + suffix), { params: Promise.resolve({ runId }) })
beforeEach(() => {
  signedIn = visible = true; outside = false; reads = queries = 0
  const identity = { version: 1, requester: owner, botId, botOwner: owner, executionPrincipal: owner,
    workspaceId, outputOwner: owner, personalResourcePolicy: 'requester_only',
    resourceBindings: [{ kind: 'device', id: deviceId, ownerId: owner, access: 'owner' },
      { kind: 'subscription', id: bindingId, ownerId: 'shared-owner', access: 'workspace_share', revision: '1' }],
    billingAccount: { model: { kind: 'subscription', ownerId: 'shared-owner', resourceId: bindingId, amount: 'provider_unknown' },
      runtime: { kind: 'local_device', ownerId: owner, resourceId: deviceId, amount: 'not_applicable' } } }
  row = { id: runId, userId: owner, botId, deviceId, kind: 'implement', status: 'queued', attempt: 1,
    repository: 'v2/github.com/alexj11324/mikka-handoff', startedAt: null, sessionId: null, deviceTokenId: null,
    retryOf: null, continuesRunId: null, questionContinuation: null, stopRequestedAt: null,
    definition: { schemaVersion: 1, kind: 'worker', harness: 'claude_code', modelSource: 'subscription',
      cliModelSelection: 'explicit', model: 'claude-haiku-5-5', readOnly: true,
      subscription: { bindingId, modelId: 'claude-haiku-5-5', route: 'claude_code_cli' },
      agentProfile: { effort: 'low' }, policyCeiling: resolveAgentSettings(null, null, 'cloud').policy,
      mailbox: { tools: ['mailbox_inbox'] }, executionIdentity: identity } }
})

test('ordinary owner evidence keeps the identical response and performs no bootstrap read', async () => {
  const response = await call()
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), ordinary)
  assert.equal(reads, 1); assert.equal(queries, 0)
})

test('explicit bootstrap evidence is non-secret, frozen, bound and never an assignment', async () => {
  const response = await call('?' + query)
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.bootstrap?.version, 1)
  assert.equal(body.bootstrap.authority, 'none')
  assert.equal(body.bootstrap.deviceId, deviceId); assert.equal(body.bootstrap.workspaceId, workspaceId)
  assert.equal(body.bootstrap.hint.runId, runId); assert.equal(body.bootstrap.hint.bootstrapSha256, digest)
  assert.deepEqual(body.bootstrap.hint.mailboxTools, ['mailbox_inbox'])
  assert.equal(body.bootstrap.hint.policy.readOnly, true)
  assert.equal(body.bootstrap.hint.diagnostics, true)
  assert.deepEqual(Object.keys(body.bootstrap).sort(), ['authority', 'deviceId', 'harness', 'hint', 'version', 'workspaceId'])
  assert.doesNotMatch(JSON.stringify(body.bootstrap), /credential|prompt|bindingId|shared-owner/)
  assert.equal(reads, 1); assert.equal(queries, 1)
})

test('missing session, foreign owner and token scope fail before loading bootstrap data', async () => {
  signedIn = false; assert.equal((await call('?' + query)).status, 401); assert.equal(reads, 0)
  signedIn = true; visible = false; assert.equal((await call('?' + query)).status, 404)
  visible = true; outside = true; assert.equal((await call('?' + query)).status, 404)
  assert.equal(queries, 0)
})

test('malformed and duplicate opt-in fields reject without a bootstrap read', async () => {
  for (const suffix of ['?bootstrap=0', '?' + query + '&deviceId=' + deviceId, '?' + query + '&unknown=1',
    '?' + new URLSearchParams({ bootstrap: '1', deviceId, workspaceId, bootstrapSha256: 'wrong' })]) {
    assert.equal((await call(suffix)).status, 400)
  }
  assert.equal(queries, 0)
})

test('claimed, stopped, resumed and foreign-workspace runs never yield bootstrap hints', async () => {
  for (const changed of [{ status: 'preparing' }, { attempt: 2 }, { startedAt: new Date() }, { sessionId: 'old' },
    { deviceTokenId: randomUUID() }, { retryOf: randomUUID() }, { continuesRunId: randomUUID() },
    { questionContinuation: {} }, { stopRequestedAt: new Date() }]) {
    const original = row; row = { ...row, ...changed }
    assert.equal((await call('?' + query)).status, 404); row = original
  }
  const definition = row.definition as Record<string, unknown>
  const identity = definition.executionIdentity as Record<string, unknown>
  row = { ...row, definition: { ...definition, executionIdentity: { ...identity, workspaceId: randomUUID() } } }
  assert.equal((await call('?' + query)).status, 404)
})
