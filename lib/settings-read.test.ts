import assert from 'node:assert/strict'
import test from 'node:test'
import { settingsRead } from './settings-read'
import { isAutoRetryable, ReadResponseError } from './swr/retry'

test('settings reads retain 401, 403 and 429 without exposing response bodies', async t => {
  for (const status of [401, 403, 429]) {
    const stub = t.mock.method(globalThis, 'fetch', async () => Response.json({ error: 'private body' }, { status }))
    await assert.rejects(settingsRead('issue-prefix'), error => {
      assert.ok(error instanceof ReadResponseError)
      assert.equal(error.status, status)
      assert.equal(isAutoRetryable(error), false)
      assert.equal(error.message.includes('private body'), false)
      return true
    })
    stub.mock.restore()
  }
})

test('ordinary settings use authorized no-store GET and keep their read model', async t => {
  const value = { prefix: 'ALEX', saved: null, suggested: 'ALEX', teamKeys: [] }
  const stub = t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    assert.ok(String(url).endsWith('/api/settings/issue-prefix'))
    assert.equal(init?.cache, 'no-store')
    assert.equal(init?.credentials, 'same-origin')
    return Response.json(value)
  })
  assert.deepEqual(await settingsRead('issue-prefix'), value)
  stub.mock.restore()
})
