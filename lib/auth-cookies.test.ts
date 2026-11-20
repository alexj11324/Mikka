import assert from 'node:assert/strict'
import test from 'node:test'
import { betterAuth } from 'better-auth'
import { memoryAdapter } from 'better-auth/adapters/memory'
import { oneTimeToken } from 'better-auth/plugins'
import { createRequestScope, runRequestScope } from '../apps/api/src/context'
import { mikkaCookies } from './auth-cookies'

/**
 * `mikkaCookies` replaces the framework integration's Set-Cookie copy. These
 * tests run it through a real better-auth instance so the hook wiring — not
 * just the cookie parsing — is what is being checked.
 */
const SECRET = 'x'.repeat(40)

function authFixture() {
  const db = { user: [], session: [], account: [], verification: [] }
  return betterAuth({
    baseURL: 'http://localhost:3000',
    secret: SECRET,
    database: memoryAdapter(db),
    emailAndPassword: { enabled: true },
    session: { expiresIn: 60, updateAge: 1, cookieCache: { enabled: true, maxAge: 1 } },
    plugins: [mikkaCookies()],
  })
}

async function signedIn(auth: ReturnType<typeof authFixture>) {
  const created = await auth.api.signUpEmail({
    body: { email: 'cookie@example.com', password: 'password123', name: 'Cookie' },
    returnHeaders: true,
  })
  return created.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
}

test('a sign-in writes its session cookies into the request journal', async () => {
  const auth = authFixture()
  const scope = createRequestScope(new Request('http://localhost/mikka/api/auth/sign-up/email', { method: 'POST' }))
  await runRequestScope(scope, () => auth.api.signUpEmail({
    body: { email: 'journal@example.com', password: 'password123', name: 'Journal' },
  }))
  const response = new Headers()
  scope.cookies.commit(response)
  const written = response.getSetCookie()
  assert.ok(written.some(value => value.startsWith('better-auth.session_token=')), 'the session token reaches the response')
  assert.ok(written.some(value => value.startsWith('better-auth.session_data=')), 'the signed session cache reaches the response')
})

test('a renewed session cookie lands in the journal on an ordinary read', async () => {
  // The session is past `updateAge` but inside `expiresIn`, so the read issues
  // a fresh token and a fresh signed cache without changing the identity.
  const auth = authFixture()
  const cookie = await signedIn(auth)
  await new Promise(resolve => setTimeout(resolve, 1100))
  const scope = createRequestScope(new Request('http://localhost/mikka/api/x', { headers: { cookie } }))
  const session = await runRequestScope(scope, () => auth.api.getSession({ headers: scope.headers })) as { user?: { email?: string } } | null
  assert.equal(session?.user?.email, 'cookie@example.com')
  const response = new Headers()
  scope.cookies.commit(response)
  assert.ok(response.getSetCookie().some(value => value.startsWith('better-auth.session_token=')), 'the renewed token is written')
})

test('sign-out clears the session cookies by name', async () => {
  const auth = authFixture()
  const cookie = await signedIn(auth)
  const scope = createRequestScope(new Request('http://localhost/mikka/api/auth/sign-out', { headers: { cookie } }))
  await runRequestScope(scope, () => auth.api.signOut({ headers: scope.headers }))
  const response = new Headers({ 'set-cookie': 'unrelated=keep; Path=/' })
  scope.cookies.commit(response)
  const written = response.getSetCookie()
  assert.ok(written.includes('unrelated=keep; Path=/'), 'an unrelated response cookie survives')
  assert.ok(written.some(value => value.startsWith('better-auth.session_token=;')), 'the session token is cleared')
})

test('a cookie write outside a request is skipped instead of throwing', async () => {
  const auth = authFixture()
  // No request scope: the hook has no journal to write into and must stay quiet.
  const session = await auth.api.getSession({ headers: new Headers({ cookie: 'better-auth.session_token=none' }) })
  assert.equal(session, null)
})

test('a router-dispatched sign-in writes no session cookie into the journal', async () => {
  // `app/api/mobile/open/route.ts` exchanges a one-time token through
  // `auth.handler` to learn who the link belongs to, and must not sign that
  // person in before they confirm. `auth.handler` goes through better-call's
  // router, which marks the context `_flag: 'router'`; the plugin has to skip
  // those. Without the skip the journal would carry a live session cookie.
  const db = { user: [], session: [], account: [], verification: [] }
  const auth = betterAuth({
    baseURL: 'http://localhost:3000',
    basePath: '/api/auth',
    secret: SECRET,
    database: memoryAdapter(db),
    emailAndPassword: { enabled: true },
    trustedOrigins: ['http://localhost:3000'],
    plugins: [oneTimeToken({ expiresIn: 1, storeToken: 'hashed' }), mikkaCookies()],
  })
  const created = await auth.api.signUpEmail({
    body: { email: 'router@example.com', password: 'password123', name: 'Router' },
    returnHeaders: true,
  })
  const cookie = created.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  const token = (await auth.api.generateOneTimeToken({ headers: new Headers({ cookie }) })).token

  const scope = createRequestScope(new Request('http://localhost:3000/mikka/api/mobile/open', { method: 'POST' }))
  const exchanged = await runRequestScope(scope, () => auth.handler(new Request('http://localhost:3000/api/auth/one-time-token/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
    body: JSON.stringify({ token }),
  })))
  assert.equal(exchanged.ok, true, 'the exchange itself still succeeds')
  assert.ok(exchanged.headers.getSetCookie().some(value => value.startsWith('better-auth.session_token=')),
    'the exchange response carries the cookies the handoff will seal')

  const journal = new Headers()
  scope.cookies.commit(journal)
  assert.deepEqual(journal.getSetCookie().filter(value => value.includes('session_token')), [],
    'a router dispatch must not sign the browser in through the request journal')
})
