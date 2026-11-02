// POST /api/mobile/threads/:id/continue (same-page flows A2): a quota-paused thread goes on from the phone,
// for its owner only, on the caller's own run (lib/run-quota.ts locks the run by the caller's id and picks
// the key from the caller's keys or keys shared with them: tests/run-quota.db.test.ts).
import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { ActionFailureError } from '../lib/action-error'

const RUN = '6b0f2c8e-2d5c-4a1e-9a7b-0d6f3c1e2a4b'
let signedIn: { id: string } | null = { id: 'user-1' }
let outsideToken = false
let outcome: () => Promise<{ runId: string }> = async () => ({ runId: 'next-run' })
const calls: [string, string, string][] = []

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
mock.module(new URL('../lib/mobile-api.ts', import.meta.url).href, { namedExports: {
  json, mobileUser: async () => signedIn, writeAllowed: () => true,
  unauthorized: () => json({ error: 'authRequired' }, 401), forbiddenOrigin: () => json({ error: 'originNotAllowed' }, 403),
} })
mock.module(new URL('../lib/request-log.ts', import.meta.url).href, { namedExports: { withRequestLog: (_: string, handler: unknown) => handler, noteLogUser: () => {} } })
mock.module(new URL('../lib/tokens/scope.ts', import.meta.url).href, { namedExports: { runOutsideToken: async () => outsideToken } })
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
  calls.length = 0; outcome = async () => ({ runId: 'next-run' })
  assert.deepEqual(await post(RUN, { via: 'key' }), { status: 200, body: { runId: 'next-run' } })
  assert.deepEqual(await post(RUN, { via: 'retry' }), { status: 200, body: { runId: 'next-run' } })
  assert.deepEqual(calls, [['key', 'user-1', RUN], ['retry', 'user-1', RUN]])
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
  signedIn = { id: 'user-1' }
})
