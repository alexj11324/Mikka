import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

const browserSession = {
  user: { id: 'user-1', name: 'Owner', email: 'owner@example.invalid', image: null },
  session: { id: 'browser-session' },
}
mock.module('@/lib/auth', { namedExports: {
  auth: { api: { getSession: async (options: { headers: Headers }) => options.headers.get('cookie') ? browserSession : null } },
} })
const { getApiSession } = await import('./api-auth')
test.after(() => mock.restoreAll())

test('v1 audience is PAT-only: a cookie never authenticates it', async () => {
  assert.equal(await getApiSession({ headers: new Headers({ cookie: 'session=1' }), audience: 'v1' }), null)
})

test('legacy audience still accepts the existing cookie session', async () => {
  const session = await getApiSession({ headers: new Headers({ cookie: 'session=1' }) })
  assert.equal(session?.session.id, 'browser-session')
  assert.equal(session?.tokenId, undefined)
})

test('malformed bearer tokens never fall back to a cookie', async () => {
  for (const audience of ['legacy', 'v1'] as const)
    assert.equal(await getApiSession({ headers: new Headers({ authorization: 'Bearer mkp_invalid', cookie: 'session=1' }), audience }), null)
})
