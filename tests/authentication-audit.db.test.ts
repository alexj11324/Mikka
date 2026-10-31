import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { Pool } from 'pg'
import { dbUrl, seedWorkspace } from './support/workspace-admin-db'
import { TestAccountPool } from '../scripts/test-accounts/pool.mjs'

// Real Better Auth and PostgreSQL. Only Next's request cookie-store port is
// explicit fixture IO; no provider, mailbox or OAuth flow is invoked.
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
    emailAndPassword: { enabled: true }, trustedOrigins: [origin], logger: { disabled: true }, plugins: [nextCookies()],
    hooks: { after: createAuthMiddleware(auditAuthentication) },
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
  const post = (body: unknown) => auth.handler(new Request(`${origin}/mikka/api/auth/sign-in/email`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) }))
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
    const session = (await database.query('SELECT id FROM session WHERE token=$1', [body.token])).rows[0]
    const rows = (await events()).filter(row => row.payload.action === 'auth.signed_in'); assert.equal(rows.length, 2)
    assert.ok(rows.every(row => row.payload.actorType === 'user' && row.payload.actorId === userId && row.payload.targetType === 'session' && row.payload.targetId === session.id))
    assert.ok(rows.every(row => JSON.stringify(row.payload.metadata) === JSON.stringify({ method: 'password' })))
    assert.equal(JSON.stringify(rows).includes(body.token), false)
    const count = (await events()).length
    await auth.api.getSession({ headers: new Headers({ cookie: response.headers.getSetCookie().map((value: string) => value.split(';')[0]).join('; ') }) })
    assert.equal((await events()).length, count)
    // Exercise the production relay without adopting another test's pending intent.
    const own = new Set((await events()).map(row => row.id))
    const pending = (await database.query('SELECT id FROM workspace_audit_outbox WHERE "deliveredAt" IS NULL')).rows
    if (pending.every(row => own.has(row.id))) {
      const name = `auth_audit_sink_${randomUUID().replaceAll('-', '')}`
      await database.query(`ALTER TABLE workspace_audit_events ADD CONSTRAINT ${name} CHECK("workspaceId"<> '${workspaces[0]}'::uuid AND "workspaceId"<>'${workspaces[1]}'::uuid) NOT VALID`)
      try { assert.equal((await deliverWorkspaceAudits({ main: database, workspace: database })).failed, 1) }
      finally { await database.query(`ALTER TABLE workspace_audit_events DROP CONSTRAINT ${name}`) }
      assert.equal((await events()).every(row => row.deliveredAt === null), true)
      assert.equal((await deliverWorkspaceAudits({ main: database, workspace: database })).failed, 0)
      const sink = (await database.query('SELECT action FROM workspace_audit_events WHERE "workspaceId"=ANY($1::uuid[])', [workspaces])).rows
      assert.equal(sink.length, 4)
    }
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
    assert.equal((await database.query('SELECT count(*)::int n FROM workspace_audit_events WHERE "workspaceId"=ANY($1::uuid[])', [workspaces])).rows[0].n, 4)
    // Exercise a delivered login as well: prior unrelated rows remain untouched.
    const after = await post({ email, password }); assert.equal(after.status, 200)
    const next = await after.json(), nextSession = (await database.query('SELECT id FROM session WHERE token=$1', [next.token])).rows[0]
    const own = new Set((await events()).map(row => row.id)), pending = (await database.query('SELECT id FROM workspace_audit_outbox WHERE "deliveredAt" IS NULL')).rows
    if (pending.every(row => own.has(row.id))) await deliverWorkspaceAudits({ main: database, workspace: database })
    const cleanup = await database.connect()
    try { await cleanup.query('BEGIN'); await TestAccountPool.prototype.cleanupLoginAudit(cleanup, [{ id: nextSession.id, owner_id: userId }]); await cleanup.query('COMMIT') }
    catch (error) { await cleanup.query('ROLLBACK'); throw error } finally { cleanup.release() }
    assert.equal(await fingerprint(), before)
  })
})
