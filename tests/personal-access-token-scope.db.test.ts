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
  mock.module('@/lib/auth', { namedExports: { MOBILE_APP_ORIGIN: 'mikka://', auth: { api: { getSession: async () => null } } } })
  const next = await import('next/server')
  mock.module('next/server', { namedExports: { ...next, after: () => {} } })
  const store = await import('../lib/tokens/store')
  const token = await store.createPersonalAccessToken(owner, ws.id, { name: 'Scope test' })
  const origin = 'http://127.0.0.1'
  const call = async <P>(handler: (request: Request, context: { params: Promise<P> }) => Promise<Response>, path: string, params: P, body?: unknown, method = body === undefined ? 'GET' : 'POST') => {
    currentHeaders = new Headers({ authorization: `Bearer ${token.token}`, origin, 'content-type': 'application/json' })
    const response = await handler(new Request(`${origin}${path}`, { method, headers: currentHeaders, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), { params: Promise.resolve(params) })
    return { status: response.status, body: response.headers.get('content-type')?.includes('json') ? await response.json() : await response.text() }
  }
  t.after(async () => {
    mock.restoreAll()
    const [{ pool: appPool }, { workspacePool }] = await Promise.all([import('../lib/db'), import('../lib/workspace-db')])
    await Promise.all([pool.end(), appPool.end(), workspacePool.end()])
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
  await t.test('self-improvement reads a run of the token workspace only', async () => {
    const route = await import('../app/api/self-improvement/route')
    assert.equal((await call(route.GET, `/api/self-improvement?runId=${ownRun}`, {})).status, 200)
    assert.equal((await call(route.GET, `/api/self-improvement?runId=${otherRun}`, {})).status, 404)
    // A task in no workspace does not open a run whose Bot is in another one.
    assert.equal((await call(route.GET, `/api/self-improvement?runId=${ownBotLooseRun}`, {})).status, 200)
    assert.equal((await call(route.GET, `/api/self-improvement?runId=${otherBotLooseRun}`, {})).status, 404)
    assert.equal((await call(route.POST, '/api/self-improvement', {}, { action: 'propose', runId: otherBotLooseRun })).status, 404)
    assert.equal((await call(route.POST, '/api/self-improvement', {}, { action: 'feedback', eventId: randomUUID(), runId: otherBotLooseRun, verdict: 'negative' })).status, 404)
    assert.equal(Number((await pool.query('SELECT count(*) FROM improvement_scores WHERE "runId"=$1', [otherBotLooseRun])).rows[0].count), 0)
    // A run with no task has no improvement record to reach.
    assert.equal((await call(route.GET, `/api/self-improvement?runId=${otherBotNoTaskRun}`, {})).status, 404)
  })

  // Records made from runs: a proposal (its source runs), a benchmark instance (its source run)
  // and an evaluation (its instance's and its proposal's source runs), all on the task in no workspace.
  const scorer = randomUUID().replaceAll('-', '')
  await pool.query(`INSERT INTO improvement_scorers (digest,id,version,definition) VALUES ($1,$1,1,'{}')`, [scorer])
  const proposal = async (sourceRuns: string[]) => {
    const id = randomUUID(), bucket = randomUUID(), task = randomUUID(), attempt = randomUUID(), event = randomUUID()
    await pool.query(`INSERT INTO improvement_proposals (id,"userId",bucket,fingerprint,"issueId","scorerDigest",candidate,result,status)
      VALUES ($1,$2,$3,$4,$5,$6,'{}','{}','awaiting_model_candidate')`, [id, owner, bucket, randomUUID(), looseIssue, scorer])
    for (const runId of sourceRuns) {
      const score = randomUUID()
      await pool.query(`INSERT INTO improvement_feedback (id,"userId","eventId","runId","issueId",fingerprint,verdict,note) VALUES ($1,$2,$3,$4,$5,'f','negative','')`, [score, owner, randomUUID(), runId, looseIssue])
      await pool.query(`INSERT INTO improvement_scores (id,"userId","runId",bucket,"scorerDigest",outcome,reason,snapshot) VALUES ($1,$2,$3,$4,$5,'failure','r','{}')`, [score, owner, runId, bucket, scorer])
      await pool.query('INSERT INTO improvement_proposal_sources ("proposalId","scoreId","userId",bucket,"runId") VALUES ($1,$2,$3,$4,$5)', [id, score, owner, bucket, runId])
    }
    // Its Factory handoff, so its status reads. Its Factory task and attempt reference each other (a deferred key), so they go in together.
    await pool.query(`INSERT INTO coordinator_events (id,"userId",kind,"dedupeKey",payload) VALUES ($1,$2,'user_message',$3,'{}')`, [event, owner, event])
    await pool.query(`WITH t AS (INSERT INTO factory_tasks (id,"userId","issueId","sourceEventId",route,stage,status,"attemptId",reason)
      VALUES ($1,$2,$3,$4,'{}','execute','running',$5,'Scope fixture'))
      INSERT INTO factory_attempts (id,"taskId",stage,ordinal,position,status,reason) VALUES ($5,$1,'execute',1,1,'running','Scope fixture')`, [task, owner, looseIssue, event, attempt])
    await pool.query(`INSERT INTO improvement_factory_links ("proposalId","userId","issueId","taskId","attemptId","runId",request) VALUES ($1,$2,$3,$4,$5,$6,'{}')`,
      [id, owner, looseIssue, task, attempt, sourceRuns[0] ?? randomUUID()])
    return { id, binding: { taskId: task, issueId: looseIssue, attemptId: attempt, revision: 1, candidateId: null } }
  }
  const ownProposal = await proposal([ownBotLooseRun]), otherProposal = await proposal([otherBotLooseRun]), sourcelessProposal = await proposal([])
  const instance = randomUUID(), candidateVersion = randomUUID(), baselineVersion = randomUUID(), evaluation = randomUUID()
  await pool.query(`INSERT INTO improvement_benchmark_instances (id,"userId","issueId","agentId","repoId","sourceRunId","sourceCommit","definitionDigest","instanceDigest",seed,settings)
    VALUES ($1,$2,$3,$4,$5,$6,repeat('a',40),'definition','instance',repeat('b',64),'{}')`, [instance, owner, looseIssue, agent, repo, otherBotLooseRun])
  await pool.query(`INSERT INTO improvement_skill_versions (id,artifact,markdown) VALUES ($1,'{}',''),($2,'{}','')`, [candidateVersion, baselineVersion])
  await pool.query(`INSERT INTO improvement_skill_candidates ("versionId","userId","issueId","agentId","repoId","proposalId","factoryTaskId","candidateId",repository,"commitSha",path,"baselineVersionId")
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'repo',repeat('c',40),'SKILL.md',$9)`, [candidateVersion, owner, looseIssue, agent, repo, otherProposal.id, otherProposal.binding.taskId, randomUUID(), baselineVersion])
  await pool.query(`INSERT INTO improvement_skill_evaluations (id,"instanceId","userId","proposalId","candidateVersionId",scope) VALUES ($1,$2,$3,$4,$5,'{}')`,
    [evaluation, instance, owner, otherProposal.id, candidateVersion])

  await t.test('self-improvement keeps a token to records made from runs of its workspace', async () => {
    const route = await import('../app/api/self-improvement/route')
    const post = (body: unknown) => call(route.POST, '/api/self-improvement', {}, body)
    assert.equal((await call(route.GET, `/api/self-improvement?proposalId=${ownProposal.id}`, {})).status, 200)
    // A proposal on a task in no workspace whose source run's Bot is in another workspace.
    assert.equal((await call(route.GET, `/api/self-improvement?proposalId=${otherProposal.id}`, {})).status, 404)
    assert.equal((await post({ action: 'handoff', proposalId: otherProposal.id, binding: otherProposal.binding, agentId: agent, deviceRepoId: repo })).status, 404)
    assert.equal((await post({ action: 'register_candidate', proposalId: otherProposal.id, binding: otherProposal.binding })).status, 404)
    assert.equal((await post({ action: 'dispatch_training', instanceId: instance })).status, 404)
    assert.equal((await post({ action: 'begin_evaluation', instanceId: instance, proposalId: ownProposal.id, candidateVersionId: candidateVersion })).status, 404)
    assert.equal((await post({ action: 'dispatch_evaluation', evaluationId: evaluation })).status, 404)
    assert.equal((await post({ action: 'compare_evaluation', evaluationId: evaluation })).status, 404)
    // A record with no source run to place it.
    assert.equal((await call(route.GET, `/api/self-improvement?proposalId=${sourcelessProposal.id}`, {})).status, 404)
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
      const proposalStatus = (id: string) => route.GET(new Request(`${origin}/api/self-improvement?proposalId=${id}`, { headers: currentHeaders = new Headers() }))
      assert.equal((await proposalStatus(otherProposal.id)).status, 200)
      assert.equal((await proposalStatus(sourcelessProposal.id)).status, 200)
    } finally { api.getSession = signedOut }
  })
})
