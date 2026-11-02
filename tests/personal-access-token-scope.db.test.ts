import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mock, test } from 'node:test'
import { Pool } from 'pg'
import { dbUrl, seedAgent, seedBot, seedRun, seedTeam, seedUser, seedWorkspace } from './support/workspace-admin-db'

/** A token pinned to one workspace reaches its owner's threads, evidence, proposals and chats
 * of that workspace only. Real token storage and route logic; only Next's request context is a fixture. */
test('a workspace token stays in its workspace on thread, evidence, proposal and chat routes', { skip: !dbUrl }, async t => {
  const pool = new Pool({ connectionString: dbUrl })
  const owner = await seedUser(pool, 'pat-scope-owner')
  const ws = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }])
  const other = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }])
  // The owner's personal workspace: the one a record naming no workspace belongs to.
  const personal = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }])
  await pool.query(`UPDATE mikka_workspaces SET kind='personal' WHERE id=$1`, [personal.id])
  const ownBot = await seedBot(pool, ws.id, owner), otherBot = await seedBot(pool, other.id, owner)
  const ownTeam = await seedTeam(pool, ws.id, owner), otherTeam = await seedTeam(pool, other.id, owner)
  const ownIssue = randomUUID(), otherIssue = randomUUID()
  for (const [issueId, workspaceId, teamId] of [[ownIssue, ws.id, ownTeam.id], [otherIssue, other.id, otherTeam.id]]) {
    await pool.query(`INSERT INTO issues (id,"userId",title,content,status,priority,scope) VALUES ($1,$2,'Task','{"type":"doc"}','todo','normal','workspace')`, [issueId, owner])
    await pool.query('INSERT INTO mikka_team_issues ("issueId","teamId","workspaceId","userId") VALUES ($1,$2,$3,$4)', [issueId, teamId, workspaceId, owner])
  }
  const agent = await seedAgent(pool, owner)
  const device = randomUUID(), repo = randomUUID()
  await pool.query(`INSERT INTO devices (id,"ownerId",name,kind,enabled,"lastSeenAt") VALUES ($1,$2,'Laptop','local',true,now())`, [device, owner])
  await pool.query(`INSERT INTO device_repos (id,"deviceId","userId","repoPath") VALUES ($1,$2,$3,'/repo')`, [repo, device, owner])
  const run = async (botId: string | null, issueId: string | null) => {
    const id = await seedRun(pool, { userId: owner, agentId: agent, botId, issueId, status: 'succeeded', finishedAt: new Date() })
    await pool.query(`UPDATE agent_runs SET "deviceId"=$2,"deviceRepoId"=$3,"sessionId"='session' WHERE id=$1`, [id, device, repo])
    return id
  }
  // Another workspace's run: by its Bot, or (no Bot) by its task.
  const ownRun = await run(ownBot, ownIssue), otherRun = await run(otherBot, otherIssue), otherTaskRun = await run(null, otherIssue)
  // A task in no workspace: only its run's Bot places the run.
  const looseIssue = randomUUID()
  await pool.query(`INSERT INTO issues (id,"userId",title,content,status,priority,scope) VALUES ($1,$2,'Task','{"type":"doc"}','todo','normal','personal')`, [looseIssue, owner])
  const ownBotLooseRun = await run(ownBot, looseIssue), otherBotLooseRun = await run(otherBot, looseIssue), otherBotNoTaskRun = await run(otherBot, null)

  let currentHeaders = new Headers()
  mock.module('next/headers', { namedExports: { headers: async () => currentHeaders, cookies: async () => ({ get: () => undefined }) } })
  mock.module('next-intl/server', { namedExports: { getLocale: async () => 'en', getTranslations: async () => Object.assign((code: string) => code, { has: () => true }) } })
  // A browser session (no bearer token) is the owner's cookie session when `browser` is set.
  let browser = false
  const ownerName = 'pat-scope-owner'
  mock.module('@/lib/auth', { namedExports: { MOBILE_APP_ORIGIN: 'mikka://', auth: { api: { getSession: async () => browser ? { user: { id: owner, name: ownerName, email: `${owner}@example.invalid`, image: null }, session: { id: 'browser' } } : null } } } })
  const next = await import('next/server')
  mock.module('next/server', { namedExports: { ...next, after: () => {} } })
  const store = await import('../lib/tokens/store')
  const token = await store.createPersonalAccessToken(owner, ws.id, { name: 'Scope test' })
  const personalToken = await store.createPersonalAccessToken(owner, personal.id, { name: 'Scope test personal' })
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
  await t.test('a record naming no workspace: the personal workspace token only', async () => {
    const list = await import('../app/api/mobile/threads/route')
    const evidence = await import('../app/api/runs/[runId]/evidence/route')
    const download = await import('../app/api/artifacts/[artifactId]/versions/[version]/download/route')
    const listRoute = await import('../app/api/pending-actions/route')
    const decide = await import('../app/api/mobile/pending-actions/[id]/route')
    const reactions = await import('../app/api/mobile/reactions/route')
    // No Bot and no task; a personal task linked to no workspace; an OAuth client's artifact; an older proposal; an older Coordinator message.
    const personalIssue = randomUUID()
    await pool.query(`INSERT INTO issues (id,"userId",title,content,status,priority) VALUES ($1,$2,'Mine','{"type":"doc"}','todo','normal')`, [personalIssue, owner])
    const bare = await run(null, null), personalTask = await run(null, personalIssue)
    // A cloud computer run with no Bot of its own belongs to the workspace its binding names.
    const bound = await run(null, null)
    await pool.query('INSERT INTO computer_run_bindings ("runId","botId","workspaceId","ownerId") VALUES ($1,$2,$3,$4)', [bound, ownBot, ws.id, owner])
    const artifact = randomUUID(), proposal = randomUUID(), message = randomUUID()
    await pool.query(`INSERT INTO artifacts (id,"userId",kind,title) VALUES ($1,$2,'markdown','From a client')`, [artifact, owner])
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
      // A browser session: unchanged, every record of the owner.
      bearer = null; browser = true
      assert.deepEqual(await reach(), { threads: [true, true], evidence: [200, 200], artifact: 200, proposals: true })
      assert.equal((await call(evidence.GET, `/api/runs/${otherRun}/evidence`, { runId: otherRun })).status, 200)
    } finally {
      bearer = token.token; browser = false
      await pool.query('DELETE FROM agent_runs WHERE id=ANY($1::uuid[])', [[bare, personalTask, bound]])
      await pool.query('DELETE FROM issues WHERE id=$1', [personalIssue])
      await pool.query('DELETE FROM pending_actions WHERE id=$1', [proposal])
      await pool.query('DELETE FROM message_reactions WHERE "messageId"=$1', [message])
      await pool.query('DELETE FROM coordinator_messages WHERE id=$1', [message])
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
  })

  await t.test('the home counts', async () => {
    const home = await import('../app/api/mobile/home/route')
    await pool.query(`UPDATE agent_runs SET status='running' WHERE id=ANY($1::uuid[])`, [[ownRun, otherRun]])
    try {
      const result = await call(home.GET, '/api/mobile/home', {})
      assert.equal(result.status, 200)
      assert.equal(result.body.threads.running, 1)
    } finally { await pool.query(`UPDATE agent_runs SET status='succeeded' WHERE id=ANY($1::uuid[])`, [[ownRun, otherRun]]) }
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
    // A bare id, as the Coordinator and MCP pass, keeps the owner's reach.
    assert.equal((await actAs(owner, () => requireIssueAccess(otherIssue))).issue.id, otherIssue)
  })
  await t.test('tasks: a team token reaches only its workspace tasks; the personal token keeps personal and unlinked ones', async () => {
    const [{ actAs }, { requireIssueAccess, issueForUser }, { getApiSession }] = await Promise.all([import('../lib/acting-user'), import('../lib/issue-access'), import('../lib/api-auth')])
    const tasks = await import('../app/api/mobile/tasks/route')
    const search = await import('../app/api/issues/search/route')
    const personalTask = randomUUID(), unlinkedTask = randomUUID()
    await pool.query(`INSERT INTO issues (id,"userId",title,content,status,priority) VALUES ($1,$2,'Mine','{"type":"doc"}','todo','normal')`, [personalTask, owner])
    await pool.query(`INSERT INTO issues (id,"userId",title,content,status,priority,scope) VALUES ($1,$2,'Loose','{"type":"doc"}','todo','normal','workspace')`, [unlinkedTask, owner])
    const ids = [ownIssue, personalTask, unlinkedTask]
    const reach = async () => {
      const listed = (await call(tasks.GET, '/api/mobile/tasks', {})).body.tasks.map((item: { id: string }) => item.id)
      const found = (await call(search.GET, '/api/issues/search?q=', {})).body.items.map((item: { id: string }) => item.id)
      const session = bearer ? await getApiSession({ headers: new Headers({ authorization: `Bearer ${bearer}` }) }) : null
      const user = session?.user ?? owner
      const read = await Promise.all(ids.map(async id => Boolean(await issueForUser(user, id))))
      const acted = await Promise.all(ids.map(id => actAs(user, () => requireIssueAccess(id)).then(() => true, () => false)))
      return { listed: ids.map(id => listed.includes(id)), searched: ids.map(id => found.includes(id)), read, acted }
    }
    try {
      // [W-linked task, personal task, unlinked task]
      assert.deepEqual(await reach(), { listed: [true, false, false], searched: [true, false, false], read: [true, false, false], acted: [true, false, false] })
      bearer = personalToken.token
      assert.deepEqual(await reach(), { listed: [false, true, true], searched: [false, true, true], read: [false, true, true], acted: [false, true, true] })
      // A browser session: unchanged, the owner's tasks wherever they are.
      bearer = null; browser = true
      const read = await Promise.all(ids.map(async id => Boolean(await issueForUser(owner, id))))
      assert.deepEqual(read, [true, true, true])
      const found = (await call(search.GET, `/api/issues/search?q=&workspaceId=${ws.id}`, {})).body.items.map((item: { id: string }) => item.id)
      assert.deepEqual(ids.map(id => found.includes(id)), [true, true, true])
    } finally {
      bearer = token.token; browser = false
      await pool.query('DELETE FROM issues WHERE id=ANY($1::uuid[])', [[personalTask, unlinkedTask]])
    }
  })
  await t.test('self-improvement reads a run of the token workspace only', async () => {
    const route = await import('../app/api/self-improvement/route')
    assert.equal((await call(route.GET, `/api/self-improvement?runId=${ownRun}`, {})).status, 200)
    assert.equal((await call(route.GET, `/api/self-improvement?runId=${otherRun}`, {})).status, 404)
    // A team token reaches no task in no workspace (the task allowlist), so neither run on one opens.
    assert.equal((await call(route.GET, `/api/self-improvement?runId=${ownBotLooseRun}`, {})).status, 404)
    assert.equal((await call(route.GET, `/api/self-improvement?runId=${otherBotLooseRun}`, {})).status, 404)
    // The personal token keeps tasks in no workspace, so only the run's Bot keeps it out of a team
    // workspace's run: a task in no workspace does not open a run whose Bot is in another one.
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
  })

  await t.test('self-improvement keeps a browser session to its owner checks', async () => {
    const route = await import('../app/api/self-improvement/route')
    // The mocked cookie session, as the owner's browser.
    const { api } = (await import('../lib/auth')).auth as unknown as { api: { getSession: () => Promise<unknown> } }
    const signedOut = api.getSession
    api.getSession = async () => ({ user: { id: owner }, session: { id: 'browser' } })
    try {
      const read = (runId: string) => route.GET(new Request(`${origin}/api/self-improvement?runId=${runId}`, { headers: currentHeaders = new Headers() }))
      assert.equal((await read(otherBotLooseRun)).status, 200)
      assert.equal((await read(otherRun)).status, 200)
    } finally { api.getSession = signedOut }
  })
})
