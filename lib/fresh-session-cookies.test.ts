import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequestScope, runRequestScope } from '../apps/api/src/context'
import { readFreshSessionsInScope } from './fresh-session'

/**
 * Session-cookie contract at the boundary this repository owns.
 *
 * A renewed cookie reaches the response through `mikkaCookies`, a better-auth
 * after hook, because `auth.api.*` runs the plugin pipeline. These tests pin
 * the parts a plain wrapper could still break: the result shape every caller
 * receives, and the freshness flag the wrapper adds.
 */
const request = () => new Request('http://localhost/mikka/api/x', { headers: { cookie: 'session=old' } })

test('a plain session read returns the session value, not the header wrapper', async () => {
  const api = { getSession: async () => ({ user: { id: 'u' }, session: { id: 's' } }) }
  readFreshSessionsInScope(api)
  const scope = createRequestScope(request())
  const session = await runRequestScope(scope, () => api.getSession({ headers: scope.headers }))
  assert.deepEqual(session, { user: { id: 'u' }, session: { id: 's' } })
})

test('a caller that asks for headers keeps the {headers, response} pair', async () => {
  // Browser RPC reads this pair directly: `result.response` is the session and
  // `result.headers` carries the Set-Cookie it forwards to the browser.
  const headers = new Headers({ 'set-cookie': 'session=renewed; Path=/mikka' })
  const api = { getSession: async () => ({ headers, response: { user: { id: 'u' } } }) }
  readFreshSessionsInScope(api)
  const scope = createRequestScope(request())
  const result = await runRequestScope(scope, () => api.getSession({ headers: scope.headers, returnHeaders: true })) as {
    headers: Headers
    response: { user: { id: string } }
  }
  assert.equal(result.headers, headers, 'the caller reads the renewal off this object')
  assert.equal(result.response.user.id, 'u')
})

test('a caller that asks for a Response gets the Response untouched', async () => {
  const response = Response.json({ user: { id: 'u' } })
  const api = { getSession: async () => response }
  readFreshSessionsInScope(api)
  const scope = createRequestScope(request())
  const result = await runRequestScope(scope, () => api.getSession({ headers: scope.headers, asResponse: true }))
  assert.equal(result, response)
})

test('the freshness flag reaches the session read as a query, and only there', async () => {
  const seen: { query?: Record<string, unknown> }[] = []
  const api = { getSession: async (input: { query?: Record<string, unknown> }) => { seen.push(input); return null } }
  readFreshSessionsInScope(api)
  const scope = createRequestScope(request())
  await runRequestScope(scope, () => api.getSession({ headers: scope.headers }))
  assert.equal(seen[0].query?.disableCookieCache, undefined, 'an ordinary read keeps the cookie cache')
  const { withFreshSession } = await import('./fresh-session')
  await runRequestScope(scope, () => withFreshSession(() => api.getSession({ headers: scope.headers })))
  assert.equal(seen[1].query?.disableCookieCache, true, 'a fresh read bypasses it')
})

test('a session read outside a request still returns its value', async () => {
  const api = { getSession: async () => ({ user: { id: 'u' } }) }
  readFreshSessionsInScope(api)
  assert.deepEqual(await api.getSession({ headers: new Headers() }), { user: { id: 'u' } })
})
