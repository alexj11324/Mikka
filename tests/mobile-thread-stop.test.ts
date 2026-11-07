// POST /api/mobile/threads/:id/stop (usability review #5): the phone stops a working thread as the web does.
import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { ActionFailureError } from '../lib/action-error'

const RUN = '6b0f2c8e-2d5c-4a1e-9a7b-0d6f3c1e2a4b'
let signedIn: { id: string } | null = { id: 'user-1' }
let outsideToken = false
let stop: (userId: string, runId: string) => Promise<{ stoppedRunIds: string[] }> = async () => ({ stoppedRunIds: [] })
const calls: [string, string][] = []

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
mock.module(new URL('../lib/mobile-api.ts', import.meta.url).href, { namedExports: {
  json, mobileUser: async () => signedIn, writeAllowed: () => true,
  unauthorized: () => json({ error: 'authRequired' }, 401), forbiddenOrigin: () => json({ error: 'originNotAllowed' }, 403),
} })
mock.module(new URL('../lib/request-log.ts', import.meta.url).href, { namedExports: { noteLogRpcAction: () => {}, withRequestLog: (_: string, handler: unknown) => handler, noteLogUser: () => {} } })
mock.module(new URL('../lib/tokens/scope.ts', import.meta.url).href, { namedExports: { runOutsideToken: async () => outsideToken } })
mock.module(new URL('../lib/agent-runs.ts', import.meta.url).href, { namedExports: { requestRunStop: (userId: string, runId: string) => { calls.push([userId, runId]); return stop(userId, runId) } } })
const route = import('../app/api/mobile/threads/[id]/stop/route')

async function post(id: string) {
  const { POST } = await route
  const response = await POST(new Request(`https://mikka.test/api/mobile/threads/${id}/stop`, { method: 'POST' }), { params: Promise.resolve({ id }) })
  return { status: response.status, body: await response.json() }
}

test('a working thread stops for its owner', async () => {
  calls.length = 0
  stop = async () => ({ stoppedRunIds: [RUN] })
  assert.deepEqual(await post(RUN), { status: 200, body: { stoppedRunIds: [RUN] } })
  assert.deepEqual(calls, [['user-1', RUN]])
})

test('a thread that already ended is 409 runChainEnded', async () => {
  stop = async () => { throw new ActionFailureError('runChainEnded') }
  assert.deepEqual(await post(RUN), { status: 409, body: { error: 'runChainEnded' } })
})

test('someone else\'s thread, a bad id or a thread outside the token is 404', async () => {
  stop = async () => { throw new ActionFailureError('runNotFound') }
  assert.deepEqual(await post(RUN), { status: 404, body: { error: 'runNotFound' } })
  calls.length = 0
  assert.deepEqual(await post('not-a-uuid'), { status: 404, body: { error: 'runNotFound' } })
  outsideToken = true
  assert.deepEqual(await post(RUN), { status: 404, body: { error: 'runNotFound' } })
  outsideToken = false
  assert.deepEqual(calls, [])
})

test('signed out is 401', async () => {
  signedIn = null
  assert.equal((await post(RUN)).status, 401)
  signedIn = { id: 'user-1' }
})
