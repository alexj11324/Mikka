import assert from 'node:assert/strict'
import { before, beforeEach, mock, test } from 'node:test'

let sweeps = 0
let replays: string[] = []
let fail = false
const secret = 'synthetic-isolated-cron-secret'
const eventId = '00000000-0000-4000-8000-000000000176'
mock.module(new URL('../../../../lib/coordinator/wake.ts', import.meta.url).href, { namedExports: {
  retryCoordinatorWakes: async () => { sweeps++; if (fail) throw new Error('private-error-secret'); return { due: 3, started: 1, deferred: 1, failed: 1, exhausted: 0 } },
  replayCoordinatorWake: async (id: string) => { replays.push(id); return true },
} })
let GET: typeof import('./route')['GET'], POST: typeof import('./route')['POST']
before(async () => { ({ GET, POST } = await import('./route')) })
beforeEach(() => { process.env.CRON_SECRET = secret; sweeps = 0; replays = []; fail = false })
const call = (method: 'GET' | 'POST', token: string | null = secret, body?: unknown) => {
  const request = new Request('http://127.0.0.1/mikka/api/cron/coordinator-wakes', {
    method, headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  })
  return method === 'GET' ? GET(request) : POST(request)
}

test('cron requires the exact configured bearer before reading or writing the inbox', async () => {
  for (const method of ['GET', 'POST'] as const) {
    for (const token of [null, 'wrong-secret']) assert.equal((await call(method, token, { eventId })).status, 401)
    delete process.env.CRON_SECRET
    assert.equal((await call(method)).status, 503)
    process.env.CRON_SECRET = secret
  }
  assert.equal(sweeps, 0)
  assert.deepEqual(replays, [])
})

test('authenticated sweeps return only counts and never cache them', async () => {
  const result = await call('GET')
  assert.equal(result.status, 200)
  assert.equal(result.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await result.json(), { due: 3, started: 1, deferred: 1, failed: 1, exhausted: 0 })
  fail = true
  const failed = await call('GET')
  assert.equal(failed.status, 502)
  assert.doesNotMatch(await failed.text(), /private-error-secret/)
})

test('explicit replay accepts only an event UUID and leaves other events alone', async () => {
  for (const body of [null, {}, { eventId: 'invalid' }, { eventId, userId: 'someone-else' }]) {
    assert.equal((await call('POST', secret, body)).status, 400)
  }
  assert.deepEqual(replays, [])
  assert.deepEqual(await (await call('POST', secret, { eventId })).json(), { replayed: true })
  assert.deepEqual(replays, [eventId])
})
