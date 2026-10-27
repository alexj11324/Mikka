import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { enrollmentHTTP, enrollmentOperator } from './subscription-enrollment'

const token = 'fixture-enrollment-operator-with-32-random-characters'
const principal = `operator:${createHash('sha256').update(token).digest('hex')}`
test('server custody route authenticates the operator without SQL, inference reader or browser vault credentials', async () => {
  const calls: unknown[] = []
  const response = { id: randomUUID(), provider: 'claude', state: 'awaiting_consent', taskUseAllowed: false, authorizationUrl: 'https://claude.ai/oauth/authorize', expiresAt: new Date().toISOString() }
  const route = enrollmentHTTP({ authorize: async request => enrollmentOperator(request, token), client: () => ({ async call(actor, body) { calls.push({ actor, body }); return response } }) })
  const post = (body: unknown, authorization = `Bearer ${token}`, extra: Record<string,string> = {}) => route(new Request('https://mikka.example/api/subscriptions/enrollments', { method: 'POST', headers: { 'content-type': 'application/json', authorization, ...extra }, body: JSON.stringify(body) }))
  assert.equal((await post({ action: 'start' }, '')).status, 401)
  assert.equal((await post({ action: 'start' }, 'Bearer invalid')).status, 401)
  assert.equal((await post({ action: 'start' }, undefined, { origin: 'https://foreign.example' })).status, 403)
  assert.equal(calls.length, 0)
  const started = await post({ action: 'start' })
  assert.equal(started.status, 200)
  assert.match(started.headers.get('cache-control')!, /no-store/)
  assert.deepEqual(await started.json(), response)
  assert.deepEqual(calls[0], { actor: principal, body: { action: 'start' } })
  for (const body of [{ action: 'start', ownerId: 'invented-user' }, { action: 'refresh' }, { action: 'execute' }, { action: 'complete', id: response.id, accessToken: 'forbidden-import' }]) assert.equal((await post(body)).status, 409)
  assert.equal(calls.length, 1)
})
test('callback failures return fixed errors and do not echo secret ceremony bodies', async () => {
  const route = enrollmentHTTP({ authorize: async () => principal, client: () => ({ async call() { throw new Error('private-provider-token-must-not-leak') } }) })
  const response = await route(new Request('https://mikka.example/api/subscriptions/enrollments', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'complete', id: randomUUID(), callbackUrl: 'http://localhost:54545/callback?code=private-code&state=private-state' }) }))
  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), { error: 'subscription_enrollment_unavailable' })
})
