import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { z } from 'zod'
import { disposableDatabase } from './helpers/e2e-target.mjs'
import { createDesktopRpc } from '../lib/desktop-rpc/handler'
import { encode, decode } from '../lib/desktop-rpc/wire'
import { withDesktopSession, safeDesktopSession } from '../lib/desktop-rpc/session'
import { withBasePath } from '../lib/base-path'
import { DESKTOP_SESSION_CACHE_HEADER, validDesktopSessionCache } from '../lib/desktop-rpc/session-cache'

const url = process.env.E2E_DATABASE_URL
if (process.env.REQUIRE_DB === '1') assert.ok(url, 'REQUIRE_DB=1 needs isolated PostgreSQL')
if (url) assert.ok(disposableDatabase(process.env, url), 'loopback *_e2e only')

test('native RPC verifies real bearer sessions, tenant membership, expiry and one-use PKCE exchange', { skip: !url, timeout: 120_000 }, async t => {
  const database = new Pool({ connectionString: url, max: 4 })
  const userIds: string[] = [], workspaceIds = [randomUUID(), randomUUID()]
  const states: string[] = []
  const mocks: { restore(): void }[] = []
  const origin = 'http://127.0.0.1:3030'
  try {
    const [{ betterAuth }, { bearer, oneTimeToken }, fresh, desktopAuth, schema] = await Promise.all([
      import('better-auth'), import('better-auth/plugins'), import('../lib/fresh-session'), import('../lib/desktop-auth-server'), import('../lib/db/schema'),
    ])
    const auth = betterAuth({ baseURL: origin, basePath: withBasePath('/api/auth'), database, secret: randomBytes(32).toString('hex'),
      emailAndPassword: { enabled: true }, trustedOrigins: [origin], logger: { disabled: true }, session: fresh.SESSION_OPTIONS,
      plugins: [bearer(), oneTimeToken({ expiresIn: 1, storeToken: 'hashed' })],
    })
    fresh.readFreshSessionsInScope(auth.api, { cookieName: async () => (await auth.$context).authCookies.sessionData.name })
    const register = async (name: string) => {
      const email = `desktop-rpc-${randomUUID()}@example.invalid`, password = randomBytes(24).toString('hex')
      const send = (path: string, body: unknown) => auth.handler(new Request(`${origin}${withBasePath(`/api/auth/${path}`)}`, {
        method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body),
      }))
      const signup = await send('sign-up/email', { name, email, password })
      assert.equal(signup.status, 200)
      const user = (await signup.json()).user as { id: string }
      userIds.push(user.id)
      const signin = await send('sign-in/email', { email, password })
      assert.equal(signin.status, 200)
      const token = (await signin.json()).token as string
      assert.equal(typeof token, 'string')
      return { id: user.id, email, token, cookie: signin.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') }
    }
    const alice = await register('Desktop Alice'), bob = await register('Desktop Bob')
    for (const [index, person] of [alice, bob].entries()) {
      await database.query('INSERT INTO mikka_workspaces(id,"userId",name) VALUES($1,$2,$3)', [workspaceIds[index], person.id, `Desktop fixture ${index}`])
      await database.query('INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) VALUES($1,$2,$3,$4,\'admin\',\'active\')', [workspaceIds[index], person.id, 'Desktop fixture', person.email])
    }
    const rpc = createDesktopRpc({
      authenticate: headers => auth.api.getSession({ headers, query: { disableCookieCache: true } }),
      scope: withDesktopSession,
      actions: {
        'desktop.session': { args: z.tuple([]), invoke: async () => safeDesktopSession((await auth.api.getSession({ headers: new Headers() }))!) },
        // Uses the same real membership row/active-status boundary as workspace actions.
        'fixture.workspace': { args: z.tuple([z.uuid()]), invoke: async ([workspaceId]) => {
          const session = await auth.api.getSession({ headers: new Headers() })
          const { rows } = await database.query('SELECT w.id FROM mikka_workspaces w JOIN mikka_workspace_members m ON m."workspaceId"=w.id WHERE w.id=$1 AND m."userId"=$2 AND m.status=\'active\'', [workspaceId, session!.user.id])
          if (!rows.length) throw new Error('workspaceAccessDenied')
          return rows[0]
        } },
      },
      error: () => ({ status: 403, code: 'workspaceAccessDenied' }),
    })
    const request = (person: typeof alice, action = 'desktop.session', args: unknown[] = [], extra: Record<string, string> = {}) => new Request(`${origin}/mikka/api/desktop/rpc`, {
      method: 'POST', headers: { authorization: `Bearer ${person.token}`, 'content-type': 'application/json', ...extra }, body: JSON.stringify({ version: 1, action, args: encode(args) }),
    })
    await t.test('a real bearer authenticates without cookies and never returns its secret', async () => {
      const response = await rpc(request(alice))
      assert.equal(response.status, 200)
      const text = await response.text()
      assert.equal(text.includes(alice.token), false)
      const safe = decode(JSON.parse(text).result) as { user: { id: string }; session: { id: string } }
      assert.equal(safe.user.id, alice.id); assert.equal(typeof safe.session.id, 'string')
    })
    await t.test('cookie-only and invalid bearer plus a valid foreign cookie are rejected', async () => {
      const cookieOnly = request(alice); cookieOnly.headers.delete('authorization'); cookieOnly.headers.set('cookie', alice.cookie)
      assert.equal((await rpc(cookieOnly)).status, 401)
      assert.equal((await rpc(request(alice, 'desktop.session', [], { authorization: `Bearer ${'x'.repeat(32)}`, cookie: bob.cookie }))).status, 401)
      const valid = await rpc(request(alice, 'desktop.session', [], { cookie: bob.cookie }))
      assert.equal((decode((await valid.json()).result) as { user: { id: string } }).user.id, alice.id)
    })
    await t.test('same transport cannot read another tenant or a newly suspended membership', async () => {
      assert.equal((await rpc(request(alice, 'fixture.workspace', [workspaceIds[0]]))).status, 200)
      assert.equal((await rpc(request(alice, 'fixture.workspace', [workspaceIds[1]]))).status, 403)
      await database.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2', [workspaceIds[0], alice.id])
      assert.equal((await rpc(request(alice, 'fixture.workspace', [workspaceIds[0]]))).status, 403)
    })
    await t.test('the bundled exchange consumes PKCE and OTT once, returning the actual session bearer', async () => {
      mocks.push(mock.module(new URL('../lib/auth.ts', import.meta.url).href, { namedExports: { auth } }))
      mocks.push(mock.module(new URL('../lib/db/index.ts', import.meta.url).href, { namedExports: { pool: database, db: drizzle(database, { schema }) } }))
      mocks.push(mock.module(new URL('../lib/request-log.ts', import.meta.url).href, { namedExports: { noteLogRpcAction: () => {}, withRequestLog: (_path: string, handler: unknown) => handler } }))
      const { POST } = await import('../app/api/desktop/exchange/route')
      const create = async () => {
        const state = randomBytes(24).toString('base64url'), verifier = randomBytes(32).toString('base64url'), code = randomBytes(32).toString('base64url')
        const stateHash = desktopAuth.sha256Hex(state)
        states.push(stateHash)
        const ott = await auth.api.generateOneTimeToken({ headers: new Headers({ authorization: `Bearer ${alice.token}` }) })
        await database.query('INSERT INTO desktop_auth_requests("stateHash",callback,"codeChallenge","codeHash",token,"boundAt","expiresAt") VALUES($1,$2,$3,$4,$5,now(),now()+interval \'1 minute\')', [stateHash, 'http://127.0.0.1:49152/auth/callback', desktopAuth.challengeFor(verifier), desktopAuth.sha256Hex(code), ott.token])
        return { state, verifier, code, client: 'bundled' }
      }
      const exchange = (body: unknown) => POST(new Request(`${origin}/mikka/api/desktop/exchange`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) }))
      const proof = await create()
      const response = await exchange(proof)
      assert.equal(response.status, 200)
      const value = await response.json()
      assert.equal(value.token, alice.token); assert.equal(value.user.id, alice.id); assert.deepEqual(Object.keys(value.session), ['id'])
      const cache = response.headers.get(DESKTOP_SESSION_CACHE_HEADER)
      assert.ok(validDesktopSessionCache(cache), 'the one-use SDK exchange supplies the existing signed proof privately')
      const cold = await auth.api.getSession({ headers: new Headers({ authorization: `Bearer ${value.token}`, [DESKTOP_SESSION_CACHE_HEADER]: cache }) })
      assert.equal(cold?.user.id, alice.id)
      assert.equal((await exchange(proof)).status, 400)
      const bad = await create()
      assert.equal((await exchange({ ...bad, verifier: randomBytes(32).toString('base64url') })).status, 400)
      assert.equal((await exchange(bad)).status, 400)
    })
    await t.test('browser integration continuation confirms the native account before installing cookies', async () => {
      const { GET, POST } = await import('../app/api/mobile/open/route')
      const { token } = await auth.api.generateOneTimeToken({ headers: new Headers({ authorization: `Bearer ${alice.token}` }) })
      const page = '/en/settings?section=connections&app=gmail'
      const openURL = `${origin}${withBasePath('/api/mobile/open')}?${new URLSearchParams({ token, to: page })}`
      const opened = await GET(new Request(openURL, { headers: { cookie: bob.cookie } }))
      assert.equal(opened.status, 200)
      const pendingCookie = opened.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
      assert.equal(await auth.api.getSession({ headers: new Headers({ cookie: pendingCookie }) }), null)
      const html = await opened.text()
      assert.ok(html.includes(alice.email), 'the confirmation names the intended account')
      const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1]
      assert.ok(csrf)
      const confirm = (from: string) => POST(new Request(`${origin}${withBasePath('/api/mobile/open')}`, {
        method: 'POST', headers: { origin: from, cookie: `${bob.cookie}; ${pendingCookie}` }, body: new URLSearchParams({ csrf }),
      }))
      assert.equal((await confirm('https://foreign.invalid')).status, 403)
      const confirmed = await confirm(origin)
      assert.equal(confirmed.status, 303)
      assert.equal(confirmed.headers.get('location'), `${origin}${withBasePath(page)}`)
      const cookie = confirmed.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
      assert.equal((await auth.api.getSession({ headers: new Headers({ cookie }), query: { disableCookieCache: true } }))?.user.id, alice.id)
      assert.equal((await GET(new Request(openURL, { headers: { cookie: bob.cookie } }))).headers.getSetCookie().length, 0)
    })
    await t.test('revoked and expired database sessions fail immediately, including with a valid cached cookie', async () => {
      await database.query('UPDATE session SET "expiresAt"=now()-interval \'1 second\' WHERE token=$1', [alice.token])
      assert.equal((await rpc(request(alice, 'desktop.session', [], { cookie: alice.cookie }))).status, 401)
      await database.query('DELETE FROM session WHERE token=$1', [bob.token])
      assert.equal((await rpc(request(bob, 'desktop.session', [], { cookie: bob.cookie }))).status, 401)
    })
  } finally {
    for (const handle of mocks.reverse()) handle.restore()
    if (states.length) await database.query('DELETE FROM desktop_auth_requests WHERE "stateHash"=ANY($1)', [states])
    await database.query('DELETE FROM mikka_workspaces WHERE id=ANY($1::uuid[])', [workspaceIds])
    if (userIds.length) await database.query('DELETE FROM "user" WHERE id=ANY($1)', [userIds])
    await database.end()
  }
})
