import assert from 'node:assert/strict'
import test from 'node:test'
import type { SWRConfiguration } from 'swr'
import { CacheReadError } from '../cache-read-error'
import { fetchGroups } from '../group-messages'
import { isAutoRetryable, MAX_READ_RETRIES, MAX_READ_RETRY_MS, readRetryDelay, ReadResponseError, retryRead } from './retry'

test('access, rate limit and explicit terminal errors never retry, including wrapped causes', () => {
  for (const status of [401, 403, 429]) {
    assert.equal(isAutoRetryable(new ReadResponseError(status)), false)
    assert.equal(isAutoRetryable(new Error('transport wrapper', { cause: { statusCode: status } })), false)
  }
  for (const code of ['authRequired', 'workspaceAccessDenied', 'issueNotFound', 'botNotFound']) assert.equal(isAutoRetryable(new CacheReadError(code)), false)
  assert.equal(isAutoRetryable({ retryable: false }), false)
  assert.equal(isAutoRetryable({ kind: 'owner' }), false)
  assert.equal(isAutoRetryable({ kind: 'workspace' }), false)
  assert.equal(isAutoRetryable(new TypeError('offline')), true)
  assert.equal(isAutoRetryable(new ReadResponseError(503)), true)
  const cycle: { cause?: unknown } = {}; cycle.cause = cycle
  assert.equal(isAutoRetryable(cycle), true)
})

test('read retries have exponential equal jitter, a 30-second cap and at most five attempts', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const delays = [1, 2, 3, 4, 5, 20].map(attempt => readRetryDelay(attempt, () => 1))
  assert.deepEqual(delays, [1_000, 2_000, 4_000, 8_000, 16_000, 30_000])
  assert.equal(readRetryDelay(4, () => 0), 4_000)
  assert.equal(readRetryDelay(40, () => 0.5), 22_500)
  let calls = 0
  for (let retryCount = 1; retryCount <= MAX_READ_RETRIES + 1; retryCount++) {
    retryRead(new ReadResponseError(503), 'key', {}, () => { calls++ }, { retryCount, dedupe: true })
    t.mock.timers.tick(MAX_READ_RETRY_MS)
    assert.equal(calls, Math.min(retryCount, MAX_READ_RETRIES))
  }
  for (const status of [401, 403, 429]) retryRead(new ReadResponseError(status), 'key', {}, () => { calls++ }, { retryCount: 1 })
  retryRead(new Error('offline'), 'key', { errorRetryCount: 2 }, () => { calls++ }, { retryCount: 3 })
  retryRead(new Error('offline'), 'key', { isPaused: () => true }, () => { calls++ }, { retryCount: 1 })
  t.mock.timers.tick(MAX_READ_RETRY_MS)
  assert.equal(calls, MAX_READ_RETRIES)
})

test('group GET failures retain HTTP status and the original network cause', async () => {
  for (const status of [401, 403, 429]) {
    await assert.rejects(fetchGroups('workspace', async () => Response.json({}, { status })), error => {
      assert.equal((error as { status?: number }).status, status)
      assert.equal(isAutoRetryable(error), false)
      return true
    })
  }
  const cause = new TypeError('offline')
  await assert.rejects(fetchGroups('workspace', async () => { throw cause }), error => {
    assert.equal((error as Error).cause, cause)
    assert.equal(isAutoRetryable(error), true)
    return true
  })
})

test('a queued transient retry cannot repeat a newer rate-limit failure or successful read', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const failure = new ReadResponseError(503)
  const cache = new Map([['key', { error: failure as unknown }]])
  let calls = 0
  const schedule = () => retryRead(failure, 'key', { cache } as SWRConfiguration, () => { calls++ }, { retryCount: 1 })
  schedule()
  cache.set('key', { error: new ReadResponseError(429) })
  t.mock.timers.tick(MAX_READ_RETRY_MS)
  assert.equal(calls, 0)
  cache.set('key', { error: failure }); schedule()
  cache.set('key', { error: undefined })
  t.mock.timers.tick(MAX_READ_RETRY_MS)
  assert.equal(calls, 0)
})
