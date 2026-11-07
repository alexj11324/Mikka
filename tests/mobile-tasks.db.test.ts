import 'next/dist/server/node-environment-baseline'
import assert from 'node:assert/strict'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { Pool } from 'pg'
import { dbUrl, seedAgent, seedBot, seedIssue, seedPersonalWorkspace, seedRun, seedTeam, seedUser, seedWorkspace } from './support/workspace-admin-db'
import { measured } from './helpers/read-metrics'

type ReadOptions = { bearer?: string | null; workspaceId?: string | null; cookie?: string }

const sqlState = (error: unknown): string | undefined => {
  if (!error || typeof error !== 'object') return undefined
  if ('code' in error && typeof error.code === 'string') return error.code
  return 'cause' in error ? sqlState(error.cause) : undefined
}

test('mobile task endpoints with real task ACL, current workspace membership and run history', { skip: !dbUrl, timeout: 120_000 }, async t => {
  // workspace-admin-db validates loopback *_e2e and identical APP/WS targets.
  // Bind both canonical pools before importing any production runtime module.
  const pool = new Pool({ connectionString: dbUrl, max: 3 })
  const app = new Pool({ connectionString: dbUrl, max: 1, connectionTimeoutMillis: 3000 })
  const workspace = new Pool({ connectionString: dbUrl, max: 1, connectionTimeoutMillis: 3000 })
  const globals = globalThis as unknown as { mikkaPool?: Pool; workspacePool?: Pool }
  const previous = { app: globals.mikkaPool, workspace: globals.workspacePool }
  const environment = { MIKKA_EDITION: process.env.MIKKA_EDITION, BETTER_AUTH_URL: process.env.BETTER_AUTH_URL,
    BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET, WORKSPACE_SECRETS_KEY: process.env.WORKSPACE_SECRETS_KEY,
    NEXT_PUBLIC_POSTHOG_KEY: process.env.NEXT_PUBLIC_POSTHOG_KEY }
  const origin = 'http://localhost:3100'
  Object.assign(process.env, { MIKKA_EDITION: 'cloud', BETTER_AUTH_URL: origin, NEXT_PUBLIC_POSTHOG_KEY: '',
    BETTER_AUTH_SECRET: randomBytes(32).toString('hex'), WORKSPACE_SECRETS_KEY: randomBytes(32).toString('hex') })
  globals.mikkaPool = app; globals.workspacePool = workspace
  const users: string[] = []
  t.after(async () => {
    try {
      if (users.length) {
        await pool.query('delete from user_schedules where owner_id=any($1::text[])', [users])
        await pool.query('delete from artifacts where "userId"=any($1::text[])', [users])
        await pool.query('delete from agent_runs where "userId"=any($1::text[])', [users])
        await pool.query('delete from issues where "userId"=any($1::text[])', [users])
        await pool.query('delete from bots where "ownerId"=any($1::text[])', [users])
        await workspace.query('delete from mikka_workspaces where "userId"=any($1::text[])', [users])
        await pool.query('delete from "user" where id=any($1::text[])', [users])
      }
    } finally {
      mock.restoreAll()
      globals.mikkaPool = previous.app; globals.workspacePool = previous.workspace
      await Promise.all([app.end(), workspace.end(), pool.end()])
      for (const [key, value] of Object.entries(environment)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })
  const context = await import('../apps/api/src/context')
  // The ordinary API framework adapters supply request-local headers, cookies,
  // translations and after-work. Authentication and authorization stay real.
  mock.module('next/headers', { namedExports: await import('../apps/api/compat/headers') })
  mock.module('next-intl/server', { namedExports: await import('../apps/api/compat/intl') })
  mock.module('next/server', { namedExports: await import('../apps/api/compat/server') })
  const { auth } = await import('../lib/auth')
  const { GET } = await import('../app/api/mobile/tasks/[id]/route')
  const { GET: list } = await import('../app/api/mobile/tasks/route')
  const { newestTaskRuns } = await import('../lib/task-block-runs')
  const owner = await seedUser(pool, 'owner'); users.push(owner)
  const other = await seedUser(pool, 'other'); users.push(other)
  const own = { id: await seedPersonalWorkspace(workspace, owner) }
  const teamWorkspace = await seedWorkspace(workspace, owner, [{ userId: owner, role: 'admin' }, { userId: other, role: 'member' }])
  const secondWorkspace = await seedWorkspace(workspace, owner, [{ userId: owner, role: 'admin' }])
  const team = await seedTeam(workspace, teamWorkspace.id, owner)
  const workspaceTask = async (workspaceId = teamWorkspace.id, linked = true) => {
    const id = await seedIssue(pool, owner, workspaceId)
    if (linked) {
      assert.equal(workspaceId, teamWorkspace.id)
      await workspace.query('insert into mikka_team_issues ("issueId","teamId","workspaceId","userId") values ($1,$2,$3,$4)', [id, team.id, workspaceId, owner])
    }
    return id
  }
  const issueId = await workspaceTask()
  await pool.query(`update issues set title='Full title',"shortTitle"='Short title',"shortTitleFrom"='Full title',content=$2,"createdAt"='2026-01-01T00:00:00Z' where id=$1`, [issueId, { type: 'doc', attrs: { mikka: { pullRequests: [{ url: 'https://github.com/acme/app/pull/1', state: 'open' }] } }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Description' }] }] }])
  const bot = await seedBot(pool, teamWorkspace.id, owner, 'Dispatcher'), agent = await seedAgent(pool, owner)
  const first = await seedRun(pool, { userId: owner, agentId: agent, workspaceId: teamWorkspace.id, botId: bot, issueId, status: 'failed' })
  const latest = await seedRun(pool, { userId: owner, agentId: agent, workspaceId: teamWorkspace.id, botId: bot, issueId })
  await pool.query(`update agent_runs set "createdAt"='2026-01-02T00:00:00Z',"threadReplacedBy"=$2,error='PRIVATE_RAW_ERROR' where id=$1`, [first, latest])
  await pool.query(`update agent_runs set "createdAt"=now(),outcome='idle',"agentDefinition"='{"harness":"codex","model":"fixture-model","modelDispatch":{"location":"cloud"}}' where id=$1`, [latest])
  const noRun = await workspaceTask()
  const schedule = randomUUID()
  await pool.query(`insert into user_schedules (id,owner_id,workspace_id,bot_id,source_event_id,request_id,definition,request_definition,status,next_at) values ($1,$2,$3,$4,$5,$6,$7,$7,'active','2030-01-01T09:00:00Z')`, [schedule, owner, teamWorkspace.id, bot, randomUUID(), randomUUID(), { title: 'Daily task', timezone: 'UTC', timing: { kind: 'daily', time: '09:00', fold: 'earlier', gap: 'skip' }, task: { kind: 'issue_snapshot', issueId: noRun }, misfire: 'skip', maxLatenessMinutes: 60 }])
  const personalTask = await seedIssue(pool, owner, own.id)
  const unlinkedTask = await workspaceTask(teamWorkspace.id, false)
  const secondTask = await workspaceTask(secondWorkspace.id, false)
  const personalBot = await seedBot(pool, own.id, owner, 'Personal dispatcher')
  const secondBot = await seedBot(pool, secondWorkspace.id, owner, 'Second dispatcher')
  const personalRun = await seedRun(pool, { userId: owner, agentId: agent, workspaceId: own.id, botId: personalBot, issueId: personalTask })
  const secondRun = await seedRun(pool, { userId: owner, agentId: agent, workspaceId: secondWorkspace.id, botId: secondBot, issueId: secondTask })
  const artifactIds: string[] = []
  for (const [workspaceId, taskId, runId] of [[own.id, personalTask, personalRun], [teamWorkspace.id, issueId, latest], [secondWorkspace.id, secondTask, secondRun]]) {
    const id = randomUUID(); artifactIds.push(id)
    await pool.query(`insert into artifacts(id,"userId","workspaceId",kind,title,"issueId","runId") values($1,$2,$3,'html','Mobile task fixture',$4,$5)`, [id, owner, workspaceId, taskId, runId])
  }
  const authContext = await auth.$context
  const native = await authContext.internalAdapter.createSession(owner); assert.ok(native)
  const peer = await authContext.internalAdapter.createSession(other); assert.ok(peer)
  const signature = createHmac('sha256', authContext.secret).update(native.token).digest('base64')
  const cookie = authContext.authCookies.sessionToken.name + '=' + encodeURIComponent(native.token + '.' + signature)
  const { createPersonalAccessToken, revokePersonalAccessToken } = await import('../lib/tokens/store')
  const pat = await createPersonalAccessToken(owner, teamWorkspace.id, { name: 'Mobile task isolated fixture', expiresAt: null })
  const selectedWorkspace = teamWorkspace.id
  const run = async (path: string, handler: (request: Request) => Promise<Response>, options: ReadOptions = {}) => {
    const bearer = options.bearer === undefined ? native.token : options.bearer
    const selection = options.workspaceId === undefined ? selectedWorkspace : options.workspaceId
    const req = new Request(origin + '/mikka' + path, { headers: {
      'x-mikka-locale': 'en', ...(bearer ? { authorization: 'Bearer ' + bearer } : {}),
      ...(selection ? { 'x-mikka-workspace-id': selection } : {}), ...(options.cookie ? { cookie: options.cookie } : {}),
    } })
    const scope = context.createRequestScope(req)
    try { return await context.runRequestScope(scope, () => handler(req)) }
    finally { await scope.after.finish() }
  }
  const request = (id: string, options?: ReadOptions) => run('/api/mobile/tasks/' + id, req => GET(req, { params: Promise.resolve({ id }) }), options)
  const listRequest = (options?: ReadOptions) => run('/api/mobile/tasks', list, options)
  const persisted = async () => (await pool.query(`select
    (select coalesce(jsonb_agg(jsonb_build_array(id,"workspaceId","ownershipState",status,title) order by id),'[]') from issues where "userId"=$1) as tasks,
    (select coalesce(jsonb_agg(jsonb_build_array(id,"workspaceId","issueId","botId",status) order by id),'[]') from agent_runs where "userId"=$1) as runs,
    (select coalesce(jsonb_agg(jsonb_build_array(id,"workspaceId","issueId","runId") order by id),'[]') from artifacts where "userId"=$1) as artifacts,
    (select coalesce(jsonb_agg(jsonb_build_array(id,workspace_id,status,next_at) order by id),'[]') from user_schedules where owner_id=$1) as schedules`, [owner])).rows[0]

  await t.test('detail includes contract fields, every attempt, replacement time and creation; excludes raw errors', async () => {
    const response = await request(issueId)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store')
    const body = await response.json()
    assert.deepEqual(Object.keys(body).sort(), ['activity', 'live', 'task'])
    assert.equal(body.task.title, 'Short title')
    assert.equal(body.task.description, 'Description')
    assert.equal(body.task.group, 'pending', 'PR metadata wins over idle')
    assert.equal(body.task.bot.id, bot)
    assert.deepEqual(body.task.agent, { harness: 'codex', model: 'fixture-model' })
    assert.deepEqual(body.task.place, { kind: 'cloud', name: 'Cloud' })
    assert.equal(body.task.schedule, null)
    assert.deepEqual(body.live, { workspaceId: teamWorkspace.id })
    assert.deepEqual(body.activity.map((row: { kind: string }) => row.kind), ['attempt', 'replaced', 'attempt', 'created'])
    assert.deepEqual(body.activity.filter((row: { kind: string }) => row.kind === 'attempt').map((row: { runId: string; n: number }) => [row.runId, row.n]), [[latest, 2], [first, 1]])
    assert.equal(body.activity[0].group, 'waiting', 'attempts retain the five thread groups consumed by iOS')
    assert.equal(body.activity[0].createdAt, body.activity[1].createdAt)
    assert.equal(body.activity.at(-1).by, 'owner')
    assert.doesNotMatch(JSON.stringify(body), /PRIVATE_RAW_ERROR|failureDetails|"error"/)
  })
  await t.test('list decorations share one batched read, cover no-thread schedules and preserve blocked', async () => {
    const measurement = await measured(() => newestTaskRuns(owner, [issueId, noRun], teamWorkspace.id))
    assert.equal(measurement.statements, 1)
    assert.equal(measurement.value.find(row => row.issueId === noRun)?.runId, null)
    const body = await (await listRequest()).json()
    const row = body.tasks.find((item: { id: string }) => item.id === issueId)
    assert.equal(row.group, 'pending'); assert.equal(row.bot.id, bot); assert.ok(row.createdAt)
    assert.ok(Object.hasOwn(row, 'blocked'))
    const scheduled = body.tasks.find((item: { id: string }) => item.id === noRun)
    assert.equal(scheduled.group, 'todo'); assert.equal(scheduled.bot, null)
    assert.equal(scheduled.schedule.label, 'Every day at 09:00')
    assert.equal(Date.parse(scheduled.schedule.nextAt), Date.parse('2030-01-01T09:00:00Z'))
    await pool.query(`update issues set status='done' where id=$1`, [issueId])
    const closed = await (await listRequest()).json()
    assert.equal(closed.tasks.find((item: { id: string }) => item.id === issueId).group, 'done')
    assert.equal((await (await request(issueId)).json()).task.group, 'done')
  })
  await t.test('without a thread, board flags and open dependencies put both list and detail in pending', async () => {
    const groups = async () => {
      const listBody = await (await listRequest()).json()
      const row = listBody.tasks.find((item: { id: string }) => item.id === noRun)
      const detail = await (await request(noRun)).json()
      return [row.group, detail.task.group]
    }
    const metadata = async (value: unknown) => pool.query('update issues set content=$2 where id=$1', [noRun, { type: 'doc', attrs: { mikka: value } }])
    await metadata({ block: { blocked: true, runId: null } })
    assert.deepEqual(await groups(), ['pending', 'pending'])
    await pool.query(`update issues set status='done' where id=$1`, [noRun])
    assert.deepEqual(await groups(), ['done', 'done'])
    await pool.query(`update issues set status='todo' where id=$1`, [noRun])
    const blocker = await workspaceTask()
    await metadata({ blockedByIds: [blocker] })
    assert.deepEqual(await groups(), ['pending', 'pending'])
    await pool.query(`update issues set status='done' where id=$1`, [blocker])
    assert.deepEqual(await groups(), ['todo', 'todo'])
    await pool.query(`update issues set status='todo' where id=$1`, [blocker])
    await metadata({ blockedByIds: [blocker], block: { blocked: false, runId: null } })
    assert.deepEqual(await groups(), ['todo', 'todo'], 'an explicitly cleared board block stays clear')
  })
  await t.test('task, run and Artifact origins are persisted, immutable and cannot disagree', async () => {
    const rows = (await pool.query(`select a.id,a."workspaceId" as artifact,r."workspaceId" as run,i."workspaceId" as task
      from artifacts a join agent_runs r on r.id=a."runId" join issues i on i.id=a."issueId"
      where a.id=any($1::uuid[]) order by a.id`, [artifactIds])).rows
    assert.equal(rows.length, 3)
    assert.ok(rows.every(row => row.artifact === row.run && row.run === row.task))
    const before = await persisted()
    await assert.rejects(pool.query('update issues set "workspaceId"=$2 where id=$1', [issueId, secondWorkspace.id]), error => sqlState(error) === '23514')
    await assert.rejects(seedRun(pool, { userId: owner, agentId: agent, workspaceId: secondWorkspace.id, botId: secondBot, issueId }), error => sqlState(error) === '23514')
    await assert.rejects(pool.query(`insert into artifacts(id,"userId","workspaceId",kind,title,"issueId","runId")
      values($1,$2,$3,'html','Rejected foreign origin',$4,$5)`, [randomUUID(), owner, secondWorkspace.id, issueId, latest]), error => sqlState(error) === '23514')
    assert.deepEqual(await persisted(), before)
  })

  await t.test('one account switches Personal and two Shared tenants without mixing tasks, attempts or decorations', async () => {
    const examples = [
      { workspaceId: own.id, taskId: personalTask, runIds: [personalRun] },
      { workspaceId: teamWorkspace.id, taskId: issueId, runIds: [latest, first] },
      { workspaceId: secondWorkspace.id, taskId: secondTask, runIds: [secondRun] },
    ]
    for (const example of examples) {
      const selected = { workspaceId: example.workspaceId }
      const response = await listRequest(selected)
      assert.equal(response.status, 200)
      const body = await response.json()
      const expected = (await pool.query(`select id from issues where "userId"=$1 and "workspaceId"=$2 and "ownershipState"='bound' order by id`, [owner, example.workspaceId])).rows.map(row => row.id)
      assert.deepEqual(body.tasks.map((row: { id: string }) => row.id).sort(), expected)
      const detail = await request(example.taskId, selected)
      assert.equal(detail.status, 200)
      const value = await detail.json()
      assert.equal(value.task.id, example.taskId)
      assert.deepEqual(value.live, { workspaceId: example.workspaceId })
      assert.deepEqual(value.activity.filter((row: { kind: string }) => row.kind === 'attempt').map((row: { runId: string }) => row.runId), example.runIds)
      const browser = await request(example.taskId, { bearer: null, workspaceId: null, cookie: cookie + '; mikka-workspace=' + example.workspaceId })
      assert.equal(browser.status, 200, 'the native signed cookie reaches the same selected tenant')
      for (const foreign of examples.filter(row => row.workspaceId !== example.workspaceId)) {
        assert.equal((await request(foreign.taskId, selected)).status, 404)
        for (const id of [foreign.taskId, ...foreign.runIds]) assert.ok(!JSON.stringify(value).includes(id))
      }
    }
  })

  await t.test('a bound Shared task needs no Team link and remains visible with provider sync disabled', async () => {
    assert.equal((await workspace.query('select count(*)::int as n from mikka_team_issues where "issueId"=$1', [unlinkedTask])).rows[0].n, 0)
    assert.deepEqual((await pool.query('select "workspaceId","ownershipState","linearSyncPolicy" from issues where id=$1', [unlinkedTask])).rows[0],
      { workspaceId: teamWorkspace.id, ownershipState: 'bound', linearSyncPolicy: 'disabled' })
    const response = await request(unlinkedTask)
    assert.equal(response.status, 200)
    assert.equal((await response.json()).task.id, unlinkedTask)
    assert.equal((await request(unlinkedTask, { bearer: peer.token })).status, 200, 'an active workspace peer can read without Team membership')
    const listed = await (await listRequest()).json()
    assert.ok(listed.tasks.some((row: { id: string }) => row.id === unlinkedTask))
  })

  await t.test('the single decoration query excludes unresolved tasks and foreign schedule origins', async () => {
    // Unresolved migration input is a legal quarantined row. Never turn off a
    // trigger or invent an impossible bound-task/foreign-run relationship.
    const pending = randomUUID(), foreignSchedule = randomUUID()
    await pool.query(`insert into issues(id,"userId","workspaceId","ownershipState",scope,title,content,status,priority)
      values($1,$2,null,'pending','workspace','Unresolved mobile fixture','{"type":"doc"}','todo','normal')`, [pending, owner])
    const definition = { title: 'Foreign schedule must not appear', timezone: 'UTC', timing: { kind: 'daily', time: '01:00', fold: 'earlier', gap: 'skip' },
      task: { kind: 'issue_snapshot', issueId: noRun }, misfire: 'skip', maxLatenessMinutes: 60 }
    await pool.query(`insert into user_schedules(id,owner_id,workspace_id,bot_id,source_event_id,request_id,definition,request_definition,status,next_at)
      values($1,$2,$3,$4,$5,$6,$7,$7,'active','2029-01-01T01:00:00Z')`, [foreignSchedule, owner, secondWorkspace.id, secondBot, randomUUID(), randomUUID(), definition])
    try {
      const selected = await measured(() => newestTaskRuns(owner, [noRun, secondTask, personalTask, pending], teamWorkspace.id))
      assert.equal(selected.statements, 1)
      assert.deepEqual(selected.value.map(row => row.issueId), [noRun])
      assert.equal(selected.value[0].runId, null)
      assert.equal(selected.value[0].schedule?.label, 'Daily task')
      const unscoped = await measured(() => newestTaskRuns(owner, [noRun, secondTask, pending]))
      assert.equal(unscoped.statements, 1, 'the authorized-ID batch remains one query when no explicit tenant argument is supplied')
      assert.deepEqual(unscoped.value.map(row => row.issueId).sort(), [noRun, secondTask].sort())
      assert.equal(unscoped.value.find(row => row.issueId === noRun)?.schedule?.label, 'Daily task')
      assert.equal(unscoped.value.find(row => row.issueId === secondTask)?.runId, secondRun)
      assert.equal(unscoped.value.find(row => row.issueId === secondTask)?.bot?.id, secondBot)
      assert.equal((await request(pending)).status, 404)
      const listBody = await (await listRequest()).json()
      assert.ok(!listBody.tasks.some((row: { id: string }) => row.id === pending))
      assert.equal(listBody.tasks.find((row: { id: string }) => row.id === noRun).schedule.label, 'Every day at 09:00')
      assert.equal((await (await request(noRun)).json()).task.schedule.label, 'Every day at 09:00')
    } finally {
      await pool.query('delete from user_schedules where id=$1', [foreignSchedule])
      await pool.query('delete from issues where id=$1', [pending])
    }
  })

  await t.test('real workspace PATs cannot borrow a browser cookie or override their pin with a selection header', async () => {
    const before = await persisted()
    const mixed = { bearer: pat.token, workspaceId: null, cookie: cookie + '; mikka-workspace=' + secondWorkspace.id }
    assert.equal((await request(issueId, mixed)).status, 200)
    const listed = await listRequest(mixed)
    assert.equal(listed.status, 200)
    const body = await listed.json()
    assert.ok(body.tasks.some((row: { id: string }) => row.id === issueId))
    assert.ok(!body.tasks.some((row: { id: string }) => row.id === personalTask || row.id === secondTask))
    assert.equal((await request(personalTask, mixed)).status, 404)
    assert.equal((await request(secondTask, mixed)).status, 404)
    for (const workspaceId of [own.id, secondWorkspace.id]) {
      assert.equal((await request(issueId, { ...mixed, workspaceId })).status, 404)
      const denied = await listRequest({ ...mixed, workspaceId })
      assert.equal(denied.status, 403)
      assert.deepEqual(await denied.json(), { error: 'workspaceAccessDenied' })
    }
    const malformed = { ...mixed, bearer: 'mkp_invalid' }
    assert.equal((await request(issueId, malformed)).status, 401)
    assert.equal((await listRequest(malformed)).status, 401)
    await revokePersonalAccessToken(owner, teamWorkspace.id, { id: pat.id })
    assert.equal((await request(issueId, mixed)).status, 401)
    assert.equal((await listRequest(mixed)).status, 401)
    assert.deepEqual(await persisted(), before)
  })

  await t.test('suspension and removal deny the creator while another active member retains access', async () => {
    const before = await persisted()
    const ownerMember = (await workspace.query(`select name,email,role from mikka_workspace_members where "workspaceId"=$1 and "userId"=$2`, [teamWorkspace.id, owner])).rows[0]
    assert.ok(ownerMember)
    try {
      await workspace.query(`update mikka_workspace_members set status='suspended' where "workspaceId"=$1 and "userId"=$2`, [teamWorkspace.id, owner])
      assert.equal((await request(issueId)).status, 404)
      assert.equal((await request(unlinkedTask)).status, 404)
      assert.equal((await listRequest()).status, 403)
      assert.equal((await request(unlinkedTask, { bearer: peer.token })).status, 200)
      assert.equal((await request(secondTask, { workspaceId: secondWorkspace.id })).status, 200)
      await workspace.query('delete from mikka_workspace_members where "workspaceId"=$1 and "userId"=$2', [teamWorkspace.id, owner])
      assert.equal((await request(issueId)).status, 404)
      assert.equal((await listRequest()).status, 403)
      assert.deepEqual(await persisted(), before)
    } finally {
      await workspace.query(`insert into mikka_workspace_members("workspaceId","userId",name,email,role,status)
        values($1,$2,$3,$4,$5,'active') on conflict("workspaceId","userId") do update set status='active'`,
      [teamWorkspace.id, owner, ownerMember.name, ownerMember.email, ownerMember.role])
    }
    assert.equal((await request(issueId)).status, 200)
  })

  await t.test('invalid/missing IDs are 404; unauthenticated and expired native requests are 401', async () => {
    assert.equal((await request('invalid')).status, 404)
    assert.equal((await request(randomUUID())).status, 404)
    assert.equal((await request(issueId, { bearer: null })).status, 401)
    assert.equal((await listRequest({ bearer: null })).status, 401)
    await pool.query(`update session set "expiresAt"=now()-interval '1 minute' where id=$1`, [native.id])
    assert.equal((await request(issueId)).status, 401)
    assert.equal((await listRequest()).status, 401)
    assert.equal((await request(issueId, { bearer: null, cookie })).status, 401)
  })
})
