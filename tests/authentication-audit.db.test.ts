import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto'
import test, { mock } from 'node:test'
import { Pool } from 'pg'
import { dbUrl, seedWorkspace } from './support/workspace-admin-db'
import { TestAccountPool } from '../scripts/test-accounts/pool.mjs'
import { authAppleOptions, requireAppleSignInNonce } from '../lib/auth-config'
import { SESSION_OPTIONS } from '../lib/fresh-session'
import { DESKTOP_SESSION_CACHE_HEADER, desktopSessionCacheAfter, validDesktopSessionCache } from '../lib/desktop-rpc/session-cache'

// Real Better Auth and PostgreSQL. Next's cookie store and Apple's public-key
// endpoint are fixture IO; Apple tokens are signed locally.
test('authentication writes tenant-bound durable intent and withholds every new credential when audit fails', { skip: !dbUrl }, async t => {
  const database = new Pool({ connectionString: dbUrl, max: 5 })
  assert.ok((await database.query("SELECT to_regclass('workspace_audit_outbox') AS name")).rows[0].name, 'tracked workspace migrations must be applied by normal setup')
  const cookieWrites: unknown[] = []
  mock.module('next/headers.js', { namedExports: { headers: async () => new Headers(), cookies: async () => ({ set: (...args: unknown[]) => cookieWrites.push(args) }) } })
  const [{ betterAuth }, { createAuthMiddleware }, { nextCookies }, { auditAuthentication }, { deliverWorkspaceAudits }, { pool }, { workspacePool }] = await Promise.all([
    import('better-auth'), import('better-auth/api'), import('better-auth/next-js'), import('../lib/audit/authentication'), import('../lib/audit/delivery'), import('../lib/db'), import('../lib/workspace-db'),
  ])
  const origin = 'http://localhost:3187', password = `fixture-${randomBytes(20).toString('hex')}`, email = `audit-login-${randomUUID()}@example.invalid`
  const auth = betterAuth({ baseURL: origin, basePath: '/mikka/api/auth', database, secret: randomBytes(32).toString('hex'),
    socialProviders: { apple: authAppleOptions({ MIKKA_EDITION: 'cloud' })! },
    emailAndPassword: { enabled: true }, trustedOrigins: [origin], logger: { disabled: true }, plugins: [nextCookies()],
    session: SESSION_OPTIONS,
    hooks: { before: createAuthMiddleware(async ctx => { requireAppleSignInNonce(ctx) }), after: createAuthMiddleware(async ctx => { await auditAuthentication(ctx); desktopSessionCacheAfter(ctx) }) },
  })
  const created = await auth.api.signUpEmail({ body: { name: 'Audit Login Fixture', email, password } })
  const userId = created.user.id, workspaces: string[] = []
  t.after(async () => {
    await database.query('DELETE FROM workspace_audit_outbox WHERE "workspaceId"=ANY($1::uuid[])', [workspaces])
    await database.query('DELETE FROM workspace_audit_events WHERE "workspaceId"=ANY($1::uuid[])', [workspaces])
    await database.query('DELETE FROM mikka_workspace_members WHERE "workspaceId"=ANY($1::uuid[])', [workspaces])
    await database.query('DELETE FROM mikka_workspaces WHERE id=ANY($1::uuid[]) AND "userId"=$2', [workspaces, userId])
    await database.query('DELETE FROM "user" WHERE id=$1', [userId])
    await Promise.all([database.end(), pool.end(), workspacePool.end()])
  })
  for (let index = 0; index < 3; index++) workspaces.push((await seedWorkspace(database, userId, [{ userId, role: 'admin', status: index === 2 ? 'suspended' : 'active' }])).id)
  const events = () => database.query('SELECT * FROM workspace_audit_outbox WHERE "workspaceId"=ANY($1::uuid[]) ORDER BY "workspaceId",id', [workspaces]).then(result => result.rows)
  // The relay delivers any pending row (FOR UPDATE SKIP LOCKED). Rows another suite left pending are
  // held locked while this test delivers, so it delivers and counts only its own and never touches theirs.
  const deliverOwn = async () => {
    const own = (await events()).map(row => row.id)
    const holder = await database.connect()
    try {
      await holder.query('BEGIN')
      await holder.query('SELECT id FROM workspace_audit_outbox WHERE "deliveredAt" IS NULL AND NOT (id=ANY($1::uuid[])) FOR UPDATE', [own])
      return await deliverWorkspaceAudits({ main: database, workspace: database })
    } finally { await holder.query('ROLLBACK'); holder.release() }
  }
  const post = (body: unknown) => auth.handler(new Request(`${origin}/mikka/api/auth/sign-in/email`, { method: 'POST', headers: { origin, 'content-type': 'application/json', 'x-mikka-client': 'desktop' }, body: JSON.stringify(body) }))
  await t.test('wrong passwords name an attempted subject, never a forged authenticated actor or client-selected tenant', async () => {
    const denied = await post({ email, password: 'wrong-fixture-password', userId: 'forged-actor', workspaceId: workspaces[2] })
    assert.equal(denied.status, 401)
    const rows = await events(); assert.equal(rows.length, 2)
    assert.deepEqual(rows.map(row => row.workspaceId).sort(), workspaces.slice(0, 2).sort())
    for (const { payload } of rows) {
      assert.equal(payload.action, 'auth.sign_in_failed'); assert.equal(payload.actorType, 'system'); assert.equal(payload.actorId, null)
      assert.equal(payload.targetType, 'user'); assert.equal(payload.targetId, userId)
      assert.deepEqual(payload.metadata, { method: 'password', reason: 'invalid' })
    }
    const unknown = await post({ email: `unknown-${randomUUID()}@example.invalid`, password: 'wrong-fixture-password' })
    assert.equal(unknown.status, 401); assert.equal((await events()).length, 2)
    const json = JSON.stringify(rows); assert.equal(json.includes(password), false); assert.equal(json.includes(email), false); assert.equal(json.includes('wrong-fixture-password'), false)
  })
  await t.test('real successful sign-in queues exact session references, skips session reads, and remains durable when the sink refuses delivery', async () => {
    const response = await post({ email, password }); assert.equal(response.status, 200)
    const body = await response.json(); assert.equal(body.user.id, userId)
    assert.ok(response.headers.getSetCookie().length)
    assert.ok(validDesktopSessionCache(response.headers.get(DESKTOP_SESSION_CACHE_HEADER)))
    const session = (await database.query('SELECT id FROM session WHERE token=$1', [body.token])).rows[0]
    const rows = (await events()).filter(row => row.payload.action === 'auth.signed_in'); assert.equal(rows.length, 2)
    assert.ok(rows.every(row => row.payload.actorType === 'user' && row.payload.actorId === userId && row.payload.targetType === 'session' && row.payload.targetId === session.id))
    assert.ok(rows.every(row => JSON.stringify(row.payload.metadata) === JSON.stringify({ method: 'password' })))
    assert.equal(JSON.stringify(rows).includes(body.token), false)
    const count = (await events()).length
    await auth.api.getSession({ headers: new Headers({ cookie: response.headers.getSetCookie().map((value: string) => value.split(';')[0]).join('; ') }) })
    assert.equal((await events()).length, count)
    // Exercise the production relay on this test's own pending intent only (deliverOwn).
    const name = `auth_audit_sink_${randomUUID().replaceAll('-', '')}`
    await database.query(`ALTER TABLE workspace_audit_events ADD CONSTRAINT ${name} CHECK("workspaceId"<> '${workspaces[0]}'::uuid AND "workspaceId"<>'${workspaces[1]}'::uuid) NOT VALID`)
    try { assert.equal((await deliverOwn()).failed, 1) }
    finally { await database.query(`ALTER TABLE workspace_audit_events DROP CONSTRAINT ${name}`) }
    assert.equal((await events()).every(row => row.deliveredAt === null), true)
    assert.equal((await deliverOwn()).failed, 0)
    const own = (await events()).map(row => row.id)
    assert.equal(own.length, 4)
    const sink = (await database.query('SELECT id FROM workspace_audit_events WHERE id=ANY($1::uuid[])', [own])).rows
    assert.equal(sink.length, 4)
  })
  await t.test('actual Better Auth HTTP and nextCookies API paths publish no credential on an outbox error', async () => {
    const name = `auth_audit_source_${randomUUID().replaceAll('-', '')}`
    const sessions = () => database.query('SELECT count(*)::int AS n FROM session WHERE "userId"=$1', [userId]).then(result => result.rows[0].n)
    const before = await sessions(), oldEvents = (await events()).length, logs: unknown[] = [], original = console.error
    await database.query(`ALTER TABLE workspace_audit_outbox ADD CONSTRAINT ${name} CHECK("workspaceId"<>'${workspaces[0]}'::uuid) NOT VALID`)
    console.error = (...args: unknown[]) => { logs.push(args) }
    try {
      const response = await post({ email, password }); assert.equal(response.status, 503)
      assert.equal(response.headers.getSetCookie().length, 0)
      assert.equal(response.headers.has(DESKTOP_SESSION_CACHE_HEADER), false, 'withheld sign-in must not expose a reusable native proof')
      const body = await response.json(); assert.equal(body.code, 'AUTH_AUDIT_UNAVAILABLE'); assert.equal(Object.hasOwn(body, 'token'), false)
      cookieWrites.length = 0
      await assert.rejects(auth.api.signInEmail({ body: { email, password }, headers: new Headers({ origin }) }), { statusCode: 503 })
      assert.equal(cookieWrites.length, 0)
      assert.equal(await sessions(), before); assert.equal((await events()).length, oldEvents)
      // Refused authentication keeps the same response during an audit outage.
      assert.equal((await post({ email, password: 'wrong-fixture-password' })).status, 401)
      assert.equal(JSON.stringify(logs).includes(password), false); assert.equal(JSON.stringify(logs).includes(email), false)
    } finally { console.error = original; await database.query(`ALTER TABLE workspace_audit_outbox DROP CONSTRAINT ${name}`) }
  })
  await t.test('only this login fixture audit is disposable; actual pool fingerprints return to baseline', async () => {
    // Retain all preceding failure/business evidence as the immutable baseline.
    const reader = { ownedRows: TestAccountPool.prototype.ownedRows }
    const fingerprint = () => TestAccountPool.prototype.fingerprint.call(reader, database, userId)
    const before = await fingerprint()
    const response = await post({ email, password }); assert.equal(response.status, 200)
    const body = await response.json(), session = (await database.query('SELECT id FROM session WHERE token=$1', [body.token])).rows[0]
    assert.notEqual(await fingerprint(), before)
    const client = await database.connect()
    try { await client.query('BEGIN'); await TestAccountPool.prototype.cleanupLoginAudit(client, [{ id: session.id, owner_id: userId }]); await client.query('COMMIT') }
    catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
    assert.equal(await fingerprint(), before)
    // This test's own four earlier rows are delivered, whatever other suites left in the outbox.
    const delivered = (await events()).filter(row => row.deliveredAt !== null).map(row => row.id)
    assert.equal(delivered.length, 4)
    assert.equal((await database.query('SELECT count(*)::int n FROM workspace_audit_events WHERE id=ANY($1::uuid[])', [delivered])).rows[0].n, 4)
    // Exercise a delivered login as well: prior unrelated rows remain untouched.
    const after = await post({ email, password }); assert.equal(after.status, 200)
    const next = await after.json(), nextSession = (await database.query('SELECT id FROM session WHERE token=$1', [next.token])).rows[0]
    await deliverOwn()
    const cleanup = await database.connect()
    try { await cleanup.query('BEGIN'); await TestAccountPool.prototype.cleanupLoginAudit(cleanup, [{ id: nextSession.id, owner_id: userId }]); await cleanup.query('COMMIT') }
    catch (error) { await cleanup.query('ROLLBACK'); throw error } finally { cleanup.release() }
    assert.equal(await fingerprint(), before)
  })
  await t.test('native Apple sign-in commits OAuth audit and withholds the session on audit failure', async native => {
    await (await auth.$context).internalAdapter.updateUser(userId, { emailVerified: true })
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'native-audit-fixture', alg: 'RS256' }
    native.mock.method(globalThis, 'fetch', async (input: unknown) => {
      assert.equal(String(input), 'https://appleid.apple.com/auth/keys')
      return Response.json({ keys: [jwk] })
    })
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    const nonce = `${randomBytes(32).toString('hex')}.${hash(`${origin}/mikka/api/auth`)}`
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: jwk.kid })).toString('base64url')
    const payload = Buffer.from(JSON.stringify({ sub: `apple-audit-${userId}`, email, email_verified: true,
      nonce: hash(nonce), iss: 'https://appleid.apple.com', aud: 'com.aspectlylabs.mikka',
      iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300 })).toString('base64url')
    const unsigned = `${header}.${payload}`
    const token = `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url')}`
    const postNative = () => auth.handler(new Request(`${origin}/mikka/api/auth/sign-in/social`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-skip-oauth-proxy': 'true' },
      body: JSON.stringify({ provider: 'apple', idToken: { token, nonce } }),
    }))
    const beforeEvents = (await events()).length
    const response = await postNative()
    assert.equal(response.status, 200)
    const body = await response.json()
    // Query by the new session, since the outbox sorts by workspace before id.
    const session = (await database.query('SELECT id FROM session WHERE token=$1', [body.token])).rows[0]
    const nativeEvents = (await events()).filter(row => row.payload?.targetId === session.id)
    assert.equal((await events()).length - beforeEvents, 2)
    assert.equal(nativeEvents.length, 2)
    assert.ok(nativeEvents.every(row => row.payload.action === 'auth.signed_in' && row.payload.metadata.method === 'oauth'))
    assert.equal(JSON.stringify(nativeEvents).includes(token), false)
    const name = `auth_native_audit_${randomUUID().replaceAll('-', '')}`
    const sessions = () => database.query('SELECT count(*)::int AS n FROM session WHERE "userId"=$1', [userId]).then(result => result.rows[0].n)
    const beforeSessions = await sessions(), beforeFailure = (await events()).length
    await database.query(`ALTER TABLE workspace_audit_outbox ADD CONSTRAINT ${name} CHECK("workspaceId"<>'${workspaces[0]}'::uuid) NOT VALID`)
    try {
      cookieWrites.length = 0
      const denied = await postNative()
      assert.equal(denied.status, 503)
      const withheld = await denied.json()
      assert.equal(withheld.code, 'AUTH_AUDIT_UNAVAILABLE')
      assert.equal(Object.hasOwn(withheld, 'token'), false)
      assert.equal(denied.headers.getSetCookie().length, 0)
      assert.equal(denied.headers.has(DESKTOP_SESSION_CACHE_HEADER), false)
      assert.equal(cookieWrites.length, 0)
      assert.equal(await sessions(), beforeSessions)
      assert.equal((await events()).length, beforeFailure)
    } finally { await database.query(`ALTER TABLE workspace_audit_outbox DROP CONSTRAINT ${name}`) }
  })
})
