import assert from 'node:assert/strict'
import { before, mock, test } from 'node:test'
import { Composio } from '@composio/core'

const forgotten: string[][] = []
mock.module(new URL('./composio-account-store.ts', import.meta.url).href, { exports: {
  chosenComposioDefault: async () => null,
  forgetComposioAccount: async (userId: string, accountId: string) => { forgotten.push([userId, accountId]) },
} })
let retireComposioAccount: typeof import('./composio').retireComposioAccount
before(async () => { ({ retireComposioAccount } = await import('./composio')) })

test('real SDK disconnect uses only the exact account delete endpoint and requests revocation', async () => {
  const client = new Composio({ apiKey: 'synthetic-test-key', baseURL: 'https://composio.test.invalid', allowTracking: false, disableVersionCheck: true })
  const calls: { method: string; url: string }[] = []
  let status = 200, success = true
  const transport = mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init)
    assert.equal(new URL(request.url).origin, 'https://composio.test.invalid')
    calls.push({ method: request.method, url: request.url })
    return Response.json(status === 200 ? { success } : { error: { message: 'synthetic refusal' } }, { status })
  })
  try {
    await retireComposioAccount(client, 'owner', 'ca_exact')
    assert.deepEqual(forgotten, [['owner', 'ca_exact']])
    assert.deepEqual(calls, [{ method: 'DELETE', url: 'https://composio.test.invalid/api/v3.1/connected_accounts/ca_exact?revoke_on_delete=true' }])
    forgotten.length = 0
    for (const response of [{ status: 400, success: false }, { status: 200, success: false }]) {
      status = response.status; success = response.success; calls.length = 0
      await assert.rejects(retireComposioAccount(client, 'owner', 'ca_exact'))
      assert.deepEqual(forgotten, [])
      assert.equal(calls.length, 1)
      assert.equal(calls[0].method, 'DELETE')
    }
  } finally { transport.mock.restore() }
})
