import test from 'node:test'
import assert from 'node:assert/strict'
import { POST } from '../../app/api/approved-writes/route'
import { createPersonalWriteRoute, PERSONAL_WRITES_ENABLED } from './write-route'
import { personalWritesEnabled } from './write-feature'

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request('https://candidate.invalid/api/approved-writes', { method: 'POST', headers: { cookie: 'synthetic=fixture', origin: 'https://candidate.invalid', ...headers }, body: JSON.stringify(body) })
}
const proposal = { op: 'propose', action: 'send_slack_message', intentId: id, input: { channel: 'C12345678', text: 'Fixture' } }

test('actual product POST is registered but disabled without initializing runtime', async () => {
  assert.equal(PERSONAL_WRITES_ENABLED, false)
  const response = await POST(request(proposal))
  assert.equal(response.status, 503)
  assert.deepEqual(await response.json(), { error: 'approvedWritesDisabled' })
  assert.equal(response.headers.get('cache-control'), 'no-store')
  let loads = 0
  const handler = createPersonalWriteRoute({ enabled: () => false, load: async () => { loads++; throw Error('runtime must not initialize') } })
  assert.equal((await handler(request(proposal))).status, 503)
  assert.equal(loads, 0)
})

test('production rollout delegates browser authority and durable IDs to the existing HTTP service', async () => {
  const calls: unknown[] = []
  const handler = createPersonalWriteRoute({ enabled: () => personalWritesEnabled({VERCEL_ENV:'production',MIKKA_PERSONAL_WRITES_ENABLED:'1'}), load: async () => ({
    auth: { api: { getSession: async ({ query }) => { assert.equal(query.disableCookieCache, true); return { user: { id: 'owner' }, session: { id: 'session' } } } } },
    operations: action => ({
      propose: async (ownerId, input, intentId) => { calls.push({ action, ownerId, input, intentId }); return { status: 'awaiting_approval', actionId: id } },
      view: async () => { throw Error('unexpected view') },
      decide: async (actor, actionId, approve) => { calls.push({ action, actor, actionId, approve }); return { status: 'running' as const, error: 'operationUncertain' } },
    }),
  }) })
  assert.equal((await handler(request(proposal, { authorization: 'Bearer synthetic' }))).status, 401)
  assert.equal((await handler(request(proposal, { origin: 'https://other.invalid' }))).status, 403)
  assert.equal((await handler(request({ ...proposal, ownerId: 'other' }))).status, 400)
  assert.equal(calls.length, 0)
  assert.deepEqual(await (await handler(request(proposal))).json(), { status: 'awaiting_approval', actionId: id })
  assert.deepEqual(calls[0], { action: proposal.action, ownerId: 'owner', input: proposal.input, intentId: id })
  for (let i = 0; i < 2; i++) assert.deepEqual(await (await handler(request({ op: 'decide', action: proposal.action, id, approve: true }))).json(), { status: 'running', error: 'operationUncertain' })
  assert.deepEqual(calls.slice(1), Array.from({ length: 2 }, () => ({ action: proposal.action, actor: { userId: 'owner', sessionId: 'session' }, actionId: id, approve: true })))
})

test('runtime load failure returns an unavailable response without diagnostics', async () => {
  const handler = createPersonalWriteRoute({ enabled: () => true, load: async () => { throw Error('private synthetic configuration diagnostic') } })
  const response = await handler(request(proposal))
  assert.equal(response.status, 503)
  assert.deepEqual(await response.json(), { error: 'writeServiceUnavailable' })
})
