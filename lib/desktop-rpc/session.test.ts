import test from 'node:test'
import assert from 'node:assert/strict'
import { readFreshSessionsInScope, withFreshSession } from '../fresh-session'
import { withDesktopSession, currentDesktopSession, desktopHumanSessionId, recordDesktopTokenRotation, desktopRotatedToken, withDesktopLocale, currentDesktopLocale } from './session'

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
