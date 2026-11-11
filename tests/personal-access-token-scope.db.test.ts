import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mock, test } from 'node:test'
import { Pool } from 'pg'
import { dbUrl, seedAgent, seedBot, seedIssue, seedPersonalWorkspace, seedRun, seedTeam, seedUser, seedWorkspace } from './support/workspace-admin-db'

/** Tokens pin a workspace; browser requests select an active workspace. Both
 * must retain task/evidence isolation for one owner who belongs to multiple tenants. */
test('API requests stay in their effective workspace on thread, evidence, proposal and chat routes', { skip: !dbUrl }, async t => {
  const pool = new Pool({ connectionString: dbUrl })
  const owner = await seedUser(pool, 'pat-scope-owner')
  const ws = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }])
  const other = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }])
  const personal = { id: await seedPersonalWorkspace(pool, owner) }
  const ownBot = await seedBot(pool, ws.id, owner), otherBot = await seedBot(pool, other.id, owner)
  const ownTeam = await seedTeam(pool, ws.id, owner), otherTeam = await seedTeam(pool, other.id, owner)
  const ownIssue = await seedIssue(pool, owner, ws.id), otherIssue = await seedIssue(pool, owner, other.id)
  for (const [issueId, workspaceId, teamId] of [[ownIssue, ws.id, ownTeam.id], [otherIssue, other.id, otherTeam.id]]) {
    await pool.query('INSERT INTO mikka_team_issues ("issueId","teamId","workspaceId","userId") VALUES ($1,$2,$3,$4)', [issueId, teamId, workspaceId, owner])
  }
  const agent = await seedAgent(pool, owner)
  const device = randomUUID(), repo = randomUUID()
  await pool.query(`INSERT INTO devices (id,"ownerId",name,kind,enabled,"lastSeenAt") VALUES ($1,$2,'Laptop','local',true,now())`, [device, owner])
  await pool.query(`INSERT INTO device_repos (id,"deviceId","userId","repoPath") VALUES ($1,$2,$3,'/repo')`, [repo, device, owner])
  const run = async (botId: string | null, issueId: string | null, workspaceId?: string) => {
    const id = await seedRun(pool, { userId: owner, agentId: agent, botId, issueId, workspaceId, status: 'succeeded', finishedAt: new Date() })
    await pool.query(`UPDATE agent_runs SET "deviceId"=$2,"deviceRepoId"=$3,"sessionId"='session' WHERE id=$1`, [id, device, repo])
    return id
  }
  // Another workspace's run: by its Bot, or (no Bot) by its task.
  const ownRun = await run(ownBot, ownIssue), otherRun = await run(otherBot, otherIssue), otherTaskRun = await run(null, otherIssue)
  // Team grouping is optional. Each task still has one immutable tenant, so
  // runs in different workspaces never share a synthetic tenant-less task.
  const ownLooseIssue = await seedIssue(pool, owner, ws.id), otherLooseIssue = await seedIssue(pool, owner, other.id)
  const personalLooseIssue = await seedIssue(pool, owner, personal.id)
  const ownBotLooseRun = await run(ownBot, ownLooseIssue), otherBotLooseRun = await run(otherBot, otherLooseIssue), otherBotNoTaskRun = await run(otherBot, null)

  let currentHeaders = new Headers()
  let activeWorkspaceId: string | undefined = ws.id
  mock.module('next/headers', { namedExports: { headers: async () => currentHeaders,
    cookies: async () => ({ get: (name: string) => name === 'mikka-workspace' && activeWorkspaceId ? { value: activeWorkspaceId } : undefined }) } })
  mock.module('next-intl/server', { namedExports: { getLocale: async () => 'en', getTranslations: async () => Object.assign((code: string) => code, { has: () => true }) } })
  // A browser session (no bearer token) is the owner's cookie session when `browser` is set.
  let browser = false
  const ownerName = 'pat-scope-owner'
  mock.module('@/lib/auth', { namedExports: { MOBILE_APP_ORIGIN: 'mikka://', auth: { api: { getSession: async () => browser ? { user: { id: owner, name: ownerName, email: `${owner}@example.invalid`, image: null }, session: { id: 'browser' } } : null } } } })
  const next = await import('next/server')
  mock.module('next/server', { namedExports: { ...next, after: () => {} } })
  const store = await import('../lib/tokens/store')
  const token = await store.createLegacyPersonalAccessToken(owner, ws.id, { name: 'Scope test' })
  const personalToken = await store.createLegacyPersonalAccessToken(owner, personal.id, { name: 'Scope test personal' })
  let bearer: string | null = token.token
  const origin = 'http://127.0.0.1'
  const call = async <P>(handler: (request: Request, context: { params: Promise<P> }) => Promise<Response>, path: string, params: P, body?: unknown, method = body === undefined ? 'GET' : 'POST') => {
    currentHeaders = new Headers({ ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), origin, 'content-type': 'application/json' })
    const response = await handler(new Request(`${origin}${path}`, { method, headers: currentHeaders, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), { params: Promise.resolve(params) })
    return { status: response.status, body: response.headers.get('content-type')?.includes('json') ? await response.json() : await response.text() }
  }
  t.after(async () => {
    mock.restoreAll()
    const [{ pool: appPool }, { workspacePool }] = await Promise.all([import('../lib/db'), import('../lib/workspace-db')])
    await Promise.all([pool.end(), appPool.end(), workspacePool.end()])
  })

  // Runs first: nothing has moved the owner's bot-less rows onto a Coordinator yet (lib/coordinator/coordinator-bot.ts backfill).
  await t.test('personal task/run/artifact tenants and legacy Coordinator records retain their personal contract', async () => {
    const list = await import('../app/api/mobile/threads/route')
    const evidence = await import('../app/api/runs/[runId]/evidence/route')
    const download = await import('../app/api/artifacts/[artifactId]/versions/[version]/download/route')
    const listRoute = await import('../app/api/pending-actions/route')
    const decide = await import('../app/api/mobile/pending-actions/[id]/route')
    const reactions = await import('../app/api/mobile/reactions/route')
    const personalIssue = await seedIssue(pool, owner, personal.id)
    const bare = await run(null, null, personal.id), personalTask = await run(null, personalIssue)
    // The cloud binding must agree with the run's previously recorded tenant.
    const bound = await run(null, null, ws.id)
    await pool.query('INSERT INTO computer_run_bindings ("runId","botId","workspaceId","ownerId") VALUES ($1,$2,$3,$4)', [bound, ownBot, ws.id, owner])
    const artifact = randomUUID(), proposal = randomUUID(), message = randomUUID()
    await pool.query(`INSERT INTO artifacts (id,"userId","workspaceId",kind,title) VALUES ($1,$2,$3,'markdown','From a client')`, [artifact, owner, personal.id])
    await pool.query(`INSERT INTO artifact_versions (id,"artifactId",version,"storageKey","inlineContent",sha256,size,"authorName") VALUES ($1,$2,1,'inline','# Notes','sha',7,'Client')`, [randomUUID(), artifact])
    await pool.query(`INSERT INTO pending_actions (id,"userId",action,input) VALUES ($1,$2,'credential_operation',$3)`, [proposal, owner, { summary: 'Sign in', origin: 'https://example.invalid', operation: 'login' }])
    await pool.query(`INSERT INTO coordinator_messages (id,"userId",position,message) VALUES ($1,$2,1,'{"role":"assistant"}')`, [message, owner])
    const reach = async () => {
      const threads = (await call(list.GET, '/api/mobile/threads', {})).body.threads.map((item: { id: string }) => item.id)
      return {
        threads: [bare, personalTask].map(id => threads.includes(id)),
        evidence: [(await call(evidence.GET, `/api/runs/${bare}/evidence`, { runId: bare })).status, (await call(evidence.GET, `/api/runs/${personalTask}/evidence`, { runId: personalTask })).status],
        artifact: (await call(download.GET, `/api/artifacts/${artifact}/versions/1/download`, { artifactId: artifact, version: '1' })).status,
        proposals: (await call(listRoute.GET, '/api/pending-actions', {})).body.map((item: { id: string }) => item.id).includes(proposal),
      }
    }
    try {
      assert.equal((await call(evidence.GET, `/api/runs/${bound}/evidence`, { runId: bound })).status, 200)
      // A team workspace's token: refused.
      assert.deepEqual(await reach(), { threads: [false, false], evidence: [404, 404], artifact: 404, proposals: false })
      assert.equal((await call(decide.POST, `/api/mobile/pending-actions/${proposal}`, { id: proposal }, { approve: false })).status, 409)
      assert.equal((await pool.query('SELECT status FROM pending_actions WHERE id=$1', [proposal])).rows[0].status, 'pending')
      assert.equal((await call(reactions.POST, '/api/mobile/reactions', {}, { messageId: message, emoji: '👍' })).status, 404)
      assert.equal(Number((await pool.query('SELECT count(*) FROM message_reactions WHERE "messageId"=$1', [message])).rows[0].count), 0)
      // The personal workspace's token: allowed, and still refused another workspace's run.
      bearer = personalToken.token
      assert.deepEqual(await reach(), { threads: [true, true], evidence: [200, 200], artifact: 200, proposals: true })
      assert.equal((await call(reactions.POST, '/api/mobile/reactions', {}, { messageId: message, emoji: '👍' })).status, 200)
      assert.equal((await call(evidence.GET, `/api/runs/${otherRun}/evidence`, { runId: otherRun })).status, 404)
      assert.equal((await call(evidence.GET, `/api/runs/${ownRun}/evidence`, { runId: ownRun })).status, 404)
      assert.equal((await call(evidence.GET, `/api/runs/${bound}/evidence`, { runId: bound })).status, 404)
      // A browser's verified session selects a tenant; sharing an owner is insufficient.
      bearer = null; browser = true; activeWorkspaceId = personal.id
      assert.deepEqual(await reach(), { threads: [true, true], evidence: [200, 200], artifact: 200, proposals: true })
      assert.equal((await call(evidence.GET, `/api/runs/${otherRun}/evidence`, { runId: otherRun })).status, 404)
      activeWorkspaceId = other.id
      assert.deepEqual(await reach(), { threads: [false, false], evidence: [404, 404], artifact: 404, proposals: true })
      assert.equal((await call(evidence.GET, `/api/runs/${otherRun}/evidence`, { runId: otherRun })).status, 200)
    } finally {
      bearer = token.token; browser = false; activeWorkspaceId = ws.id
      await pool.query('DELETE FROM agent_runs WHERE id=ANY($1::uuid[])', [[bare, personalTask, bound]])
      await pool.query('DELETE FROM issues WHERE id=$1', [personalIssue])
      await pool.query('DELETE FROM pending_actions WHERE id=$1', [proposal])
      await pool.query('DELETE FROM message_reactions WHERE "messageId"=$1', [message])
      await pool.query('DELETE FROM coordinator_messages WHERE id=$1', [message])
    }
  })

  await t.test('cookie-less browser evidence defaults to a freshly authorized personal workspace even when teams were created first', async () => {
    const [{ GET }, { createRequestScope, runRequestScope }] = await Promise.all([
      import('../app/api/runs/[runId]/evidence/route'), import('../apps/api/src/context'),
    ])
    const personalRun = await run(null, personalLooseIssue)
    const ordered = (await pool.query('SELECT id,kind FROM mikka_workspaces WHERE "userId"=$1 ORDER BY "createdAt"', [owner])).rows
    assert.equal(ordered[0].id, ws.id, 'the older team must actually precede the personal tenant in PostgreSQL')
    const read = async (runId: string, selected?: string) => {
      currentHeaders = new Headers({ origin, ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        ...(selected !== undefined ? { 'x-mikka-workspace-id': selected } : {}) })
      const request = new Request(`${origin}/api/runs/${runId}/evidence`, { headers: currentHeaders })
      return (await runRequestScope(createRequestScope(request), () => GET(request, { params: Promise.resolve({ runId }) }))).status
    }
    try {
      bearer = null; browser = true; activeWorkspaceId = undefined
      assert.equal(await read(personalRun), 200)
      assert.equal(await read(ownRun), 404, 'an older team is not the default browser tenant')
      activeWorkspaceId = ws.id
      assert.equal(await read(ownRun), 200)
      assert.equal(await read(personalRun), 404, 'an explicit valid team cookie remains exact')
      assert.equal(await read(personalRun, personal.id), 200, 'an explicit header overrides the cookie after fresh membership checks')
      assert.equal(await read(ownRun, personal.id), 404)
      activeWorkspaceId = personal.id
      assert.equal(await read(ownRun, ws.id), 200)
      assert.equal(await read(personalRun, ws.id), 404)
      for (const invalid of ['invalid-workspace', randomUUID()]) {
        assert.equal(await read(personalRun, invalid), 404)
        assert.equal(await read(ownRun, invalid), 404)
      }
      await pool.query(`UPDATE mikka_workspace_members SET status='suspended' WHERE "workspaceId"=$1 AND "userId"=$2`, [personal.id, owner])
      assert.equal(await read(personalRun, personal.id), 404, 'a header cannot revive suspended personal membership')
      activeWorkspaceId = undefined
      assert.equal(await read(personalRun), 404, 'the default is chosen only from freshly authorized memberships')
      await pool.query(`UPDATE mikka_workspace_members SET status='active' WHERE "workspaceId"=$1 AND "userId"=$2`, [personal.id, owner])
      await pool.query(`UPDATE mikka_workspace_members SET status='suspended' WHERE "workspaceId"=$1 AND "userId"=$2`, [ws.id, owner])
      activeWorkspaceId = ws.id
      assert.equal(await read(ownRun), 404, 'a saved cookie cannot revive suspended team membership')
      assert.equal(await read(ownRun, ws.id), 404)
      await pool.query(`UPDATE mikka_workspace_members SET status='active' WHERE "workspaceId"=$1 AND "userId"=$2`, [ws.id, owner])
      browser = false; bearer = token.token; activeWorkspaceId = personal.id
      assert.equal(await read(ownRun), 200, 'a PAT retains its pinned team despite the personal cookie')
      assert.equal(await read(personalRun), 404)
      assert.equal(await read(ownRun, personal.id), 404, 'a conflicting header cannot widen a PAT')
    } finally {
      await pool.query(`UPDATE mikka_workspace_members SET status='active' WHERE "workspaceId"=ANY($1::uuid[]) AND "userId"=$2`, [[personal.id, ws.id], owner])
      bearer = token.token; browser = false; activeWorkspaceId = ws.id
      await pool.query('DELETE FROM agent_runs WHERE id=$1', [personalRun])
    }
  })

  await t.test('threads: the list and a thread by id', async () => {
    const list = await import('../app/api/mobile/threads/route')
    const thread = await import('../app/api/mobile/threads/[id]/route')
    const listed = await call(list.GET, '/api/mobile/threads', {})
    assert.equal(listed.status, 200)
    const ids = listed.body.threads.map((item: { id: string }) => item.id)
    assert.ok(ids.includes(ownRun))
    assert.ok(!ids.includes(otherRun) && !ids.includes(otherTaskRun))
    assert.equal((await call(thread.GET, `/api/mobile/threads/${ownRun}`, { id: ownRun })).status, 200)
    assert.equal((await call(thread.GET, `/api/mobile/threads/${otherRun}`, { id: otherRun })).status, 404)
    // A working thread takes a message as it is.
    await pool.query(`UPDATE agent_runs SET status='running' WHERE id=ANY($1::uuid[])`, [[otherRun, otherTaskRun]])
    try {
      assert.equal((await call(thread.POST, `/api/mobile/threads/${otherRun}`, { id: otherRun }, { text: 'must not arrive' })).status, 404)
      assert.equal(Number((await pool.query('SELECT count(*) FROM run_messages WHERE "runId"=ANY($1::uuid[])', [[otherRun, otherTaskRun]])).rows[0].count), 0)
    } finally { await pool.query(`UPDATE agent_runs SET status='succeeded' WHERE id=ANY($1::uuid[])`, [[otherRun, otherTaskRun]]) }
  })

  await t.test('thread selection applies workspace filtering before the result limit', async () => {
    const list = await import('../app/api/mobile/threads/route')
    const { rows } = await pool.query<{ id: string }>(`INSERT INTO agent_runs (id,"userId","agentId","workspaceId","botId","issueId",status,"finishedAt")
      SELECT gen_random_uuid(),$1,$2,$3,$4,$5,'succeeded',now() FROM generate_series(1,65) RETURNING id`,
      [owner, agent, other.id, otherBot, otherIssue])
    try {
      for (const useBrowser of [false, true]) {
        browser = useBrowser; bearer = useBrowser ? null : token.token; activeWorkspaceId = ws.id
        const result = await call(list.GET, '/api/mobile/threads', {})
        assert.equal(result.status, 200)
        const listed = result.body.threads.map((item: { id: string }) => item.id)
        assert.ok(listed.includes(ownRun), 'newer foreign rows must not hide valid selected-workspace threads')
        assert.ok(rows.every(row => !listed.includes(row.id)))
      }
    } finally {
      browser = false; bearer = token.token
      await pool.query('DELETE FROM agent_runs WHERE id=ANY($1::uuid[])', [rows.map(row => row.id)])
    }
  })

  await t.test('evidence, captures and artifacts of a run', async () => {
    const evidence = await import('../app/api/runs/[runId]/evidence/route')
    const capture = await import('../app/api/captures/[captureId]/route')
    const download = await import('../app/api/artifacts/[artifactId]/versions/[version]/download/route')
    assert.equal((await call(evidence.GET, `/api/runs/${ownRun}/evidence`, { runId: ownRun })).status, 200)
    assert.equal((await call(evidence.GET, `/api/runs/${otherRun}/evidence`, { runId: otherRun })).status, 404)
    assert.equal((await call(evidence.GET, `/api/runs/${otherTaskRun}/evidence`, { runId: otherTaskRun })).status, 404)
    const captures = [randomUUID(), randomUUID()], artifacts = [randomUUID(), randomUUID()]
    for (const [index, runId] of [ownRun, otherRun].entries()) {
      await pool.query(`INSERT INTO run_captures (id,"userId","runId",kind,"contentType",source,status,title,"storageKey","inlineContent",size,sha256) VALUES ($1,$2,$3,'image','image/png','local','ready','Shot','inline',$4,4,'sha')`, [captures[index], owner, runId, Buffer.from('shot')])
      await pool.query(`INSERT INTO artifacts (id,"userId",kind,title,"runId") VALUES ($1,$2,'markdown','Notes',$3)`, [artifacts[index], owner, runId])
      await pool.query(`INSERT INTO artifact_versions (id,"artifactId",version,"storageKey","inlineContent",sha256,size,"authorName") VALUES ($1,$2,1,'inline',$3,'sha',7,'Agent')`, [randomUUID(), artifacts[index], '# Notes'])
    }
    assert.equal((await call(capture.GET, `/api/captures/${captures[0]}`, { captureId: captures[0] })).status, 200)
    assert.equal((await call(capture.GET, `/api/captures/${captures[1]}`, { captureId: captures[1] })).status, 404)
    const version = (artifactId: string) => call(download.GET, `/api/artifacts/${artifactId}/versions/1/download`, { artifactId, version: '1' })
    assert.equal((await version(artifacts[0])).status, 200)
    assert.equal((await version(artifacts[1])).status, 404)
    bearer = null; browser = true
    try {
      assert.equal((await call(capture.GET, `/api/captures/${captures[1]}`, { captureId: captures[1] })).status, 404)
      assert.equal((await version(artifacts[1])).status, 404)
      activeWorkspaceId = other.id
      assert.equal((await call(capture.GET, `/api/captures/${captures[1]}`, { captureId: captures[1] })).status, 200)
      assert.equal((await version(artifacts[1])).status, 200)
      assert.equal((await version(artifacts[0])).status, 404)
    } finally { bearer = token.token; browser = false; activeWorkspaceId = ws.id }
  })

  await t.test('the home counts', async () => {
    const home = await import('../app/api/mobile/home/route')
    await pool.query(`UPDATE agent_runs SET status='running' WHERE id=ANY($1::uuid[])`, [[ownRun, otherRun]])
    try {
      const result = await call(home.GET, '/api/mobile/home', {})
      assert.equal(result.status, 200)
      assert.equal(result.body.threads.running, 1)
      bearer = null; browser = true
      for (const workspaceId of [ws.id, other.id]) {
        activeWorkspaceId = workspaceId
        const selected = await call(home.GET, '/api/mobile/home', {})
        assert.equal(selected.body.workspace.id, workspaceId)
        assert.equal(selected.body.threads.running, 1, 'the same owner cannot count both tenants together')
      }
    } finally {
      bearer = token.token; browser = false; activeWorkspaceId = ws.id
      await pool.query(`UPDATE agent_runs SET status='succeeded' WHERE id=ANY($1::uuid[])`, [[ownRun, otherRun]])
    }
  })

  await t.test('pending proposals: the list and a decision', async () => {
    const listRoute = await import('../app/api/pending-actions/route')
    const decide = await import('../app/api/mobile/pending-actions/[id]/route')
    const [own, others] = [randomUUID(), randomUUID()]
    const input = { summary: 'Sign in', origin: 'https://example.invalid', operation: 'login' }
    for (const [id, botId] of [[own, ownBot], [others, otherBot]]) {
      await pool.query(`INSERT INTO pending_actions (id,"userId","botId",action,input) VALUES ($1,$2,$3,'credential_operation',$4)`, [id, owner, botId, input])
    }
    const listed = await call(listRoute.GET, '/api/pending-actions', {})
    assert.deepEqual(listed.body.map((item: { id: string }) => item.id).sort(), [own])
    assert.equal((await call(decide.POST, `/api/mobile/pending-actions/${others}`, { id: others }, { approve: false })).status, 409)
    assert.equal((await pool.query('SELECT status FROM pending_actions WHERE id=$1', [others])).rows[0].status, 'pending')
  })

  await t.test('local computer reviews: the list and a decision', async () => {
    const route = await import('../app/api/devices/computer/route')
    const reviews = [randomUUID(), randomUUID()]
    await pool.query(`UPDATE agent_runs SET status='running',"leaseExpiresAt"=now()+interval '5 minutes' WHERE id=ANY($1::uuid[])`, [[ownRun, otherRun]])
    try {
      for (const [index, runId] of [ownRun, otherRun].entries()) {
        await pool.query(`INSERT INTO local_computer_reviews (id,"deviceId","runId","userId",target,call,digest,"expiresAt","seenAt") VALUES ($1,$2,$3,$4,'screen','{}',$5,now()+interval '5 minutes',now())`, [reviews[index], device, runId, owner, String(index).repeat(64)])
      }
      const listed = await call(route.GET, '/api/devices/computer', {})
      assert.deepEqual(listed.body.requests.map((item: { id: string }) => item.id), [reviews[0]])
      assert.equal((await call(route.POST, '/api/devices/computer', {}, { id: reviews[1], digest: '1'.repeat(64), approve: true })).status, 409)
      assert.equal((await pool.query('SELECT decision FROM local_computer_reviews WHERE id=$1', [reviews[1]])).rows[0].decision, null)
    } finally { await pool.query(`UPDATE agent_runs SET status='succeeded',"leaseExpiresAt"=NULL WHERE id=ANY($1::uuid[])`, [[ownRun, otherRun]]) }
  })

  await t.test('chat reactions and a Bot chat preference', async () => {
    const reactions = await import('../app/api/mobile/reactions/route')
    const botRoute = await import('../app/api/mobile/bots/[id]/route')
    const groups = [randomUUID(), randomUUID()], messages = [randomUUID(), randomUUID()]
    for (const [index, workspaceId] of [ws.id, other.id].entries()) {
      await pool.query(`INSERT INTO conversations (id,"workspaceId",kind,title,"createdBy") VALUES ($1,$2,'group','Scope group',$3)`, [groups[index], workspaceId, owner])
      await pool.query(`INSERT INTO conversation_members ("conversationId","memberType","memberId",role) VALUES ($1,'user',$2,'owner')`, [groups[index], owner])
      await pool.query(`INSERT INTO conversation_messages (id,"conversationId",position,"authorType","authorId",body) VALUES ($1,$2,1,'user',$3,'hello')`, [messages[index], groups[index], owner])
      await pool.query(`INSERT INTO message_reactions ("userId","messageId",emoji) VALUES ($1,$2,'👍')`, [owner, messages[index]])
    }
    const read = await call(reactions.GET, `/api/mobile/reactions?ids=${messages.join(',')}`, {})
    assert.equal(read.status, 200)
    assert.deepEqual(Object.keys(read.body.reactions), [messages[0]])
    assert.equal((await call(reactions.POST, '/api/mobile/reactions', {}, { messageId: messages[1], emoji: null })).status, 404)
    assert.equal(Number((await pool.query('SELECT count(*) FROM message_reactions WHERE "messageId"=$1', [messages[1]])).rows[0].count), 1)
    assert.equal((await call(botRoute.PATCH, `/api/mobile/bots/${otherBot}`, { id: otherBot }, { pinned: true }, 'PATCH')).status, 404)
    assert.equal(Number((await pool.query('SELECT count(*) FROM chat_preferences WHERE "userId"=$1 AND "chatKey"=$2', [owner, otherBot])).rows[0].count), 0)
  })

  await t.test('actAs with the token user keeps its scope in task actions', async () => {
    const [{ actAs }, { requireIssueAccess }, { getApiSession }] = await Promise.all([import('../lib/acting-user'), import('../lib/issue-access'), import('../lib/api-auth')])
    const session = await getApiSession({ headers: new Headers({ authorization: `Bearer ${token.token}` }) })
    assert.ok(session)
    assert.equal((await actAs(session.user, () => requireIssueAccess(ownIssue))).issue.id, ownIssue)
    await assert.rejects(actAs(session.user, () => requireIssueAccess(otherIssue)), (error: { code?: string }) => error.code === 'issueNotFound')
    // Existing actions with an internal owner id still resolve the selected
    // workspace; they cannot use ownership to evade that request boundary.
    await assert.rejects(actAs(owner, () => requireIssueAccess(otherIssue)), { code: 'issueNotFound' })
    activeWorkspaceId = other.id
    try { assert.equal((await actAs(owner, () => requireIssueAccess(otherIssue))).issue.id, otherIssue) }
    finally { activeWorkspaceId = ws.id }
  })
  await t.test('task lists, search and actions use the effective tenant even when a historical scope label differs', async () => {
    const [{ actAs }, { requireIssueAccess }, { getApiSession }] = await Promise.all([import('../lib/acting-user'), import('../lib/issue-access'), import('../lib/api-auth')])
    const tasks = await import('../app/api/mobile/tasks/route')
    const search = await import('../app/api/issues/search/route')
    const personalTask = await seedIssue(pool, owner, personal.id)
    const unlinkedTask = randomUUID()
    await pool.query(`INSERT INTO issues (id,"userId","workspaceId","ownershipState",title,content,status,priority,scope)
      VALUES ($1,$2,$3,'bound','Loose','{"type":"doc"}','todo','normal','workspace')`, [unlinkedTask, owner, personal.id])
    const ids = [ownIssue, personalTask, unlinkedTask]
    const reach = async () => {
      const listed = (await call(tasks.GET, '/api/mobile/tasks', {})).body.tasks.map((item: { id: string }) => item.id)
      const found = (await call(search.GET, '/api/issues/search?q=', {})).body.items.map((item: { id: string }) => item.id)
      const session = await getApiSession({ headers: currentHeaders })
      assert.ok(session)
      const acted = await Promise.all(ids.map(id => actAs(session.user, () => requireIssueAccess(id)).then(() => true, () => false)))
      return { listed: ids.map(id => listed.includes(id)), searched: ids.map(id => found.includes(id)), acted }
    }
    try {
      // [W-linked task, personal task, unlinked task]
      assert.deepEqual(await reach(), { listed: [true, false, false], searched: [true, false, false], acted: [true, false, false] })
      bearer = personalToken.token
      assert.deepEqual(await reach(), { listed: [false, true, true], searched: [false, true, true], acted: [false, true, true] })
      bearer = null; browser = true
      activeWorkspaceId = ws.id
      assert.deepEqual(await reach(), { listed: [true, false, false], searched: [true, false, false], acted: [true, false, false] })
      activeWorkspaceId = personal.id
      assert.deepEqual(await reach(), { listed: [false, true, true], searched: [false, true, true], acted: [false, true, true] })
      const found = (await call(search.GET, `/api/issues/search?q=&workspaceId=${ws.id}`, {})).body.items.map((item: { id: string }) => item.id)
      assert.deepEqual(ids.map(id => found.includes(id)), [true, false, false])
    } finally {
      bearer = token.token; browser = false; activeWorkspaceId = ws.id
      await pool.query('DELETE FROM issues WHERE id=ANY($1::uuid[])', [[personalTask, unlinkedTask]])
    }
  })
  await t.test('self-improvement reads a run of the token workspace only', async () => {
    const route = await import('../app/api/self-improvement/route')
    assert.equal((await call(route.GET, `/api/self-improvement?runId=${ownRun}`, {})).status, 200)
    assert.equal((await call(route.GET, `/api/self-improvement?runId=${otherRun}`, {})).status, 404)
    // A task without a Team link still belongs to its persisted workspace.
    assert.equal((await call(route.GET, `/api/self-improvement?runId=${ownBotLooseRun}`, {})).status, 200)
    assert.equal((await call(route.GET, `/api/self-improvement?runId=${otherBotLooseRun}`, {})).status, 404)
    bearer = personalToken.token
    try {
      for (const runId of [ownBotLooseRun, otherBotLooseRun]) {
        assert.equal((await call(route.GET, `/api/self-improvement?runId=${runId}`, {})).status, 404)
        assert.equal((await call(route.POST, '/api/self-improvement', {}, { action: 'propose', runId })).status, 404)
        assert.equal((await call(route.POST, '/api/self-improvement', {}, { action: 'feedback', eventId: randomUUID(), runId, verdict: 'negative' })).status, 404)
        assert.equal(Number((await pool.query('SELECT count(*) FROM improvement_scores WHERE "runId"=$1', [runId])).rows[0].count), 0)
      }
    } finally {
      bearer = token.token
    }
    // A run with no task has no improvement record to reach.
    assert.equal((await call(route.GET, `/api/self-improvement?runId=${otherBotNoTaskRun}`, {})).status, 404)
    const unknown = randomUUID()
    assert.equal((await call(route.GET, `/api/self-improvement?runId=${unknown}`, {})).status, 404)
    assert.equal((await call(route.POST, '/api/self-improvement', {}, { action: 'feedback', eventId: randomUUID(), runId: unknown, verdict: 'negative' })).status, 404)
    assert.equal(Number((await pool.query('SELECT count(*) FROM improvement_feedback WHERE "runId"=$1', [unknown])).rows[0].count), 0)
  })

  // Each immutable improvement record must keep both its task tenant and all
  // source-run tenants. Broken historical provenance never supplies a grant.
  const scorer = randomUUID().replaceAll('-', '')
  await pool.query(`INSERT INTO improvement_scorers (digest,id,version,definition) VALUES ($1,$1,1,'{}')`, [scorer])
  const proposal = async (issueId: string, sourceRuns: string[]) => {
    const id = randomUUID(), bucket = randomUUID(), task = randomUUID(), attempt = randomUUID(), event = randomUUID()
    await pool.query(`INSERT INTO improvement_proposals (id,"userId",bucket,fingerprint,"issueId","scorerDigest",candidate,result,status)
      VALUES ($1,$2,$3,$4,$5,$6,'{}','{}','awaiting_model_candidate')`, [id, owner, bucket, randomUUID(), issueId, scorer])
    for (const runId of sourceRuns) {
      const score = randomUUID()
      await pool.query(`INSERT INTO improvement_feedback (id,"userId","eventId","runId","issueId",fingerprint,verdict,note) VALUES ($1,$2,$3,$4,$5,'f','negative','')`, [score, owner, randomUUID(), runId, issueId])
      await pool.query(`INSERT INTO improvement_scores (id,"userId","runId",bucket,"scorerDigest",outcome,reason,snapshot) VALUES ($1,$2,$3,$4,$5,'failure','r','{}')`, [score, owner, runId, bucket, scorer])
      await pool.query('INSERT INTO improvement_proposal_sources ("proposalId","scoreId","userId",bucket,"runId") VALUES ($1,$2,$3,$4,$5)', [id, score, owner, bucket, runId])
    }
    // Its Factory handoff, so its status reads. Its Factory task and attempt reference each other (a deferred key), so they go in together.
    await pool.query(`INSERT INTO coordinator_events (id,"userId",kind,"dedupeKey",payload) VALUES ($1,$2,'user_message',$3,'{}')`, [event, owner, event])
    await pool.query(`WITH t AS (INSERT INTO factory_tasks (id,"userId","issueId","sourceEventId",route,stage,status,"attemptId",reason)
      VALUES ($1,$2,$3,$4,'{}','execute','running',$5,'Scope fixture'))
      INSERT INTO factory_attempts (id,"taskId",stage,ordinal,position,status,reason) VALUES ($5,$1,'execute',1,1,'running','Scope fixture')`, [task, owner, issueId, event, attempt])
    await pool.query(`INSERT INTO improvement_factory_links ("proposalId","userId","issueId","taskId","attemptId","runId",request) VALUES ($1,$2,$3,$4,$5,$6,'{}')`,
      [id, owner, issueId, task, attempt, sourceRuns[0] ?? randomUUID()])
    return { id, binding: { taskId: task, issueId, attemptId: attempt, revision: 1, candidateId: null } }
  }
  const personalLooseRun = await run(null, personalLooseIssue)
  const ownProposal = await proposal(ownLooseIssue, [ownBotLooseRun]), otherProposal = await proposal(otherLooseIssue, [otherBotLooseRun])
  const personalProposal = await proposal(personalLooseIssue, [personalLooseRun])
  const sourcelessProposal = await proposal(ownLooseIssue, []), danglingProposal = await proposal(ownLooseIssue, [randomUUID()])
  const mixedProposal = await proposal(ownLooseIssue, [ownBotLooseRun, otherBotLooseRun])
  const mismatchedProposal = await proposal(otherLooseIssue, [ownBotLooseRun])
  const instance = randomUUID(), candidateVersion = randomUUID(), baselineVersion = randomUUID(), evaluation = randomUUID()
  await pool.query(`INSERT INTO improvement_benchmark_instances (id,"userId","issueId","agentId","repoId","sourceRunId","sourceCommit","definitionDigest","instanceDigest",seed,settings)
    VALUES ($1,$2,$3,$4,$5,$6,repeat('a',40),'definition','instance',repeat('b',64),'{}')`, [instance, owner, otherLooseIssue, agent, repo, otherBotLooseRun])
  await pool.query(`INSERT INTO improvement_skill_versions (id,artifact,markdown) VALUES ($1,'{}',''),($2,'{}','')`, [candidateVersion, baselineVersion])
  await pool.query(`INSERT INTO improvement_skill_candidates ("versionId","userId","issueId","agentId","repoId","proposalId","factoryTaskId","candidateId",repository,"commitSha",path,"baselineVersionId")
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'repo',repeat('c',40),'SKILL.md',$9)`, [candidateVersion, owner, otherLooseIssue, agent, repo, otherProposal.id, otherProposal.binding.taskId, randomUUID(), baselineVersion])
  await pool.query(`INSERT INTO improvement_skill_evaluations (id,"instanceId","userId","proposalId","candidateVersionId",scope) VALUES ($1,$2,$3,$4,$5,'{}')`,
    [evaluation, instance, owner, otherProposal.id, candidateVersion])

  await t.test('self-improvement keeps a token to records made from runs of its workspace', async () => {
    const route = await import('../app/api/self-improvement/route')
    const post = (body: unknown) => call(route.POST, '/api/self-improvement', {}, body)
    const proposalStatus = async (id: string) => (await call(route.GET, `/api/self-improvement?proposalId=${id}`, {})).status
    assert.equal(await proposalStatus(ownProposal.id), 200)
    for (const id of [otherProposal.id, personalProposal.id, sourcelessProposal.id, danglingProposal.id, mixedProposal.id, mismatchedProposal.id]) {
      assert.equal(await proposalStatus(id), 404)
    }
    bearer = personalToken.token
    try {
      assert.equal(await proposalStatus(personalProposal.id), 200)
      assert.equal(await proposalStatus(otherProposal.id), 404)
      assert.equal(await proposalStatus(ownProposal.id), 404)
      assert.equal((await post({ action: 'handoff', proposalId: otherProposal.id, binding: otherProposal.binding, agentId: agent, deviceRepoId: repo })).status, 404)
      assert.equal((await post({ action: 'register_candidate', proposalId: otherProposal.id, binding: otherProposal.binding })).status, 404)
      assert.equal((await post({ action: 'dispatch_training', instanceId: instance })).status, 404)
      assert.equal((await post({ action: 'begin_evaluation', instanceId: instance, proposalId: personalProposal.id, candidateVersionId: candidateVersion })).status, 404)
      assert.equal((await post({ action: 'dispatch_evaluation', evaluationId: evaluation })).status, 404)
      assert.equal((await post({ action: 'compare_evaluation', evaluationId: evaluation })).status, 404)
      for (const id of [sourcelessProposal.id, danglingProposal.id, mixedProposal.id, mismatchedProposal.id]) assert.equal(await proposalStatus(id), 404)
    } finally {
      bearer = token.token
    }
  })

  await t.test('browser evidence and self-improvement use the selected workspace and reject broken provenance without side effects', async () => {
    const route = await import('../app/api/self-improvement/route')
    const evidence = await import('../app/api/runs/[runId]/evidence/route')
    const thread = await import('../app/api/mobile/threads/[id]/route')
    const unknownRun = randomUUID()
    const read = async (runId: string) => (await call(route.GET, `/api/self-improvement?runId=${runId}`, {})).status
    const proposalStatus = async (id: string) => (await call(route.GET, `/api/self-improvement?proposalId=${id}`, {})).status
    const scores = async () => Number((await pool.query('SELECT count(*) FROM improvement_scores WHERE "userId"=$1', [owner])).rows[0].count)
    const before = await scores()
    bearer = null; browser = true; activeWorkspaceId = ws.id
    try {
      assert.equal(await read(ownBotLooseRun), 200)
      assert.equal(await proposalStatus(ownProposal.id), 200)
      for (const runId of [otherBotLooseRun, otherRun, unknownRun]) {
        assert.equal(await read(runId), 404)
        assert.equal((await call(evidence.GET, `/api/runs/${runId}/evidence`, { runId })).status, 404)
        assert.equal((await call(thread.GET, `/api/mobile/threads/${runId}`, { id: runId })).status, 404)
        assert.equal((await call(route.POST, '/api/self-improvement', {}, { action: 'propose', runId })).status, 404)
        assert.equal((await call(route.POST, '/api/self-improvement', {}, { action: 'feedback', eventId: randomUUID(), runId, verdict: 'negative' })).status, 404)
      }
      for (const id of [otherProposal.id, sourcelessProposal.id, danglingProposal.id, mixedProposal.id, mismatchedProposal.id]) assert.equal(await proposalStatus(id), 404)
      assert.equal((await call(route.POST, '/api/self-improvement', {}, { action: 'handoff', proposalId: otherProposal.id, binding: otherProposal.binding, agentId: agent, deviceRepoId: repo })).status, 404)
      assert.equal((await call(route.POST, '/api/self-improvement', {}, { action: 'dispatch_training', instanceId: instance })).status, 404)
      assert.equal((await call(route.POST, '/api/self-improvement', {}, { action: 'dispatch_evaluation', evaluationId: evaluation })).status, 404)
      assert.equal(await scores(), before, 'denied browser writes record no score or feedback')
      activeWorkspaceId = other.id
      assert.equal(await read(otherBotLooseRun), 200)
      assert.equal(await read(otherRun), 200)
      assert.equal(await proposalStatus(otherProposal.id), 200)
      assert.equal((await call(evidence.GET, `/api/runs/${otherRun}/evidence`, { runId: otherRun })).status, 200)
      assert.equal((await call(thread.GET, `/api/mobile/threads/${otherRun}`, { id: otherRun })).status, 200)
      assert.equal(await read(ownRun), 404)
      assert.equal(await proposalStatus(ownProposal.id), 404)
      for (const id of [sourcelessProposal.id, danglingProposal.id, mixedProposal.id, mismatchedProposal.id]) assert.equal(await proposalStatus(id), 404)
      await pool.query(`UPDATE mikka_workspace_members SET status='suspended' WHERE "workspaceId"=$1 AND "userId"=$2`, [other.id, owner])
      try {
        assert.equal(await read(otherRun), 404, 'a saved browser cookie cannot revive removed workspace membership')
        assert.equal((await call(evidence.GET, `/api/runs/${otherRun}/evidence`, { runId: otherRun })).status, 404)
      } finally { await pool.query(`UPDATE mikka_workspace_members SET status='active' WHERE "workspaceId"=$1 AND "userId"=$2`, [other.id, owner]) }
    } finally { bearer = token.token; browser = false; activeWorkspaceId = ws.id }
  })
})
