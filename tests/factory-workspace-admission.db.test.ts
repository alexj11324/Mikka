import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import test, { mock } from 'node:test'
import { Pool } from 'pg'
import { normalizeRepository } from '@mikka/protocol/repository'
import type { FactoryTask } from '../lib/factory/store'
import type { FactoryBinding } from '../lib/factory/contract'
import { enterprisePrincipal } from '../lib/enterprise/principal'
import { disposableDatabase } from './helpers/e2e-target.mjs'
import { orderMigrations } from '../scripts/migration-order.mjs'
import { dropTestDatabase } from './support/drop-test-database'
import { connectGitHub, githubAppStub } from './support/github-app-stub'

const target = process.env.E2E_DATABASE_URL
const allowed = !!target && disposableDatabase(process.env, target)
if (process.env.REQUIRE_DB === '1' && !allowed) throw new Error('Factory admission tests require isolated loopback *_e2e targets')
const code = (error: unknown): string | undefined => error && typeof error === 'object'
  ? 'code' in error && typeof error.code === 'string' ? error.code : 'cause' in error ? code(error.cause) : undefined : undefined

test('human Factory admission holds Workspace before APP and reuses Profile membership with both pools at one', { skip: !allowed, timeout: 180_000 }, async t => {
  const admin = new Pool({ connectionString: target, max: 1 })
  const database = 'factory_workspace_' + randomUUID().replaceAll('-', '') + '_e2e'
  await admin.query('CREATE DATABASE "' + database + '" TEMPLATE template0')
  const isolated = new URL(target!); isolated.pathname = '/' + database
  const url = isolated.toString()
  const controls = new Pool({ connectionString: url, max: 1 })
  const app = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 3000, options: '-c statement_timeout=10000 -c lock_timeout=3000' })
  const workspace = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 3000, options: '-c statement_timeout=10000 -c lock_timeout=3000' })
  const globals = globalThis as unknown as { mikkaPool?: Pool; workspacePool?: Pool }
  const oldPools = { app: globals.mikkaPool, workspace: globals.workspacePool }
  const environment = { E2E_DATABASE_URL: process.env.E2E_DATABASE_URL, MIKKA_DATABASE_URL: process.env.MIKKA_DATABASE_URL,
    DATABASE_URL: process.env.DATABASE_URL, BETTER_AUTH_URL: process.env.BETTER_AUTH_URL, BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
    MIKKA_EDITION: process.env.MIKKA_EDITION, MIKKA_BYOS_ENABLED: process.env.MIKKA_BYOS_ENABLED,
    NEXT_PUBLIC_POSTHOG_KEY: process.env.NEXT_PUBLIC_POSTHOG_KEY, WORKSPACE_SECRETS_KEY: process.env.WORKSPACE_SECRETS_KEY }
  const origin = 'http://localhost:3100'
  Object.assign(process.env, { E2E_DATABASE_URL: url, MIKKA_DATABASE_URL: url, DATABASE_URL: url, MIKKA_EDITION: 'cloud',
    MIKKA_BYOS_ENABLED: '1', NEXT_PUBLIC_POSTHOG_KEY: '', BETTER_AUTH_URL: origin,
    BETTER_AUTH_SECRET: randomBytes(32).toString('hex'), WORKSPACE_SECRETS_KEY: randomBytes(32).toString('hex') })
  globals.mikkaPool = app; globals.workspacePool = workspace
  let github: ReturnType<typeof githubAppStub> | undefined
  let flushWakes: (() => Promise<void>) | undefined
  let clearSwitches: (() => void) | undefined
  t.after(async () => {
    await flushWakes?.()
    github?.restore(); mock.restoreAll(); clearSwitches?.()
    globals.mikkaPool = oldPools.app; globals.workspacePool = oldPools.workspace
    await dropTestDatabase(admin, database, app, workspace, controls)
    await admin.end()
    for (const [key, value] of Object.entries(environment)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  assert.equal(Math.floor(Number((await controls.query('SHOW server_version_num')).rows[0].server_version_num) / 10000), 17)
  const directory = new URL('../drizzle/', import.meta.url)
  for (const name of orderMigrations((await readdir(directory)).filter(name => name.endsWith('.sql')))) {
    await controls.query(await readFile(new URL(name, directory), 'utf8'))
  }
  const context = await import('../apps/api/src/context')
  const framework = await import('next/headers')
  mock.module('next/headers', { namedExports: { ...framework,
    headers: async () => context.requireRequestScope().headers,
    cookies: async () => context.requireRequestScope().cookies,
  } })
  const next = await import('next/server')
  mock.module('next/server', { namedExports: { ...next, after: (work: () => unknown) => context.requireRequestScope().after.add(work) } })
  const locale = await import('next-intl/server')
  mock.module('next-intl/server', { namedExports: { ...locale, getLocale: async () => 'en',
    getTranslations: async () => Object.assign((key: string) => key, { has: () => true }) } })
  // Only the external GitHub wire and background consumer are fixtures.
  // Native authentication, SQL, queue admission, Profile and COMMIT are real.
  let unexpectedNetwork = 0
  mock.method(globalThis, 'fetch', async () => { unexpectedNetwork++; throw new Error('Unexpected external provider call in Factory admission test') })
  github = githubAppStub()
  const { isolateCoordinatorWakes } = await import('./support/coordinator-wake')
  const wakes = await isolateCoordinatorWakes(t); flushWakes = wakes.flush
  const { overrideDeploymentSwitch } = await import('../lib/deployment-switches')
  for (const name of ['factoryRouting', 'factoryLifecycle', 'issueTools', 'byos'] as const) overrideDeploymentSwitch(name, true)
  clearSwitches = () => { for (const name of ['factoryRouting', 'factoryLifecycle', 'issueTools', 'byos'] as const) overrideDeploymentSwitch(name, undefined) }

  const owner = 'factory-lease-' + randomUUID(), stranger = 'factory-stranger-' + randomUUID()
  const personal = randomUUID(), alpha = randomUUID(), beta = randomUUID()
  for (const id of [owner, stranger]) await controls.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,\'Factory fixture\',$2,true,now(),now())', [id, id + '@example.invalid'])
  for (const [id, kind, createdAt] of [[personal, 'personal', '2020-01-03T00:00:00.000Z'], [alpha, 'team', '2020-01-01T00:00:00.000Z'], [beta, 'team', '2020-01-02T00:00:00.000Z']]) {
    await controls.query('INSERT INTO mikka_workspaces(id,"userId",name,kind,"createdAt") VALUES($1,$2,\'Factory fixture\',$3,$4)', [id, owner, kind, createdAt])
    await controls.query('INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) VALUES($1,$2,\'Factory fixture\',$3,\'admin\',\'active\')', [id, owner, owner + '@example.invalid'])
  }
  const { auth } = await import('../lib/auth')
  const native = await (await auth.$context).internalAdapter.createSession(owner); assert.ok(native)
  const { getApiSession } = await import('../lib/api-auth')
  const { actAs } = await import('../lib/acting-user')
  const { withTaskWorkspace, borrowTaskWorkspaceMembership, taskReaderScope } = await import('../lib/task-workspace')
  const { withFactoryMembership, withFactoryWorkspace, factoryWorkspaceReader } = await import('../lib/factory/workspace-reader')
  const { withProjectResourceLease, requireProjectResourceLease } = await import('../lib/project-resources/store')
  const { acquireProfileMembership } = await import('../lib/factory/agent-profile-store')
  const { pool, withDatabaseClient } = await import('../lib/db')
  const { factoryHumanStore } = await import('../lib/factory/server')
  const intake = await import('../app/api/factory/tasks/route/route')
  const tasks = await import('../app/api/factory/tasks/route')
  const detail = await import('../app/api/factory/tasks/[taskId]/route')
  const flow = await import('../app/api/factory/tasks/[taskId]/flow/route')
  const status = await import('../app/api/factory/tasks/[taskId]/dispatch/route')
  const approval = await import('../app/api/factory/tasks/[taskId]/approval/route')
  const questions = await import('../app/api/factory/questions/route')
  const question = await import('../app/api/factory/questions/[questionId]/route')
  const workspaceSettings = await import('../app/api/workspace/route')
  const profiles = await import('../app/api/factory/agent-profiles/route')
  const profileDetail = await import('../app/api/factory/agent-profiles/[profileId]/route')
  type Handler = (request: Request) => Promise<Response>
  const request = (path: string, workspaceId: string, body?: unknown, bearer = native.token) => new Request(origin + '/mikka' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: 'Bearer ' + bearer, 'x-mikka-workspace-id': workspaceId, origin, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const run = async <T,>(req: Request, handler: (request: Request) => Promise<T>): Promise<T> => {
    const scope = context.createRequestScope(req)
    try { return await context.runRequestScope(scope, () => handler(req)) }
    finally { await scope.after.finish() }
  }
  const call = (path: string, workspaceId: string, handler: Handler, body?: unknown, bearer?: string) => run(request(path, workspaceId, body, bearer), handler)
  const verifiedSession = await run(request('/api/factory/tasks', alpha), req => getApiSession({ headers: req.headers, query: { disableCookieCache: true } }))
  assert.ok(verifiedSession)
  const session = verifiedSession
  assert.equal(session.user[enterprisePrincipal]?.kind, 'session')
  const params = (taskId: string) => ({ params: Promise.resolve({ taskId }) })
  const state = async () => (await controls.query(`SELECT
    (SELECT coalesce(jsonb_agg(jsonb_build_array(id,revision,status,"attemptId","candidateId") ORDER BY id),'[]') FROM factory_tasks WHERE "userId"=$1) AS tasks,
    (SELECT coalesce(jsonb_agg(jsonb_build_array(a.id,a.status,a."runId",a.output) ORDER BY a.id),'[]') FROM factory_attempts a JOIN factory_tasks t ON t.id=a."taskId" WHERE t."userId"=$1) AS attempts,
    (SELECT count(*)::int FROM factory_events e JOIN factory_tasks t ON t.id=e."taskId" WHERE t."userId"=$1) AS events,
    (SELECT count(*)::int FROM agent_runs WHERE "userId"=$1) AS runs,
    (SELECT count(*)::int FROM issue_versions WHERE "userId"=$1) AS history,
    (SELECT coalesce(jsonb_agg(jsonb_build_array(id,revision,status,"continuationRunId","answerId") ORDER BY id),'[]') FROM factory_questions WHERE "userId"=$1) AS questions`, [owner])).rows[0]
  await t.test('a session without a Workspace selector uses Personal for settings, Profile catalog and creation even when Teams are older', async t => {
    const unselected = (path: string, handler: Handler, body?: unknown) => {
      const req = new Request(origin + '/mikka' + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { authorization: 'Bearer ' + native.token, origin, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      assert.equal(req.headers.get('x-mikka-workspace-id'), null)
      assert.equal(req.headers.get('cookie'), null)
      return run(req, handler)
    }
    const selected = await unselected('/api/workspace', workspaceSettings.GET)
    assert.equal(selected.status, 200)
    const settings = await selected.json() as { currentUserId: string; workspace: { id: string; kind: string }; choices: Array<{ id: string }> }
    assert.equal(settings.currentUserId, owner)
    assert.deepEqual(settings.choices.map(choice => choice.id), [alpha, beta, personal])
    assert.equal(settings.workspace.id, personal)
    assert.equal(settings.workspace.kind, 'personal')
    t.diagnostic('The real Workspace API selected owned Personal for the selector-free native session after two older Teams.')

    const path = '/api/factory/agent-profiles?workspaceId=' + settings.workspace.id
    const listed = await unselected(path, profiles.GET)
    assert.equal(listed.status, 200, 'Profile and catalog must use the Personal selected by the real Workspace API')
    type Profile = { id: string; version: number; model: { mode: string } }
    const initial = await listed.json() as { profiles: Profile[]; catalog: { models: unknown[]; skills: unknown[] } }
    assert.deepEqual(initial.profiles, [])
    assert.ok(Array.isArray(initial.catalog.models))
    assert.ok(Array.isArray(initial.catalog.skills))

    const profileId = randomUUID()
    const created = await unselected(path, profiles.POST, {
      workspaceId: settings.workspace.id, requestId: profileId,
      profile: { name: 'Personal default profile', harness: 'auto', model: { mode: 'inherit' }, roles: [], skills: [],
        instructions: 'A management fixture only; do not dispatch a model or task.' },
    })
    assert.equal(created.status, 201)
    const body = await created.json() as { profile: Profile }
    assert.equal(body.profile.id, profileId)
    assert.equal(body.profile.version, 1)
    assert.deepEqual(body.profile.model, { mode: 'inherit' })
    assert.deepEqual((await controls.query('SELECT id,"ownerId","workspaceId",version FROM factory_agent_profiles WHERE id=$1', [profileId])).rows,
      [{ id: profileId, ownerId: owner, workspaceId: personal, version: 1 }])
    const readback = await unselected(path, profiles.GET)
    assert.equal(readback.status, 200)
    const saved = await readback.json() as { profiles: Profile[] }
    assert.deepEqual(saved.profiles.map(profile => profile.id), [profileId])
    assert.deepEqual(saved.profiles[0].model, { mode: 'inherit' })
    assert.equal(app.totalCount, 1); assert.equal(workspace.totalCount, 1)
    assert.equal(unexpectedNetwork, 0)
  })

  let taskNumber = 0
  const createTask = async (workspaceId: string) => {
    const issueId = randomUUID(), sourceEventId = randomUUID()
    const content = { type: 'doc', attrs: { mikka: { number: ++taskNumber } }, content: [] }
    await controls.query('INSERT INTO issues(id,"userId","workspaceId","ownershipState",scope,title,content,status,priority) VALUES($1,$2,$3,\'bound\',\'workspace\',\'Factory lease fixture\',$4,\'todo\',\'normal\')', [issueId, owner, workspaceId, JSON.stringify(content)])
    await controls.query('INSERT INTO coordinator_events(id,"userId","issueId",kind,"dedupeKey",payload) VALUES($1::uuid,$2,$3,\'user_message\',$1::text,\'{"text":"Prepare a bounded fixture change"}\')', [sourceEventId, owner, issueId])
    const response = await call('/api/factory/tasks/route', workspaceId, intake.POST, { issueId, sourceEventId, eventId: randomUUID(), rationale: 'Verify real admission', needsSpec: false })
    const body = await response.json() as { task: FactoryTask; binding: FactoryBinding; error?: string }
    assert.equal(response.status, 200, JSON.stringify(body))
    assert.equal(body.task.workspaceId, workspaceId)
    return { issueId, sourceEventId, task: body.task, binding: body.binding }
  }
  const a = await createTask(alpha), b = await createTask(beta)

  await t.test('actual task, flow, dispatch-status, approval and questions adapters reject another owned tenant', async () => {
    const before = await state()
    for (const [suffix, handler] of [['', detail.GET], ['/flow', flow.GET], ['/dispatch', status.GET], ['/approval', approval.GET]] as const) {
      const response = await call('/api/factory/tasks/' + b.task.id + suffix, alpha, req => handler(req, params(b.task.id)))
      assert.equal(response.status, 404, suffix || 'detail')
      assert.deepEqual(await response.json(), { error: 'factoryNotFound' })
    }
    const listed = await call('/api/factory/tasks?issueId=' + b.issueId, alpha, tasks.GET)
    assert.equal(listed.status, 404)
    const questionList = await call('/api/factory/questions?taskId=' + b.task.id, alpha, questions.GET)
    assert.equal(questionList.status, 404)
    const dispatched = await call('/api/factory/tasks', alpha, tasks.POST, { binding: b.binding, agentId: randomUUID(), deviceRepoId: randomUUID() })
    assert.equal(dispatched.status, 404)
    assert.deepEqual(await state(), before)
    for (const [suffix, handler] of [['', detail.GET], ['/flow', flow.GET]] as const) {
      assert.equal((await call('/api/factory/tasks/' + a.task.id + suffix, alpha, req => handler(req, params(a.task.id)))).status, 200)
    }
    assert.equal(app.totalCount, 1); assert.equal(workspace.totalCount, 1)
  })

  await t.test('the actual Factory task list retains membership through its read without an execution resource lease or writes', async () => {
    const before = await state()
    const originalList = factoryHumanStore.listForIssue.bind(factoryHumanStore)
    let borrowed: ReturnType<typeof borrowTaskWorkspaceMembership> | undefined
    // Observe the real store result inside the HTTP admission. Authorization,
    // its APP transaction and every SQL query still use production code.
    const observed = mock.method(factoryHumanStore, 'listForIssue', async (...args: Parameters<typeof originalList>) => {
      const result = await originalList(...args)
      assert.equal(args[0], owner); assert.equal(args[1], a.issueId)
      const reader = await factoryWorkspaceReader(owner)
      if (typeof reader === 'string') assert.fail('task discovery must retain its verified principal')
      assert.equal(reader[enterprisePrincipal]?.kind, 'session')
      assert.equal(taskReaderScope(reader).workspaceId, alpha)
      borrowed = borrowTaskWorkspaceMembership(owner, alpha)
      assert.ok(borrowed)
      await borrowed.check()
      assert.throws(() => requireProjectResourceLease(owner, alpha), error => code(error) === 'projectEnvironmentUnavailable')
      const writer = await controls.connect()
      try {
        await writer.query('BEGIN')
        assert.equal((await writer.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired',
          ['project-resources:' + alpha])).rows[0].acquired, true, 'discovery does not hold the execution resource lock')
        await writer.query("SET LOCAL lock_timeout='100ms'")
        await assert.rejects(writer.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2', [alpha, owner]), error => code(error) === '55P03')
      } finally { await writer.query('ROLLBACK'); writer.release() }
      return result
    })
    try {
      const response = await call('/api/factory/tasks?issueId=' + a.issueId, alpha, tasks.GET)
      assert.equal(response.status, 200)
      const body = await response.json()
      assert.equal(body.liveWorkspaceId, alpha)
      assert.deepEqual(body.tasks.map((task: { id: string }) => task.id), [a.task.id])
      assert.equal(observed.mock.callCount(), 1)
      assert.deepEqual(await state(), before)
      assert.ok(borrowed)
      await assert.rejects(borrowed.check(), error => code(error) === 'workspaceAccessDenied')
      assert.equal(app.totalCount, 1); assert.equal(workspace.totalCount, 1)
    } finally { observed.mock.restore() }
  })

  await t.test('the initial cookie choice and full native principal stay fixed for the whole handler', async () => {
    const req = new Request(origin + '/mikka/api/factory/tasks', { headers: { authorization: 'Bearer ' + native.token, cookie: 'mikka-workspace=' + alpha } })
    const scope = context.createRequestScope(req)
    await context.runRequestScope(scope, () => actAs(session.user, () => withFactoryWorkspace(owner, async () => {
      scope.cookies.set('mikka-workspace', beta)
      const reader = await factoryWorkspaceReader(owner)
      assert.notEqual(typeof reader, 'string')
      assert.equal(taskReaderScope(reader).workspaceId, alpha)
      if (typeof reader === 'string') assert.fail('human reader must retain its principal')
      assert.equal(reader[enterprisePrincipal], session.user[enterprisePrincipal])
      requireProjectResourceLease(owner, alpha)
      assert.equal((await factoryHumanStore.read(owner, a.task.id)).task.id, a.task.id)
      await assert.rejects(factoryHumanStore.read(owner, b.task.id), error => code(error) === 'factoryNotFound')
    })))
    await scope.after.finish()
  })

  await t.test('the human adapter holds the resource lease before APP for spec approval and acceptance consumers', async () => {
    const req = request('/api/factory/tasks/' + a.task.id + '/flow', alpha)
    await run(req, () => actAs(session.user, () => withFactoryWorkspace(owner, async () => {
      requireProjectResourceLease(owner, alpha)
      const tx = await pool.connect()
      try {
        await tx.query('BEGIN')
        await withDatabaseClient(tx, () => withProjectResourceLease(session.user, alpha, async () => {
          assert.equal((await tx.query('SELECT 1 AS present')).rows[0].present, 1)
        }, true))
        const writer = await controls.connect()
        try {
          await writer.query('BEGIN')
          assert.equal((await writer.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired',
            ['project-resources:' + alpha])).rows[0].acquired, false, 'configuration cannot change while the human mutation owns APP')
        } finally { await writer.query('ROLLBACK'); writer.release() }
        await tx.query('COMMIT')
      } catch (error) { await tx.query('ROLLBACK'); throw error }
      finally { tx.release() }
    })))
    assert.throws(() => requireProjectResourceLease(owner, alpha), error => code(error) === 'projectEnvironmentUnavailable')
    assert.equal(app.totalCount, 1); assert.equal(workspace.totalCount, 1)
  })

  await t.test('Profile management pins the verified membership without granting a Project execution lease', async () => {
    const req = request('/api/factory/agent-profiles?workspaceId=' + alpha, alpha)
    let borrowed: ReturnType<typeof borrowTaskWorkspaceMembership> | undefined
    await run(req, () => actAs(session.user, () => withFactoryMembership(owner, async () => {
      const reader = await factoryWorkspaceReader(owner)
      if (typeof reader === 'string') assert.fail('Profile management must retain its principal')
      assert.equal(reader[enterprisePrincipal], session.user[enterprisePrincipal])
      assert.equal(taskReaderScope(reader).workspaceId, alpha)
      borrowed = borrowTaskWorkspaceMembership(owner, alpha)
      assert.ok(borrowed)
      await borrowed.check()
      assert.throws(() => borrowTaskWorkspaceMembership(owner, beta), error => code(error) === 'workspaceAccessDenied')
      assert.throws(() => requireProjectResourceLease(owner, alpha), error => code(error) === 'projectEnvironmentUnavailable')
      const writer = await controls.connect()
      try {
        await writer.query('BEGIN')
        assert.equal((await writer.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired',
          ['project-resources:' + alpha])).rows[0].acquired, true, 'Profile management does not serialize Project configuration')
        await writer.query("SET LOCAL lock_timeout='100ms'")
        await assert.rejects(writer.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2', [alpha, owner]), error => code(error) === '55P03')
      } finally { await writer.query('ROLLBACK'); writer.release() }
    })))
    assert.ok(borrowed)
    await assert.rejects(borrowed.check(), error => code(error) === 'workspaceAccessDenied')
    assert.equal(app.totalCount, 1); assert.equal(workspace.totalCount, 1)
  })

  await t.test('Profile borrows are exact, cannot close their owner, and expire after nested rollback or return', async () => {
    let afterReturn: Awaited<ReturnType<typeof acquireProfileMembership>> | undefined
    await withTaskWorkspace(session.user, alpha, async () => {
      const first = await acquireProfileMembership({ ownerId: owner, workspaceId: alpha })
      const other = await acquireProfileMembership({ ownerId: owner, workspaceId: alpha })
      await first.check(); await first.close(); await other.check()
      await assert.rejects(first.check(), error => code(error) === 'agentProfileScopeNotFound')
      await assert.rejects(acquireProfileMembership({ ownerId: owner, workspaceId: beta }), error => code(error) === 'agentProfileScopeNotFound')
      await assert.rejects(acquireProfileMembership({ ownerId: stranger, workspaceId: alpha }), error => code(error) === 'agentProfileScopeNotFound')
      const writer = await controls.connect()
      try {
        await writer.query('BEGIN'); await writer.query("SET LOCAL lock_timeout='100ms'")
        await assert.rejects(writer.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2', [alpha, owner]), error => code(error) === '55P03')
      } finally { await writer.query('ROLLBACK'); writer.release() }
      let rolledBack: Awaited<ReturnType<typeof acquireProfileMembership>> | undefined
      await assert.rejects(withTaskWorkspace(session.user, alpha, async () => {
        rolledBack = await acquireProfileMembership({ ownerId: owner, workspaceId: alpha })
        await rolledBack.check()
        throw new Error('fixture nested rollback')
      }), /fixture nested rollback/)
      assert.ok(rolledBack)
      await assert.rejects(rolledBack.check(), error => code(error) === 'agentProfileScopeNotFound')
      await other.check()
      afterReturn = other
    })
    assert.ok(afterReturn)
    await assert.rejects(afterReturn.check(), error => code(error) === 'agentProfileScopeNotFound')
    assert.equal(borrowTaskWorkspaceMembership(owner, alpha), null)
    const fresh = await acquireProfileMembership({ ownerId: owner, workspaceId: alpha })
    try { await fresh.check() } finally { await fresh.close() }
    assert.equal(workspace.totalCount, 1)
  })

  // A waiting request starts outside the writer's ALS. Observe only the real
  // pool checkout attempt; neither authorization nor any SQL result is faked.
  async function behindWorkspaceWriter(req: Request, handler: Handler) {
    const acquired = Promise.withResolvers<void>(), proceed = Promise.withResolvers<void>(), queued = Promise.withResolvers<void>()
    const connect = workspace.connect.bind(workspace) as (...args: unknown[]) => unknown
    const observe = mock.method(workspace, 'connect', ((...args: unknown[]) => {
      if (context.currentRequestScope()?.request === req) queued.resolve()
      return connect(...args)
    }) as Pool['connect'])
    const writer = withTaskWorkspace(session.user, alpha, async () => {
      acquired.resolve(); await proceed.promise
      await pool.query('UPDATE issues SET title=\'Serialized writer\' WHERE id=$1', [a.issueId])
    })
    await acquired.promise
    const reading = run(req, handler)
    try {
      await Promise.race([
        queued.promise,
        reading.then(() => { throw new Error('Request completed before Workspace admission') }),
      ])
      proceed.resolve()
      const [, response] = await Promise.all([writer, reading])
      assert.equal(app.totalCount, 1); assert.equal(workspace.totalCount, 1)
      return response
    } finally {
      proceed.resolve(); await Promise.allSettled([writer, reading]); observe.mock.restore()
    }
  }

  await t.test('a real detail request cannot reserve APP while a writer owns the only Workspace connection', async () => {
    const response = await behindWorkspaceWriter(request('/api/factory/tasks/' + a.task.id, alpha), req => detail.GET(req, params(a.task.id)))
    assert.equal(response.status, 200)
    assert.equal((await controls.query('SELECT title FROM issues WHERE id=$1', [a.issueId])).rows[0].title, 'Serialized writer')
  })

  const repository = 'octo/factory-lease', githubAccount = '97411324'
  github.install(repository, { contents: 'write', pull_requests: 'write' }); github.allowWriter(repository, githubAccount)
  await controls.query('INSERT INTO account(id,"accountId","providerId","userId","createdAt","updatedAt") VALUES($1,$2,\'github\',$3,now(),now())', [randomUUID(), githubAccount, owner])
  await connectGitHub(github, owner, githubAccount, [repository])
  await controls.query('INSERT INTO repository_settings("userId","remoteKey",push) VALUES($1,$2,$3)', [owner, normalizeRepository(repository).key, JSON.stringify({ approved: true, remote: 'origin', approvedByUserId: owner, approvedAt: new Date().toISOString() })])
  const deviceId = randomUUID(), agentId = randomUUID(), repoId = randomUUID(), connectionId = randomUUID()
  const model = 'gpt-6-luna'
  await controls.query('INSERT INTO devices(id,"ownerId",name,kind,"deviceType",enabled,"lastSeenAt",harnesses) VALUES($1,$2,\'Factory local fixture\',\'local\',\'server\',true,now(),$3)', [deviceId, owner, JSON.stringify([{ harness: 'codex', installed: true, subscriptionBroker: true, models: [model] }])])
  await controls.query('INSERT INTO agents(id,"userId",harness,name,"deviceId") VALUES($1,$2,\'codex\',\'Factory local fixture\',$3)', [agentId, owner, deviceId])
  await controls.query('INSERT INTO device_repos(id,"deviceId","userId","repoPath","remoteUrl","baseBranch") VALUES($1,$2,$3,$4,$5,\'main\')', [repoId, deviceId, owner, normalizeRepository(repository).key, 'https://github.com/' + repository + '.git'])
  await controls.query('INSERT INTO byos_connections(id,"ownerId","workspaceId",provider,state,epoch,"secretName","secretDigest","providerSubject","modelCatalog",quota) VALUES($1,$2,$3,\'codex\',\'connected\',1,$4,$5,\'synthetic-subject\',$6,$7)', [
    connectionId, owner, alpha, 'synthetic-' + connectionId, 'a'.repeat(64), JSON.stringify({ revision: '1', models: [model] }),
    JSON.stringify({ vendor: 'codex', source: 'official', status: 'ok', plan: 'Pro', observedAt: new Date().toISOString(), windows: [{ kind: 'five_hour', used: .1, resetsAt: null }] }),
  ])
  await controls.query('INSERT INTO byos_bindings(id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision",route,"modelId") VALUES($1,$2,$3,\'catalogue\',$4,1,\'codex_cpa\',$5)', [randomUUID(), owner, alpha, connectionId, model])
  await controls.query('INSERT INTO byos_bindings(id,"ownerId","workspaceId","consumerId","connectionId","connectionRevision",route,"modelId") VALUES($1,$2,$3,$4,$5,1,\'codex_cli\',$6)', [randomUUID(), owner, alpha, agentId, connectionId, model])
  const definition = { name: 'Bounded implementer', description: 'Only a queue fixture; no model or CLI is started.', roles: ['execute'], harness: 'codex',
    model: { mode: 'fixed', harness: 'codex', model, source: { kind: 'subscription', connectionId } }, instructions: 'Retain the explicit tenant.', skills: [] }
  const profileResponse = await call('/api/factory/agent-profiles?workspaceId=' + alpha, alpha, profiles.POST, { workspaceId: alpha, profile: definition })
  const profileBody = await profileResponse.json() as { profile: { id: string; version: number; digest: string }; error?: string }
  assert.equal(profileResponse.status, 201, JSON.stringify(profileBody))
  const profile = profileBody.profile

  await t.test('Profile body and query cannot select another owned Workspace', async () => {
    const before = (await controls.query('SELECT id,version,digest FROM factory_agent_profiles WHERE "ownerId"=$1 ORDER BY id', [owner])).rows
    const changed = await call('/api/factory/agent-profiles?workspaceId=' + beta, alpha, profiles.POST, { workspaceId: beta, profile: { ...definition, name: 'Must not exist' } })
    assert.equal(changed.status, 404)
    const listed = await call('/api/factory/agent-profiles?workspaceId=' + beta, alpha, profiles.GET)
    assert.equal(listed.status, 404)
    const read = await call('/api/factory/agent-profiles/' + profile.id + '?workspaceId=' + beta, alpha, req => profileDetail.GET(req, { params: Promise.resolve({ profileId: profile.id }) }))
    assert.equal(read.status, 404)
    assert.deepEqual((await controls.query('SELECT id,version,digest FROM factory_agent_profiles WHERE "ownerId"=$1 ORDER BY id', [owner])).rows, before)
    const same = await call('/api/factory/agent-profiles/' + profile.id + '?workspaceId=' + alpha, alpha, req => profileDetail.GET(req, { params: Promise.resolve({ profileId: profile.id }) }))
    assert.equal(same.status, 200)
    assert.equal((await same.json()).profile.id, profile.id)
  })

  let dispatchedRun: string
  await t.test('real dispatch, frozen Profile and idempotent COMMIT share both one-connection pools', async () => {
    const input = { binding: a.binding, agentId, deviceRepoId: repoId, profileId: profile.id }
    const response = await behindWorkspaceWriter(request('/api/factory/tasks', alpha, input), tasks.POST)
    const result = await response.json() as { runId: string; replayed: boolean; error?: string }
    assert.equal(response.status, 201, JSON.stringify(result))
    assert.equal(result.replayed, false); dispatchedRun = result.runId
    const saved = (await controls.query('SELECT "workspaceId","agentDefinition",status FROM agent_runs WHERE id=$1', [dispatchedRun])).rows[0]
    assert.equal(saved.workspaceId, alpha); assert.equal(saved.status, 'queued')
    assert.equal(saved.agentDefinition.agentProfile.profileId, profile.id)
    assert.equal(saved.agentDefinition.agentProfile.digest, profile.digest)
    assert.equal(saved.agentDefinition.executionIdentity.workspaceId, alpha)
    const replay = await call('/api/factory/tasks', alpha, tasks.POST, input)
    assert.equal(replay.status, 200)
    const repeated = await replay.json()
    assert.equal(repeated.runId, dispatchedRun); assert.equal(repeated.replayed, true)
    assert.equal((await controls.query('SELECT count(*)::int AS count FROM agent_runs WHERE "issueId"=$1', [a.issueId])).rows[0].count, 1)
    assert.equal(app.totalCount, 1); assert.equal(workspace.totalCount, 1)
    assert.equal(unexpectedNetwork, 0)
  })

  await t.test('a committed revocation rejects reads and dispatch with no task, run or history side effects', async () => {
    const before = await state()
    const profilesBefore = (await controls.query('SELECT id,version,digest FROM factory_agent_profiles WHERE "ownerId"=$1 ORDER BY id', [owner])).rows
    await controls.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2', [alpha, owner])
    try {
      assert.equal((await call('/api/factory/tasks/' + a.task.id, alpha, req => detail.GET(req, params(a.task.id)))).status, 404)
      assert.equal((await call('/api/factory/tasks?issueId=' + a.issueId, alpha, tasks.GET)).status, 404)
      assert.equal((await call('/api/factory/tasks', alpha, tasks.POST, { binding: a.binding, agentId, deviceRepoId: repoId, profileId: profile.id })).status, 404)
      assert.equal((await call('/api/factory/agent-profiles?workspaceId=' + alpha, alpha, profiles.GET)).status, 404)
      assert.equal((await call('/api/factory/agent-profiles?workspaceId=' + alpha, alpha, profiles.POST,
        { workspaceId: alpha, profile: { ...definition, name: 'Revoked member must not create' } })).status, 404)
      assert.deepEqual(await state(), before)
      assert.deepEqual((await controls.query('SELECT id,version,digest FROM factory_agent_profiles WHERE "ownerId"=$1 ORDER BY id', [owner])).rows, profilesBefore)
    } finally { await controls.query('UPDATE mikka_workspace_members SET status=\'active\' WHERE "workspaceId"=$1 AND "userId"=$2', [alpha, owner]) }
    assert.equal((await call('/api/factory/tasks/' + b.task.id, beta, req => detail.GET(req, params(b.task.id)))).status, 200)
  })

  await t.test('a PAT cannot override its pin and concurrent same-issue reads never cross tenant buckets', async () => {
    const { createPersonalAccessToken } = await import('../lib/tokens/store')
    const pat = await createPersonalAccessToken(owner, alpha, { name: 'Factory lease PAT' })
    const before = await state()
    const profilesBefore = (await controls.query('SELECT id,version,digest FROM factory_agent_profiles WHERE "ownerId"=$1 ORDER BY id', [owner])).rows
    assert.equal((await call('/api/factory/tasks/' + b.task.id, beta, req => detail.GET(req, params(b.task.id)), undefined, pat.token)).status, 404)
    assert.equal((await call('/api/factory/tasks?issueId=' + b.issueId, beta, tasks.GET, undefined, pat.token)).status, 404)
    const pinnedList = await call('/api/factory/tasks?issueId=' + a.issueId, alpha, tasks.GET, undefined, pat.token)
    assert.equal(pinnedList.status, 200)
    assert.equal((await pinnedList.json()).tasks[0].id, a.task.id)
    assert.equal((await call('/api/factory/agent-profiles?workspaceId=' + beta, beta, profiles.GET, undefined, pat.token)).status, 404)
    assert.equal((await call('/api/factory/agent-profiles?workspaceId=' + beta, beta, profiles.POST,
      { workspaceId: beta, profile: { ...definition, name: 'Pinned PAT must not create' } }, pat.token)).status, 404)
    assert.equal((await call('/api/factory/agent-profiles?workspaceId=' + alpha, alpha, profiles.GET, undefined, pat.token)).status, 200)
    const [own, other] = await Promise.all([
      call('/api/factory/tasks?issueId=' + a.issueId, alpha, tasks.GET),
      call('/api/factory/tasks?issueId=' + a.issueId, beta, tasks.GET),
    ])
    assert.equal(own.status, 200); assert.equal(other.status, 404)
    assert.equal((await own.json()).tasks[0].id, a.task.id)
    assert.deepEqual(await state(), before)
    assert.deepEqual((await controls.query('SELECT id,version,digest FROM factory_agent_profiles WHERE "ownerId"=$1 ORDER BY id', [owner])).rows, profilesBefore)
  })

  await t.test('one Alpha question survives 51 newer Beta questions before the pending cap', async () => {
    const makeQuestion = async (task: typeof a, workspaceId: string, createdAt: Date) => {
      const runId = randomUUID(), id = randomUUID(), nativeId = 'question-' + randomUUID()
      await controls.query('INSERT INTO agent_runs(id,"userId","workspaceId","issueId","agentId",status,"stopReason","sessionId") VALUES($1,$2,$3,$4,$5,\'stopped\',\'asked_human\',$6)', [runId, owner, workspaceId, task.issueId, agentId, nativeId])
      await controls.query('INSERT INTO factory_questions(id,"userId","issueId","taskId","attemptId","candidateId",stage,"originRunId","originSessionId","originRevision","waitingBinding",kind,question,request,status,reason,"sourceEventId","createdAt") VALUES($1,$2,$3,$4,$5,NULL,\'execute\',$6,$7,1,$8,\'decision\',\'Synthetic question\',\'{}\',\'open\',\'Synthetic isolation fixture\',$9,$10)', [id, owner, task.issueId, task.task.id, task.task.attemptId, runId, nativeId, JSON.stringify(task.binding), task.sourceEventId, createdAt])
      return id
    }
    const alphaQuestion = await makeQuestion(a, alpha, new Date(Date.now() - 10000))
    for (let index = 0; index < 51; index++) await makeQuestion(b, beta, new Date(Date.now() + index))
    const before = await state()
    const response = await call('/api/factory/questions', alpha, questions.GET)
    assert.equal(response.status, 200)
    assert.deepEqual((await response.json()).questions.map((item: { questionId: string }) => item.questionId), [alphaQuestion])
    const foreign = await call('/api/factory/questions/' + alphaQuestion, beta, req => question.GET(req, { params: Promise.resolve({ questionId: alphaQuestion }) }))
    assert.equal(foreign.status, 404)
    assert.deepEqual(await state(), before)
    assert.equal(unexpectedNetwork, 0)
  })
})
