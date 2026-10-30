import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mock, test } from 'node:test'
import { Pool } from 'pg'
import { dbUrl, seedUser, seedWorkspace, seedBot, seedTeam } from './support/workspace-admin-db'

/** Real HTTP, token storage, membership and route logic. Only Next's request
 * context and the existing cookie-session boundary are supplied by the fixture. */
test('PAT bearer authenticates existing GET/POST routes with owner/workspace checks', { skip: !dbUrl }, async t => {
  const pool = new Pool({ connectionString: dbUrl })
  const previousAgentKit = process.env.MIKKA_AGENT_KIT
  process.env.MIKKA_AGENT_KIT = '1'
  const previousFlag = process.env.MIKKA_CLOUD_COMPUTER_TASKS
  process.env.MIKKA_CLOUD_COMPUTER_TASKS = '1'
  const owner = await seedUser(pool, 'pat-owner'), member = await seedUser(pool, 'pat-member')
  const ws = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }, { userId: member, role: 'member' }])
  const other = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }])
  const ownBot = await seedBot(pool, ws.id, owner), otherBot = await seedBot(pool, other.id, owner)
  const ownTeam = await seedTeam(pool, ws.id, owner), otherTeam = await seedTeam(pool, other.id, owner)
  const groups = [randomUUID(), randomUUID()]
  for (const [index, workspaceId] of [ws.id, other.id].entries()) {
    await pool.query(`INSERT INTO conversations (id,"workspaceId",kind,title,"createdBy") VALUES ($1,$2,'group','PAT fixture group',$3)`, [groups[index], workspaceId, owner])
    await pool.query(`INSERT INTO conversation_members ("conversationId","memberType","memberId",role) VALUES ($1,'user',$2,'owner')`, [groups[index], owner])
  }
  let currentHeaders = new Headers()
  let cookieReads = 0
  mock.module('next/headers', { namedExports: {
    headers: async () => currentHeaders,
    cookies: async () => ({ get: (name: string) => name === 'mikka-workspace' ? { value: other.id } : undefined }),
  } })
  mock.module('next-intl/server', { namedExports: { getLocale: async () => 'en', getTranslations: async () => Object.assign((code: string) => code, { has: () => true }) } })
  mock.module('@/lib/auth', { namedExports: { MOBILE_APP_ORIGIN: 'mikka://', auth: { api: { getSession: async () => {
    cookieReads++
    return currentHeaders.has('cookie') ? { user: { id: owner }, session: { id: 'browser-session' } } : null
  } } } } })
  const next = await import('next/server')
  mock.module('next/server', { namedExports: { ...next, after: () => {} } })
  mock.module('@/app/actions/coordinator', { namedExports: { getCoordinatorChat: async () => { throw new Error('PAT must not use cookie action') }, sendCoordinatorMessage: async () => { throw new Error('PAT must not use cookie action') } } })
  const store = await import('../lib/tokens/store')
  const { getApiSession } = await import('../lib/api-auth')
  const workspaceRoute = await import('../app/api/workspace/route')
  const policyRoute = await import('../app/api/workspaces/[workspaceId]/computer-policy/route')
  const switcherRoute = await import('../app/api/workspace/switcher/route')
  const botRoute = await import('../app/api/bots/[botId]/definition/route')
  const groupRoute = await import('../app/api/conversations/route')
  const teamRoute = await import('../app/api/teams/[teamId]/members/route')
  const searchRoute = await import('../app/api/search/route')
  const mobileTasks = await import('../app/api/mobile/tasks/route')
  const mobileChat = await import('../app/api/mobile/chat/route')
  const token = await store.createPersonalAccessToken(owner, ws.id, { name: 'API test' })
  const memberToken = await store.createPersonalAccessToken(member, ws.id, { name: 'Member API test' })
  const server = createServer(async (req, res) => {
    try {
      const url = `http://127.0.0.1:${(server.address() as { port: number }).port}${req.url}`
      currentHeaders = new Headers(Object.entries(req.headers).flatMap(([key, value]) => typeof value === 'string' ? [[key, value]] : []))
      const body = req.method === 'POST' ? await new Promise<string>((resolve, reject) => { let value = ''; req.on('data', chunk => { value += chunk }); req.on('end', () => resolve(value)); req.on('error', reject) }) : undefined
      const request = new Request(url, { method: req.method, headers: currentHeaders, body })
      const pathname = new URL(url).pathname
      const response = pathname === '/api/workspace/switcher' ? await switcherRoute.GET(request)
        : pathname === '/api/workspace' ? await workspaceRoute.GET(request)
        : pathname.startsWith('/api/bots/') ? await botRoute.GET(request, { params: Promise.resolve({ botId: pathname.split('/')[3] }) })
        : pathname === '/api/conversations' ? await (req.method === 'POST' ? groupRoute.POST : groupRoute.GET)(request)
        : pathname.startsWith('/api/teams/') ? await teamRoute.GET(request, { params: Promise.resolve({ teamId: pathname.split('/')[3] }) })
        : pathname === '/api/mobile/tasks' ? await mobileTasks.GET(request)
        : pathname === '/api/mobile/chat' ? await (req.method === 'POST' ? mobileChat.POST : mobileChat.GET)(request)
        : pathname === '/api/search' ? await searchRoute.GET(request)
        : await policyRoute.GET(request, { params: Promise.resolve({ workspaceId: pathname.split('/')[3] }) })
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(await response.text())
    } catch { res.writeHead(500); res.end('fixture handler failed') }
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const call = (bearer: string, workspaceId = ws.id, method = 'GET') => fetch(`${origin}/api/workspaces/${workspaceId}/computer-policy`, {
    method, headers: { authorization: `Bearer ${bearer}`, origin, 'content-type': 'application/json' }, ...(method === 'POST' ? { body: JSON.stringify({ permission: 'deny' }) } : {}),
  })
  t.after(async () => {
    server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    if (previousAgentKit === undefined) delete process.env.MIKKA_AGENT_KIT; else process.env.MIKKA_AGENT_KIT = previousAgentKit
    if (previousFlag === undefined) delete process.env.MIKKA_CLOUD_COMPUTER_TASKS; else process.env.MIKKA_CLOUD_COMPUTER_TASKS = previousFlag
    mock.restoreAll()
    const [{ pool: appPool }, { workspacePool }] = await Promise.all([import('../lib/db'), import('../lib/workspace-db')])
    await Promise.all([pool.end(), appPool.end(), workspacePool.end()])
  })

  await t.test('GET and POST accept the token owner and record usage', async () => {
    assert.equal((await call(token.token)).status, 200)
    assert.equal((await call(token.token, ws.id, 'POST')).status, 200)
    assert.equal((await (await call(token.token)).json()).permission, 'deny')
    assert.ok((await pool.query('SELECT "lastUsedAt" FROM personal_access_tokens WHERE id=$1', [token.id])).rows[0].lastUsedAt)
  })
  await t.test('member token cannot use the admin write; token cannot cross workspace', async () => {
    assert.equal((await call(memberToken.token)).status, 200)
    assert.equal((await call(memberToken.token, ws.id, 'POST')).status, 403)
    assert.equal((await call(token.token, other.id)).status, 403)
  })
  await t.test('workspace resolver uses token workspace over cookie and refuses explicit mismatch', async () => {
    const result = await fetch(`${origin}/api/workspace?`, { headers: { authorization: `Bearer ${token.token}`, cookie: 'mikka-workspace=elsewhere' } })
    assert.equal(result.status, 200)
    const data = await result.json()
    assert.equal(data.workspace.id, ws.id)
    assert.deepEqual(data.choices.map((choice: { id: string }) => choice.id), [ws.id])
    const switcher = await fetch(`${origin}/api/workspace/switcher`, { headers: { authorization: `Bearer ${token.token}`, cookie: 'other-browser-account' } })
    assert.equal(switcher.status, 200)
    const switched = await switcher.json()
    assert.deepEqual(switched.accounts.map((account: { id: string }) => account.id), [owner])
    assert.deepEqual(switched.accounts[0].choices.map((choice: { id: string }) => choice.id), [ws.id])
    assert.equal((await fetch(`${origin}/api/workspace?workspace=${other.id}`, { headers: { authorization: `Bearer ${token.token}` } })).status, 403)
  })
  await t.test('derived Bot/team scopes, group listing/creation and search stay in the token workspace', async () => {
    const request = (path: string, method = 'GET', body?: unknown) => fetch(`${origin}${path}`, { method, headers: { authorization: `Bearer ${token.token}`, origin, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    assert.equal((await request(`/api/bots/${ownBot}/definition?view=history`)).status, 200)
    assert.equal((await request(`/api/bots/${otherBot}/definition?view=history`)).status, 404)
    assert.equal((await request(`/api/bots/${otherBot}/definition`, 'POST', {})).status, 404)
    assert.equal((await request(`/api/teams/${ownTeam.id}/members`)).status, 200)
    assert.equal((await request(`/api/teams/${otherTeam.id}/members`)).status, 403)
    const listed = await request('/api/conversations')
    assert.equal(listed.status, 200)
    assert.deepEqual((await listed.json()).conversations.map((group: { id: string }) => group.id), [groups[0]])
    assert.equal((await request(`/api/conversations?workspaceId=${other.id}`)).status, 404)
    assert.equal((await request('/api/conversations', 'POST', { workspaceId: other.id, title: 'Must not create', members: [] })).status, 404)
    assert.equal((await request(`/api/search?source=tasks&q=fixture&workspaceId=${other.id}`)).status, 403)
  })
  await t.test('mobile business APIs use the PAT owner and bound Bot workspace without a cookie session', async () => {
    const callMobile = (path: string, body?: unknown) => fetch(`${origin}${path}`, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${token.token}`, origin, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    assert.equal((await callMobile('/api/mobile/tasks')).status, 200)
    assert.equal((await callMobile(`/api/mobile/chat?bot=${ownBot}`)).status, 200)
    assert.equal((await callMobile(`/api/mobile/chat?bot=${otherBot}`)).status, 404)
    assert.equal((await callMobile('/api/mobile/chat', { text: 'PAT mobile message', botId: ownBot })).status, 202)
    assert.equal((await callMobile('/api/mobile/chat', { text: 'must not send', botId: otherBot })).status, 404)
    const messages = (await pool.query(`SELECT "userId","botId",payload FROM coordinator_events WHERE "userId"=$1 AND payload->>'text'='PAT mobile message'`, [owner])).rows
    assert.equal(messages.length, 1)
    assert.equal(messages[0].botId, ownBot)
  })
  await t.test('the existing browser issue fetcher ignores the SWR cache-key argument', async () => {
    const { actAs } = await import('../lib/acting-user')
    const { listIssues } = await import('../app/actions/issues')
    const listed = await actAs(owner, () => Reflect.apply(listIssues, undefined, [['issues', owner]]))
    assert.ok(Array.isArray(listed))
  })
  await t.test('PAT support stays on API adapters, without authorizing general server actions', async () => {
    currentHeaders = new Headers({ authorization: `Bearer ${token.token}` })
    assert.equal(await (await import('../lib/session')).getSession(), null)
  })
  await t.test('bad, expired and revoked PATs fail and never fall back to a browser cookie', async () => {
    const before = cookieReads
    for (const invalid of ['mkp_invalid', 'mkp_' + 'A'.repeat(43)]) {
      assert.equal(await getApiSession({ headers: new Headers({ authorization: `Bearer ${invalid}`, cookie: 'valid-browser-cookie' }) }), null)
    }
    assert.equal(cookieReads, before)
    const expired = await store.createPersonalAccessToken(owner, ws.id, { name: 'Expired API test' })
    await pool.query('UPDATE personal_access_tokens SET "createdAt"=now()-interval \'2 minutes\', "expiresAt"=now()-interval \'1 minute\' WHERE id=$1', [expired.id])
    assert.equal((await call(expired.token)).status, 403)
    await store.revokePersonalAccessToken(owner, ws.id, { id: token.id })
    assert.equal((await call(token.token)).status, 403)
  })
  await t.test('suspended membership invalidates a still-live token', async () => {
    await pool.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2', [ws.id, member])
    assert.equal((await call(memberToken.token)).status, 403)
  })
})
