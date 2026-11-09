import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { createSnapshotWorkloadTokenCache, infisicalWorkloadToken } from './infisical-workload'

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

test('ordinary workload callers still log in freshly even when issuer TTL is present', async () => {
  let calls = 0
  const fetcher: typeof fetch = async () => Response.json({ accessToken: `token-${++calls}`, expiresIn: 3600 })
  assert.equal(await infisicalWorkloadToken('https://vault.example', 'id', 'secret', undefined, fetcher), 'token-1')
  assert.equal(await infisicalWorkloadToken('https://vault.example', 'id', 'secret', undefined, fetcher), 'token-2')
})

test('snapshot token expiry honors issuer TTL, local cap and a fixed non-sliding margin', async () => {
  for (const [ttl, lifetime] of [[5, 4000], [60, 59000], [3600, 59000]]) {
    let now = 100, calls = 0
    const cache = createSnapshotWorkloadTokenCache(() => now)
    const fetcher: typeof fetch = async () => Response.json({ accessToken: `token-${++calls}`, expiresIn: ttl, accessTokenMaxTTL: 999999 })
    const get = () => cache.get('https://vault.example', 'id', 'secret', undefined, fetcher)
    assert.equal((await get()).token, 'token-1')
    now = 100 + lifetime - 1
    assert.equal((await get()).token, 'token-1')
    now++
    assert.equal((await get()).token, 'token-2')
    assert.equal(calls, 2)
  }
})

test('invalid or exhausted issuer lifetimes remain fresh and are never guessed', async () => {
  for (const ttl of [undefined, null, 0, -1, Number.NaN, Infinity, '60', true, 0.5]) {
    let calls = 0
    const cache = createSnapshotWorkloadTokenCache(() => 0)
    const fetcher: typeof fetch = async () => Response.json({ accessToken: `token-${++calls}`, expiresIn: ttl, accessTokenMaxTTL: 3600 })
    await cache.get('https://vault.example', 'id', 'secret', undefined, fetcher)
    assert.equal((await cache.get('https://vault.example', 'id', 'secret', undefined, fetcher)).token, 'token-2')
  }
  let now = 0, calls = 0
  const cache = createSnapshotWorkloadTokenCache(() => now)
  const fetcher: typeof fetch = async () => { calls++; now += 5000; return Response.json({ accessToken: `token-${calls}`, expiresIn: 5 }) }
  await cache.get('https://vault.example', 'id', 'secret', undefined, fetcher)
  assert.equal((await cache.get('https://vault.example', 'id', 'secret', undefined, fetcher)).token, 'token-2')
})

test('login latency consumes token lifetime rather than extending it after response', async () => {
  let now = 0, calls = 0
  const cache = createSnapshotWorkloadTokenCache(() => now)
  const fetcher: typeof fetch = async () => { calls++; now += 2000; return Response.json({ accessToken: `token-${calls}`, expiresIn: 5 }) }
  await cache.get('https://vault.example', 'id', 'secret', undefined, fetcher)
  now = 3999
  assert.equal((await cache.get('https://vault.example', 'id', 'secret', undefined, fetcher)).token, 'token-1')
  now = 4000
  assert.equal((await cache.get('https://vault.example', 'id', 'secret', undefined, fetcher)).token, 'token-2')
})

test('snapshot tokens are isolated by validated origin, client id and secret', async () => {
  let calls = 0
  const cache = createSnapshotWorkloadTokenCache(() => 0)
  const fetcher: typeof fetch = async () => Response.json({ accessToken: `token-${++calls}`, expiresIn: 60 })
  const get = (origin = 'https://vault.example', id = 'id', secret = 'secret') => cache.get(origin, id, secret, undefined, fetcher)
  await get()
  assert.equal((await get('https://vault.example/')).token, 'token-1')
  assert.equal((await get('https://other.example')).token, 'token-2')
  assert.equal((await get(undefined, 'other-id')).token, 'token-3')
  assert.equal((await get(undefined, undefined, 'other-secret')).token, 'token-4')
  for (const invalid of ['http://vault.example', 'https://vault.example/path', 'https://private@vault.example', 'https://vault.example/?private', 'not-a-url']) {
    await assert.rejects(get(invalid))
  }
  assert.equal(calls, 4)
})

test('snapshot token storage is bounded to eight credentials without a timer', async () => {
  let calls = 0
  const cache = createSnapshotWorkloadTokenCache(() => 0)
  const fetcher: typeof fetch = async () => Response.json({ accessToken: `token-${++calls}`, expiresIn: 60 })
  for (let i = 0; i < 9; i++) await cache.get('https://vault.example', `id-${i}`, 'secret', undefined, fetcher)
  assert.equal((await cache.get('https://vault.example', 'id-8', 'secret', undefined, fetcher)).token, 'token-9')
  assert.equal((await cache.get('https://vault.example', 'id-0', 'secret', undefined, fetcher)).token, 'token-10')
})

test('an old refused token cannot evict a newer concurrent login', async () => {
  let calls = 0
  const pending: Array<(response: Response) => void> = []
  const cache = createSnapshotWorkloadTokenCache(() => 0)
  const fetcher: typeof fetch = async () => {
    calls++
    if (calls <= 2) return new Promise<Response>(resolve => pending.push(resolve))
    return Response.json({ accessToken: 'token-C', expiresIn: 60 })
  }
  const a = cache.get('https://vault.example', 'id', 'secret', undefined, fetcher)
  const b = cache.get('https://vault.example', 'id', 'secret', undefined, fetcher)
  assert.equal(calls, 2, 'independent misses do not share caller cancellation')
  pending[0](Response.json({ accessToken: 'token-A', expiresIn: 60 }))
  const first = await a
  pending[1](Response.json({ accessToken: 'token-B', expiresIn: 60 }))
  const second = await b
  first.invalidate()
  assert.equal((await cache.get('https://vault.example', 'id', 'secret', undefined, fetcher)).token, 'token-B')
  assert.equal(calls, 2)
  second.invalidate()
  assert.equal((await cache.get('https://vault.example', 'id', 'secret', undefined, fetcher)).token, 'token-C')
  assert.equal(calls, 3)
})

test('cancelled login cannot populate the cache or cancel another caller', async () => {
  let calls = 0
  const pending: Array<(response: Response) => void> = []
  const cache = createSnapshotWorkloadTokenCache(() => 0)
  const fetcher: typeof fetch = async () => { calls++; return new Promise<Response>(resolve => pending.push(resolve)) }
  const abort = new AbortController()
  const a = cache.get('https://vault.example', 'id', 'secret', abort.signal, fetcher)
  const rejected = assert.rejects(a, /infisical_identity_unavailable/)
  const b = cache.get('https://vault.example', 'id', 'secret', undefined, fetcher)
  assert.equal(calls, 2)
  abort.abort(new Error('private-reason'))
  pending[1](Response.json({ accessToken: 'token-B', expiresIn: 60 }))
  assert.equal((await b).token, 'token-B')
  pending[0](Response.json({ accessToken: 'token-A', expiresIn: 60 }))
  await rejected
  assert.equal((await cache.get('https://vault.example', 'id', 'secret', undefined, fetcher)).token, 'token-B')
  await assert.rejects(cache.get('https://vault.example', 'id', 'secret', abort.signal, fetcher), /infisical_identity_unavailable/)
  assert.equal(calls, 2)
})
