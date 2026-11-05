import test from 'node:test'
import assert from 'node:assert/strict'
import { readFreshSessionsInScope, withFreshSession } from '../fresh-session'
import { withDesktopSession, withDesktopReadSession, currentDesktopSession, desktopHumanSessionId, recordDesktopTokenRotation, desktopRotatedToken, withDesktopLocale, currentDesktopLocale } from './session'
import { desktopAuthentication } from './authentication'
import { DESKTOP_SESSION_CACHE_HEADER } from './session-cache'

test('bearer session reads strip cookies and always revalidate, leaving web cache behavior intact', async () => {
  const seen: { headers?: Headers; query?: Record<string, unknown> }[] = []
  const api = { getSession: async (input: { headers?: Headers; query?: Record<string, unknown> }) => { seen.push(input); return null } }
  readFreshSessionsInScope(api)
  const headers = new Headers({ cookie: 'other-account=private', authorization: `Bearer ${'x'.repeat(32)}` })
  await api.getSession({ headers })
  assert.equal(seen[0].headers?.has('cookie'), false)
  assert.equal(seen[0].headers?.get('authorization'), headers.get('authorization'))
  assert.equal(seen[0].query?.disableCookieCache, true)
  assert.equal(headers.get('cookie'), 'other-account=private')
  const web = { headers: new Headers({ cookie: 'web=1' }) }
  await api.getSession(web)
  assert.equal(seen[1], web)
})

test('validated RPC identity is reused within one request, including fresh actions, with no global leakage', async () => {
  let calls = 0
  const api = { getSession: async (_input: unknown) => { calls++; return null as unknown } }
  readFreshSessionsInScope(api)
  const one = { user: { id: 'one' }, session: { id: 'one-session' } }, two = { user: { id: 'two' }, session: { id: 'two-session' } }
  const results = await Promise.all([one, two].map(session => withDesktopSession(session, async () => {
    await Promise.resolve()
    assert.equal(desktopHumanSessionId(), session.session.id)
    return withFreshSession(() => api.getSession({ headers: new Headers({ cookie: 'other=ignored' }), query: { disableCookieCache: true } }))
  })))
  assert.deepEqual(results, [one, two]); assert.equal(calls, 0)
  assert.equal(currentDesktopSession(), undefined); assert.equal(desktopHumanSessionId(), undefined)
})

test('locale and token rotation are isolated to the authenticated request', async () => {
  const values = await Promise.all((['en', 'zh-CN'] as const).map(locale => withDesktopLocale(locale, () => withDesktopSession({ session: { id: locale } }, async () => {
    recordDesktopTokenRotation(`new-${locale}`)
    await Promise.resolve()
    return { locale: currentDesktopLocale(), token: desktopRotatedToken() }
  }))))
  assert.deepEqual(values, [{ locale: 'en', token: 'new-en' }, { locale: 'zh-CN', token: 'new-zh-CN' }])
  assert.equal(currentDesktopLocale(), undefined); assert.equal(desktopRotatedToken(), undefined)
  recordDesktopTokenRotation('outside-ignored')
  assert.equal(desktopRotatedToken(), undefined)
})

test('a cached native identity upgrades once for concurrent fresh reads, and a revoked result cannot fall back to cookies', async () => {
  let ambientCalls = 0, refreshes = 0
  const api = { getSession: async (_input: unknown) => { ambientCalls++; return { user: { id: 'foreign-cookie' } } as unknown } }
  readFreshSessionsInScope(api)
  const cached = { user: { id: 'cached' }, session: { id: 'session' } }
  await withDesktopReadSession(cached, { fresh: false, refresh: async () => { refreshes++; await Promise.resolve(); return null } }, async () => {
    assert.equal(await api.getSession({ headers: new Headers() }), cached)
    const revoked = await Promise.all([
      withFreshSession(() => api.getSession({ headers: new Headers({ cookie: 'foreign=1' }) })),
      api.getSession({ headers: new Headers(), query: { disableCookieCache: true } }),
    ])
    assert.deepEqual(revoked, [null, null])
    assert.equal(await api.getSession({ headers: new Headers({ cookie: 'foreign=1' }) }), null)
    assert.equal(desktopHumanSessionId(), undefined)
  })
  assert.equal(refreshes, 1)
  assert.equal(ambientCalls, 0)
})

test('native cache restoration preserves ordinary read policy and strips it for a fresh SDK call', async () => {
  const seen: { headers: Headers; query?: Record<string, unknown> }[] = []
  const api = { getSession: async (input: { headers: Headers; query?: Record<string, unknown> }) => { seen.push(input); return null } }
  readFreshSessionsInScope(api, { cookieName: async () => 'sdk.session_data' })
  const headers = new Headers({ authorization: 'Bearer native', cookie: 'other=ignored', [DESKTOP_SESSION_CACHE_HEADER]: 'signed_9' })
  await api.getSession({ headers })
  await withFreshSession(() => api.getSession({ headers }))
  assert.equal(seen[0].headers.get('cookie'), 'sdk.session_data=signed_9')
  assert.equal(seen[0].query?.disableCookieCache, false)
  assert.equal(seen[1].headers.has('cookie'), false)
  assert.equal(seen[1].query?.disableCookieCache, true)
})

test('password rotation clears the old private cache even if the initial authentication issued one', async () => {
  const sessions = desktopAuthentication(async () => ({ response: { user: { id: 'owner' } }, headers: new Headers({ 'set-cookie': 'sdk.session_data=old_signed; Max-Age=300' }) }), async () => 'sdk.session_data')
  const authenticated = await sessions.authenticate(new Headers({ authorization: 'Bearer native' }))
  assert.ok(authenticated)
  const response = await sessions.scope(authenticated, async () => { recordDesktopTokenRotation('new-secret'); return Response.json({ ok: true }) })
  assert.equal(response.headers.get(DESKTOP_SESSION_CACHE_HEADER), '')
  assert.equal((await response.text()).includes('secret'), false)
})
