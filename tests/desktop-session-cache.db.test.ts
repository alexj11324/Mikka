import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomBytes, randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { Pool, type PoolClient } from 'pg'
import { z } from 'zod'
import { disposableDatabase } from './helpers/e2e-target.mjs'
import { createDesktopRpc } from '../lib/desktop-rpc/handler'
import { createBrowserRpc } from '../lib/browser-rpc/handler'
import { browserAuthentication } from '../lib/browser-rpc/session'
import { desktopAuthentication } from '../lib/desktop-rpc/authentication'
import { safeDesktopSession, withDesktopSession } from '../lib/desktop-rpc/session'
import { DESKTOP_SESSION_CACHE_HEADER as cacheHeader, desktopSessionCacheAfter, desktopSessionCacheFromHeaders, validDesktopSessionCache, withDesktopSessionCache } from '../lib/desktop-rpc/session-cache'
import { decode, encode } from '../lib/desktop-rpc/wire'
import { withRequestLog } from '../lib/request-log'

const url = disposableDatabase() ? process.env.E2E_DATABASE_URL : undefined
if (process.env.REQUIRE_DB === '1' && !url) throw new Error('Native session cache tests require an isolated loopback *_e2e database')

test('native reads use the same signed cache and complete PostgreSQL budget as the original web action; sensitive reads revalidate', { skip: !url, timeout: 120_000 }, async t => {
  const database = new Pool({ connectionString: url, max: 4 })
  const requestHeaders = new AsyncLocalStorage<Headers>()
  const responseCookies = new AsyncLocalStorage<{ name: string; value: string; maxAge?: number }[]>()
  const clients = new Set<PoolClient>()
  const userIds: string[] = []
  const mocks: { restore(): void }[] = []
  let statements = 0, business: PoolClient | undefined, closeApplicationPool: (() => Promise<void>) | undefined
  database.on('connect', client => {
    clients.add(client)
    const query = client.query.bind(client)
    client.query = ((...args: Parameters<typeof query>) => { statements++; return query(...args) }) as typeof client.query
  })
  const bytes = () => [...clients].reduce((total, client) => total + (client as unknown as { connection: { stream: { bytesRead: number } } }).connection.stream.bytesRead, 0)
  const measure = async <T>(work: () => Promise<T>) => {
    const before = { statements, bytes: bytes() }
    const value = await work()
    return { value, statements: statements - before.statements, bytes: bytes() - before.bytes }
  }
  try {
    mocks.push(mock.module('next/headers.js', { namedExports: {
      headers: async () => requestHeaders.getStore() ?? new Headers(),
      cookies: async () => ({ set: (name: string, value: string, options: { maxAge?: number }) => responseCookies.getStore()?.push({ name, value, maxAge: options.maxAge }), get: () => undefined }),
    } }))
    const [{ betterAuth }, { createAuthMiddleware }, { bearer }, { nextCookies }, fresh] = await Promise.all([
      import('better-auth'), import('better-auth/api'), import('better-auth/plugins'), import('better-auth/next-js'), import('../lib/fresh-session'),
    ])
    const origin = 'http://127.0.0.1:3189', secret = randomBytes(32).toString('hex')
    const make = (maxAge = fresh.SESSION_COOKIE_CACHE_SECONDS, version = '1') => {
      const instance = betterAuth({ baseURL: origin, basePath: '/mikka/api/auth', database, secret,
        emailAndPassword: { enabled: true }, trustedOrigins: [origin], logger: { disabled: true }, plugins: [bearer(), nextCookies()],
        session: { ...fresh.SESSION_OPTIONS, cookieCache: { ...fresh.SESSION_OPTIONS.cookieCache, maxAge, version } },
        advanced: { database: { validateSchema: false } },
        hooks: { after: createAuthMiddleware(async ctx => desktopSessionCacheAfter(ctx)) },
      })
      const cookieName = async () => (await instance.$context).authCookies.sessionData.name
      fresh.readFreshSessionsInScope(instance.api, { cookieName })
      instance.handler = withDesktopSessionCache(instance.handler, cookieName)
      return instance
    }
    const auth = make()
    mocks.push(mock.module(new URL('../lib/auth.ts', import.meta.url).href, { namedExports: { auth } }))
    const [{ getPreferences }, { withDatabaseClient, pool }, { ActionFailureError }] = await Promise.all([
      import('../app/actions/preferences'), import('../lib/db'), import('../lib/action-error'),
    ])
    closeApplicationPool = () => pool.end()
    const register = async () => {
      const email = `native-cache-${randomUUID()}@example.invalid`, password = randomBytes(24).toString('hex')
      const created = await auth.api.signUpEmail({ body: { name: 'Native Cache Fixture', email, password } })
      userIds.push(created.user.id)
      await database.query('INSERT INTO user_preferences("userId", "personalInstructions") VALUES($1,$2)', [created.user.id, 'Cache budget fixture'])
      await database.query('INSERT INTO attention_settings("userId", enabled) VALUES($1, true)', [created.user.id])
      return { id: created.user.id, email, password }
    }
    const signIn = async (person: Awaited<ReturnType<typeof register>>, instance = auth) => {
      const response = await instance.handler(new Request(`${origin}/mikka/api/auth/sign-in/email`, {
        method: 'POST', headers: { origin, 'content-type': 'application/json', 'x-mikka-client': 'desktop' }, body: JSON.stringify({ email: person.email, password: person.password }),
      }))
      assert.equal(response.status, 200)
      const body = await response.json() as { token: string }
      const cache = response.headers.get(cacheHeader)
      assert.ok(validDesktopSessionCache(cache), 'the real SDK sign-in exposes its existing cache to main without an extra read')
      assert.equal(cache, desktopSessionCacheFromHeaders(response.headers, (await instance.$context).authCookies.sessionData.name))
      return { ...person, token: body.token, cache, cookie: response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') }
    }
    const alice = await signIn(await register()), bob = await signIn(await register())
    business = await database.connect()
    // Warm the independent SDK connection before counting PG wire bytes. No
    // auth/user response or business query is mocked, and the action is reused.
    await auth.api.getSession({ headers: new Headers({ authorization: `Bearer ${alice.token}` }), query: { disableCookieCache: true } })
    const web = () => withDatabaseClient(business!, () => requestHeaders.run(new Headers({ cookie: alice.cookie }), getPreferences))
    const route = (instance = auth, oldFreshTransport = false, browser = false) => {
      const sessions = desktopAuthentication(input => instance.api.getSession(input), async () => (await instance.$context).authCookies.sessionData.name)
      const actions = {
        'preferences.getPreferences': { args: z.tuple([]), invoke: getPreferences },
        'desktop.session': { args: z.tuple([]), invoke: async () => safeDesktopSession((await instance.api.getSession({ headers: requestHeaders.getStore()! }))!) },
        'fixture.sensitive': { args: z.tuple([]), invoke: () => fresh.withFreshSession(async () => {
          const session = await instance.api.getSession({ headers: requestHeaders.getStore()! })
          if (!session) throw new ActionFailureError('authRequired')
          return { userId: session.user.id }
        }) },
        'fixture.explicitFresh': { args: z.tuple([]), invoke: async () => {
          const session = await instance.api.getSession({ headers: requestHeaders.getStore()!, query: { disableCookieCache: true } })
          if (!session) throw new ActionFailureError('authRequired')
          return { userId: session.user.id }
        } },
        'fixture.profile': { args: z.tuple([]), invoke: async () => {
          await instance.api.updateUser({ headers: requestHeaders.getStore()!, body: { name: 'Updated Cache Fixture', image: '/mikka/avatar-fixture.png' } })
          return { updated: true }
        } },
      }
      const error = () => ({ status: 401, code: 'authRequired' })
      if (browser) {
        const browserSessions = browserAuthentication(input => instance.api.getSession(input), async () => (await instance.$context).authCookies.sessionData.name)
        return createBrowserRpc({ actions, error, trustedBaseURL: origin, authenticate: browserSessions.authenticate,
          scope: (session, work, request) => withDatabaseClient(business!, () => requestHeaders.run(request.headers, () => browserSessions.scope(session, work))),
        })
      }
      if (oldFreshTransport) return createDesktopRpc({ actions, error,
        authenticate: headers => instance.api.getSession({ headers, query: { disableCookieCache: true } }),
        scope: (session, work, request) => withDatabaseClient(business!, () => requestHeaders.run(request.headers, () => withDesktopSession(session, work))),
      })
      return createDesktopRpc({ actions, error, authenticate: sessions.authenticate,
        scope: (session, work, request) => withDatabaseClient(business!, () => requestHeaders.run(request.headers, () => sessions.scope(session, work))),
      })
    }
    const rpc = route()
    const browserRpc = route(auth, false, true)
    const request = (person = alice, action = 'preferences.getPreferences', extra: Record<string, string> = {}) => new Request(`${origin}/mikka/api/desktop/rpc`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${person.token}`, [cacheHeader]: person.cache, 'x-mikka-client': 'desktop', ...extra },
      body: JSON.stringify({ version: 1, action, args: encode([]) }),
    })
    const result = async (response: Response) => { assert.equal(response.status, 200); return decode((await response.json()).result) }
    const browserRequest = (person = alice, action = 'preferences.getPreferences', extra: Record<string, string> = {}) => new Request(`${origin}/mikka/api/rpc`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin, 'x-mikka-rpc': '1', cookie: person.cookie, ...extra },
      body: JSON.stringify({ version: 1, action, args: encode([]) }),
    })

    await t.test('full original web read and cached native RPC have identical queries, PostgreSQL bytes and data', async () => {
      const baseline = await measure(web)
      const previous = await measure(async () => result(await route(auth, true)(request())))
      const native = await measure(async () => result(await rpc(request())))
      const browser = await measure(async () => result(await browserRpc(browserRequest())))
      assert.deepEqual(native.value, baseline.value)
      assert.deepEqual(previous.value, baseline.value)
      assert.equal(baseline.statements, 1, 'the actual preferences action reads preferences and attention in one statement')
      assert.equal(previous.statements, baseline.statements + 2, 'the old transport added session and user lookups')
      assert.equal(native.statements, baseline.statements)
      assert.equal(native.bytes, baseline.bytes, 'the complete native read must not add PG response bytes')
      assert.deepEqual(browser.value, baseline.value)
      assert.equal(browser.statements, baseline.statements, 'browser RPC reuses only its verified request cookie session')
      assert.equal(browser.bytes, baseline.bytes, 'the complete independent web read must not add PG response bytes')
      assert.ok(previous.bytes > baseline.bytes)
      t.diagnostic(JSON.stringify({ action: 'preferences.getPreferences', web: { statements: baseline.statements, bytes: baseline.bytes }, oldNative: { statements: previous.statements, bytes: previous.bytes }, native: { statements: native.statements, bytes: native.bytes }, browser: { statements: browser.statements, bytes: browser.bytes } }))
      const response = await rpc(request(alice, 'desktop.session'))
      const body = await response.text()
      assert.equal(body.includes(alice.token), false)
      assert.equal(body.includes(alice.cache), false)
      assert.equal(response.headers.has(cacheHeader), false, 'a cache hit is not renewed or extended')
    })

    await t.test('browser CSRF/private credentials stop before SQL; foreign proof cannot select a different owner', async () => {
      const deniedHeaders: Record<string, string>[] = [{ origin: 'https://foreign.invalid' }, { authorization: `Bearer ${bob.token}` }, { [cacheHeader]: bob.cache }, { 'x-mikka-session-token': bob.token }, { 'sec-fetch-site': 'cross-site' }]
      for (const extra of deniedHeaders) {
        const denied = await measure(() => browserRpc(browserRequest(alice, 'desktop.session', extra)))
        assert.equal(denied.value.status, 403); assert.equal(denied.statements, 0); assert.equal(denied.bytes, 0)
      }
      const name = (await auth.$context).authCookies.sessionData.name
      const tokenOnly = alice.cookie.split('; ').filter(value => !value.startsWith(`${name}=`) && !value.startsWith(`${name}.`)).join('; ')
      const foreign = await measure(() => browserRpc(browserRequest(alice, 'desktop.session', { cookie: `${tokenOnly}; ${name}=${bob.cache}` })))
      assert.equal(foreign.statements, 2)
      assert.equal((await result(foreign.value) as { user: { id: string } }).user.id, alice.id)
      assert.equal(foreign.value.headers.has(cacheHeader), false)
    })

    await t.test('browser fresh checks always reach PostgreSQL, and a cold authenticated read does not duplicate them', async () => {
      const name = (await auth.$context).authCookies.sessionData.name
      const tokenOnly = alice.cookie.split('; ').filter(value => !value.startsWith(`${name}=`) && !value.startsWith(`${name}.`)).join('; ')
      for (const action of ['fixture.sensitive', 'fixture.explicitFresh']) {
        const baseline = await measure(() => fresh.withFreshSession(() => auth.api.getSession({ headers: new Headers({ cookie: alice.cookie }) })))
        const cached = await measure(() => browserRpc(browserRequest(alice, action)))
        assert.equal(cached.statements, baseline.statements); assert.equal(cached.bytes, baseline.bytes)
        assert.deepEqual(await result(cached.value), { userId: alice.id })
        const cold = await measure(() => browserRpc(browserRequest(alice, action, { cookie: tokenOnly })))
        assert.equal(cold.statements, 2, 'the initial real DB authentication already proves freshness for this request')
        assert.deepEqual(await result(cold.value), { userId: alice.id })
        assert.ok(cold.value.headers.getSetCookie().length)
        assert.equal(cold.value.headers.has(cacheHeader), false)
      }
    })

    await t.test('native HTTP get-session shares the SDK proof and never lets a foreign cookie rescue an invalid bearer', async () => {
      const read = (headers: Headers) => auth.handler(new Request(`${origin}/mikka/api/auth/get-session`, { headers }))
      const cached = await measure(async () => (await read(request().headers)).json())
      assert.equal(cached.value.user.id, alice.id)
      assert.equal(cached.statements, 0)
      assert.equal(cached.bytes, 0)
      const forged = await read(new Headers({ authorization: `Bearer ${'x'.repeat(32)}`, cookie: bob.cookie, [cacheHeader]: bob.cache }))
      assert.equal(await forged.json(), null)
      const noProof = request().headers; noProof.delete(cacheHeader); noProof.set('cookie', bob.cookie)
      const renewed = await measure(async () => read(noProof))
      assert.equal(renewed.statements, 2)
      assert.ok(validDesktopSessionCache(renewed.value.headers.get(cacheHeader)))
      assert.equal((await renewed.value.json()).user.id, alice.id)
    })

    await t.test('an ordinary REST read forwards a replacement proof once, then matches web auth query and byte costs', async () => {
      const logs: string[] = []
      const short = make(1), signed = await signIn(alice, short)
      const rest = withRequestLog('/api/fixture/session', async (input: Request) => {
        const session = await short.api.getSession({ headers: input.headers })
        return Response.json(session ? safeDesktopSession(session) : null)
      }, line => logs.push(line))
      const warm = await measure(async () => rest(request(signed)))
      assert.equal(warm.statements, 0)
      await delay(1100)
      const first = await measure(async () => rest(request(signed)))
      assert.equal(first.statements, 2)
      const proof = first.value.headers.get(cacheHeader)
      assert.ok(validDesktopSessionCache(proof))
      const next = await measure(async () => rest(request(signed, 'desktop.session', { [cacheHeader]: proof })))
      assert.equal(next.statements, 0)
      assert.equal(next.bytes, 0)
      assert.equal(next.value.headers.has(cacheHeader), false, 'a valid proof is not extended')
      assert.equal((await next.value.json()).user.id, alice.id)
      assert.equal(JSON.stringify(logs).includes(proof), false)
      assert.equal(JSON.stringify(logs).includes(signed.token), false)
      // Older REST routes without withRequestLog still use the real nextCookies
      // plugin. Model only Next's response-cookie IO, then feed that SDK proof
      // through the same private header main uses after its cookie fallback.
      const written: { name: string; value: string; maxAge?: number }[] = []
      const unwrapped = await measure(() => responseCookies.run(written, () => short.api.getSession({ headers: request(signed).headers })))
      assert.equal(unwrapped.statements, 2)
      const cookieOutput = new Headers()
      for (const cookie of written) cookieOutput.append('set-cookie', `${cookie.name}=${cookie.value}${cookie.maxAge === undefined ? '' : `; Max-Age=${cookie.maxAge}`}`)
      const fallbackProof = desktopSessionCacheFromHeaders(cookieOutput, (await short.$context).authCookies.sessionData.name)
      assert.ok(validDesktopSessionCache(fallbackProof), 'the SDK already supplies the private proof through Next response cookies')
      const fallbackRead = await measure(() => short.api.getSession({ headers: request(signed, 'desktop.session', { [cacheHeader]: fallbackProof }).headers }))
      assert.equal(fallbackRead.statements, 0)
      assert.equal(fallbackRead.bytes, 0)
      assert.equal(fallbackRead.value?.user.id, alice.id)
    })

    await t.test('cookie-only, foreign, tampered and obsolete cache values cannot choose a different identity', async () => {
      const cookieOnly = request(); cookieOnly.headers.delete('authorization'); cookieOnly.headers.set('cookie', alice.cookie)
      assert.equal((await rpc(cookieOnly)).status, 401)
      assert.equal((await rpc(request(alice, 'desktop.session', { authorization: `Bearer ${'x'.repeat(32)}`, cookie: bob.cookie, [cacheHeader]: bob.cache }))).status, 401)
      const foreign = await measure(async () => rpc(request(alice, 'desktop.session', { [cacheHeader]: bob.cache, cookie: bob.cookie })))
      assert.equal(foreign.statements, 2)
      assert.equal((await result(foreign.value) as { user: { id: string } }).user.id, alice.id)
      const tampered = `${alice.cache.slice(0, -4)}AAAA`
      const invalid = await measure(async () => rpc(request(alice, 'desktop.session', { [cacheHeader]: tampered })))
      assert.equal(invalid.statements, 2)
      assert.equal((await result(invalid.value) as { user: { id: string } }).user.id, alice.id)
      const versionChanged = await measure(async () => route(make(300, '2'))(request(alice, 'desktop.session')))
      assert.equal(versionChanged.statements, 2)
      assert.equal((await result(versionChanged.value) as { user: { id: string } }).user.id, alice.id)
    })

    await t.test('both fresh policies perform a DB check, and a missing cache does not duplicate that check', async () => {
      for (const action of ['fixture.sensitive', 'fixture.explicitFresh']) {
        const checked = await measure(async () => rpc(request(alice, action)))
        assert.equal(checked.statements, 2)
        assert.ok(validDesktopSessionCache(checked.value.headers.get(cacheHeader)))
        assert.deepEqual(await result(checked.value), { userId: alice.id })
        const uncached = request(alice, action); uncached.headers.delete(cacheHeader)
        const once = await measure(async () => rpc(uncached))
        assert.equal(once.statements, 2)
        assert.deepEqual(await result(once.value), { userId: alice.id })
      }
    })

    await t.test('the SDK profile update supplies the next bootstrap proof without adding a follow-up auth lookup', async () => {
      const updated = await rpc(request(alice, 'fixture.profile'))
      assert.equal(updated.status, 200)
      const proof = updated.headers.get(cacheHeader)
      assert.ok(validDesktopSessionCache(proof))
      const next = await measure(async () => rpc(request(alice, 'desktop.session', { [cacheHeader]: proof })))
      assert.equal(next.statements, 0)
      assert.equal(next.bytes, 0)
      const safe = await result(next.value) as { user: { id: string; name: string; image: string } }
      assert.equal(safe.user.id, alice.id)
      assert.equal(safe.user.name, 'Updated Cache Fixture')
      assert.equal(safe.user.image, '/mikka/avatar-fixture.png')
    })

    await t.test('revocation preserves ordinary web cache semantics but denies sensitive native work immediately', async () => {
      await database.query('DELETE FROM session WHERE "userId"=$1', [alice.id])
      const cachedWeb = await measure(web), cachedNative = await measure(async () => result(await rpc(request())))
      const cachedBrowser = await measure(async () => result(await browserRpc(browserRequest())))
      assert.deepEqual(cachedNative.value, cachedWeb.value)
      assert.equal(cachedNative.statements, cachedWeb.statements)
      assert.equal(cachedNative.bytes, cachedWeb.bytes)
      assert.deepEqual(cachedBrowser.value, cachedWeb.value)
      assert.equal(cachedBrowser.statements, cachedWeb.statements)
      assert.equal(cachedBrowser.bytes, cachedWeb.bytes)
      for (const action of ['fixture.sensitive', 'fixture.explicitFresh']) {
        const denied = await rpc(request(alice, action, { cookie: bob.cookie }))
        assert.equal(denied.status, 401)
        assert.equal(denied.headers.get(cacheHeader), '', 'main clears the revoked proof')
        const browserDenied = await browserRpc(browserRequest(alice, action))
        assert.equal(browserDenied.status, 401)
        assert.equal(browserDenied.headers.has(cacheHeader), false)
      }
    })

    await t.test('the SDK expiry is authoritative for a restored cold-start cache', async () => {
      const short = make(1), signed = await signIn(alice, short), shortRpc = route(short)
      const restored = await measure(async () => shortRpc(request(signed, 'desktop.session')))
      assert.equal(restored.statements, 0)
      assert.equal((await result(restored.value) as { user: { id: string } }).user.id, alice.id)
      await database.query('DELETE FROM session WHERE "userId"=$1', [alice.id])
      await delay(1100)
      const expired = await measure(async () => shortRpc(request(signed, 'desktop.session')))
      assert.equal(expired.value.status, 401)
      assert.ok(expired.statements > 0)
      const browserExpired = await measure(() => route(short, false, true)(browserRequest(signed, 'desktop.session')))
      assert.equal(browserExpired.value.status, 401)
      assert.ok(browserExpired.statements > 0)
    })
  } finally {
    business?.release()
    if (userIds.length) await database.query('DELETE FROM "user" WHERE id=ANY($1::text[])', [userIds])
    for (const handle of mocks.reverse()) handle.restore()
    await closeApplicationPool?.()
    await database.end()
  }
})
