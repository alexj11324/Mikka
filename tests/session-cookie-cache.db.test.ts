import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { Pool, type PoolClient } from 'pg'
import { disposableDatabase } from './helpers/e2e-target.mjs'

// Real Better Auth with Mikka's session settings on a disposable PostgreSQL.
const dbUrl = disposableDatabase() ? process.env.E2E_DATABASE_URL : undefined
if (process.env.REQUIRE_DB === '1' && !dbUrl) throw new Error('Session cookie cache DB test requires a loopback *_e2e database')

test('a session read uses the 5-minute cookie cache; money, permission and credential writes read it from the database', { skip: !dbUrl }, async t => {
  const database = new Pool({ connectionString: dbUrl, max: 10 })
  // Every statement Better Auth sends: each goes through a checked-out client.
  let statements = 0
  const query = database.query.bind(database)
  const counted = new WeakSet<PoolClient>()
  const count = (client: PoolClient) => {
    if (counted.has(client)) return client
    counted.add(client)
    const clientQuery = client.query.bind(client)
    client.query = ((...args: Parameters<typeof clientQuery>) => { statements++; return clientQuery(...args) }) as typeof client.query
    return client
  }
  const connect = database.connect.bind(database)
  // pg's own pool.query checks a client out through connect(callback): keep that form working.
  database.connect = ((callback?: (error: Error | undefined, client: PoolClient | undefined, done: () => void) => void) => callback
    ? connect((error, client, done) => callback(error, client ? count(client) : client, done))
    : connect().then(count)) as typeof database.connect
  mock.module('next/headers.js', { namedExports: { headers: async () => new Headers(), cookies: async () => ({ set: () => {}, get: () => undefined }) } })
  const [{ betterAuth }, { nextCookies }, fresh] = await Promise.all([import('better-auth'), import('better-auth/next-js'), import('../lib/fresh-session')])
  assert.equal(fresh.SESSION_OPTIONS.cookieCache.maxAge, 300)
  const origin = 'http://localhost:3188', password = `fixture-${randomBytes(20).toString('hex')}`, email = `cookie-cache-${randomUUID()}@example.invalid`
  const make = (maxAge: number) => {
    const auth = betterAuth({ baseURL: origin, basePath: '/mikka/api/auth', database, secret: randomBytes(32).toString('hex'),
      emailAndPassword: { enabled: true }, trustedOrigins: [origin], logger: { disabled: true }, plugins: [nextCookies()],
      session: { ...fresh.SESSION_OPTIONS, cookieCache: { ...fresh.SESSION_OPTIONS.cookieCache, maxAge } } })
    fresh.readFreshSessionsInScope(auth.api)
    return auth
  }
  const auth = make(fresh.SESSION_OPTIONS.cookieCache.maxAge)
  const created = await auth.api.signUpEmail({ body: { name: 'Cookie Cache Fixture', email, password } })
  t.after(async () => { await query('DELETE FROM "user" WHERE id=$1', [created.user.id]); await database.end() })
  const signIn = async (instance: typeof auth) => {
    const response = await instance.handler(new Request(`${origin}/mikka/api/auth/sign-in/email`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) }))
    assert.equal(response.status, 200)
    return new Headers({ cookie: response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') })
  }
  const read = async (instance: typeof auth, headers: Headers, query?: { disableCookieCache: boolean }) => {
    const before = statements
    const session = await instance.api.getSession({ headers, ...(query ? { query } : {}) }) as { user: { id: string } } | null
    return { userId: session?.user.id ?? null, statements: statements - before }
  }

  const headers = await signIn(auth)
  const cached = await read(auth, headers)
  const database_ = await read(auth, headers, { disableCookieCache: true })
  t.diagnostic(JSON.stringify({ cachedReadStatements: cached.statements, databaseReadStatements: database_.statements }))
  assert.deepEqual(cached, { userId: created.user.id, statements: 0 })
  assert.equal(database_.userId, created.user.id)
  assert.equal(database_.statements, 2, 'a database read is the session and the user')

  // Inside withFreshSession every read goes to the database, even with a valid cache cookie.
  const scoped = await fresh.withFreshSession(() => read(auth, headers))
  assert.deepEqual(scoped, { userId: created.user.id, statements: 2 })
  const route = fresh.freshSessionRoute(async () => read(auth, headers))
  assert.deepEqual(await route(), { userId: created.user.id, statements: 2 })

  // A revoked session: a cached read still sees it until the cache expires (the accepted 5 minutes); a fresh read does not.
  await query('DELETE FROM session WHERE "userId"=$1', [created.user.id])
  assert.equal((await read(auth, headers)).userId, created.user.id)
  assert.equal((await fresh.withFreshSession(() => read(auth, headers))).userId, null)

  // Once the cache is older than maxAge the read checks the database again (1 s here instead of 300 s).
  const short = make(1)
  const shortHeaders = await signIn(short)
  assert.deepEqual(await read(short, shortHeaders), { userId: created.user.id, statements: 0 })
  await query('DELETE FROM session WHERE "userId"=$1', [created.user.id])
  await delay(1100)
  const expired = await read(short, shortHeaders)
  assert.equal(expired.userId, null)
  assert.ok(expired.statements > 0)
})

test('the money, permission, credential and deletion entry points read the session fresh', async () => {
  const { readFile } = await import('node:fs/promises')
  const actions: Record<string, string[]> = {
    'app/actions/billing.ts': ['openBillingPortal', 'startPlanCheckout', 'startPointsPurchase', 'startChatPointsPurchase', 'startCardVerification'],
    'app/actions/workspace-settings.ts': ['updateWorkspace', 'transferWorkspace', 'deleteWorkspace', 'removeWorkspaceMember', 'takeOverArchivedBot'],
    'app/actions/workspace.ts': ['createWorkspaceInvitation', 'updateWorkspaceMember', 'revokeWorkspaceInvitation', 'acceptWorkspaceInvitation'],
    'app/actions/workspace-secrets.ts': ['createSecret', 'replaceSecret', 'deleteSecret', 'saveE2BKey', 'deleteE2BKey'],
    'app/actions/model-api-keys.ts': ['createApiKey', 'deleteApiKey', 'updateApiKeyShare'],
    'app/actions/tokens.ts': ['createAccessToken', 'revokeAccessToken'],
    'app/actions/account.ts': ['changePassword', 'setPassword', 'revokeSession', 'revokeOtherSessions', 'requestDataExport', 'deleteAccount'],
    'app/actions/teams.ts': ['changeTeamMember', 'deleteTeam'],
    'app/actions/app-policy.ts': ['updateAppPolicy'],
  }
  for (const [file, names] of Object.entries(actions)) {
    const source = await readFile(file, 'utf8')
    for (const name of names) assert.match(source, new RegExp(`export async function ${name}\\(\\.\\.\\.args: Parameters<typeof ${name}Body>\\) \\{ return withFreshSession\\(`), `${file} ${name}`)
  }
  const routes: Record<string, string[]> = {
    'app/api/account/deletion/route.ts': ['POST', 'DELETE'],
    'app/api/credentials/oidc/route.ts': ['POST'],
    'app/api/credentials/route.ts': ['DELETE'],
    'app/api/device-tokens/[tokenId]/revoke/route.ts': ['POST'],
    'app/api/devices/enrollment/route.ts': ['POST'],
    'app/api/integrations/composio/credentials/route.ts': ['POST'],
    'app/api/integrations/github/route.ts': ['DELETE'],
    'app/api/integrations/mcp/route.ts': ['POST', 'PATCH', 'DELETE'],
    'app/api/subscriptions/enrollments/bind/route.ts': ['POST'],
    'app/api/subscriptions/enrollments/handoff/route.ts': ['POST'],
    'app/api/subscriptions/enrollments/route.ts': ['POST'],
    'app/api/subscriptions/route.ts': ['POST'],
    'app/api/workspaces/[workspaceId]/audit-log/retention/route.ts': ['PUT'],
    'app/api/workspaces/[workspaceId]/computer-policy/route.ts': ['POST'],
    'app/api/workspaces/[workspaceId]/model-admission/route.ts': ['POST'],
  }
  for (const [file, methods] of Object.entries(routes)) {
    const source = await readFile(file, 'utf8')
    for (const method of methods) assert.match(source, new RegExp(`export const ${method} = freshSessionRoute\\(${method}Body\\)`), `${file} ${method}`)
  }
})
