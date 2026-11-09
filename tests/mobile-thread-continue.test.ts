// POST /api/mobile/threads/:id/continue (same-page flows A2): a quota-paused thread goes on from the phone,
// for its owner only, on the caller's own run (lib/run-quota.ts locks the run by the caller's id and picks
// the key from the caller's keys or keys shared with them: tests/run-quota.db.test.ts).
import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { ActionFailureError } from '../lib/action-error'
import { tokenWorkspace } from '../lib/tokens/principal'
import { enterprisePrincipal } from '../lib/enterprise/principal'
import type { RequestWorkspaceUser } from '../lib/request-workspace'

const RUN = '6b0f2c8e-2d5c-4a1e-9a7b-0d6f3c1e2a4b'
const WORKSPACE = '638f1703-d835-4d0f-936d-631b96784e37'
const proof = { kind: 'session' as const, sessionId: 'verified-native-session' }
const nativeUser = () => Object.defineProperty({ id: 'user-1' }, enterprisePrincipal, { value: proof })
let signedIn: RequestWorkspaceUser | null = nativeUser()
let selectedWorkspace: string | null = WORKSPACE
const readers: RequestWorkspaceUser[] = []
const scopeReaders: RequestWorkspaceUser[] = []
const verifiedReaders: RequestWorkspaceUser[] = []
let outsideToken = false
let outcome: () => Promise<{ runId: string }> = async () => ({ runId: 'next-run' })
const calls: [string, string, string][] = []

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
mock.module(new URL('../lib/mobile-api.ts', import.meta.url).href, { namedExports: {
  json, mobileUser: async () => signedIn, writeAllowed: () => true,
  unauthorized: () => json({ error: 'authRequired' }, 401), forbiddenOrigin: () => json({ error: 'originNotAllowed' }, 403),
} })
mock.module(new URL('../lib/request-log.ts', import.meta.url).href, { namedExports: { noteLogRpcAction: () => {}, withRequestLog: (_: string, handler: unknown) => handler, noteLogUser: () => {} } })
mock.module(new URL('../lib/request-workspace.ts', import.meta.url).href, { namedExports: {
  effectiveRequestWorkspace: async (user: RequestWorkspaceUser) => { verifiedReaders.push(user); return selectedWorkspace },
} })
mock.module(new URL('../lib/acting-user.ts', import.meta.url).href, { namedExports: {
  actAs: async (reader: RequestWorkspaceUser, work: () => Promise<unknown>) => { readers.push(reader); return work() },
} })
mock.module(new URL('../lib/tokens/scope.ts', import.meta.url).href, { namedExports: {
  runOutsideToken: async (reader: RequestWorkspaceUser) => { scopeReaders.push(reader); return outsideToken },
} })
mock.module(new URL('../lib/run-quota.ts', import.meta.url).href, { namedExports: {
  resumeQuotaPausedRunOnApiKey: (userId: string, runId: string) => { calls.push(['key', userId, runId]); return outcome() },
  retryQuotaPausedRun: (userId: string, runId: string) => { calls.push(['retry', userId, runId]); return outcome() },
} })
const route = import('../app/api/mobile/threads/[id]/continue/route')

async function post(id: string, body: unknown) {
  const { POST } = await route
  const response = await POST(new Request(`https://mikka.test/api/mobile/threads/${id}/continue`, { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ id }) })
  return { status: response.status, body: await response.json() }
}

test('the owner goes on on an API key, or retries, as the signed-in person', async () => {
  calls.length = 0; readers.length = 0; scopeReaders.length = 0; verifiedReaders.length = 0
  outcome = async () => ({ runId: 'next-run' })
  assert.deepEqual(await post(RUN, { via: 'key' }), { status: 200, body: { runId: 'next-run' } })
  assert.deepEqual(await post(RUN, { via: 'retry' }), { status: 200, body: { runId: 'next-run' } })
  assert.deepEqual(calls, [['key', 'user-1', RUN], ['retry', 'user-1', RUN]])
  assert.equal(readers.length, 2)
  assert.deepEqual(verifiedReaders, [signedIn, signedIn])
  for (const [index, reader] of readers.entries()) {
    assert.equal(reader[enterprisePrincipal], proof, 'the non-enumerable verified principal survives the adapter')
    assert.equal(reader[tokenWorkspace], WORKSPACE)
    assert.equal(scopeReaders[index], reader, 'the authorization and transaction use one pinned reader')
  }
})

test('someone else\'s run is 404; no key of their own or shared with them is 409', async () => {
  outcome = async () => { throw new ActionFailureError('runNotFound') }
  assert.deepEqual(await post(RUN, { via: 'key' }), { status: 404, body: { error: 'runNotFound' } })
  outcome = async () => { throw new ActionFailureError('apiKeyNotFound') }
  assert.deepEqual(await post(RUN, { via: 'key' }), { status: 409, body: { error: 'apiKeyNotFound' } })
})

test('a run outside the token, a bad id or a bad body never reaches the run', async () => {
  calls.length = 0
  outsideToken = true
  assert.equal((await post(RUN, { via: 'key' })).status, 404)
  outsideToken = false
  assert.equal((await post('not-a-uuid', { via: 'key' })).status, 404)
  assert.equal((await post(RUN, { via: 'someone-elses-key' })).status, 400)
  assert.deepEqual(calls, [])
})

test('signed out is 401', async () => {
  signedIn = null
  assert.equal((await post(RUN, { via: 'retry' })).status, 401)
  signedIn = nativeUser()
})

test('an invalid current Workspace denies without entering quota or adopting a body tenant', async () => {
  calls.length = 0; readers.length = 0
  selectedWorkspace = null
  try {
    assert.deepEqual(await post(RUN, { via: 'retry', workspaceId: WORKSPACE }), { status: 404, body: { error: 'runNotFound' } })
    assert.deepEqual(calls, []); assert.deepEqual(readers, [])
  } finally { selectedWorkspace = WORKSPACE }
  outcome = async () => ({ runId: 'next-run' })
  assert.equal((await post(RUN, { via: 'retry', workspaceId: 'a4263c98-2774-41ce-82df-f385df33bb60' })).status, 200)
  assert.equal(readers[0][tokenWorkspace], WORKSPACE)
  assert.equal(readers[0][enterprisePrincipal], proof)
})

test('a membership revoked after the initial scope read returns the fixed not-found status', async () => {
  outcome = async () => { throw new ActionFailureError('workspaceAccessDenied') }
  try {
    assert.deepEqual(await post(RUN, { via: 'retry' }), { status: 404, body: { error: 'workspaceAccessDenied' } })
  } finally { outcome = async () => ({ runId: 'next-run' }) }
})
