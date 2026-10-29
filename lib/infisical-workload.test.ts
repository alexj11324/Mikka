import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { infisicalWorkloadToken } from './infisical-workload'

test('workload login uses HTTPS, refuses redirects, and returns the scoped token', async () => {
  const fetcher: typeof fetch = async (url, init) => {
    assert.equal(String(url), 'https://secrets.example/api/v1/auth/universal-auth/login')
    assert.equal(init?.redirect, 'error')
    assert.deepEqual(JSON.parse(String(init?.body)), { clientId: 'id', clientSecret: 'secret' })
    return Response.json({ accessToken: 'short-lived' })
  }
  assert.equal(await infisicalWorkloadToken('https://secrets.example', 'id', 'secret', undefined, fetcher), 'short-lived')
})

test('identity errors do not expose credentials or remote responses', async () => {
  const failure: typeof fetch = async () => { throw new Error('secret provider response') }
  await assert.rejects(infisicalWorkloadToken('https://secrets.example', 'id', 'secret', undefined, failure), { message: 'infisical_identity_unavailable' })
  await assert.rejects(infisicalWorkloadToken('http://secrets.example', 'id', 'secret', undefined, failure), { message: 'infisical_identity_unavailable' })
  await assert.rejects(infisicalWorkloadToken('https://secrets.example/path', 'id', 'secret', undefined, failure), { message: 'infisical_identity_unavailable' })
  await assert.rejects(infisicalWorkloadToken('https://secrets.example', 'id', 'secret', undefined, async () => Response.json({ accessToken: '' })), { message: 'infisical_identity_unavailable' })
})
