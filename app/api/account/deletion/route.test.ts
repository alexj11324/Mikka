import assert from 'node:assert/strict'
import { before, beforeEach, mock, test } from 'node:test'
import { randomUUID } from 'node:crypto'
let session: { user: { id: string; email: string }; session: { id: string; createdAt: Date; updatedAt?: Date } } | null
let unavailable = false, soleAdmin = false, cancellable = true
const calls: unknown[][] = [], id = randomUUID(), origin = 'https://mikka.example'
let route: typeof import('./route')
let cron: typeof import('../../cron/account-deletions/route')
before(async () => {
  mock.module('@/lib/auth', { namedExports: { auth: { $context: Promise.resolve({ sessionConfig: { freshAge: 24 * 60 * 60 } }), api: { getSession: async () => session } } } })
  mock.module('@/lib/account/deletion-jobs', { namedExports: {
    requestAccountDeletion: async (...args: unknown[]) => { calls.push(args); return soleAdmin ? { ok: false, soleAdminOf: ['Team'] } : { ok: true, id } },
    readAccountDeletionReceipt: async (receipt: string) => { if (unavailable || receipt !== id) throw new Error('unavailable'); return { id, stage: 'storage_pending', remainingObjects: 1 } },
    cancelAccountDeletion: async (...args: unknown[]) => { calls.push(args); return cancellable },
    sweepAccountDeletions: async () => { calls.push(['sweep']); return { scanned: 1, completed: 0, pending: 1 } },
  } })
  route = await import('./route'); cron = await import('../../cron/account-deletions/route')
})
beforeEach(() => { session = { user: { id: 'owner', email: 'Owner@example.invalid' }, session: { id: 'session', createdAt: new Date() } }; unavailable = false; soleAdmin = false; cancellable = true; calls.length = 0 })
const request = (method: string, body?: unknown, headers: Record<string, string> = {}) => new Request(`${origin}/api/account/deletion`, { method, headers: { origin, 'content-type': 'application/json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) })
test('start requires same origin, session and typed email before creating an owner-bound job', async () => {
  assert.equal((await route.POST(request('POST', { email: session!.user.email, requestId: id }, { origin: 'https://other.example' }))).status, 403)
  session = null
  assert.equal((await route.POST(request('POST', { email: 'Owner@example.invalid', requestId: id }))).status, 401)
  session = { user: { id: 'owner', email: 'Owner@example.invalid' }, session: { id: 'session', createdAt: new Date() } }
  assert.equal((await route.POST(request('POST', { email: 'someone@example.invalid', requestId: id }))).status, 400)
  assert.equal(calls.length, 0)
  const started = await route.POST(request('POST', { email: 'owner@example.invalid', requestId: id }))
  assert.equal(started.status, 202); assert.deepEqual(calls[0], ['owner', 'Owner@example.invalid', id])
  assert.equal(started.headers.get('cache-control'), 'private, no-store')
  soleAdmin = true
  assert.equal((await route.POST(request('POST', { email: 'owner@example.invalid', requestId: id }))).status, 409)
})
test('a private receipt reads only lifecycle after session removal; unknown receipts do not disclose existence', async () => {
  session = null
  assert.equal((await route.GET(request('GET'))).status, 404)
  assert.equal((await route.GET(request('GET', undefined, { 'x-mikka-deletion-receipt': randomUUID() }))).status, 404)
  const status = await route.GET(request('GET', undefined, { 'x-mikka-deletion-receipt': id }))
  assert.equal(status.status, 200); assert.equal(JSON.stringify(await status.json()).includes('owner'), false)
})
test('cancel needs a session owner and cannot claim to undo an irreversible stage', async () => {
  session = null
  assert.equal((await route.DELETE(request('DELETE', undefined, { 'x-mikka-deletion-receipt': id }))).status, 401)
  session = { user: { id: 'owner', email: 'Owner@example.invalid' }, session: { id: 'session', createdAt: new Date() } }
  assert.equal((await route.DELETE(request('DELETE', undefined, { 'x-mikka-deletion-receipt': id }))).status, 200)
  assert.deepEqual(calls.at(-1), ['owner', id]); cancellable = false
  assert.equal((await route.DELETE(request('DELETE', undefined, { 'x-mikka-deletion-receipt': id }))).status, 409)
})
test('cron accepts only its configured workload secret', async t => {
  const previous = process.env.CRON_SECRET
  t.after(() => { if (previous === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = previous })
  delete process.env.CRON_SECRET
  assert.equal((await cron.GET(request('GET'))).status, 503)
  process.env.CRON_SECRET = 'test-only-account-deletion-secret'
  assert.equal((await cron.GET(request('GET'))).status, 401); assert.equal(calls.length, 0)
  assert.equal((await cron.GET(request('GET', undefined, { authorization: `Bearer ${process.env.CRON_SECRET}` }))).status, 200)
  assert.deepEqual(calls, [['sweep']])
})

test('stale sign-in cannot create or reauthorize a deletion even with a known receipt/request UUID', async () => {
  session!.session.createdAt = new Date(Date.now() - 24 * 60 * 60 * 1000)
  session!.session.updatedAt = new Date()
  const response = await route.POST(request('POST', { email: 'owner@example.invalid', requestId: id }))
  assert.equal(response.status, 403)
  assert.deepEqual(await response.json(), { error: 'SESSION_NOT_FRESH' })
  assert.equal(calls.length, 0)
  assert.equal((await route.GET(request('GET', undefined, { 'x-mikka-deletion-receipt': id }))).status, 200, 'status access does not create fresh deletion authority')
})
