// Real PostgreSQL + Better Auth email sessions. Run only against the isolated test database.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, mock, test } from 'node:test'
import { z } from 'zod'
import { isE2eTarget } from './helpers/e2e-target.mjs'
import { challengeFor, sha256Hex } from '../lib/desktop-auth-server'
import { webAuthStateHash } from '../lib/web-connection/auth-server'
import { webConnectionURL } from '../lib/web-connection/policy'
import { withBasePath } from '../lib/base-path'
import { createWebTransport } from '../lib/web-connection/transport'
import { createDesktopRpc } from '../lib/desktop-rpc/handler'
import { safeDesktopSession, withDesktopSession } from '../lib/desktop-rpc/session'

const dbUrl = process.env.MIKKA_DATABASE_URL ?? process.env.DATABASE_URL
mock.module(new URL('../lib/request-log.ts', import.meta.url).href, { namedExports: { noteLogUser: () => {}, withRequestLog: (_path: string, handler: unknown) => handler } } as never)
let auth: typeof import('../lib/auth').auth
let pool: import('pg').Pool
let origin: string
const official = webConnectionURL()!
const officialOrigin = new URL(official).origin
const callback = `${official}/api/web/complete`
const states: string[] = []
const users: string[] = []
let sources: { token: string; cookie: string; userId: string }[] = []
type Handler = (request: Request) => Promise<Response>
let routes: { begin: Handler; ret: Handler; exchange: Handler; revoke: Handler; desktopExchange: Handler }
let remoteSession: (token: string, cookie?: string) => Promise<Response>
const pair = () => { const verifier = randomBytes(32).toString('base64url'); const state = randomBytes(24).toString('base64url'); states.push(state); return { state, verifier, challenge: challengeFor(verifier) } }
const json = (path: string, value: unknown, requestOrigin = officialOrigin, token?: string) => new Request(`${origin}${withBasePath(path)}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: requestOrigin, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(value) })

before(async () => {
  if (!dbUrl) return
  assert.ok(isE2eTarget(dbUrl), 'web handoff tests require an isolated e2e database')
  const { Pool } = await import('pg')
  pool = new Pool({ connectionString: dbUrl, max: 2 })
  auth = (await import('../lib/auth')).auth
  const context = await auth.$context
  origin = new URL(context.baseURL).origin
  for (const letter of ['a', 'b']) {
    const id = `web-handoff-${letter}-${randomBytes(6).toString('hex')}`
    const email = `${id}@example.test`
    const password = randomBytes(32).toString('base64url')
    await pool.query('insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") values ($1, $1, $2, true, now(), now())', [id, email])
    users.push(id)
    await context.internalAdapter.createAccount({ userId: id, accountId: id, providerId: 'credential', password: await context.password.hash(password) })
    const result = await auth.api.signInEmail({ body: { email, password }, headers: new Headers({ origin }), returnHeaders: true })
    const cookie = result.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    assert.ok(cookie, 'real email login issues a cookie')
    assert.ok(result.response.token)
    sources.push({ token: result.response.token!, cookie, userId: id })
  }
  routes = {
    begin: (await import('../app/api/web/begin/route')).POST,
    ret: (await import('../app/api/web/return/route')).GET,
    exchange: (await import('../app/api/web/exchange/route')).POST,
    revoke: (await import('../app/api/web/revoke/route')).POST,
    desktopExchange: (await import('../app/api/desktop/exchange/route')).POST,
  }
  // Exercise the production transport and RPC dispatch with the real auth reader.
  // A narrow session action avoids unrelated provider/configuration side effects.
  const transport = createWebTransport({
    authenticate: headers => auth.api.getSession({ headers, query: { disableCookieCache: true } }),
    scope: (_identity, work) => work(),
  })
  const rpc = createDesktopRpc({
    authenticate: headers => auth.api.getSession({ headers, query: { disableCookieCache: true } }),
    scope: (session, work) => withDesktopSession(session, work),
    actions: { 'desktop.session': { args: z.tuple([]), invoke: async () => {
      const value = await auth.api.getSession({ headers: new Headers() })
      return value && safeDesktopSession(value)
    } } },
  })
  remoteSession = async (token, cookie) => {
    const request = json('/api/desktop/rpc', { version: 1, action: 'desktop.session', args: [] }, officialOrigin, token)
    if (cookie) request.headers.set('cookie', cookie)
    const prepared = await transport(request, '/api/desktop/rpc')
    if (prepared instanceof Response) return prepared
    assert.ok(prepared, 'official cross-origin caller uses bearer transport')
    return prepared.response(await prepared.run(() => rpc(prepared.request)))
  }
})
after(async () => {
  if (!pool) return
  await pool.query('delete from desktop_auth_requests where "stateHash" = any($1)', [states.flatMap(state => [webAuthStateHash(state), sha256Hex(state)])])
  await pool.query('delete from "user" where id = any($1)', [users])
  await pool.end()
  await (await import('../lib/db')).pool.end()
})

async function begin(value = pair()) {
  const response = await routes.begin(json('/api/web/begin', { ...value, callback }))
  assert.equal(response.status, 200)
  const body = await response.json() as { signInUrl: string }
  const target = new URL(body.signInUrl)
  assert.equal(target.origin, origin)
  assert.equal(target.searchParams.get('web_state'), value.state)
  assert.equal(target.searchParams.get('web_callback'), callback)
  return value
}
async function bind(state: string, source = sources[0], target = callback, sameOrigin = true) {
  const request = new Request(`${origin}${withBasePath('/api/web/return')}?${new URLSearchParams({ state, callback: target })}`, { headers: {
    cookie: source.cookie, 'sec-fetch-site': sameOrigin ? 'same-origin' : 'cross-site', referer: `${sameOrigin ? origin : officialOrigin}/sign-in`,
  } })
  const response = await routes.ret(request)
  assert.equal(response.status, 303)
  return new URL(response.headers.get('location')!)
}
const codeFrom = (url: URL) => new URLSearchParams(url.hash.slice(1)).get('code')!
const exchange = (value: { state: string; verifier: string }, code: string, target = callback) => routes.exchange(json('/api/web/exchange', { ...value, code, callback: target }))

test('email cookie login hands off to an independent bearer; revoke cannot log out source or another account', { skip: !dbUrl }, async () => {
  const value = await begin()
  assert.equal((await routes.begin(json('/api/web/begin', { ...value, callback }))).status, 409)
  const target = await bind(value.state)
  assert.equal(target.origin + target.pathname, callback)
  assert.equal(target.search, '')
  assert.ok(codeFrom(target))
  assert.equal(new URLSearchParams(target.hash.slice(1)).get('token'), null)
  const response = await exchange(value, codeFrom(target))
  assert.equal(response.status, 200)
  const result = await response.json() as { token: string; user: { id: string }; session: { id: string } }
  assert.equal(result.user.id, users[0])
  assert.notEqual(result.token, sources[0].token)
  assert.equal(response.headers.has('set-cookie'), false)
  const read = await remoteSession(result.token, sources[1].cookie)
  assert.equal(read.status, 200)
  assert.equal((await read.json() as { result: { user: { id: string } } }).result.user.id, users[0])
  assert.equal((await exchange(value, codeFrom(target))).status, 400)
  const parked = await pool.query('select token from desktop_auth_requests where "stateHash"=$1', [webAuthStateHash(value.state)])
  assert.equal(parked.rows[0].token, null)
  const revoke = await routes.revoke(json('/api/web/revoke', { token: sources[1].token, sessionId: 'ignored' }, officialOrigin, result.token))
  assert.equal(revoke.status, 204)
  assert.equal((await remoteSession(result.token, sources[0].cookie)).status, 401, 'source cookie cannot rescue revoked bearer')
  for (const source of sources) assert.ok(await (await auth.$context).internalAdapter.findSession(source.token), 'both source sessions survive')
})

test('wrong origin and nonexact callback fail without consuming the valid grant', { skip: !dbUrl }, async () => {
  const value = await begin()
  for (const route of ['begin', 'exchange', 'revoke'] as const) {
    assert.equal((await routes[route](json(`/api/web/${route}`, { ...value, callback }, 'https://foreign.example'))).status, 403)
  }
  assert.equal((await routes.begin(json('/api/web/begin', { ...pair(), callback: `${callback}/` }))).status, 400)
  assert.equal((await bind(value.state, sources[0], `${callback}?next=bad`)).searchParams.get('oauth'), 'failed')
  assert.equal((await bind(value.state, sources[0], callback, false)).searchParams.get('oauth'), 'failed', 'cross-site navigation cannot authorize current cookie')
  const target = await bind(value.state)
  assert.equal((await exchange(value, codeFrom(target), `${callback}/`)).status, 400)
  assert.equal((await exchange(value, codeFrom(target))).status, 200)
})

test('wrong verifier burns the code; simultaneous correct proofs have one winner', { skip: !dbUrl }, async () => {
  const value = await begin()
  const code = codeFrom(await bind(value.state))
  assert.equal((await exchange({ ...value, verifier: randomBytes(32).toString('base64url') }, code)).status, 400)
  assert.equal((await exchange(value, code)).status, 400)
  const next = await begin()
  const nextCode = codeFrom(await bind(next.state))
  const attempts = await Promise.all([exchange(next, nextCode), exchange(next, nextCode)])
  assert.deepEqual(attempts.map(response => response.status).sort(), [200, 400])
})

test('pending and bound expiry, missing cookie and revoked source sessions reject handoff', { skip: !dbUrl }, async () => {
  const expire = (state: string) => pool.query('update desktop_auth_requests set "expiresAt"=now()-interval \'1 second\' where "stateHash"=$1', [webAuthStateHash(state)])
  const pending = await begin()
  assert.equal((await bind(pending.state, { ...sources[0], cookie: '' })).searchParams.get('oauth'), 'failed')
  await expire(pending.state)
  assert.equal((await bind(pending.state)).searchParams.get('oauth'), 'failed')
  const bound = await begin()
  const code = codeFrom(await bind(bound.state))
  await expire(bound.state)
  assert.equal((await exchange(bound, code)).status, 400)
  const revoked = await begin()
  const revokedCode = codeFrom(await bind(revoked.state, sources[1]))
  await (await auth.$context).internalAdapter.deleteSession(sources[1].token)
  assert.equal((await exchange(revoked, revokedCode)).status, 400, 'exchange freshly verifies the source cookie session')
})

test('desktop exchange cannot consume a web grant and web exchange cannot consume a desktop grant', { skip: !dbUrl }, async () => {
  const value = await begin()
  const code = codeFrom(await bind(value.state))
  assert.equal((await routes.desktopExchange(json('/api/desktop/exchange', { ...value, code }, origin))).status, 400)
  assert.equal((await exchange(value, code)).status, 200)
  const desktop = pair()
  await pool.query('insert into desktop_auth_requests ("stateHash",callback,"codeChallenge","expiresAt") values ($1,$2,$3,now()+interval \'10 minutes\')', [sha256Hex(desktop.state), 'http://127.0.0.1:49152/auth/callback', desktop.challenge])
  assert.equal((await exchange(desktop, randomBytes(32).toString('base64url'))).status, 400)
  const row = await pool.query('select "usedAt" from desktop_auth_requests where "stateHash"=$1', [sha256Hex(desktop.state)])
  assert.equal(row.rows[0].usedAt, null)
})
