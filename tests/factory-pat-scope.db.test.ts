import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mock, test } from 'node:test'
import { Pool } from 'pg'
import { dbUrl, seedBot, seedTeam, seedUser, seedWorkspace } from './support/workspace-admin-db'

// Real PAT storage/authentication, workspace membership, route adapters and Factory
// transactions. Only the framework request context and cookie-session boundary are fixtures.
test('Factory HTTP adapters preserve a personal access token workspace', { skip: !dbUrl, timeout: 120_000 }, async t => {
  const pool = new Pool({ connectionString: dbUrl, max: 4 })
  const owner = await seedUser(pool, 'factory-pat-owner')
  const workspace = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }])
  const otherWorkspace = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }])
  const team = await seedTeam(pool, workspace.id, owner)
  const otherTeam = await seedTeam(pool, otherWorkspace.id, owner)
  const bot = await seedBot(pool, workspace.id, owner)
  const otherBot = await seedBot(pool, otherWorkspace.id, owner)
  let currentHeaders = new Headers()
  let browser = false
  let browserWorkspaceId = workspace.id
  mock.module('next/headers', { namedExports: {
    headers: async () => currentHeaders,
    cookies: async () => ({ get: (name: string) => name === 'mikka-workspace' ? { value: browserWorkspaceId } : undefined }),
  } })
  mock.module('next-intl/server', { namedExports: {
    getLocale: async () => 'en',
    getTranslations: async () => Object.assign((code: string) => code, { has: () => true }),
  } })
  mock.module('@/lib/auth', { namedExports: {
    MOBILE_APP_ORIGIN: 'mikka://',
    auth: { api: { getSession: async () => browser ? {
      user: { id: owner, name: 'Fixture', email: `${owner}@example.invalid`, image: null },
      session: { id: 'fixture-browser-session' },
    } : null } },
  } })
  const next = await import('next/server')
  mock.module('next/server', { namedExports: { ...next, after: () => {} } })
  t.after(async () => {
    mock.restoreAll()
    const [{ pool: appPool }, { workspacePool }] = await Promise.all([import('../lib/db'), import('../lib/workspace-db')])
    await Promise.all([pool.end(), appPool.end(), workspacePool.end()])
  })
  const { createPersonalAccessToken } = await import('../lib/tokens/store')
  const token = await createPersonalAccessToken(owner, workspace.id, { name: 'Factory scope fixture' })
  const { factoryRuntimeForBot } = await import('../lib/factory/runtime')
  const detail = await import('../app/api/factory/tasks/[taskId]/route')
  const activity = await import('../app/api/factory/tasks/[taskId]/activity/route')
  const list = await import('../app/api/factory/tasks/route')
  const route = await import('../app/api/factory/tasks/route/route')
  async function fixture(foreign: boolean, withTask = true) {
    const issueId = randomUUID(), sourceEventId = randomUUID()
    const workspaceId = foreign ? otherWorkspace.id : workspace.id
    const teamId = foreign ? otherTeam.id : team.id
    const botId = foreign ? otherBot : bot
    await pool.query(`INSERT INTO issues (id,"userId","workspaceId","ownershipState",title,content,status,priority,scope) VALUES ($1,$2,$3,'bound','Factory PAT fixture','{"type":"doc"}','todo','normal','workspace')`, [issueId, owner, workspaceId])
    await pool.query('INSERT INTO mikka_team_issues ("issueId","teamId","workspaceId","userId") VALUES ($1,$2,$3,$4)', [issueId, teamId, workspaceId, owner])
    await pool.query(`INSERT INTO coordinator_events (id,"userId","botId",kind,"dedupeKey",payload) VALUES ($1,$2,$3,'user_message',$4,'{"text":"Isolated scope fixture"}')`, [sourceEventId, owner, withTask ? botId : null, sourceEventId])
    const input = { issueId, sourceEventId, eventId: randomUUID(), rationale: 'Isolated requested task', missingInformation: ['No external execution needed'], missingPermissions: [], needsSpec: false }
    const task = withTask ? (await factoryRuntimeForBot(botId).store.route(owner, input)).task : null
    return { issueId, input, task }
  }
  const origin = 'http://127.0.0.1'
  const request = (path: string, body?: unknown) => {
    currentHeaders = new Headers({ ...(!browser ? { authorization: `Bearer ${token.token}` } : { cookie: 'fixture' }), origin, 'content-type': 'application/json' })
    return new Request(origin + path, { method: body === undefined ? 'GET' : 'POST', headers: currentHeaders, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  }
  const own = await fixture(false), foreign = await fixture(true)
  await t.test('same-workspace task remains readable', async () => {
    const response = await detail.GET(request(`/api/factory/tasks/${own.task!.id}`), { params: Promise.resolve({ taskId: own.task!.id }) })
    assert.equal(response.status, 200)
  })
  await t.test('foreign task detail is not disclosed', async () => {
    const response = await detail.GET(request(`/api/factory/tasks/${foreign.task!.id}`), { params: Promise.resolve({ taskId: foreign.task!.id }) })
    assert.equal(response.status, 404)
  })
  await t.test('sidebar uses the same workspace boundary and private cache policy as task detail', async () => {
    for (const [taskId, expected] of [[own.task!.id,200],[foreign.task!.id,404]] as const) {
      const response = await activity.GET(request(`/api/factory/tasks/${taskId}/activity`), { params: Promise.resolve({ taskId }) })
      assert.equal(response.status, expected)
      assert.equal(response.headers.get('cache-control'),'private, no-store')
      if (expected === 200) {
        const body = await response.json()
        assert.equal(body.task.id,taskId)
        assert.deepEqual(body.agents,[])
        assert.deepEqual(body.artifacts,[])
      }
    }
  })
  await t.test('foreign task discovery is not disclosed', async () => {
    assert.equal((await list.GET(request(`/api/factory/tasks?issueId=${foreign.issueId}`))).status, 404)
    assert.equal((await list.GET(request(`/api/factory/tasks?issueId=${own.issueId}`))).status, 200)
  })
  await t.test('foreign cancellation cannot mutate task or append receipts', async () => {
    const item = await fixture(true)
    const task = item.task!
    const before = (await pool.query('SELECT status,revision FROM factory_tasks WHERE id=$1', [task.id])).rows[0]
    const eventId = randomUUID()
    const response = await detail.POST(request(`/api/factory/tasks/${task.id}`, { binding: { taskId: task.id, revision: task.revision }, eventId, action: 'cancel', reason: 'Scope boundary fixture' }), { params: Promise.resolve({ taskId: task.id }) })
    const after = (await pool.query('SELECT status,revision FROM factory_tasks WHERE id=$1', [task.id])).rows[0]
    const receipts = (await pool.query('SELECT 1 FROM factory_events WHERE "taskId"=$1 AND "eventId"=$2', [task.id, eventId])).rowCount
    assert.deepEqual({ status: response.status, after, receipts }, { status: 404, after: before, receipts: 0 })
  })
  await t.test('routing a foreign issue is refused before writing a task', async () => {
    const item = await fixture(true, false)
    const response = await route.POST(request('/api/factory/tasks/route', item.input))
    const tasks = (await pool.query('SELECT 1 FROM factory_tasks WHERE "issueId"=$1', [item.issueId])).rowCount
    assert.deepEqual({ status: response.status, tasks }, { status: 404, tasks: 0 })
  })
  await t.test('foreign dispatch is refused before queue creation', async () => {
    const task = foreign.task!
    const before = (await pool.query('SELECT count(*)::int AS n FROM agent_runs WHERE "issueId"=$1', [foreign.issueId])).rows[0].n
    const response = await list.POST(request('/api/factory/tasks', {
      binding: { taskId: task.id, issueId: task.issueId, attemptId: task.attemptId, candidateId: task.candidateId, revision: task.revision },
      agentId: randomUUID(), deviceRepoId: randomUUID(),
    }))
    const after = (await pool.query('SELECT count(*)::int AS n FROM agent_runs WHERE "issueId"=$1', [foreign.issueId])).rows[0].n
    assert.deepEqual({ status: response.status, after }, { status: 404, after: before })
  })
  await t.test('same-workspace control commits once and preserves terminal replay refusal', async () => {
    const item = await fixture(false), task = item.task!
    const eventId = randomUUID()
    const body = { binding: { taskId: task.id, revision: task.revision }, eventId, action: 'cancel', reason: 'Authorized fixture cancellation' }
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await detail.POST(request(`/api/factory/tasks/${task.id}`, body), { params: Promise.resolve({ taskId: task.id }) })
      assert.equal(response.status, attempt === 0 ? 200 : 409)
      if (attempt === 1) assert.equal((await response.json()).error, 'factoryStopped')
    }
    assert.equal((await pool.query('SELECT status FROM factory_tasks WHERE id=$1', [task.id])).rows[0].status, 'cancelled')
    assert.equal((await pool.query('SELECT 1 FROM factory_events WHERE "taskId"=$1 AND "eventId"=$2', [task.id, eventId])).rowCount, 1)
  })
  await t.test('concurrent workspace PAT contexts do not bleed into each other', async () => {
    const otherToken = await createPersonalAccessToken(owner, otherWorkspace.id, { name: 'Other workspace fixture' })
    const cases = [
      [token.token, own.task!.id, 200], [token.token, foreign.task!.id, 404],
      [otherToken.token, foreign.task!.id, 200], [otherToken.token, own.task!.id, 404],
    ] as const
    const results = await Promise.all(cases.map(async ([credential, taskId, expected]) => {
      const req = new Request(`${origin}/api/factory/tasks/${taskId}`, { headers: { authorization: `Bearer ${credential}` } })
      const response = await detail.GET(req, { params: Promise.resolve({ taskId }) })
      return { status: response.status, expected }
    }))
    for (const result of results) assert.equal(result.status, result.expected)
  })
  await t.test('a different account cannot read the task through a valid PAT', async () => {
    const outsider = await seedUser(pool, 'factory-pat-outsider')
    const ownWorkspace = await seedWorkspace(pool, outsider, [{ userId: outsider, role: 'admin' }])
    const otherToken = await createPersonalAccessToken(outsider, ownWorkspace.id, { name: 'Different owner fixture' })
    const response = await detail.GET(new Request(`${origin}/api/factory/tasks/${own.task!.id}`, {
      headers: { authorization: `Bearer ${otherToken.token}` },
    }), { params: Promise.resolve({ taskId: own.task!.id }) })
    assert.equal(response.status, 404)
    const sidebar = await activity.GET(new Request(`${origin}/api/factory/tasks/${own.task!.id}/activity`, {
      headers: { authorization: `Bearer ${otherToken.token}` },
    }), { params: Promise.resolve({ taskId: own.task!.id }) })
    assert.equal(sidebar.status,404)
  })
  await t.test('a browser reads only its selected workspace, including another owned workspace', async () => {
    browser = true
    try {
      browserWorkspaceId = otherWorkspace.id
      assert.equal((await detail.GET(request(`/api/factory/tasks/${foreign.task!.id}`), { params: Promise.resolve({ taskId: foreign.task!.id }) })).status, 200)
      assert.equal((await list.GET(request(`/api/factory/tasks?issueId=${foreign.issueId}`))).status, 200)
      browserWorkspaceId = workspace.id
      assert.equal((await detail.GET(request(`/api/factory/tasks/${foreign.task!.id}`), { params: Promise.resolve({ taskId: foreign.task!.id }) })).status, 404)
      assert.equal((await list.GET(request(`/api/factory/tasks?issueId=${foreign.issueId}`))).status, 404)
    } finally {
      browser = false
      browserWorkspaceId = workspace.id
    }
  })
  await t.test('expired and revoked PATs remain unauthenticated', async () => {
    for (const column of ['expiresAt', 'revokedAt']) {
      const value = await createPersonalAccessToken(owner, workspace.id, { name: `Inactive ${column} fixture` })
      const { hashPersonalAccessToken } = await import('../lib/tokens/format')
      await pool.query(`UPDATE personal_access_tokens SET "createdAt"=now()-interval '2 hours', "${column}"=now()-interval '1 minute' WHERE "tokenHash"=$1`, [hashPersonalAccessToken(value.token)])
      const response = await detail.GET(new Request(`${origin}/api/factory/tasks/${own.task!.id}`, {
        headers: { authorization: `Bearer ${value.token}` },
      }), { params: Promise.resolve({ taskId: own.task!.id }) })
      assert.equal(response.status, 401)
    }
  })
})
