import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createLinearSyncGate, LINEAR_SYNC_DISTINCT_ID, LINEAR_SYNC_FLAG, LINEAR_SYNC_FLAG_CACHE_MS } from './flags'

const answer = (enabled: unknown, extra = {}) => ({ errorsWhileComputingFlags: false, flags: { [LINEAR_SYNC_FLAG]: { enabled } }, ...extra })
const fake = (value: unknown): typeof fetch => async () => Response.json(value)

test('only an explicit boolean flag enables global Linear sync', async () => {
  for (const value of ['true', 'control', undefined, null, 1]) {
    assert.equal(await createLinearSyncGate({ fetcher: fake(answer(value)) })('project'), 'unavailable')
  }
  assert.equal(await createLinearSyncGate({ fetcher: fake(answer(true)) })('project'), 'enabled')
  assert.equal(await createLinearSyncGate({ fetcher: fake(answer(false)) })('project'), 'disabled')
  assert.equal(await createLinearSyncGate({ fetcher: fake({ errorsWhileComputingFlags: false, flags: {} }) })('project'), 'disabled')
  for (const value of [null, {}, answer(true, { flags: [] }), answer(true, { flags: { [LINEAR_SYNC_FLAG]: null } }), answer(true, { errorsWhileComputingFlags: true }), answer(true, { quotaLimited: ['feature_flags'] }), answer(true, { flags: { [LINEAR_SYNC_FLAG]: { enabled: true, variant: 'test' } } })]) {
    assert.equal(await createLinearSyncGate({ fetcher: fake(value) })('project'), 'unavailable')
  }
})

test('missing configuration, HTTP errors, invalid JSON, network and body timeouts fail closed', async () => {
  assert.equal(await createLinearSyncGate({ fetcher: async () => { throw new Error('must not fetch') } })(''), 'unavailable')
  for (const fetcher of [
    async () => new Response('', { status: 503 }),
    async () => new Response('broken'),
    async () => { throw new Error('offline') },
    () => new Promise<Response>(() => {}),
    async () => new Response(new ReadableStream({ start() {} })),
  ] satisfies typeof fetch[]) {
    assert.equal(await createLinearSyncGate({ fetcher, timeoutMs: 5 })('project'), 'unavailable')
  }
})

test('off/on/off changes propagate at the bounded cache expiry without stale true on outage', async () => {
  let time = 0
  let enabled = false
  let outage = false
  let calls = 0
  const gate = createLinearSyncGate({ now: () => time, fetcher: async (url, init) => {
    calls++
    assert.equal(url, 'https://us.i.posthog.com/flags?v=2')
    assert.equal(init?.cache, 'no-store')
    assert.equal(init?.redirect, 'error')
    assert.deepEqual(JSON.parse(init?.body as string), { api_key: 'project', distinct_id: LINEAR_SYNC_DISTINCT_ID })
    if (outage) throw new Error('offline')
    return Response.json(answer(enabled))
  } })
  assert.equal(await gate('project'), 'disabled')
  enabled = true
  time = LINEAR_SYNC_FLAG_CACHE_MS - 1
  assert.equal(await gate('project'), 'disabled')
  time++
  assert.equal(await gate('project'), 'enabled')
  enabled = false
  time += LINEAR_SYNC_FLAG_CACHE_MS
  assert.equal(await gate('project'), 'disabled')
  enabled = true
  time += LINEAR_SYNC_FLAG_CACHE_MS
  assert.equal(await gate('project'), 'enabled')
  outage = true
  time += LINEAR_SYNC_FLAG_CACHE_MS
  assert.equal(await gate('project'), 'unavailable')
  assert.equal(calls, 5)
})

test('concurrent checks share one request and cached values do not cross project tokens', async () => {
  let calls = 0
  const gate = createLinearSyncGate({ fetcher: async (_url, init) => {
    calls++
    return Response.json(answer(JSON.parse(init?.body as string).api_key === 'project-a'))
  } })
  assert.deepEqual(await Promise.all([gate('project-a'), gate('project-a'), gate('project-a')]), ['enabled', 'enabled', 'enabled'])
  assert.equal(calls, 1)
  assert.equal(await gate('project-b'), 'disabled')
  assert.equal(calls, 2)
})
