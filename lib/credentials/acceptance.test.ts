import assert from 'node:assert/strict'
import { createServer, type IncomingMessage } from 'node:http'
import { once } from 'node:events'
import { readFile, mkdtemp, symlink, unlink, rm, readdir, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { betterAuth } from 'better-auth'
import { chromium } from '@playwright/test'
import type { ElementHandle } from 'playwright-core'
import { CredentialBroker } from './broker'
import { PostgresCredentialAuthority } from './authority'
import { credentialHttp } from './http'
import { CredentialError, type Binding } from './contracts'
import { credentialServices } from './services'
import { InfisicalCredentialVault, type CredentialVault } from './vault'
import { assertBrowserIsolationTransition } from './browser-protocol'
import { OwnedChromiumExecutor } from './owned-chromium'
import { CredentialExecutionTools } from './execution-tools'

const fixture = 'synthetic-credential-ONLY-6f8ab91c'
function gate() {
  let release!: () => void, started!: () => void
  return { blocked: new Promise<void>(r => { release = r }), entered: new Promise<void>(r => { started = r }), release: () => release(), start: () => started() }
}
class FixtureVault implements CredentialVault {
  values = new Map<string, string>()
  puts = 0; reads = 0; deletes = 0
  putGate?: ReturnType<typeof gate>; readGate?: ReturnType<typeof gate>
  failPut = false; failRead = false; failDelete = false
  async put(ref: string, secret: string) {
    this.puts++
    if (this.putGate) { this.putGate.start(); await this.putGate.blocked }
    this.values.set(ref, secret)
    if (this.failPut) throw new Error(`provider included ${secret}`)
  }
  async read(ref: string) {
    this.reads++
    if (this.readGate) { this.readGate.start(); await this.readGate.blocked }
    if (this.failRead) throw new CredentialError('vault_unavailable', 503)
    const value = this.values.get(ref)
    if (!value) throw new Error(fixture)
    return value
  }
  async remove(ref: string) {
    this.deletes++
    if (this.failDelete) throw new Error(fixture)
    this.values.delete(ref)
  }
}

const databaseURL = process.env.CREDENTIAL_TEST_DATABASE_URL
test('credential broker: real HTTP + Better Auth + isolated Postgres, synthetic vault and upstream', { skip: !databaseURL }, async t => {
  const parsed = new URL(databaseURL!)
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname), 'acceptance only permits a loopback database')
  assert.match(parsed.pathname, /^\/mikka_credential_test_[a-z0-9_]+$/)
  const workspaceURL = process.env.CREDENTIAL_TEST_WORKSPACE_DATABASE_URL
  assert.ok(workspaceURL, 'provide a distinct disposable workspace database')
  const workspaceParsed = new URL(workspaceURL)
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(workspaceParsed.hostname))
  assert.match(workspaceParsed.pathname, /^\/mikka_credential_test_[a-z0-9_]+$/)
  assert.notEqual(workspaceParsed.href, parsed.href)
  const app = new Pool({ connectionString: databaseURL!, max: 8 })
  const workspace = new Pool({ connectionString: workspaceURL, max: 4 })
  const logs: string[] = []
  const server = createServer()
  const upstream = createServer()
  let received = 0
  let upstreamGate: ReturnType<typeof gate> | undefined
  let browserSubmissions = 0, browserFailSubmit = false, browserReadonly = false
  let browserPostGate: ReturnType<typeof gate> | undefined
  upstream.on('request', async (req, res) => {
    received++
    assert.ok(req.headers.authorization === `Bearer ${fixture}`, 'upstream receives the expected synthetic credential')
    if (upstreamGate) { upstreamGate.start(); await upstreamGate.blocked }
    res.setHeader('x-echo-secret', fixture)
    res.end(fixture) // Deliberately hostile response must never be returned to the caller/model.
  })
  await app.query(`CREATE TABLE "user" (id text PRIMARY KEY, name text NOT NULL, email text NOT NULL UNIQUE,
    "emailVerified" boolean NOT NULL, image text, "createdAt" timestamptz NOT NULL, "updatedAt" timestamptz NOT NULL);
    CREATE TABLE "session" (id text PRIMARY KEY, "expiresAt" timestamptz NOT NULL, token text NOT NULL UNIQUE,
    "createdAt" timestamptz NOT NULL, "updatedAt" timestamptz NOT NULL, "ipAddress" text, "userAgent" text, "userId" text NOT NULL);
    CREATE TABLE account (id text PRIMARY KEY, "accountId" text NOT NULL, "providerId" text NOT NULL, "userId" text NOT NULL,
    "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" timestamptz,
    "refreshTokenExpiresAt" timestamptz, scope text, password text, "createdAt" timestamptz NOT NULL, "updatedAt" timestamptz NOT NULL);
    CREATE TABLE verification (id text PRIMARY KEY, identifier text NOT NULL, value text NOT NULL, "expiresAt" timestamptz NOT NULL, "createdAt" timestamptz, "updatedAt" timestamptz);
    CREATE TABLE issues (id uuid PRIMARY KEY, "userId" text, content jsonb NOT NULL);
    CREATE TABLE devices (id uuid PRIMARY KEY, "ownerId" text, enabled boolean DEFAULT true, "lastSeenAt" timestamptz DEFAULT now());
    CREATE TABLE agent_runs (id uuid PRIMARY KEY, "userId" text, "issueId" uuid, "deviceId" uuid, "sessionId" text,
    status text DEFAULT 'running', "stopRequestedAt" timestamptz, "leaseExpiresAt" timestamptz DEFAULT now()+interval '90 seconds');`)
  await workspace.query(`CREATE TABLE mikka_workspaces (id uuid PRIMARY KEY);
    CREATE TABLE mikka_workspace_members ("workspaceId" uuid, "userId" text, status text DEFAULT 'active');
    CREATE TABLE mikka_team_issues ("issueId" uuid, "workspaceId" uuid);`)
  await app.query(await readFile(new URL('../../drizzle/20261025052200_credential_broker.sql', import.meta.url), 'utf8'))
  await app.query(await readFile(new URL('../../drizzle/20261025052201_credential_browser_binding.sql', import.meta.url), 'utf8'))
  await app.query(await readFile(new URL('../../drizzle/20261025052202_credential_handoff.sql', import.meta.url), 'utf8'))
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const endpoint = `http://127.0.0.1:${(upstream.address() as { port: number }).port}/fixed`
  const auth = betterAuth({
    database: app, baseURL: origin, secret: 'synthetic-test-auth-secret-32-bytes-only',
    emailAndPassword: { enabled: true }, trustedOrigins: [origin], logger: { disabled: true },
  })
  const vault = new FixtureVault()
  const authority = new PostgresCredentialAuthority(app, workspace)
  const broker = new CredentialBroker({ pool: app, vault, authority, services: new Map([
    ['fixture', { id: 'fixture', endpoint, method: 'GET', header: 'Authorization', prefix: 'Bearer ' }],
  ]) })
  const handler = credentialHttp({ broker, origin, authenticate: async request => {
    const session = await auth.api.getSession({ headers: request.headers })
    return session ? { ownerId: session.user.id, authSessionId: session.session.id } : null
  } })
  let activeHandler = handler
  function toRequest(req: IncomingMessage) {
    return new Request(new URL(req.url!, origin), {
      method: req.method, headers: req.headers as HeadersInit,
      ...(req.method !== 'GET' && req.method !== 'HEAD' ? { body: req as unknown as ReadableStream, duplex: 'half' } : {}),
    } as RequestInit)
  }
  server.on('request', async (req, res) => {
    // This fixture logger intentionally records only method; never body, headers, URLs or exceptions.
    logs.push(req.method!)
    try {
      let response: Response
      const request = toRequest(req)
      if (req.url!.startsWith('/api/auth/')) response = await auth.handler(request)
      else if (req.url === '/credential-login') response = new Response(`<!doctype html><form method="post" action="/credential-login-submit"><input id="credential" name="credential" type="password" autocomplete="off" ${browserReadonly ? 'readonly' : ''}><button id="submit" type="submit">Submit synthetic fixture</button></form>`, { headers: { 'content-type': 'text/html' } })
      else if (req.url === '/credential-login-submit') {
        const fields = new URLSearchParams(await request.text())
        assert.ok(fields.get('credential') === fixture, 'browser target receives the expected synthetic credential')
        browserSubmissions++
        if (browserPostGate) { browserPostGate.start(); await browserPostGate.blocked }
        response = browserFailSubmit ? new Response('synthetic submission rejected', { status: 500 }) : new Response('', { status: 302, headers: { Location: '/credential-login-ok', 'Set-Cookie': 'fixture-browser-session=synthetic-authenticated; HttpOnly; SameSite=Strict; Path=/' } })
      } else if (req.url === '/credential-login-ok') response = request.headers.get('cookie')?.includes('fixture-browser-session=synthetic-authenticated') || request.headers.get('cookie')?.includes('fixture-browser-session=synthetic-rotated')
        ? new Response('<!doctype html><p data-fixture-verified="true">Synthetic account verified</p>', { headers: { 'content-type': 'text/html' } })
        : new Response('no synthetic session', { status: 403 })
      else if (req.url === '/credential-account') response = request.headers.get('cookie')?.includes('fixture-browser-session=synthetic-authenticated') || request.headers.get('cookie')?.includes('fixture-browser-session=synthetic-rotated')
        ? new Response('<!doctype html><p data-fixture-verified="true">Authenticated synthetic account</p><span data-fixture-account>ACCOUNT-42</span><a id="projects" href="/credential-projects">Projects</a>', { headers: { 'content-type': 'text/html' } })
        : new Response('no synthetic session', { status: 403 })
      else if (req.url === '/credential-projects') response = request.headers.get('cookie')?.includes('fixture-browser-session=synthetic-authenticated') || request.headers.get('cookie')?.includes('fixture-browser-session=synthetic-rotated')
        ? new Response(`<!doctype html><p data-fixture-verified="true">Projects</p><div data-project-list>Project Alpine: ready for review. Session: synthetic-rotated<input type="hidden" value="hidden-private-value"></div><div data-boundary>${'x'.repeat(4090)}synthetic-rotated</div>`, { headers: { 'content-type': 'text/html', 'set-cookie': 'fixture-browser-session=synthetic-rotated; HttpOnly; SameSite=Strict; Path=/' } })
        : new Response('no synthetic session', { status: 403 })
      else if (req.url === '/test-page') response = new Response('<!doctype html><input id="password" type="password"><p>Controlled synthetic login test page</p>', { headers: { 'content-type': 'text/html' } })
      else {
        const match = /^\/api\/credential-requests(?:\/([^/]+)(?:\/(submit|cancel|events))?)?$/.exec(req.url!)
        response = match ? await activeHandler(request, (match[2] ?? (match[1] ? 'get' : 'create')) as 'create', match[1]) : new Response('', { status: 404 })
      }
      res.writeHead(response.status, Object.fromEntries(response.headers))
      res.end(Buffer.from(await response.arrayBuffer()))
    } catch { res.writeHead(500); res.end('fixture_error') }
  })
  t.after(async () => { server.closeAllConnections(); upstream.closeAllConnections(); await Promise.all([new Promise<void>(r => server.close(() => r())), new Promise<void>(r => upstream.close(() => r()))]); await Promise.all([app.end(), workspace.end()]) })
  async function signUp(email: string) {
    const response = await fetch(`${origin}/api/auth/sign-up/email`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Synthetic Fixture', email, password: 'synthetic-password-fixture-ONLY' }) })
    assert.equal(response.status, 200)
    const body = await response.json()
    const cookie = response.headers.getSetCookie().map(s => s.split(';')[0]).join('; ')
    assert.ok(cookie)
    const session = await auth.api.getSession({ headers: new Headers({ cookie }) })
    assert.ok(session)
    return { cookie, id: body.user.id as string, sessionId: session.session.id }
  }
  const alice = await signUp('credential-alice@example.test'), bob = await signUp('credential-bob@example.test')
  const workspaceId = randomUUID(), taskId = randomUUID(), runId = randomUUID(), deviceId = randomUUID(), executionSession = randomUUID()
  await app.query('INSERT INTO issues VALUES ($1,$2,$3)', [taskId, alice.id, { type: 'doc', content: [] }])
  await app.query('INSERT INTO devices (id,"ownerId") VALUES ($1,$2)', [deviceId, alice.id])
  await app.query('INSERT INTO agent_runs (id,"userId","issueId","deviceId","sessionId") VALUES ($1,$2,$3,$4,$5)', [runId, alice.id, taskId, deviceId, executionSession])
  await workspace.query('INSERT INTO mikka_workspaces VALUES ($1)', [workspaceId])
  await workspace.query('INSERT INTO mikka_workspace_members ("workspaceId","userId") VALUES ($1,$2)', [workspaceId, alice.id])
  await workspace.query('INSERT INTO mikka_team_issues VALUES ($1,$2)', [taskId, workspaceId])
  const binding: Binding & { serviceId: string } = { ownerId: alice.id, authSessionId: alice.sessionId, workspaceId, taskId, runId, executionSession, serviceId: 'fixture' }
  async function call(path: string, body?: unknown, cookie = alice.cookie, extra: Record<string, string> = {}) {
    return fetch(`${origin}/api/credential-requests${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { cookie, Origin: origin, 'Content-Type': 'application/json', 'X-Mikka-Credential': '1', ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  }
  async function create(mode = 'api_header') {
    const response = await call('', { workspaceId, runId, serviceId: 'fixture', mode })
    assert.equal(response.status, 201, await response.clone().text())
    return response.json()
  }
  async function submit(request: { id: string; nonce: string }, save = false) {
    return call(`/${request.id}/submit`, { nonce: request.nonce, secret: fixture, save })
  }

  await t.test('authenticated creation; cross-user, workspace, CSRF, strict schema and size rejection', async () => {
    assert.equal((await call('', { workspaceId, runId, serviceId: 'fixture', mode: 'api_header' }, '')).status, 401)
    assert.equal((await call('', { workspaceId, runId, serviceId: 'fixture', mode: 'api_header' }, bob.cookie)).status, 404)
    assert.equal((await call('', { workspaceId: randomUUID(), runId, serviceId: 'fixture', mode: 'api_header' })).status, 404)
    assert.equal((await call('', {}, alice.cookie, { Origin: 'https://attacker.example' })).status, 403)
    assert.equal((await call('', {}, alice.cookie, { 'X-Mikka-Credential': '' })).status, 403)
    const request = await create()
    assert.equal((await call(`/${request.id}`, undefined, bob.cookie)).status, 404)
    assert.equal((await call(`/${request.id}/cancel`, {}, bob.cookie)).status, 404)
    assert.equal((await call(`/${request.id}/submit`, { nonce: request.nonce, secret: fixture }, bob.cookie)).status, 404)
    assert.equal((await call(`/${request.id}/submit`, { nonce: request.nonce, secret: fixture, injected: fixture })).status, 400)
    assert.equal((await call(`/${request.id}/submit`, { nonce: request.nonce, secret: 'x'.repeat(15000) })).status, 413)
    assert.equal((await call(`/${request.id}/submit`, { nonce: 'a'.repeat(43), secret: fixture })).status, 403)
    assert.equal((await call('', { workspaceId, runId, serviceId: 'fixture', mode: 'api_header' })).status, 409)
    await call(`/${request.id}/cancel`, {})
  })
  await t.test('system tool adapter derives live context, rejects cross-owner/run/task, and never accepts secret arguments', async () => {
    const tools = new CredentialExecutionTools({ app, workspace, broker, basePath: '/mikka' })
    const prepare = { runId, serviceId: 'fixture', mode: 'api_header' }
    const result = await tools.execute({ userId: alice.id }, 'prepare_credential_request', prepare) as { workspaceId: string; submission: { body: unknown } }
    assert.equal(result.workspaceId, workspaceId)
    assert.deepEqual(result.submission.body, { workspaceId, runId, serviceId: 'fixture', mode: 'api_header' })
    assert.deepEqual(await tools.execute({ userId: bob.id }, 'prepare_credential_request', prepare), { error: 'credential_not_found' })
    assert.deepEqual(await tools.execute({ userId: alice.id, runId: randomUUID() }, 'prepare_credential_request', prepare), { error: 'credential_not_found' })
    assert.deepEqual(await tools.execute({ userId: alice.id, taskId: randomUUID() }, 'prepare_credential_request', prepare), { error: 'credential_not_found' })
    assert.deepEqual(await tools.execute({ userId: alice.id }, 'prepare_credential_request', { ...prepare, secret: fixture }), { error: 'credential_tool_input_invalid' })
    const request = await create(); await submit(request)
    assert.deepEqual(await tools.execute({ userId: bob.id, runId }, 'credential_status', { credentialRef: request.id }), { error: 'credential_not_found' })
    assert.deepEqual(await tools.execute({ userId: alice.id, runId }, 'credential_use', { credentialRef: request.id }), { status: 200 })
    assert.deepEqual(await tools.execute({ userId: alice.id, runId }, 'credential_use', { credentialRef: request.id }), { error: 'credential_request_gone' })
    const saved = await create(); await submit(saved, true)
    assert.deepEqual(await tools.execute({ userId: alice.id, runId }, 'credential_use', { credentialRef: saved.id }), { status: 200 })
    const finished = await tools.execute({ userId: alice.id, runId }, 'credential_finish', { credentialRef: saved.id }) as { state: string }
    assert.equal(finished.state, 'consumed'); assert.equal(vault.values.size, 0)
  })
  await t.test('one-time submit/replay; opaque-only events/DB; fixed-target executor discards echo body', async () => {
    const request = await create()
    assert.equal((await submit(request)).status, 200)
    assert.equal((await submit(request)).status, 409)
    const events = await (await call(`/${request.id}/events`)).text()
    assert.match(events, /event: credential.state/); assert.ok(!events.includes(fixture)); assert.ok(!events.includes(request.nonce))
    assert.equal((await app.query('SELECT row_to_json(c)::text AS data FROM credential_requests c')).rows.some(r => r.data.includes(fixture) || r.data.includes(request.nonce)), false)
    const before = vault.reads
    for (const wrong of [{ ownerId: bob.id }, { workspaceId: randomUUID() }, { taskId: randomUUID() }, { runId: randomUUID() }, { executionSession: randomUUID() }, { serviceId: 'other' }, { authSessionId: bob.sessionId }]) {
      await assert.rejects(broker.use(request.id, { ...binding, ...wrong }), { code: 'credential_not_found' })
    }
    assert.equal(vault.reads, before)
    assert.deepEqual(await broker.use(request.id, binding), { status: 200 })
    assert.equal((await (await call(`/${request.id}`)).json()).state, 'consumed')
    assert.equal(vault.values.size, 0)
    await assert.rejects(broker.use(request.id, binding), { code: 'credential_request_gone' })
  })
  await t.test('cancel racing vault write; no ready transition; durable failed-delete retry', async () => {
    const request = await create(), block = gate(); vault.putGate = block
    const submitting = submit(request); await block.entered
    assert.equal((await submit(request)).status, 409)
    const response = await call(`/${request.id}/cancel`, {})
    assert.equal(response.status, 200); assert.equal((await response.json()).state, 'cancelled')
    vault.failDelete = true; block.release(); assert.equal((await submitting).status, 410)
    vault.putGate = undefined
    assert.equal((await (await call(`/${request.id}`)).json()).cleanupPending, true)
    vault.failDelete = false; await broker.sweep()
    assert.equal(vault.values.size, 0)
    assert.equal((await (await call(`/${request.id}`)).json()).cleanupPending, false)
  })
  await t.test('expiry racing vault write and read; cancellation before admission prevents upstream call', async () => {
    let request = await create(), block = gate(); vault.putGate = block
    const submitting = submit(request); await block.entered
    await app.query("UPDATE credential_requests SET expires_at=now()-interval '1 second' WHERE id=$1", [request.id])
    await broker.sweep(); block.release(); assert.equal((await submitting).status, 410); vault.putGate = undefined
    request = await create(); assert.equal((await submit(request)).status, 200)
    block = gate(); vault.readGate = block
    const before = received, using = broker.use(request.id, binding); await block.entered
    await call(`/${request.id}/cancel`, {}); block.release()
    await assert.rejects(using, { code: 'credential_request_gone' }); vault.readGate = undefined
    assert.equal(received, before); assert.equal(vault.values.size, 0)
    request = await create(); await submit(request)
    await app.query("UPDATE credential_requests SET use_expires_at=now()-interval '1 second' WHERE id=$1", [request.id])
    await assert.rejects(broker.use(request.id, binding), { code: 'credential_request_gone' })
    assert.equal((await submit(request)).status, 410)
    assert.equal(vault.values.size, 0)
    request = await create(); await submit(request)
    block = gate(); vault.readGate = block
    const expiringUse = broker.use(request.id, binding); await block.entered
    await app.query("UPDATE credential_requests SET use_expires_at=now()-interval '1 second' WHERE id=$1", [request.id])
    block.release(); await assert.rejects(expiringUse, { code: 'credential_request_gone' }); vault.readGate = undefined
    assert.equal(received, before); assert.equal(vault.values.size, 0)
  })
  await t.test('cancel after use admission blocks all later uses while an admitted call completes', async () => {
    const request = await create(); await submit(request, true)
    const block = gate(); upstreamGate = block
    const using = broker.use(request.id, binding); await block.entered
    const cancelled = await (await call(`/${request.id}/cancel`, {})).json()
    assert.equal(cancelled.state, 'cancelled'); assert.equal(cancelled.cleanupPending, true)
    await assert.rejects(broker.use(request.id, binding), { code: 'credential_busy' })
    block.release(); await using; upstreamGate = undefined
    await assert.rejects(broker.use(request.id, binding), { code: 'credential_request_gone' })
    assert.equal(vault.values.size, 0)
  })
  await t.test('session-only explicit save; disconnect, permission and auth revocation deny new use', async () => {
    let request = await create(); await submit(request, true)
    await broker.use(request.id, binding); await broker.use(request.id, binding)
    assert.equal((await (await call(`/${request.id}`)).json()).state, 'ready')
    await broker.disconnect(alice.id, runId, executionSession)
    await assert.rejects(broker.use(request.id, binding), { code: 'credential_request_gone' })
    request = await create(); await submit(request)
    await workspace.query("UPDATE mikka_workspace_members SET status='suspended'")
    await assert.rejects(broker.use(request.id, binding), { code: 'credential_request_gone' })
    await workspace.query("UPDATE mikka_workspace_members SET status='active'")
    request = await create(); await submit(request)
    await workspace.query('DELETE FROM mikka_workspaces WHERE id=$1', [workspaceId])
    await assert.rejects(broker.use(request.id, binding), { code: 'credential_request_gone' })
    await workspace.query('INSERT INTO mikka_workspaces VALUES ($1)', [workspaceId])
    request = await create(); await submit(request)
    await app.query('UPDATE agent_runs SET "sessionId"=$1 WHERE id=$2', [randomUUID(), runId])
    await assert.rejects(broker.use(request.id, binding), { code: 'credential_request_gone' })
    await app.query('UPDATE agent_runs SET "sessionId"=$1 WHERE id=$2', [executionSession, runId])
    request = await create(); await submit(request)
    await app.query('DELETE FROM "session" WHERE id=$1', [alice.sessionId])
    await assert.rejects(broker.use(request.id, binding), { code: 'credential_request_gone' })
    assert.equal((await call(`/${request.id}`)).status, 401)
    // Restore a fresh real Better Auth session for the remaining tests.
    const response = await fetch(`${origin}/api/auth/sign-in/email`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'credential-alice@example.test', password: 'synthetic-password-fixture-ONLY' }) })
    alice.cookie = response.headers.getSetCookie().map(s => s.split(';')[0]).join('; ')
    const session = await auth.api.getSession({ headers: new Headers({ cookie: alice.cookie }) }); assert.ok(session)
    alice.sessionId = session.session.id; binding.authSessionId = session.session.id
  })
  await t.test('provider exceptions, crashed operations and late-write tombstones clean without leakage', async () => {
    let request = await create(); vault.failPut = true
    const response = await submit(request); assert.equal(response.status, 503); assert.ok(!(await response.text()).includes(fixture))
    vault.failPut = false; assert.equal(vault.values.size, 0)
    request = await create(); await submit(request); vault.failRead = true
    await assert.rejects(broker.use(request.id, binding), { code: 'vault_unavailable' }); vault.failRead = false
    assert.equal(vault.values.size, 0)
    request = await create(); await submit(request)
    await app.query("UPDATE credential_requests SET state='using' WHERE id=$1", [request.id])
    await broker.sweep(); assert.equal(vault.values.size, 0)
    const row = (await app.query('SELECT vault_ref FROM credential_requests WHERE id=$1', [request.id])).rows[0]
    vault.values.set(row.vault_ref, fixture) // Simulate provider committing a timed-out put after initial deletion.
    await broker.sweep(); assert.equal(vault.values.size, 0)
    assert.ok(!logs.join('\n').includes(fixture))
  })
  await t.test('small connection pool concurrent submit/use does not borrow a second app connection', async () => {
    const small = new Pool({ connectionString: databaseURL!, max: 1, connectionTimeoutMillis: 500 })
    const services = new Map(Array.from({ length: 5 }, (_, i) => [`fixture-${i}`, { id: `fixture-${i}`, endpoint, method: 'GET' as const, header: 'Authorization', prefix: 'Bearer ' }]))
    const concurrentBroker = new CredentialBroker({ pool: small, vault, services, authority: new PostgresCredentialAuthority(small, workspace) })
    try {
      const principal = { ownerId: alice.id, authSessionId: alice.sessionId }
      const requests = []
      for (const serviceId of services.keys()) requests.push(await concurrentBroker.create(principal, { workspaceId, runId, serviceId, mode: 'api_header' }))
      await Promise.all(requests.map(request => concurrentBroker.submit(principal, request.id, { nonce: request.nonce, secret: fixture, save: false })))
      const results = await Promise.all(requests.map(request => concurrentBroker.use(request.id, { ...binding, serviceId: request.serviceId })))
      assert.ok(results.every(result => 'status' in result && result.status === 200)); assert.equal(vault.values.size, 0)
    } finally { await small.end() }
  })
  await t.test('same-origin policy drift revokes before vault read; stale run lease fails closed', async () => {
    const request = await create(); await submit(request)
    const changedBroker = new CredentialBroker({ pool: app, vault, authority, services: new Map([
      ['fixture', { id: 'fixture', endpoint: `${endpoint}/changed`, method: 'POST', header: 'X-Api-Key', prefix: '' }],
    ]) })
    const reads = vault.reads
    await assert.rejects(changedBroker.use(request.id, binding), { code: 'credential_service_unavailable' })
    assert.equal(vault.reads, reads); assert.equal(vault.values.size, 0)
    await app.query("UPDATE agent_runs SET \"leaseExpiresAt\"=now()-interval '1 second' WHERE id=$1", [runId])
    assert.equal((await call('', { workspaceId, runId, serviceId: 'fixture', mode: 'api_header' })).status, 404)
    await app.query("UPDATE agent_runs SET \"leaseExpiresAt\"=now()+interval '90 seconds' WHERE id=$1", [runId])
    await app.query("UPDATE devices SET \"lastSeenAt\"=now()-interval '61 seconds' WHERE id=$1", [deviceId])
    assert.equal((await call('', { workspaceId, runId, serviceId: 'fixture', mode: 'api_header' })).status, 404)
    await app.query('UPDATE devices SET "lastSeenAt"=now() WHERE id=$1', [deviceId])
  })
  await t.test('DB lifecycle hooks revoke on stop/device disable independently of app callbacks', async () => {
    let request = await create(); await submit(request)
    await app.query('UPDATE agent_runs SET "stopRequestedAt"=now() WHERE id=$1', [runId])
    assert.equal((await app.query('SELECT state FROM credential_requests WHERE id=$1', [request.id])).rows[0].state, 'disconnected')
    await broker.sweep(); assert.equal(vault.values.size, 0)
    await app.query('UPDATE agent_runs SET "stopRequestedAt"=NULL WHERE id=$1', [runId])
    request = await create(); await submit(request)
    await app.query('UPDATE devices SET enabled=false WHERE id=$1', [deviceId])
    assert.equal((await app.query('SELECT state FROM credential_requests WHERE id=$1', [request.id])).rows[0].state, 'disconnected')
    await broker.sweep(); assert.equal(vault.values.size, 0)
    await app.query('UPDATE devices SET enabled=true WHERE id=$1', [deviceId])
  })
  await t.test('Linux Chromium controlled page: browser path fails closed before any vault write or DOM fill', async () => {
    const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] })
    try {
      const context = await browser.newContext()
      const page = await context.newPage()
      await page.goto(`${origin}/test-page`)
      await context.addCookies(alice.cookie.split('; ').map(pair => ({ name: pair.slice(0, pair.indexOf('=')), value: pair.slice(pair.indexOf('=') + 1), url: origin })))
      const puts = vault.puts
      const status = await page.evaluate(async ({ workspaceId, runId }) => {
        const response = await fetch('/api/credential-requests', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Mikka-Credential': '1' }, body: JSON.stringify({ workspaceId, runId, serviceId: 'fixture', mode: 'browser_login' }) })
        return { status: response.status, body: await response.json() }
      }, { workspaceId, runId })
      assert.deepEqual(status, { status: 501, body: { error: 'browser_isolation_unavailable' } })
      assert.equal(await page.locator('#password').inputValue(), '')
      assert.equal(vault.puts, puts)
    } finally { await browser.close() }
  })
  await t.test('owned Chromium: real HTTP secret submission, exclusive isolation, real fill/submit/site verification, destroy and restore', async () => {
    const executor = new OwnedChromiumExecutor({ executablePath: '/usr/bin/chromium', loopbackFixture: true, policies: ['fixture-browser', 'fixture-browser-other'].map(id => ({
      id, formURL: `${origin}/credential-login`, submitURL: `${origin}/credential-login-submit`, successURL: `${origin}/credential-login-ok`,
      secretSelector: '#credential', submitSelector: '#submit', verifiedSelector: '[data-fixture-verified=true]',
    })) })
    const ownedBroker = new CredentialBroker({ pool: app, vault, authority, services: new Map(), browser: executor })
    const principal = { ownerId: alice.id, authSessionId: alice.sessionId }
    const expected = { ...binding, serviceId: 'fixture-browser' }
    await executor.open(binding)
    activeHandler = credentialHttp({ broker: ownedBroker, origin, authenticate: async request => {
      const session = await auth.api.getSession({ headers: request.headers })
      return session ? { ownerId: session.user.id, authSessionId: session.session.id } : null
    } })
    const createBrowserRequest = async () => {
      const response = await call('', { workspaceId, runId, serviceId: 'fixture-browser', mode: 'browser_login' })
      assert.equal(response.status, 201, await response.clone().text())
      return response.json()
    }
    try {
      let request = await createBrowserRequest()
      await assert.rejects(ownedBroker.create(principal, { workspaceId, runId, serviceId: 'fixture-browser-other', mode: 'browser_login' }), { code: 'credential_request_exists' })
      assert.equal((await submit(request)).status, 200)
      const before = browserSubmissions, block = gate(); vault.readGate = block
      const postBlock = gate(); browserPostGate = postBlock
      const priorScreenshot = executor.screenshot(binding)
      const using = ownedBroker.use(request.id, expected); await block.entered
      assert.ok((await priorScreenshot).length > 0)
      assert.deepEqual(executor.state(binding), { phase: 'isolated', fenced: true })
      for (let agent = 0; agent < 2; agent++) {
        await assert.rejects(executor.readDOM(binding), { code: 'browser_isolation_locked' })
        await assert.rejects(executor.screenshot(binding), { code: 'browser_isolation_locked' })
        await assert.rejects(executor.click(binding, '#submit'), { code: 'browser_isolation_locked' })
        assert.throws(() => executor.rawCDP(binding), { code: 'browser_raw_access_forbidden' })
        assert.throws(() => executor.record(binding), { code: 'browser_raw_access_forbidden' })
      }
      await assert.rejects(executor.readDOM({ ...binding, executionSession: randomUUID() }), { code: 'browser_session_not_found' })
      block.release(); await postBlock.entered
      // The real password has now been filled and POSTed; observers remain fenced in this window.
      await assert.rejects(executor.readDOM(binding), { code: 'browser_isolation_locked' })
      await assert.rejects(executor.screenshot(binding), { code: 'browser_isolation_locked' })
      await assert.rejects(executor.click(binding, '#submit'), { code: 'browser_isolation_locked' })
      postBlock.release(); browserPostGate = undefined
      assert.deepEqual(await using, { result: 'site_policy_verified', cleanup: 'isolated_context_destroyed', phase: 'restored' }); vault.readGate = undefined
      assert.equal(browserSubmissions, before + 1)
      assert.deepEqual(executor.state(binding), { phase: 'restored', fenced: false })
      const restoredDOM = await executor.readDOM(binding)
      assert.ok(!restoredDOM.includes(fixture)); assert.ok(!restoredDOM.includes('fixture-verified'))
      assert.ok((await executor.screenshot(binding)).length > 0)
      assert.equal((await ownedBroker.get(principal, request.id)).state, 'consumed')
      assert.equal(vault.values.size, 0)
      assert.ok(!JSON.stringify(executor.events()).includes(fixture))

      request = await createBrowserRequest(); await submit(request)
      browserFailSubmit = true
      await assert.rejects(ownedBroker.use(request.id, expected), { code: 'browser_execution_failed' })
      browserFailSubmit = false
      assert.equal(executor.state(binding).phase, 'restored')
      assert.ok(!(await executor.readDOM(binding)).includes(fixture))
      assert.equal(vault.values.size, 0)

      request = await createBrowserRequest(); await submit(request)
      const cancelBlock = gate(); vault.readGate = cancelBlock
      const cancellingUse = ownedBroker.use(request.id, expected); await cancelBlock.entered
      const submissions = browserSubmissions
      await call(`/${request.id}/cancel`, {})
      cancelBlock.release(); await assert.rejects(cancellingUse, { code: 'credential_request_gone' }); vault.readGate = undefined
      assert.equal(browserSubmissions, submissions)
      assert.throws(() => executor.state(binding), { code: 'browser_session_not_found' })
      assert.equal(vault.values.size, 0)
      await assert.rejects(executor.readDOM(binding), { code: 'browser_session_not_found' })
    } finally {
      vault.readGate = undefined; browserPostGate?.release(); browserPostGate = undefined; browserFailSubmit = false; activeHandler = handler
      await executor.end(binding)
    }
  })
  await t.test('owned Chromium bounded keyboard fallback keeps the fence; invalid target hands off only after cleanup', async () => {
    const probe = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] })
    const probePage = await probe.newPage(); await probePage.setContent('<input type="password">')
    const probeTarget = await probePage.locator('input').elementHandle(); assert.ok(probeTarget)
    const prototype = Object.getPrototypeOf(probeTarget) as ElementHandle
    const originalFill = prototype.fill, originalType = prototype.type
    let interruptDirect = true, keyboardCalls = 0
    const typing = gate()
    const executor = new OwnedChromiumExecutor({ executablePath: '/usr/bin/chromium', loopbackFixture: true, policies: [{
      id: 'fixture-fallback', formURL: `${origin}/credential-login`, submitURL: `${origin}/credential-login-submit`, successURL: `${origin}/credential-login-ok`,
      secretSelector: '#credential', submitSelector: '#submit', verifiedSelector: '[data-fixture-verified=true]',
    }] })
    const fallbackBroker = new CredentialBroker({ pool: app, vault, authority, services: new Map(), browser: executor })
    const principal = { ownerId: alice.id, authSessionId: alice.sessionId }, expected = { ...binding, serviceId: 'fixture-fallback' }
    prototype.fill = async function(value, options) {
      if (interruptDirect && (await this.ownerFrame())?.url() === `${origin}/credential-login`) { interruptDirect = false; throw new Error('Synthetic direct-fill interruption') }
      return originalFill.call(this, value, options)
    }
    prototype.type = async function(value, options) {
      if ((await this.ownerFrame())?.url() === `${origin}/credential-login`) { keyboardCalls++; typing.start(); await typing.blocked }
      return originalType.call(this, value, options)
    }
    try {
      const request = await fallbackBroker.create(principal, { workspaceId, runId, serviceId: 'fixture-fallback', mode: 'browser_login' })
      await fallbackBroker.submit(principal, request.id, { nonce: request.nonce, secret: fixture, save: false })
      const using = fallbackBroker.use(request.id, expected); await typing.entered
      await assert.rejects(executor.readDOM(binding), { code: 'browser_isolation_locked' })
      await assert.rejects(executor.screenshot(binding), { code: 'browser_isolation_locked' })
      await assert.rejects(executor.click(binding, '#submit'), { code: 'browser_isolation_locked' })
      typing.release(); await using
      assert.equal(interruptDirect, false); assert.equal(keyboardCalls, 1)
      await executor.end(binding)
      browserReadonly = true
      const handoff = await fallbackBroker.create(principal, { workspaceId, runId, serviceId: 'fixture-fallback', mode: 'browser_login' })
      await fallbackBroker.submit(principal, handoff.id, { nonce: handoff.nonce, secret: fixture, save: false })
      const reads = vault.reads, submissions = browserSubmissions
      await assert.rejects(fallbackBroker.use(handoff.id, expected), { code: 'browser_handoff_required' })
      assert.equal((await fallbackBroker.get(principal, handoff.id)).state, 'handoff_required')
      assert.equal(vault.reads, reads); assert.equal(browserSubmissions, submissions); assert.equal(vault.values.size, 0)
      await assert.rejects(executor.readDOM(binding), { code: 'browser_session_not_found' })
    } finally {
      typing.release(); prototype.fill = originalFill; prototype.type = originalType; browserReadonly = false
      await executor.end(binding); await probe.close()
    }
  })
  await t.test('owned Chromium replacement-launch fault quarantines all reads after original process destruction', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mikka-credential-launch-fixture-'))
    const executablePath = join(directory, 'chromium')
    await symlink('/usr/bin/chromium', executablePath)
    const executor = new OwnedChromiumExecutor({ executablePath, loopbackFixture: true, policies: [{
      id: 'fixture-browser-quarantine', formURL: `${origin}/credential-login`, submitURL: `${origin}/credential-login-submit`, successURL: `${origin}/credential-login-ok`,
      secretSelector: '#credential', submitSelector: '#submit', verifiedSelector: '[data-fixture-verified=true]',
    }] })
    const isolatedBroker = new CredentialBroker({ pool: app, vault, authority, services: new Map(), browser: executor })
    const principal = { ownerId: alice.id, authSessionId: alice.sessionId }
    await executor.open(binding)
    const request = await isolatedBroker.create(principal, { workspaceId, runId, serviceId: 'fixture-browser-quarantine', mode: 'browser_login' })
    await isolatedBroker.submit(principal, request.id, { nonce: request.nonce, secret: fixture, save: false })
    try {
      // Actual executable removal makes replacement launch fail; no fake browser/cleanup method.
      await unlink(executablePath)
      await assert.rejects(isolatedBroker.use(request.id, { ...binding, serviceId: 'fixture-browser-quarantine' }), { code: 'browser_cleanup_quarantined' })
      assert.throws(() => executor.state(binding), { code: 'browser_session_not_found' })
      await assert.rejects(executor.readDOM(binding), { code: 'browser_session_not_found' })
      await assert.rejects(executor.screenshot(binding), { code: 'browser_session_not_found' })
      assert.equal(executor.policy('fixture-browser-quarantine', binding), undefined)
      assert.equal((await isolatedBroker.get(principal, request.id)).state, 'failed')
      assert.equal(vault.values.size, 0)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
  await t.test('retained task login: protected read after scrub/unlock, identity refusal, completion/cancel/TTL cleanup', async () => {
    const executor = new OwnedChromiumExecutor({ executablePath: '/usr/bin/chromium', loopbackFixture: true, sessionTTLms: 2000, policies: [{
      id: 'fixture-retained', formURL: `${origin}/credential-login`, submitURL: `${origin}/credential-login-submit`, successURL: `${origin}/credential-login-ok`,
      secretSelector: '#credential', submitSelector: '#submit', verifiedSelector: '[data-fixture-verified=true]',
      continuation: { accountURL: `${origin}/credential-account`, accountSelector: '[data-fixture-account]', cookieName: 'fixture-browser-session', pages: [
        { id: 'account', url: `${origin}/credential-account`, regions: [{ id: 'summary', selector: '[data-fixture-account]' }], links: [{ id: 'projects', selector: '#projects', pageId: 'projects' }] },
        { id: 'projects', url: `${origin}/credential-projects`, regions: [{ id: 'items', selector: '[data-project-list]' }, { id: 'boundary', selector: '[data-boundary]' }] },
      ] },
    }] })
    const retainedBroker = new CredentialBroker({ pool: app, vault, authority, services: new Map(), browser: executor })
    const principal = { ownerId: alice.id, authSessionId: alice.sessionId }, expected = { ...binding, serviceId: 'fixture-retained' }
    activeHandler = credentialHttp({ broker: retainedBroker, origin, authenticate: async request => {
      const session = await auth.api.getSession({ headers: request.headers })
      return session ? { ownerId: session.user.id, authSessionId: session.session.id } : null
    } })
    const prepare = async () => {
      // Each positive scenario represents a still-running device. Earlier real
      // Chromium fault cases can outlast the production heartbeat/lease TTLs.
      // Refresh only at scenario entry; stale-authority cases above stay strict.
      await app.query('UPDATE devices SET "lastSeenAt"=now() WHERE id=$1', [deviceId])
      await app.query("UPDATE agent_runs SET \"leaseExpiresAt\"=now()+interval '90 seconds' WHERE id=$1", [runId])
      await executor.open(binding)
      const response = await call('', { workspaceId, runId, serviceId: 'fixture-retained', mode: 'browser_login' })
      assert.equal(response.status, 201)
      const request = await response.json()
      assert.equal((await submit(request)).status, 200)
      return request
    }
    try {
      assert.equal((await fetch(`${origin}/credential-account`)).status, 403)
      let request = await prepare()
      await assert.rejects(executor.readProtected(binding, 'fixture-retained', request.id, async () => true), { code: 'browser_not_authenticated' })
      const block = gate(); vault.readGate = block
      const using = retainedBroker.use(request.id, expected); await block.entered
      await assert.rejects(executor.readProtected(binding, 'fixture-retained', request.id, async () => true), { code: 'browser_isolation_locked' })
      await assert.rejects(executor.taskAction(binding, 'fixture-retained', request.id, { type: 'navigate', pageId: 'projects' }, async () => true), { code: 'browser_isolation_locked' })
      block.release(); const receipt = await using; vault.readGate = undefined
      assert.ok('cleanup' in receipt && receipt.cleanup === 'password_context_destroyed_auth_retained')
      assert.deepEqual(executor.state(binding), { phase: 'restored', fenced: false })
      assert.equal((await retainedBroker.get(principal, request.id)).state, 'active_session')
      assert.equal(vault.values.size, 0)
      for (const wrong of [{ ownerId: bob.id }, { taskId: randomUUID() }, { workspaceId: randomUUID() }, { executionSession: randomUUID() }]) {
        await assert.rejects(retainedBroker.continueBrowser(request.id, { ...expected, ...wrong }), { code: 'credential_not_found' })
      }
      await assert.rejects(executor.readDOM(binding), { code: 'browser_restricted_session' })
      await assert.rejects(executor.screenshot(binding), { code: 'browser_restricted_session' })
      assert.deepEqual(await retainedBroker.continueBrowser(request.id, expected), { accountId: 'ACCOUNT-42' })
      assert.deepEqual(await retainedBroker.continueBrowser(request.id, expected, { type: 'click', targetId: 'projects' }), { pageId: 'projects' })
      assert.ok(JSON.stringify(await retainedBroker.continueBrowser(request.id, expected, { type: 'read', regionId: 'items' })) === JSON.stringify({ pageId: 'projects', text: 'Project Alpine: ready for review. Session: [REDACTED]' }), 'protected business text returned with rotated cookie redacted')
      assert.deepEqual(await retainedBroker.continueBrowser(request.id, expected, { type: 'read', regionId: 'boundary' }), { pageId: 'projects', text: 'x'.repeat(4090) + '[REDAC' })
      assert.deepEqual(await retainedBroker.continueBrowser(request.id, expected, { type: 'navigate', pageId: 'account' }), { pageId: 'account' })
      // Old terminal request tombstones must not destroy the currently authenticated reference.
      await retainedBroker.sweep()
      assert.deepEqual(await retainedBroker.continueBrowser(request.id, expected), { accountId: 'ACCOUNT-42' })
      // Task finish and two independent lifecycle signals share one destruction.
      const [finished] = await Promise.all([
        retainedBroker.finishBrowser(request.id, expected),
        executor.end(binding, request.id), executor.end(binding, request.id),
      ])
      assert.equal(finished.state, 'consumed')
      await assert.rejects(retainedBroker.continueBrowser(request.id, expected), { code: 'credential_request_gone' })
      assert.throws(() => executor.state(binding), { code: 'browser_session_not_found' })

      request = await prepare(); await retainedBroker.use(request.id, expected)
      await call(`/${request.id}/cancel`, {})
      await assert.rejects(retainedBroker.continueBrowser(request.id, expected), { code: 'credential_request_gone' })
      assert.throws(() => executor.state(binding), { code: 'browser_session_not_found' })

      request = await prepare(); await retainedBroker.use(request.id, expected)
      await new Promise(resolve => setTimeout(resolve, 2300))
      await assert.rejects(retainedBroker.continueBrowser(request.id, expected), { code: 'credential_request_gone' })
      assert.throws(() => executor.state(binding), { code: 'browser_session_not_found' })
      assert.equal((await retainedBroker.get(principal, request.id)).state, 'expired')

      request = await prepare(); await retainedBroker.use(request.id, expected)
      await app.query("UPDATE agent_runs SET status='succeeded' WHERE id=$1", [runId])
      await retainedBroker.sweep()
      await assert.rejects(retainedBroker.continueBrowser(request.id, expected), { code: 'credential_request_gone' })
      assert.throws(() => executor.state(binding), { code: 'browser_session_not_found' })
      await app.query("UPDATE agent_runs SET status='running' WHERE id=$1", [runId])
      assert.equal(vault.values.size, 0)

      const previousDirectories = new Set(await readdir(tmpdir()))
      request = await prepare(); await retainedBroker.use(request.id, expected)
      const ownedDirectories = (await readdir(tmpdir())).filter(name => name.startsWith('mikka-credential-browser-') && !previousDirectories.has(name))
      assert.equal(ownedDirectories.length, 1)
      const profileDirectory = join(tmpdir(), ownedDirectories[0])
      await chmod(profileDirectory, 0)
      try {
        await assert.rejects(retainedBroker.finishBrowser(request.id, expected), { code: 'browser_cleanup_quarantined' })
        assert.deepEqual(executor.state(binding), { phase: 'quarantined', fenced: true })
        await assert.rejects(executor.readDOM(binding), { code: 'browser_isolation_locked' })
      } finally { await chmod(profileDirectory, 0o700) }
      await retainedBroker.sweep()
      assert.throws(() => executor.state(binding), { code: 'browser_session_not_found' })
    } finally {
      activeHandler = handler; vault.readGate = undefined
      await executor.end(binding)
    }
  })
})

test('Infisical v4 adapter contract: synthetic transport only, scope, no redirects, sanitized failures', async () => {
  const ref = randomUUID(), seen: { url: URL; init: RequestInit }[] = []
  let failure = false
  const vault = new InfisicalCredentialVault({ origin: 'https://us.infisical.com', projectId: 'fixture-project', environment: 'fixture', secretPath: '/credential-fixtures', accessToken: async () => 'synthetic-machine-identity-token', fetch: (async (input, init) => {
    seen.push({ url: new URL(String(input)), init: init! })
    if (failure) return Response.json({ echoed: fixture }, { status: 500 })
    return init?.method === 'GET' ? Response.json({ secret: { secretValue: fixture } }) : new Response('', { status: 200 })
  }) as typeof fetch })
  await vault.put(ref, fixture); assert.ok(await vault.read(ref) === fixture); await vault.remove(ref)
  assert.equal(seen[0].url.pathname, `/api/v4/secrets/MIKKA_CREDENTIAL_${ref.replaceAll('-', '')}`)
  assert.deepEqual(JSON.parse(String(seen[0].init.body)), { projectId: 'fixture-project', environment: 'fixture', secretPath: '/credential-fixtures', type: 'shared', secretValue: fixture, skipMultilineEncoding: true })
  assert.equal(seen[1].url.searchParams.get('expandSecretReferences'), 'false')
  assert.equal(seen[1].url.searchParams.get('projectId'), 'fixture-project')
  assert.ok(seen.every(c => c.init.redirect === 'error' && c.init.cache === 'no-store'))
  failure = true
  await assert.rejects(vault.read(ref), error => error instanceof CredentialError && error.message === 'vault_unavailable' && !('cause' in error))
  assert.throws(() => credentialServices(JSON.stringify([{ id: 'bad', endpoint: 'http://127.0.0.1/x', header: 'Authorization', method: 'GET', prefix: '' }])), { code: 'service_configuration_invalid' })
  assert.throws(() => assertBrowserIsolationTransition('filled', 'restored'), /browser_isolation_transition_rejected/)
})
