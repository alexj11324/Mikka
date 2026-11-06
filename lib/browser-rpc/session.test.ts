import assert from 'node:assert/strict'
import test from 'node:test'
import { z } from 'zod'
import { createBrowserRpc } from './handler'
import { browserAuthentication, readBrowserSession, withBrowserSession } from './session'
import { currentDesktopSession } from '../desktop-rpc/session'
import { readFreshSessionsInScope, withFreshSession } from '../fresh-session'

const headers = (owner = 'one') => new Headers({ cookie: `session=${owner}` })
const session = { user: { id: 'one' }, session: { id: 'public-session' } }

test('request reuse is exact-cookie bound and never changes the desktop scope', async () => {
  await withBrowserSession('session=one', session, { fresh: false, refresh: async () => null }, async () => {
    assert.equal(await readBrowserSession({ headers: headers() }, false), session)
    assert.equal(readBrowserSession({ headers: headers('other') }, false), undefined)
    assert.equal(readBrowserSession(undefined, false), undefined)
    assert.equal(currentDesktopSession(), undefined)
    assert.equal(readBrowserSession({ headers: new Headers({ cookie: 'session=one', authorization: 'Bearer anything' }) }, false), undefined)
  })
  assert.equal(readBrowserSession({ headers: headers() }, false), undefined)
})

test('SDK response modes and unknown semantics bypass reuse', async () => {
  const modes = [{ returnHeaders: true }, { asResponse: true }, { returnStatus: true }, { futureOption: true }, { query: { future: true } }, { query: { disableRefresh: true } }]
  await withBrowserSession('session=one', session, { fresh: true, refresh: async () => session }, async () => {
    for (const mode of modes) assert.equal(readBrowserSession({ headers: headers(), ...mode }, false), undefined)
  })
})

test('concurrent fresh checks upgrade once and null never falls back', async () => {
  let calls = 0
  const gate = Promise.withResolvers<null>()
  await withBrowserSession('session=one', session, { fresh: false, refresh: () => { calls++; return gate.promise } }, async () => {
    const first = readBrowserSession({ headers: headers() }, true)
    const second = readBrowserSession({ headers: headers() }, true)
    gate.resolve(null)
    assert.equal(first, second); assert.deepEqual(await Promise.all([first, second]), [null, null])
    assert.equal(await readBrowserSession({ headers: headers() }, false), null)
    assert.equal(await readBrowserSession({ headers: headers() }, true), null)
  })
  assert.equal(calls, 1)
})

test('a failed fresh authorization cannot fall back to cached identity', async () => {
  let calls = 0
  await withBrowserSession('session=one', session, { fresh: false, refresh: async () => { calls++; throw new Error('fixture') } }, async () => {
    await assert.rejects(readBrowserSession({ headers: headers() }, true)!, /fixture/)
    await assert.rejects(readBrowserSession({ headers: headers() }, false)!, /fixture/)
  })
  assert.equal(calls, 1)
})

test('fresh wrapper delegates unfamiliar contexts to real SDK and retains the DB flag', async () => {
  const seen: unknown[] = []
  const api = { getSession: async (input: unknown) => { seen.push(input); return { sdk: true } } }
  readFreshSessionsInScope(api)
  await withBrowserSession('session=one', session, { fresh: false, refresh: async () => null }, async () => {
    assert.deepEqual(await api.getSession({ headers: headers(), returnStatus: true }), { sdk: true })
    const result = await withFreshSession(() => api.getSession({ headers: headers(), returnHeaders: true }))
    assert.deepEqual(result, { sdk: true })
  })
  assert.equal((seen[1] as { query: { disableCookieCache: boolean } }).query.disableCookieCache, true)
})

test('initial/fresh SDK cookie outputs survive; only a real issued proof marks initial read fresh', async () => {
  let calls = 0
  const auth = browserAuthentication(async input => {
    calls++
    const output = new Headers()
    if (input.query?.disableCookieCache) output.append('set-cookie', 'better-auth.session_data=validProof; Path=/; HttpOnly')
    output.append('set-cookie', 'old=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; Secure')
    return { response: session, headers: output }
  }, async () => 'better-auth.session_data')
  const identity = await auth.authenticate(headers())
  assert.ok(identity); assert.equal(identity.fresh, false)
  const result = await auth.scope(identity, async () => {
    assert.equal(await readBrowserSession({ headers: headers() }, false), session)
    assert.equal(await readBrowserSession({ headers: headers() }, true), session)
    return Response.json({ ok: true }, { headers: { 'x-mikka-session-token': 'private', 'x-mikka-session-cache': 'private' } })
  })
  assert.equal(calls, 2)
  assert.deepEqual(result.headers.getSetCookie(), ['old=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; Secure', 'better-auth.session_data=validProof; Path=/; HttpOnly'])
  assert.equal(result.headers.has('x-mikka-session-token'), false); assert.equal(result.headers.has('x-mikka-session-cache'), false)
})

test('browser RPC rejects origin, cookie/bearer confusion, unknown actions and invalid args before execution', async () => {
  let reads = 0, invoked = 0
  const rpc = createBrowserRpc({
    trustedBaseURL: 'https://example.test', authenticate: async () => { reads++; return session },
    scope: (_session, work) => work(),
    actions: { 'test.read': { args: z.tuple([z.string().uuid()]), invoke: async () => { invoked++; return new Date('2026-01-01') } } },
  })
  const request = (body: unknown, extra: Record<string, string> = {}) => new Request('https://example.test/mikka/api/rpc', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://example.test', 'x-mikka-rpc': '1', cookie: 'session=one', ...extra }, body: JSON.stringify(body),
  })
  const valid = { version: 1, action: 'test.read', args: ['8fd4a011-25c0-4e0e-ad1e-ef0203ee15c3'] }
  const deniedHeaders: Record<string, string>[] = [{ origin: 'https://foreign.test' }, { authorization: 'Bearer anything' }, { 'x-mikka-session-cache': 'cache' }, { 'sec-fetch-site': 'cross-site' }]
  for (const extra of deniedHeaders) assert.equal((await rpc(request(valid, extra))).status, 403)
  assert.equal(reads, 0)
  assert.equal((await rpc(request({ ...valid, action: 'auth.getSession' }))).status, 404)
  assert.equal((await rpc(request({ ...valid, args: ['not-a-uuid'] }))).status, 400)
  assert.equal((await rpc(request({ ...valid, version: 99 }))).status, 426)
  assert.equal(invoked, 0)
  const response = await rpc(request(valid, { 'x-deployment-id': 'dpl_public' }))
  assert.equal(response.status, 200); assert.equal(response.headers.get('vary'), 'Cookie')
  assert.equal((await response.json()).ok, true); assert.equal(invoked, 1)
})
