import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import test, { mock } from 'node:test'
import { serve } from 'srvx/node'
import { createApiHandler } from '../apps/api/src/application'
import { createWebTransport } from '../lib/web-connection/transport'
import { OFFICIAL_WEB_URL } from '../lib/web-connection/policy'
import { WORKSPACE_SELECTION_HEADER } from '../lib/workspace-selection'
import { withBasePath } from '../lib/base-path'
import { decode, encode } from '../lib/desktop-rpc/wire'
import { WORKSPACE_NAME } from '../components/workspace/issue-properties'
import { disposableDatabase } from './helpers/e2e-target.mjs'
import { seedFixtureWorkspace } from './helpers/task-workspace'

const appUrl = process.env.MIKKA_DATABASE_URL ?? process.env.E2E_DATABASE_URL
const workspaceUrl = process.env.DATABASE_URL ?? appUrl
const enabled = Boolean(appUrl && workspaceUrl && disposableDatabase(process.env, appUrl, workspaceUrl))
if (process.env.REQUIRE_DB === '1' && !enabled) throw new Error('Project Workspace HTTP tests require loopback *_e2e application and Workspace databases')
const officialOrigin = new URL(OFFICIAL_WEB_URL).origin

type Project = { id: string; revision: number; userId: string }
type ProjectEvent = { id: string; projectId: string; userId: string }
type ProjectTeam = { projectId: string; teamId: string; workspaceId: string }
type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string }

test('registered Project RPC reads and writes stay inside a native human session\'s selected Workspace', { skip: !enabled, timeout: 120_000 }, async t => {
  const oldEnvironment = { BETTER_AUTH_URL: process.env.BETTER_AUTH_URL, NODE_ENV: process.env.NODE_ENV,
    MIKKA_DATABASE_URL: process.env.MIKKA_DATABASE_URL, DATABASE_URL: process.env.DATABASE_URL }
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
  // Reuse the API build's framework adapters. Auth, registry/actions, request
  // Workspace selection, resource ACLs and both PostgreSQL pools remain real.
  const framework = [
    mock.module('next/headers', { namedExports: await import('../apps/api/compat/headers') }),
    mock.module('next-intl/server', { namedExports: await import('../apps/api/compat/intl') }),
  ]
  const { pool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  const { auth } = await import('../lib/auth')
  const users: string[] = [], tenants: string[] = []
  try {
    const { routes } = await import('../apps/api/generated/routes')
    const paths = new Set(['/api/auth/[...all]', '/api/desktop/rpc', '/api/workspace'])
    const selected = routes.filter(route => paths.has(route.template)).map(route => ({ ...route, path: withBasePath(route.template) }))
    assert.equal(selected.length, paths.size, 'load the actual generated route modules')
    application = createApiHandler(selected, undefined, createWebTransport({
      authenticate: headers => auth.api.getSession({ headers, query: { disableCookieCache: true } }),
      // Same outer scope as apps/api/src/index.ts. The generated native RPC
      // route installs its own verified session and principal scope.
      scope: (_identity, work) => work(),
    }))

    const userId = `project-workspace-${randomUUID()}`, email = `${userId}@example.invalid`, password = randomBytes(32).toString('base64url')
    users.push(userId)
    await pool.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$1,$2,true,now(),now())', [userId, email])
    const authContext = await auth.$context
    await authContext.internalAdapter.createAccount({ userId, accountId: userId, providerId: 'credential', password: await authContext.password.hash(password) })
    const signin = await fetch(`${origin}${withBasePath('/api/auth/sign-in/email')}`, { method: 'POST',
      headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) })
    // A failed login reports only its status. Never attach its body or headers.
    assert.equal(signin.status, 200, 'real HTTP email sign-in succeeds')
    const identity = await signin.json() as { token?: string; user?: { id: string } }
    assert.equal(identity.user?.id, userId); assert.ok(identity.token)
    const token = identity.token
    const personal = await seedFixtureWorkspace(workspacePool, userId)
    tenants.push(personal)
    const alpha = await seedFixtureWorkspace(workspacePool, userId, 'team')
    tenants.push(alpha)
    const beta = await seedFixtureWorkspace(workspacePool, userId, 'team')
    tenants.push(beta)

    let selectedWorkspace: string | undefined
    const request = (path: string, body?: unknown) => fetch(`${origin}${withBasePath(path)}`, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      headers: { origin: officialOrigin, authorization: `Bearer ${token}`, 'content-type': 'application/json',
        'x-mikka-desktop-protocol': '1', 'x-mikka-locale': 'en',
        ...(selectedWorkspace === undefined ? {} : { [WORKSPACE_SELECTION_HEADER]: selectedWorkspace }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    async function rpc<T>(action: string, args: unknown[]) {
      const response = await request('/api/desktop/rpc', { version: 1, action, args: encode(args) })
      const body = await response.json() as { ok: boolean; result?: unknown; error?: { code: string } }
      return { response, ok: body.ok, result: body.ok ? decode(body.result) as T : undefined, error: body.error }
    }
    async function switchTo(workspaceId: string) {
      const switched = await rpc<ActionResult<{ workspaceId: string }>>('workspace.switchWorkspace', [workspaceId])
      assert.equal(switched.response.status, 200); assert.equal(switched.ok, true)
      assert.equal(switched.result?.ok, true)
      assert.equal(switched.response.headers.get(WORKSPACE_SELECTION_HEADER), workspaceId)
      selectedWorkspace = switched.response.headers.get(WORKSPACE_SELECTION_HEADER)!
      const context = await request('/api/workspace')
      assert.equal(context.status, 200)
      assert.equal((await context.json()).workspace.id, workspaceId, 'canonical context confirms this request selection')
    }

    await switchTo(beta)
    const created = await rpc<{ project?: Project; error?: string }>('projects.saveProject', [{
      name: 'Selected Workspace Project fixture', summary: '', description: '', status: 'planned',
      priority: 'none', lead: '', team: WORKSPACE_NAME, startDate: '', targetDate: '',
    }])
    assert.equal(created.response.status, 200); assert.equal(created.ok, true)
    assert.ok(created.result?.project, 'the real Project action creates the B fixture and its resource ACL')
    const project = created.result.project
    const team = await rpc<ActionResult<{ id: string }>>('teams.saveTeam', [{
      workspaceId: beta, name: 'Selected Workspace Team fixture', identifier: 'PRJ', description: '',
    }])
    assert.equal(team.response.status, 200); assert.equal(team.ok, true)
    assert.ok(team.result?.ok, 'the real Team action creates the B fixture')
    const teamId = team.result.data.id
    const linked = await rpc<ActionResult<Project>>('team-relations.setProjectTeams', [{
      projectId: project.id, revision: project.revision, teamIds: [teamId], primaryTeamId: teamId,
    }])
    assert.equal(linked.response.status, 200); assert.equal(linked.ok, true)
    assert.ok(linked.result?.ok, 'link the B Team through the actual registered action')

    const snapshot = async () => ({
      project: (await workspacePool.query('SELECT id,revision,"issueIds" FROM workspace_projects WHERE id=$1', [project.id])).rows,
      events: (await workspacePool.query('SELECT id,"projectId",message FROM workspace_project_events WHERE "projectId"=$1 ORDER BY id', [project.id])).rows,
      links: (await workspacePool.query('SELECT "projectId","teamId","workspaceId","isPrimary" FROM mikka_team_projects WHERE "projectId"=$1 ORDER BY "teamId"', [project.id])).rows,
    })
    const before = await snapshot()
    assert.ok(before.events.length > 0)

    await t.test('selecting A does not reveal B Project events even when the human belongs to both', async () => {
      await switchTo(alpha)
      const listed = await rpc<Project[]>('projects.listProjects', [])
      assert.equal(listed.response.status, 200); assert.equal(listed.ok, true)
      assert.deepEqual(listed.result, [], 'the existing Project list already honors selected A')
      const events = await rpc<ProjectEvent[]>('projects.listProjectEvents', [project.id])
      if (events.ok) {
        assert.equal(events.response.status, 200)
        assert.deepEqual(events.result, [], 'a B Project id must not reveal its events in A')
      } else {
        // Preserve the current missing-Project error contract; this test does
        // not require a new HTTP status design. The B control below must work.
        const expectedCode = new Map<number, string>([
          [400, 'issueNotFound'], [403, 'workspaceAccessDenied'], [500, 'desktop_rpc_failed'],
        ]).get(events.response.status)
        assert.ok(expectedCode, 'use an existing native Project denial status')
        assert.equal(events.error?.code, expectedCode, 'preserve the actual native RPC status/code pairing')
      }
    })
    await t.test('selecting A omits B Project Team links for the same native session', async () => {
      await switchTo(alpha)
      const links = await rpc<ProjectTeam[]>('team-relations.listProjectTeams', [])
      assert.equal(links.response.status, 200); assert.equal(links.ok, true)
      assert.deepEqual(links.result, [], 'a same-user membership in B does not select B')
    })
    const revision = Number(before.project[0].revision)
    const fullProjectInput = { id: project.id, revision, name: 'Cross-Workspace mutation must be refused',
      summary: '', description: '', status: 'planned', priority: 'none', lead: '', team: WORKSPACE_NAME,
      startDate: '', targetDate: '' }
    const writes: Array<{ action: string; input: unknown }> = [
      { action: 'projects.saveProject', input: fullProjectInput },
      { action: 'projects.updateProjectProperties', input: { id: project.id, revision, changes: { name: fullProjectInput.name } } },
      { action: 'projects.setProjectIssues', input: { id: project.id, revision, issueIds: [] } },
      { action: 'team-relations.setProjectTeams', input: { projectId: project.id, revision, teamIds: [teamId], primaryTeamId: teamId } },
    ]
    for (const { action, input } of writes) await t.test(`selected A cannot write B through ${action}`, async () => {
      await switchTo(alpha)
      const result = await rpc<{ project?: Project; error?: string } | ActionResult<Project>>(action, [input])
      if (result.ok) {
        assert.equal(result.response.status, 200)
        assert.ok(result.result && ('error' in result.result && typeof result.result.error === 'string')
          && !('project' in result.result) && !('ok' in result.result && result.result.ok), 'the existing action returns an explicit denial')
      } else {
        const expectedCode = new Map<number, string>([[400, 'issueNotFound'], [403, 'workspaceAccessDenied']]).get(result.response.status)
        assert.ok(expectedCode, 'deny with an existing typed authorization error, not an internal failure')
        assert.equal(result.error?.code, expectedCode)
      }
      assert.deepEqual(await snapshot(), before, 'cross-Workspace writes leave revisions, events and Team links unchanged')
    })
    await t.test('switching that session to B returns its actual Project, events and Team link', async () => {
      await switchTo(beta)
      const listed = await rpc<Project[]>('projects.listProjects', [])
      assert.equal(listed.response.status, 200); assert.equal(listed.ok, true)
      assert.deepEqual(listed.result?.map(item => item.id), [project.id])
      const events = await rpc<ProjectEvent[]>('projects.listProjectEvents', [project.id])
      assert.equal(events.response.status, 200); assert.equal(events.ok, true)
      assert.ok(events.result?.length)
      assert.ok(events.result.every(event => event.projectId === project.id && event.userId === userId))
      const links = await rpc<ProjectTeam[]>('team-relations.listProjectTeams', [])
      assert.equal(links.response.status, 200); assert.equal(links.ok, true)
      assert.deepEqual(links.result?.map(link => ({ projectId: link.projectId, teamId: link.teamId, workspaceId: link.workspaceId })),
        [{ projectId: project.id, teamId, workspaceId: beta }])
    })
    await t.test('the selected-Workspace reads do not change Project revisions, events or links', async () => {
      assert.deepEqual(await snapshot(), before)
    })
    await t.test('the same valid write inputs succeed after the human selects B', async () => {
      await switchTo(beta)
      let nextRevision = revision
      for (const { action, input } of writes) {
        const result = await rpc<{ project?: Project; error?: string } | ActionResult<Project>>(action, [{ ...input as object, revision: nextRevision }])
        assert.equal(result.response.status, 200)
        assert.equal(result.ok, true)
        assert.ok(result.result)
        const saved = 'ok' in result.result ? result.result.ok ? result.result.data : undefined : result.result.project
        assert.equal(saved?.id, project.id, 'the exact action and input succeed only in the selected tenant')
        assert.equal(saved?.revision, nextRevision + 1)
        nextRevision += 1
      }
    })
  } finally {
    try {
      try {
        server.closeAllConnections()
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      } finally {
        await runtime.close()
      }
    } finally {
      try {
        // Only this random fixture's rows in guarded disposable databases.
        await workspacePool.query('DELETE FROM mikka_team_projects WHERE "userId"=ANY($1::text[])', [users])
        await workspacePool.query('DELETE FROM workspace_project_events WHERE "userId"=ANY($1::text[])', [users])
        await workspacePool.query('DELETE FROM workspace_projects WHERE "userId"=ANY($1::text[])', [users])
        await workspacePool.query('DELETE FROM mikka_team_members WHERE "userId"=ANY($1::text[])', [users])
        await workspacePool.query('DELETE FROM mikka_teams WHERE "workspaceId"=ANY($1::uuid[])', [tenants])
        await pool.query("DELETE FROM resource_access_policies WHERE kind='project' AND \"ownerId\"=ANY($1::text[])", [users])
        // Immutable resource_access_events remain in this disposable database
        // until its lifecycle ends; never disable their audit trigger.
        await pool.query('DELETE FROM "user" WHERE id=ANY($1::text[])', [users])
        await workspacePool.query('DELETE FROM mikka_workspaces WHERE id=ANY($1::uuid[])', [tenants])
      } finally {
        try {
          await Promise.all([pool.end(), workspacePool.end()])
        } finally {
          try {
            for (const module of framework) module.restore()
          } finally {
            for (const [key, value] of Object.entries(oldEnvironment)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
          }
        }
      }
    }
  }
})

