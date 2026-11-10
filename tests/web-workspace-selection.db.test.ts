import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import test, { mock } from 'node:test'
import pg from 'pg'
import { serve } from 'srvx/node'
import { createApiHandler } from '../apps/api/src/application'
import { createWebTransport } from '../lib/web-connection/transport'
import { OFFICIAL_WEB_URL } from '../lib/web-connection/policy'
import { WORKSPACE_SELECTION_HEADER } from '../lib/workspace-selection'
import { withBasePath } from '../lib/base-path'
import { decode, encode } from '../lib/desktop-rpc/wire'
import { disposableDatabase } from './helpers/e2e-target.mjs'
import { seedFixtureWorkspace } from './helpers/task-workspace'

const appUrl = process.env.MIKKA_DATABASE_URL ?? process.env.E2E_DATABASE_URL
const workspaceUrl = process.env.DATABASE_URL ?? appUrl
const enabled = Boolean(appUrl && workspaceUrl && disposableDatabase(process.env, appUrl, workspaceUrl))
if (process.env.REQUIRE_DB === '1' && !enabled) throw new Error('Web Workspace HTTP tests require loopback *_e2e application and Workspace databases')
const officialOrigin = new URL(OFFICIAL_WEB_URL).origin
type Session = { token: string; cookie: string; userId: string }
type CreatedIssue = { issue?: { id: string; workspaceId: string }; error?: string }
type PayloadBarrier = { issueId: string; reached(): void; resume: Promise<void>; armed: boolean }

test('remote Web Workspace selection survives bearer-only HTTP and never broadens a tenant or PAT', { skip: !enabled, timeout: 120_000 }, async t => {
  const oldEnvironment = { BETTER_AUTH_URL: process.env.BETTER_AUTH_URL, NODE_ENV: process.env.NODE_ENV,
    MIKKA_DATABASE_URL: process.env.MIKKA_DATABASE_URL, DATABASE_URL: process.env.DATABASE_URL }
  // This is the ordinary development HTTP ingress, with real Better Auth and
  // PostgreSQL. Its only configured databases have passed the target guard.
  Object.assign(process.env, { NODE_ENV: 'development' })
  process.env.MIKKA_DATABASE_URL = appUrl
  process.env.DATABASE_URL = workspaceUrl
  let application: ReturnType<typeof createApiHandler> | undefined
  const runtime = serve({ manual: true, gracefulShutdown: false, silent: true, trustProxy: false,
    fetch: request => { assert.ok(application); return application.fetch(request) },
  })
  const server: Server = createServer(runtime.node!.handler)
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  const origin = `http://127.0.0.1:${address.port}`
  process.env.BETTER_AUTH_URL = origin
  // These are the same aliases as the API build, not session/permission mocks.
  const framework = [
    mock.module('next/headers', { namedExports: await import('../apps/api/compat/headers') }),
    mock.module('next-intl/server', { namedExports: await import('../apps/api/compat/intl') }),
  ]
  // Keep authentication, Workspace/Bot resolution and message persistence
  // real; capture only the external Coordinator dispatch after its commit.
  const background = await import('../lib/background')
  const coordinatorWakes: Array<() => unknown> = []
  framework.push(mock.module(new URL('../lib/background.ts', import.meta.url).href, { namedExports: { ...background,
    afterJob: (...args: Parameters<typeof background.afterJob>) => {
      if (args[0] === 'after:coordinator-wake') { coordinatorWakes.push(args[1]); return }
      return background.afterJob(...args)
    },
  } }))
  let payloadBarrier: PayloadBarrier | undefined
  const query = pg.Client.prototype.query
  const queryProbe = mock.method(pg.Client.prototype, 'query', function (this: pg.Client, ...args: unknown[]) {
    const argument = args[0]
    const sql = typeof argument === 'string' ? argument : argument && typeof argument === 'object' && 'text' in argument ? String(argument.text) : ''
    const values = Array.isArray(args[1]) ? args[1] : []
    const barrier = payloadBarrier?.armed && sql.startsWith('SELECT t.*, c.') && sql.includes('FROM factory_tasks t JOIN issues i')
      && values[1] === payloadBarrier.issueId ? payloadBarrier : undefined
    if (barrier) barrier.armed = false
    const callback = args.at(-1)
    if (barrier && typeof callback === 'function') return Reflect.apply(query, this, [...args.slice(0, -1), (error: unknown, result: unknown) => {
      if (error) return callback(error, result)
      barrier.reached(); void barrier.resume.then(() => callback(error, result))
    }])
    const result: unknown = Reflect.apply(query, this, args)
    return barrier ? Promise.resolve(result).then(async value => { barrier.reached(); await barrier.resume; return value }) : result
  } as typeof query)
  // Observe the real coalescer after it has selected/started a flight. The
  // wrapper changes no result or authority; it makes the negative race exact.
  const flights = await import('../lib/single-flight')
  let factoryFlight: (() => void) | undefined
  const flightProbe = mock.module(new URL('../lib/single-flight.ts', import.meta.url).href, { namedExports: { ...flights,
    singleFlight: <T>(parts: readonly (string | number | boolean | null | undefined)[], read: () => Promise<T>) => {
      const result = flights.singleFlight(parts, read)
      if (parts[0] === '/api/factory/tasks') factoryFlight?.()
      return result
    },
  } })
  const { pool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  const { auth } = await import('../lib/auth')
  const users: string[] = [], tenants: string[] = []
  let releaseHeld: (() => void) | undefined
  try {
    const { routes } = await import('../apps/api/generated/routes')
    const paths = new Set(['/api/auth/[...all]', '/api/desktop/rpc', '/api/workspace', '/api/workspace/switcher',
      '/api/issues/search', '/api/factory/tasks', '/api/factory/tasks/[taskId]', '/api/mobile/threads'])
    const selected = routes.filter(route => paths.has(route.template)).map(route => ({ ...route, path: withBasePath(route.template) }))
    assert.equal(selected.length, paths.size, 'the test loads the real generated route modules')
    application = createApiHandler(selected, undefined, createWebTransport({
      authenticate: headers => auth.api.getSession({ headers, query: { disableCookieCache: true } }),
      scope: (_identity, work) => work(),
    }))
    async function login(label: string): Promise<Session> {
      const userId = `web-workspace-${label}-${randomUUID()}`, email = `${userId}@example.invalid`, password = randomBytes(32).toString('base64url')
      users.push(userId)
      await pool.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$1,$2,true,now(),now())', [userId, email])
      const context = await auth.$context
      await context.internalAdapter.createAccount({ userId, accountId: userId, providerId: 'credential', password: await context.password.hash(password) })
      const response = await fetch(`${origin}${withBasePath('/api/auth/sign-in/email')}`, { method: 'POST',
        headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) })
      assert.equal(response.status, 200, 'real HTTP email login succeeds')
      const body = await response.json() as { token?: string; user?: { id: string } }
      assert.equal(body.user?.id, userId); assert.ok(body.token)
      const cookie = response.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ')
      assert.ok(cookie, 'source login has its own real cookie')
      return { token: body.token, cookie, userId }
    }
    const owner = await login('owner'), outsider = await login('outsider')
    const personal = await seedFixtureWorkspace(workspacePool, owner.userId)
    const alpha = await seedFixtureWorkspace(workspacePool, owner.userId, 'team')
    const beta = await seedFixtureWorkspace(workspacePool, owner.userId, 'team')
    const foreign = await seedFixtureWorkspace(workspacePool, outsider.userId, 'team')
    const foreignPersonal = await seedFixtureWorkspace(workspacePool, outsider.userId)
    tenants.push(personal, alpha, beta, foreign, foreignPersonal)
    // Team governance rejects a foreign Personal member at the database edge.
    // The HTTP cases below still prove that selecting that tenant is denied.
    await assert.rejects(workspacePool.query(`INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) VALUES($1,$2,$2,$2,'member','active')`, [foreignPersonal, owner.userId]), { code: '23514' })
    const request = (path: string, workspaceId?: string, options: { token?: string; remote?: boolean; body?: unknown; cookie?: string } = {}) => fetch(`${origin}${withBasePath(path)}`, {
      method: options.body === undefined ? 'GET' : 'POST', redirect: 'error',
      headers: { origin: options.remote === false ? origin : officialOrigin, authorization: `Bearer ${options.token ?? owner.token}`,
        'content-type': 'application/json', 'x-mikka-desktop-protocol': '1', 'x-mikka-locale': 'en',
        ...(workspaceId === undefined ? {} : { [WORKSPACE_SELECTION_HEADER]: workspaceId }), ...(options.cookie ? { cookie: options.cookie } : {}) },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    })
    async function rpc<T>(action: string, args: unknown[], workspaceId?: string, options: { token?: string; remote?: boolean; cookie?: string } = {}) {
      const response = await request('/api/desktop/rpc', workspaceId, { ...options, body: { version: 1, action, args: encode(args) } })
      const body = await response.json() as { ok: boolean; result?: unknown; error?: { code: string } }
      return { response, ok: body.ok, result: body.ok ? decode(body.result) as T : undefined, error: body.error }
    }
    const newIssue = (title: string) => ({ title, content: { type: 'doc', content: [] }, status: 'todo', priority: 'normal' })
    const issueIds = new Map<string, string>(), taskIds = new Map<string, string>(), runIds = new Map<string, string>()
    const agentId = randomUUID()
    await pool.query(`INSERT INTO agents(id,"userId",harness,name) VALUES($1,$2,'codex','HTTP fixture')`, [agentId, owner.userId])
    const { factoryStore } = await import('../lib/factory/server')
    await t.test('Personal/A/B switches acknowledge only the validated choice; context, create, cache namespace and REST keep it', async () => {
      let selectedWorkspace: string | undefined
      for (const workspaceId of [personal, alpha, beta]) {
        const switched = await rpc<{ ok: boolean; data: { workspaceId: string } }>('workspace.switchWorkspace', [workspaceId], selectedWorkspace)
        assert.equal(switched.response.status, 200); assert.equal(switched.result?.ok, true)
        assert.equal(switched.response.headers.get(WORKSPACE_SELECTION_HEADER), workspaceId)
        assert.equal(switched.response.headers.has('set-cookie'), false, 'remote selection never carries an auth cookie')
        selectedWorkspace = switched.response.headers.get(WORKSPACE_SELECTION_HEADER)!
        const context = await request('/api/workspace', selectedWorkspace)
        assert.equal(context.status, 200)
        assert.equal((await context.json()).workspace.id, workspaceId)
        const switcher = await request('/api/workspace/switcher', selectedWorkspace)
        assert.equal(switcher.status, 200); assert.equal((await switcher.json()).workspace.id, workspaceId)
        const bootstrap = await rpc<{ cacheWorkspace: { workspaceId: string } }>('desktop.bootstrap', [], selectedWorkspace)
        assert.equal(bootstrap.response.status, 200); assert.equal(bootstrap.result?.cacheWorkspace.workspaceId, workspaceId)
        const created = await rpc<CreatedIssue>('issues.saveIssue', [newIssue(`Workspace HTTP ${workspaceId}`)], selectedWorkspace)
        assert.equal(created.response.status, 200); assert.ok(created.result?.issue)
        assert.equal(created.result.issue.workspaceId, workspaceId)
        const issueId = created.result.issue.id; issueIds.set(workspaceId, issueId)
        const sourceEventId = randomUUID()
        await pool.query(`INSERT INTO coordinator_events(id,"userId","issueId",kind,"dedupeKey",payload) VALUES($1::uuid,$2,$3,'user_message','web-workspace:'||$1::text,'{"text":"Synthetic HTTP fixture"}')`, [sourceEventId, owner.userId, issueId])
        const routed = await factoryStore.route(owner.userId, { issueId, eventId: randomUUID(), sourceEventId, rationale: 'Synthetic HTTP fixture' })
        assert.equal(routed.task.workspaceId, workspaceId); taskIds.set(workspaceId, routed.task.id)
        const runId = randomUUID(); runIds.set(workspaceId, runId)
        await pool.query(`INSERT INTO agent_runs(id,"userId","agentId","issueId","workspaceId",status,prompt) VALUES($1,$2,$3,$4,$5,'succeeded','Synthetic HTTP fixture')`, [runId, owner.userId, agentId, issueId, workspaceId])
      }
      for (const workspaceId of [personal, alpha, beta]) {
        const listed = await rpc<{ id: string }[]>('issues.listIssues', [], workspaceId)
        assert.equal(listed.response.status, 200); assert.deepEqual(listed.result?.map(item => item.id), [issueIds.get(workspaceId)])
        const detail = await rpc<CreatedIssue>('issues.getIssue', [issueIds.get(workspaceId)], workspaceId)
        assert.equal(detail.result?.issue?.id, issueIds.get(workspaceId))
        const search = await request('/api/issues/search?q=Workspace%20HTTP', workspaceId)
        assert.equal(search.status, 200); assert.deepEqual((await search.json()).items.map((item: { id: string }) => item.id), [issueIds.get(workspaceId)])
        const threads = await request('/api/mobile/threads', workspaceId)
        assert.equal(threads.status, 200); assert.deepEqual((await threads.json()).threads.map((item: { id: string }) => item.id), [runIds.get(workspaceId)])
      }
      const mismatchedCache = await rpc<{ cacheWorkspace: null }>('desktop.bootstrap', [beta], alpha)
      assert.equal(mismatchedCache.response.status, 200)
      assert.equal(mismatchedCache.result?.cacheWorkspace, null, 'an explicit target cannot relabel A data as a B disk namespace')
      const explicitTarget = await request(`/api/workspace?workspace=${beta}`, alpha)
      assert.equal(explicitTarget.status, 200); assert.equal((await explicitTarget.json()).workspace.id, beta)
      assert.equal(explicitTarget.headers.has(WORKSPACE_SELECTION_HEADER), false, 'an independent business read does not change the selected Workspace')
      const stillSelected = await request('/api/workspace', alpha)
      assert.equal((await stillSelected.json()).workspace.id, alpha)
      const rows = await pool.query('SELECT id,"workspaceId","ownershipState" FROM issues WHERE "userId"=$1', [owner.userId])
      assert.equal(rows.rowCount, 3)
      for (const row of rows.rows) { assert.equal(row.ownershipState, 'bound'); assert.equal(issueIds.get(row.workspaceId), row.id) }
    })
    const snapshot = async () => (await pool.query(`SELECT
      (SELECT count(*)::int FROM issues WHERE "userId"=$1) AS issues,
      (SELECT count(*)::int FROM issue_versions WHERE "userId"=$1) AS versions,
      (SELECT count(*)::int FROM agent_runs WHERE "userId"=$1) AS runs,
      (SELECT jsonb_agg(jsonb_build_array(id,"workspaceId",revision,status,stage) ORDER BY id) FROM factory_tasks WHERE "userId"=$1) AS tasks,
      (SELECT count(*)::int FROM factory_events e JOIN factory_tasks t ON t.id=e."taskId" WHERE t."userId"=$1) AS events`, [owner.userId])).rows[0]
    await t.test('a captured Coordinator workspace is checked before ensuring a Bot or writing an inbox event', async () => {
      const fresh = await seedFixtureWorkspace(workspacePool, owner.userId, 'team')
      tenants.push(fresh)
      const stored = async () => ({ ...await snapshot(), ...(await pool.query(`SELECT
        (SELECT jsonb_agg(jsonb_build_array(id,"workspaceId",name) ORDER BY id) FROM bots WHERE "ownerId"=$1) AS bots,
        (SELECT jsonb_agg(jsonb_build_array("workspaceId","botId") ORDER BY "workspaceId") FROM coordinator_bots WHERE "ownerId"=$1) AS coordinators,
        (SELECT jsonb_agg(jsonb_build_array(id,"botId","dedupeKey",payload,"issueId","runId") ORDER BY id) FROM coordinator_events WHERE "userId"=$1) AS inbox`, [owner.userId])).rows[0] })
      const before = await stored(), wakes = coordinatorWakes.length
      const submissionId = randomUUID(), text = 'Synthetic captured Workspace submission'
      const args = (expected: string, botId: string | null = null) => [text, null, botId, submissionId, undefined, undefined, undefined, undefined, undefined, expected]
      for (const [selected, expected] of [[beta, alpha], [fresh, alpha], [alpha, foreign]]) {
        const refused = await rpc<{ error?: string }>('coordinator.sendCoordinatorMessage', args(expected), selected)
        assert.equal(refused.response.status, 200); assert.equal(refused.ok, true)
        assert.equal(refused.result?.error, 'workspaceAccessDenied')
        assert.deepEqual(await stored(), before, 'the expectation never retargets or creates the selected Coordinator')
        assert.equal(coordinatorWakes.length, wakes)
      }
      assert.equal((await pool.query('SELECT 1 FROM coordinator_bots WHERE "ownerId"=$1 AND "workspaceId"=$2', [owner.userId, fresh])).rowCount, 0)

      const accepted = await rpc<{ queued?: boolean }>('coordinator.sendCoordinatorMessage', args(alpha.toUpperCase()), alpha)
      assert.equal(accepted.response.status, 200); assert.equal(accepted.result?.queued, true)
      const source = await pool.query(`SELECT e.id,e."botId",b."workspaceId",e.payload FROM coordinator_events e
        JOIN bots b ON b.id=e."botId" WHERE e."userId"=$1 AND e.payload->>'text'=$2`, [owner.userId, text])
      assert.equal(source.rowCount, 1); assert.equal(source.rows[0].workspaceId, alpha)
      const session = await auth.api.getSession({ headers: new Headers({ authorization: `Bearer ${owner.token}` }), query: { disableCookieCache: true } })
      assert.ok(session); assert.equal(session.user.id, owner.userId)
      assert.deepEqual(source.rows[0].payload, { text, source: 'person', humanSessionId: session.session.id }, 'the message retains authenticated audience/session provenance, not the client Workspace expectation')
      assert.equal(coordinatorWakes.length, wakes + 1)
      const recorded = await stored()
      const retryElsewhere = await rpc<{ error?: string }>('coordinator.sendCoordinatorMessage', args(alpha), beta)
      assert.equal(retryElsewhere.result?.error, 'workspaceAccessDenied')
      assert.deepEqual(await stored(), recorded); assert.equal(coordinatorWakes.length, wakes + 1)
      const retryOriginal = await rpc<{ queued?: boolean }>('coordinator.sendCoordinatorMessage', args(alpha), alpha)
      assert.equal(retryOriginal.result?.queued, true)
      assert.deepEqual(await stored(), recorded, 'retrying in the captured Workspace keeps the original event and Bot')
      const afterRetryWakes = coordinatorWakes.length
      const otherBot = await rpc<{ error?: string }>('coordinator.sendCoordinatorMessage', args(beta, source.rows[0].botId), beta)
      assert.equal(otherBot.result?.error, 'botNotFound', 'a matching expectation does not grant a same-owner foreign Bot')
      assert.deepEqual(await stored(), recorded); assert.equal(coordinatorWakes.length, afterRetryWakes)
    })
    await t.test('invalid, foreign and foreign-Personal choices fail closed; a query target cannot hide an invalid selection', async () => {
      const before = await snapshot()
      for (const workspaceId of ['', 'invalid', `${alpha}, ${beta}`, randomUUID(), foreign, foreignPersonal]) {
        assert.equal((await request('/api/workspace', workspaceId)).status, 403)
        assert.equal((await request(`/api/workspace?workspace=${personal}`, workspaceId)).status, 403)
        assert.equal((await request('/api/issues/search?q=Workspace', workspaceId)).status, 403)
        const created = await rpc<CreatedIssue>('issues.saveIssue', [newIssue('Must not be inserted')], workspaceId)
        assert.equal(created.response.status, 403)
      }
      const accountChange = await rpc<{ ok: boolean }>('workspace.switchWorkspace', [{ accountId: outsider.userId, workspaceId: foreign }], alpha)
      assert.equal(accountChange.result?.ok, false)
      assert.equal(accountChange.response.headers.has(WORKSPACE_SELECTION_HEADER), false)
      const otherCookie = await request('/api/workspace', foreign, { cookie: outsider.cookie })
      assert.equal(otherCookie.status, 403, 'another native cookie cannot override the selected bearer')
      assert.deepEqual(await snapshot(), before)
    })
    await t.test('Factory list/detail and rejected control remain in the selected same-owner tenant with no write side effects', async () => {
      const before = await snapshot()
      for (const workspaceId of [personal, alpha, beta]) {
        const issueId = issueIds.get(workspaceId)!, taskId = taskIds.get(workspaceId)!
        const listed = await request(`/api/factory/tasks?issueId=${issueId}`, workspaceId)
        assert.equal(listed.status, 200); assert.deepEqual((await listed.json()).tasks.map((item: { id: string }) => item.id), [taskId])
        const own = await request(`/api/factory/tasks/${taskId}`, workspaceId)
        assert.equal(own.status, 200); const state = await own.json()
        const other = workspaceId === alpha ? beta : alpha
        assert.equal((await request(`/api/factory/tasks?issueId=${issueId}`, other)).status, 404)
        assert.equal((await request(`/api/factory/tasks/${taskId}`, other)).status, 404)
        const refused = await request(`/api/factory/tasks/${taskId}`, other, { body: { action: 'cancel', reason: 'Must remain unchanged', eventId: randomUUID(),
          binding: { taskId, revision: state.task.revision, issueId, attemptId: state.task.attemptId, candidateId: state.task.candidateId } } })
        assert.equal(refused.status, 404)
      }
      assert.deepEqual(await snapshot(), before)
    })
    await t.test('a pending Factory A list cannot be joined from B even when both belong to the same owner', async () => {
      const reached = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), attempted = Promise.withResolvers<void>()
      const issueId = issueIds.get(alpha)!, before = await snapshot(), joined = flights.singleFlightJoined()
      releaseHeld = release.resolve
      payloadBarrier = { issueId, armed: true, reached: reached.resolve, resume: release.promise }
      const first = request(`/api/factory/tasks?issueId=${issueId}`, alpha)
      try {
        await reached.promise
        factoryFlight = attempted.resolve
        const second = request(`/api/factory/tasks?issueId=${issueId}`, beta)
        // An isolated request either rejects itself or demonstrably reaches a
        // flight. No sleep or timing guess determines the race window.
        await Promise.race([second, attempted.promise])
        release.resolve()
        const [allowed, denied] = await Promise.all([first, second])
        assert.equal(allowed.status, 200); assert.equal(denied.status, 404)
        await allowed.arrayBuffer(); await denied.arrayBuffer()
        assert.equal(flights.singleFlightJoined(), joined, 'the denied tenant never joins the authorized flight')
        assert.deepEqual(await snapshot(), before)
      } finally { release.resolve(); releaseHeld = undefined; payloadBarrier = undefined; factoryFlight = undefined; await first.catch(() => undefined) }
    })
    await t.test('PAT selection cannot escape its pin; public Web transport never promotes a PAT to a human session', async () => {
      const { createPersonalAccessToken } = await import('../lib/tokens/store')
      const pat = await createPersonalAccessToken(owner.userId, alpha, { name: 'Synthetic HTTP Workspace PAT' })
      const before = await snapshot()
      assert.equal((await request('/api/workspace', alpha, { token: pat.token, remote: false })).status, 200)
      for (const workspaceId of [personal, beta, foreign]) {
        assert.equal((await request('/api/workspace', workspaceId, { token: pat.token, remote: false, cookie: owner.cookie })).status, 403)
        assert.equal((await request('/api/issues/search?q=Workspace', workspaceId, { token: pat.token, remote: false })).status, 403)
        assert.equal((await request(`/api/factory/tasks?issueId=${issueIds.get(alpha)}`, workspaceId, { token: pat.token, remote: false })).status, 404)
      }
      assert.equal((await request('/api/workspace', alpha, { token: pat.token })).status, 401)
      const switched = await rpc('workspace.switchWorkspace', [beta], alpha, { token: pat.token, remote: false, cookie: owner.cookie })
      assert.equal(switched.response.status, 401); assert.equal(switched.response.headers.has(WORKSPACE_SELECTION_HEADER), false)
      assert.deepEqual(await snapshot(), before)
    })
    await t.test('suspending a creator/member invalidates the selected tenant on the next request without defaulting Personal', async () => {
      const before = await snapshot()
      await workspacePool.query(`UPDATE mikka_workspace_members SET status='suspended' WHERE "workspaceId"=$1 AND "userId"=$2`, [alpha, owner.userId])
      assert.equal((await request('/api/workspace', alpha)).status, 403)
      assert.equal((await request('/api/issues/search?q=Workspace', alpha)).status, 403)
      const created = await rpc<CreatedIssue>('issues.saveIssue', [newIssue('Revoked creation')], alpha)
      assert.equal(created.response.status, 403)
      assert.equal((await request(`/api/factory/tasks?issueId=${issueIds.get(alpha)}`, alpha)).status, 404)
      assert.equal((await request(`/api/factory/tasks/${taskIds.get(alpha)}`, alpha)).status, 404)
      const recovery = await rpc<{ ok: boolean }>('workspace.switchWorkspace', [beta], alpha)
      assert.equal(recovery.result?.ok, true); assert.equal(recovery.response.headers.get(WORKSPACE_SELECTION_HEADER), beta)
      assert.equal((await request('/api/workspace', beta)).status, 200)
      assert.deepEqual(await snapshot(), before)
    })
    await t.test('a revoked native session cannot switch or recover authority from another browser cookie', async () => {
      const before = await snapshot()
      await (await auth.$context).internalAdapter.deleteSession(owner.token)
      assert.equal((await request('/api/workspace', beta, { cookie: outsider.cookie })).status, 401)
      const switched = await rpc('workspace.switchWorkspace', [beta], alpha, { cookie: outsider.cookie })
      assert.equal(switched.response.status, 401); assert.equal(switched.response.headers.has(WORKSPACE_SELECTION_HEADER), false)
      assert.deepEqual(await snapshot(), before)
    })
  } finally {
    releaseHeld?.()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await runtime.close()
    await pool.query('DELETE FROM "user" WHERE id=ANY($1::text[])', [users])
    await workspacePool.query('DELETE FROM mikka_workspaces WHERE id=ANY($1::uuid[])', [tenants])
    await Promise.all([pool.end(), workspacePool.end()])
    queryProbe.mock.restore(); flightProbe.restore(); for (const module of framework) module.restore()
    for (const [key, value] of Object.entries(oldEnvironment)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  }
})
