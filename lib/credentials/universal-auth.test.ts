import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { universalAuthTokenProvider } from './universal-auth'
import { InfisicalCredentialVault } from './vault'

const origin = 'https://vault.example.invalid'
const credentials = { clientId: 'synthetic-client', clientSecret: 'synthetic-client-secret' }
const token = (value = 'synthetic-access', expiresIn = 600) => Response.json({ accessToken: value, expiresIn, tokenType: 'Bearer' })
const rejected = (promise: Promise<unknown>) => assert.rejects(promise, { message: 'vault_auth_unavailable' })

test('default/missing identity refuses without transport; only HTTPS origin accepted', async () => {
  let calls = 0
  const p = universalAuthTokenProvider({ origin, credentials: () => undefined, fetch: async () => { calls++; return token() } })
  await rejected(p.getAccessToken()); assert.equal(calls, 0)
  assert.throws(() => universalAuthTokenProvider({ origin: 'http://localhost', credentials: () => credentials }))
})

test('single flight, early refresh, new login beyond original maximum lifetime', async () => {
  let time = 0, calls = 0
  const p = universalAuthTokenProvider({ origin, credentials: () => credentials, now: () => time, fetch: async () => { calls++; await Promise.resolve(); return token(`synthetic-${calls}`) } })
  assert.deepEqual(await Promise.all(Array.from({ length: 10 }, () => p.getAccessToken())), Array(10).fill('synthetic-1'))
  time = 539999; await p.getAccessToken(); assert.equal(calls, 1)
  time = 540000; assert.equal(await p.getAccessToken(), 'synthetic-2')
  time = 5000000; assert.equal(await p.getAccessToken(), 'synthetic-3')
})

test('refresh failure discards still-valid old token, cools down, later recovers', async () => {
  let time = 0, calls = 0
  const p = universalAuthTokenProvider({ origin, credentials: () => credentials, now: () => time, fetch: async () => ++calls === 2 ? new Response('synthetic-sensitive-body', { status: 503 }) : token() })
  await p.getAccessToken(); time = 540000
  await rejected(p.getAccessToken()); await rejected(p.getAccessToken()); assert.equal(calls, 2)
  time += 30000; await p.getAccessToken(); assert.equal(calls, 3)
})

test('401/403 latches until credential rotation; rejected vault token is not reissued', async () => {
  for (const status of [401, 403]) {
    let time = 0, calls = 0, current = credentials
    const p = universalAuthTokenProvider({ origin, credentials: () => current, now: () => time, fetch: async () => ++calls === 1 ? new Response('', { status }) : token() })
    await rejected(p.getAccessToken()); time += 999999; await rejected(p.getAccessToken()); assert.equal(calls, 1)
    current = { ...credentials, clientSecret: 'synthetic-rotated' }
    const value = await p.getAccessToken(); p.rejectAccessToken(value)
    await rejected(p.getAccessToken()); assert.equal(calls, 2)
  }
})

test('in-flight old login cannot survive rotation or disable; no cached credential leak', async () => {
  let current: typeof credentials | undefined = credentials
  let release!: () => void
  const p = universalAuthTokenProvider({ origin, credentials: () => current, fetch: async () => { await new Promise<void>(r => { release = r }); return token() } })
  const old = p.getAccessToken(); current = undefined; release(); await rejected(old)
  await rejected(p.getAccessToken())
})

test('malformed/overlong/non-bearer/invalid-expiry/slow responses fail closed and redact', async () => {
  for (const body of [...[NaN, Infinity, -1, 1.5, '600', Number.MAX_SAFE_INTEGER].map(expiresIn => ({ accessToken: 'synthetic', tokenType: 'Bearer', expiresIn })), { accessToken: 'bad\nvalue', tokenType: 'Bearer', expiresIn: 600 }, { accessToken: 'x', tokenType: 'Other', expiresIn: 600 }, { accessToken: 'x', tokenType: 'Bearer', expiresIn: 0 }, { accessToken: 'x'.repeat(16385), tokenType: 'Bearer', expiresIn: 600 }]) {
    const p = universalAuthTokenProvider({ origin, credentials: () => credentials, fetch: async () => Response.json(body) })
    await rejected(p.getAccessToken())
  }
  let time = 0
  const p = universalAuthTokenProvider({ origin, credentials: () => credentials, now: () => time, fetch: async () => { time = 600001; return token() } })
  await rejected(p.getAccessToken())
  const network = universalAuthTokenProvider({ origin, credentials: () => credentials, fetch: async () => { throw new Error('synthetic-secret-must-not-escape') } })
  await rejected(network.getAccessToken())
})

test('real loopback HTTP30-day cleaner login/delete/denial and redirect refusal; no real Infisical identity', async () => {
  let logins = 0, deletes = 0, rejectedToken = false, redirect = false
  const server = createServer(async (req, res) => {
    if (req.url === '/api/v1/auth/universal-auth/login') {
      logins++; let data = ''; for await (const chunk of req) data += chunk
      assert.deepEqual(JSON.parse(data), credentials)
      if (redirect) { res.writeHead(302, { location: '/must-not-follow' }); res.end(); return }
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ accessToken: 'synthetic-http-token', tokenType: 'Bearer', expiresIn: 2592000 })); return
    }
    assert.equal(req.method, 'DELETE'); assert.equal(req.headers.authorization, 'Bearer synthetic-http-token')
    deletes++; res.writeHead(rejectedToken ? 403 : 200); res.end()
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address(); assert(address && typeof address !== 'string')
  const transport: typeof fetch = (input, init) => {
    const u = new URL(String(input)); assert.equal(u.origin, origin)
    assert.equal(init?.redirect, 'error'); assert(init?.signal)
    return fetch(`http://127.0.0.1:${address.port}${u.pathname}${u.search}`, init)
  }
  try {
    const p = universalAuthTokenProvider({ origin, credentials: () => credentials, fetch: transport })
    const vault = new InfisicalCredentialVault({ origin, projectId: 'synthetic-project', environment: 'prod', secretPath: '/credential-custody/production', accessToken: p.getAccessToken, rejectAccessToken: p.rejectAccessToken, fetch: transport })
    const ref = '00000000-0000-4000-8000-000000000001'
    await vault.remove(ref); rejectedToken = true
    await assert.rejects(vault.remove(ref), { message: 'vault_unavailable' })
    await assert.rejects(vault.remove(ref), { message: 'vault_unavailable' })
    assert.equal(logins, 1); assert.equal(deletes, 2)
    redirect = true
    const other = universalAuthTokenProvider({ origin, credentials: () => credentials, fetch: transport })
    await rejected(other.getAccessToken()); assert.equal(logins, 2); assert.equal(deletes, 2)
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})

test('old refresh and old vault rejection cannot overwrite a rotated token', async () => {
  let current = credentials, calls = 0
  let release!: () => void
  const p = universalAuthTokenProvider({ origin, credentials: () => current, fetch: async () => {
    calls++
    if (calls === 1) { await new Promise<void>(r => { release = r }); return token('synthetic-old') }
    return token('synthetic-new')
  } })
  const old = p.getAccessToken()
  current = { ...credentials, clientSecret: 'synthetic-rotation' }
  assert.equal(await p.getAccessToken(), 'synthetic-new')
  release(); await rejected(old)
  p.rejectAccessToken('synthetic-old')
  assert.equal(await p.getAccessToken(), 'synthetic-new'); assert.equal(calls, 2)
})

test('vault rejection during early refresh fences late login response', async () => {
  let time = 0, calls = 0
  let release!: () => void
  const p = universalAuthTokenProvider({ origin, credentials: () => credentials, now: () => time, fetch: async () => {
    calls++
    if (calls > 1) await new Promise<void>(r => { release = r })
    return token(`synthetic-${calls}`)
  } })
  const old = await p.getAccessToken(); time = 540000
  const refreshing = p.getAccessToken(); p.rejectAccessToken(old); release()
  await rejected(refreshing); await rejected(p.getAccessToken()); assert.equal(calls, 2)
})

test('delayed old-identity denial does not latch rotated credentials while login is pending', async () => {
  let current = credentials, calls = 0
  let release!: () => void
  const p = universalAuthTokenProvider({ origin, credentials: () => current, fetch: async () => {
    calls++
    if (calls === 2) await new Promise<void>(r => { release = r })
    return token(`synthetic-${calls}`)
  } })
  const old = await p.getAccessToken()
  current = { ...credentials, clientSecret: 'synthetic-rotated-pending' }
  const rotated = p.getAccessToken()
  p.rejectAccessToken(old); release()
  assert.equal(await rotated, 'synthetic-2')
  assert.equal(await p.getAccessToken(), 'synthetic-2'); assert.equal(calls, 2)
})

test('bounded worker lifetime requires enough validity and refreshes cached tokens before dispatch', async () => {
  let time=0, calls=0
  const p=universalAuthTokenProvider({origin,credentials:()=>credentials,minimumValidityMs:335000,now:()=>time,fetch:async()=>token(`lease-${++calls}`)})
  assert.equal(await p.getAccessToken(),'lease-1')
  time=264999; assert.equal(await p.getAccessToken(),'lease-1')
  time=265000; assert.equal(await p.getAccessToken(),'lease-2')
  const short=universalAuthTokenProvider({origin,credentials:()=>credentials,minimumValidityMs:335000,fetch:async()=>token('too-short',300)})
  await rejected(short.getAccessToken())
})

test('issuer 30-day lifetime works for default cleaner and bounded BYOS leases, with early refresh and denial', async()=>{
 for(const minimumValidityMs of [0,105000,335000]) {
  let time=0,calls=0
  const ttl=2592000,margin=Math.max(minimumValidityMs,60000)
  const p=universalAuthTokenProvider({origin,credentials:()=>credentials,minimumValidityMs,now:()=>time,fetch:async()=>token(`long-${++calls}`,ttl)})
  assert.equal(await p.getAccessToken(),'long-1')
  time=ttl*1000-margin-1;assert.equal(await p.getAccessToken(),'long-1');assert.equal(calls,1)
  time++;assert.equal(await p.getAccessToken(),'long-2');assert.equal(calls,2)
  p.rejectAccessToken('long-2');await rejected(p.getAccessToken())
 }
})
test('long issuer lifetime cannot survive elapsed expiry or unsafe deadline arithmetic',async()=>{
 let time=0
 const p=universalAuthTokenProvider({origin,credentials:()=>credentials,now:()=>time,fetch:async()=>{time=2592000001;return token('expired',2592000)}})
 await rejected(p.getAccessToken())
 const overflow=universalAuthTokenProvider({origin,credentials:()=>credentials,now:()=>Number.MAX_SAFE_INTEGER-10,fetch:async()=>token('overflow',600)})
 await rejected(overflow.getAccessToken())
})

test('non-2xx diagnostics use only fixed classifications and a hashed request identifier', async () => {
  const cases = [
    [401, 'UnauthorizedError', 'Invalid credentials', 'invalid_credentials'],
    [401, 'UnauthorizedError', 'Access denied due to expired client secret', 'client_secret_expired'],
    [401, 'UnauthorizedError', 'Access denied due to client secret usage limit reached', 'client_secret_usage_limit'],
    [401, 'UnauthorizedError', 'This identity auth method is temporarily locked, please try again later', 'temporarily_locked'],
    [403, 'ForbiddenRequestError', 'You are not allowed to access this resource from the current IP address', 'ip_denied'],
  ] as const
  for (const [status, error, message, reason] of cases) {
    const observed: unknown[] = []
    const p = universalAuthTokenProvider({ origin, credentials: () => credentials,
      fetch: async () => Response.json({ statusCode: status, error, message, reqId: 'req-abc123', unexpected: credentials }, { status }),
      onFailure: value => observed.push(value),
    })
    await rejected(p.getAccessToken())
    const value = observed[0] as Record<string, unknown>
    assert.deepEqual(Object.keys(value).sort(), ['kind', 'reason', 'requestIdHash', 'status'])
    assert.equal(value.reason, reason); assert.match(String(value.requestIdHash), /^[a-f0-9]{64}$/)
    for (const forbidden of [message, 'req-abc123', credentials.clientId, credentials.clientSecret, 'unexpected']) assert(!JSON.stringify(observed).includes(forbidden))
  }
})

test('unknown, malicious and overlong upstream payloads cannot become diagnostic text', async () => {
  const cases = [
    Response.json({ statusCode: 401, error: 'UnauthorizedError', message: `Invalid credentials ${credentials.clientSecret}`, reqId: 'req-a\nInjected' }, { status: 401 }),
    Response.json({ statusCode: 401, error: 'UnauthorizedError', message: 'x'.repeat(5000), reqId: 'req-a' }, { status: 401 }),
    Response.json({ statusCode: 403, error: 'UnauthorizedError', message: 'Invalid credentials', reqId: 'req-a' }, { status: 401 }),
    Response.json({ statusCode: 401, error: 'UnknownError', message: credentials.clientSecret, reqId: credentials.clientSecret }, { status: 401 }),
    new Response(`<html>${credentials.clientSecret}</html>`, { status: 401, headers: { 'content-type': 'text/html' } }),
    new Response('{invalid', { status: 401, headers: { 'content-type': 'application/json' } }),
    Response.json(null, { status: 401 }), Response.json([], { status: 401 }),
    new Response('{}', { status: 401, headers: { 'content-type': 'application/json', 'content-length': '999999' } }),
  ]
  for (const response of cases) {
    const observed: unknown[] = []
    const p = universalAuthTokenProvider({ origin, credentials: () => credentials, fetch: async () => response, onFailure: value => observed.push(value) })
    await rejected(p.getAccessToken()); assert.deepEqual(observed, [{ kind: 'http', status: 401, reason: 'unknown' }])
  }
})

test('request ID length, syntax and credential collisions are rejected without exposing any original field', async () => {
  for (const reqId of ['req-' + 'x'.repeat(100), 'https://private.invalid/token', 'req-a\r\nsecret', credentials.clientSecret, 'req-secret']) {
    const observed: unknown[] = []
    const current = { ...credentials, clientSecret: 'req-secret' }
    const p = universalAuthTokenProvider({ origin, credentials: () => current,
      fetch: async () => Response.json({ statusCode: 401, error: 'UnauthorizedError', message: 'Invalid credentials', reqId }, { status: 401 }),
      onFailure: value => observed.push(value),
    })
    await rejected(p.getAccessToken()); assert.deepEqual(observed, [{ kind: 'http', status: 401, reason: 'invalid_credentials' }])
  }
})

test('hostile streams are bounded and 401 remains latched without retry or secret-bearing errors', async () => {
  for (const mode of ['never', 'many', 'large', 'error'] as const) {
    let canceled = false, calls = 0, time = 0
    const observed: unknown[] = []
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (mode === 'many') controller.enqueue(new Uint8Array())
        if (mode === 'large') controller.enqueue(new Uint8Array(4097))
        if (mode === 'error') controller.error(new Error(credentials.clientSecret))
      },
      cancel() { canceled = true },
    })
    const p = universalAuthTokenProvider({ origin, credentials: () => credentials, now: () => time,
      fetch: async () => { calls++; return new Response(stream, { status: 401, headers: { 'content-type': 'application/json' } }) },
      onFailure: value => { observed.push(value); throw new Error(credentials.clientSecret) },
    })
    const started = performance.now()
    await Promise.all(Array.from({ length: 5 }, () => rejected(p.getAccessToken())))
    time += 999999; await rejected(p.getAccessToken())
    assert.equal(calls, 1); assert(performance.now() - started < 1500)
    assert.deepEqual(observed, [{ kind: 'http', status: 401, reason: 'unknown' }])
    if (mode !== 'error') assert(canceled)
  }
})

test('real loopback login denial produces fixed classification, hashed ID and exactly one request', async () => {
  let calls = 0
  const observed: unknown[] = []
  const server = createServer(async (req, res) => {
    calls++; assert.equal(req.method, 'POST'); assert.equal(req.url, '/api/v1/auth/universal-auth/login')
    assert.equal(req.headers['content-type'], 'application/json')
    let body = ''; for await (const chunk of req) body += chunk
    assert.deepEqual(JSON.parse(body), credentials)
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ statusCode: 401, error: 'UnauthorizedError', message: 'Access denied due to expired client secret', reqId: 'req-loopback', private: credentials.clientSecret }))
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address(); assert(address && typeof address !== 'string')
  try {
    const p = universalAuthTokenProvider({ origin, credentials: () => credentials,
      fetch: (input, init) => { const url = new URL(String(input)); assert.equal(url.origin, origin); return fetch(`http://127.0.0.1:${address.port}${url.pathname}`, init) },
      onFailure: value => observed.push(value),
    })
    await rejected(p.getAccessToken()); await rejected(p.getAccessToken())
    assert.equal(calls, 1)
    const diagnostic = observed[0] as Record<string, unknown>
    assert.equal(diagnostic.reason, 'client_secret_expired')
    assert.match(String(diagnostic.requestIdHash), /^[a-f0-9]{64}$/)
    assert(!JSON.stringify(observed).includes('req-loopback')); assert(!JSON.stringify(observed).includes(credentials.clientSecret))
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})
