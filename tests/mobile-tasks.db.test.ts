import 'next/dist/server/node-environment-baseline'
import assert from 'node:assert/strict'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { Pool } from 'pg'
import { dbUrl, seedAgent, seedBot, seedIssue, seedPersonalWorkspace, seedRun, seedTeam, seedUser, seedWorkspace } from './support/workspace-admin-db'
import { measured, readMetrics } from './helpers/read-metrics'

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
        await pool.query('delete from issue_prefixes where "userId"=any($1::text[])', [users])
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
  await workspace.query(`update mikka_workspaces set "createdAt"=case when id=$1 then '2026-10-19T00:00:00Z'::timestamptz else '2026-10-25T00:00:00Z'::timestamptz end where id=any($2)`, [teamWorkspace.id, [teamWorkspace.id, own.id]])
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
  await pool.query(`insert into user_schedules (id,owner_id,workspace_id,bot_id,source_event_id,request_id,definition,request_definition,status,next_at) values ($1,$2,$3,$4,$5,$6,$7,$7,'active','2030-01-01T10:00:00Z')`, [randomUUID(), owner, own.id, personalBot, randomUUID(), randomUUID(), { title: 'Personal daily task', timezone: 'UTC', timing: { kind: 'daily', time: '10:00', fold: 'earlier', gap: 'skip' }, task: { kind: 'issue_snapshot', issueId: personalTask }, misfire: 'skip', maxLatenessMinutes: 60 }])
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
  const teamSelection = { workspaceId: teamWorkspace.id }
  const run = async <T>(path: string, handler: (request: Request) => Promise<T>, options: ReadOptions = {}) => {
    const bearer = options.bearer === undefined ? native.token : options.bearer
    const selection = options.workspaceId
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
    const body = await (await listRequest(teamSelection)).json()
    const row = body.tasks.find((item: { id: string }) => item.id === issueId)
    assert.equal(row.group, 'pending'); assert.equal(row.bot.id, bot); assert.ok(row.createdAt)
    assert.ok(Object.hasOwn(row, 'blocked'))
    const scheduled = body.tasks.find((item: { id: string }) => item.id === noRun)
    assert.equal(scheduled.group, 'todo'); assert.equal(scheduled.bot, null)
    assert.equal(scheduled.schedule.label, 'Every day at 09:00')
    assert.equal(Date.parse(scheduled.schedule.nextAt), Date.parse('2030-01-01T09:00:00Z'))
    await pool.query(`update issues set status='done' where id=$1`, [issueId])
    const closed = await (await listRequest(teamSelection)).json()
    assert.equal(closed.tasks.find((item: { id: string }) => item.id === issueId).group, 'done')
    assert.equal((await (await request(issueId)).json()).task.group, 'done')
  })
  await t.test('without a thread, board flags and open dependencies put both list and detail in pending', async () => {
    const groups = async () => {
      const listBody = await (await listRequest(teamSelection)).json()
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
  await t.test('without a cookie or header, the Personal list and authorized task tenants keep their own decorations', async () => {
    const unselected = { workspaceId: null }
    const response = await listRequest(unselected)
    assert.equal(response.status, 200)
    const row = (await response.json()).tasks.find((item: { id: string }) => item.id === personalTask)
    assert.ok(row, 'the personal default is shared by the list and detail')
    const detail = await request(personalTask, unselected)
    assert.equal(detail.status, 200)
    const body = await detail.json()
    assert.equal(body.task.bot.id, personalBot)
    assert.equal(body.task.schedule.label, 'Every day at 10:00')
    assert.deepEqual(body.live, { workspaceId: own.id })
    assert.deepEqual(row.bot, body.task.bot)
    assert.deepEqual(row.schedule, body.task.schedule)

    const { loadWorkspaceContext } = await import('../lib/workspace-access')
    const defaultContext = await run('/api/workspace', () => loadWorkspaceContext(), unselected)
    assert.equal(defaultContext.workspace.id, own.id)
    const explicit = await run('/api/workspace', () => loadWorkspaceContext(teamWorkspace.id), unselected)
    assert.equal(explicit.workspace.id, teamWorkspace.id, 'an explicit business target still wins')
    const unselectedTeam = await request(issueId, unselected)
    assert.equal(unselectedTeam.status, 200, 'a native session reads the task in its persisted Workspace, independent of the Personal default')
    const teamBody = await unselectedTeam.json()
    assert.equal(teamBody.task.bot.id, bot)
    assert.deepEqual(teamBody.live, { workspaceId: teamWorkspace.id })
    const unselectedSchedule = await request(noRun, unselected)
    assert.equal(unselectedSchedule.status, 200)
    const scheduleBody = await unselectedSchedule.json()
    assert.equal(scheduleBody.task.schedule.label, 'Every day at 09:00')
    assert.deepEqual(scheduleBody.live, { workspaceId: teamWorkspace.id })
    const selectedTeam = await request(issueId, { workspaceId: teamWorkspace.id })
    assert.equal(selectedTeam.status, 200)
    assert.deepEqual((await selectedTeam.json()).live, { workspaceId: teamWorkspace.id })

    const savedTeam = { workspaceId: null, cookie: 'mikka-workspace=' + teamWorkspace.id }
    const savedContext = await run('/api/workspace', () => loadWorkspaceContext(), savedTeam)
    assert.equal(savedContext.workspace.id, teamWorkspace.id, 'a valid workspace cookie still wins')
    assert.equal((await request(issueId, savedTeam)).status, 200)
    const personalFromTeamCookie = await request(personalTask, savedTeam)
    assert.equal(personalFromTeamCookie.status, 200, 'a normal session cookie is a preference, not an authentication pin')
    const personalBody = await personalFromTeamCookie.json()
    assert.equal(personalBody.task.bot.id, personalBot)
    assert.deepEqual(personalBody.live, { workspaceId: own.id })
    const savedPersonal = { bearer: null, workspaceId: null, cookie: cookie + '; mikka-workspace=' + own.id }
    const teamFromPersonalCookie = await request(issueId, savedPersonal)
    assert.equal(teamFromPersonalCookie.status, 200)
    const cookieTeamBody = await teamFromPersonalCookie.json()
    assert.equal(cookieTeamBody.task.bot.id, bot)
    assert.deepEqual(cookieTeamBody.live, { workspaceId: teamWorkspace.id })
    const scheduleFromPersonalCookie = await request(noRun, savedPersonal)
    assert.equal(scheduleFromPersonalCookie.status, 200)
    assert.equal((await scheduleFromPersonalCookie.json()).task.schedule.label, 'Every day at 09:00')
    for (const workspaceId of ['not-a-workspace', randomUUID()]) {
      assert.equal((await request(personalTask, { workspaceId })).status, 404, 'an invalid or inaccessible header never falls back to Personal')
      assert.equal((await listRequest({ workspaceId })).status, 403)
    }
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

  await t.test('an unlinked workspace task keeps its owner number without a repeated empty team read', async () => {
    const { setIssueTeam } = await import('../app/actions/team-relations')
    const changeTeam = (input: Parameters<typeof setIssueTeam>[0]) => run('/actions/team-relations', () => setIssueTeam(input), teamSelection)
    const unlinkedId = await workspaceTask()
    const { rows: [localTeam] } = await workspace.query('select identifier from mikka_teams where id=$1', [team.id])
    const removed = await changeTeam({ issueId: unlinkedId, teamId: null, expectedTeamId: team.id })
    assert.equal(removed.ok, true, JSON.stringify(removed))
    await pool.query('insert into issue_prefixes ("userId",prefix) values ($1,$2),($3,$4)', [owner, 'MOBI', other, 'OTHR'])
    const { rows: [numbered] } = await pool.query('select content,scope,"workspaceId","ownershipState" from issues where id=$1', [unlinkedId])
    const identifier = 'MOBI-' + numbered.content.attrs.mikka.number
    assert.equal(numbered.scope, 'workspace')
    assert.equal(numbered.workspaceId, teamWorkspace.id, 'removing a Team link cannot move task ownership')
    assert.equal(numbered.ownershipState, 'bound')
    await request(personalTask, { workspaceId: own.id })
    const warmup = await request(unlinkedId)
    assert.equal(warmup.status, 200)
    assert.equal((await warmup.json()).task.identifier, identifier)
    const personalRead = await measured(async () => {
      const response = await request(personalTask, { workspaceId: own.id })
      assert.equal(response.status, 200)
      return response.json()
    })
    const unlinkedRead = await measured(async () => {
      const response = await request(unlinkedId)
      assert.equal(response.status, 200)
      return response.json()
    })
    assert.equal(unlinkedRead.value.task.identifier, identifier)
    assert.deepEqual(unlinkedRead.value.live, { workspaceId: teamWorkspace.id }, 'an absent Team link does not turn Shared ownership into Personal')
    assert.ok(unlinkedRead.statements <= personalRead.statements,
      'the same owner and absent team link require no extra database statement for workspace scope')
    assert.equal((await request(unlinkedId, { workspaceId: own.id })).status, 404)
    const linked = await changeTeam({ issueId: unlinkedId, teamId: team.id, expectedTeamId: null })
    assert.equal(linked.ok, true)
    const relinked = await request(unlinkedId)
    assert.equal(relinked.status, 200)
    const relinkedBody = await relinked.json()
    assert.match(relinkedBody.task.identifier, new RegExp('^' + localTeam.identifier + '-\\d+$'))
    assert.deepEqual(relinkedBody.live, { workspaceId: teamWorkspace.id }, 'relinking keeps the same persisted Shared workspace')
    assert.equal((await request(unlinkedId, { workspaceId: own.id })).status, 404, 'a prior negative link read cannot cross a later team boundary')
    assert.equal((await request(unlinkedId, { workspaceId: secondWorkspace.id })).status, 404)
    t.diagnostic(JSON.stringify({ event: 'read_cache_measurement', surface: 'mobile-unlinked-task-detail', scope: 'data-read-path_not_page_http',
      personal: readMetrics(personalRead), unlinked: readMetrics(unlinkedRead) }))
  })

  await t.test('explicit workspace selections return 404 across tenants, and workspace tokens stay scoped', async () => {
    const personalPat = await createPersonalAccessToken(owner, own.id, { name: 'Mobile personal pin fixture', expiresAt: null })
    const ownerMember = (await workspace.query('select name,email,role from mikka_workspace_members where "workspaceId"=$1 and "userId"=$2', [teamWorkspace.id, owner])).rows[0]
    assert.ok(ownerMember)
    try {
      assert.equal((await request(issueId, { workspaceId: own.id })).status, 404)
      assert.equal((await request(personalTask, teamSelection)).status, 404)
      assert.equal((await request(issueId, { bearer: personalPat.token })).status, 404)
      assert.equal((await request(personalTask, { bearer: personalPat.token, workspaceId: own.id })).status, 200)
      assert.equal((await request(issueId, { bearer: pat.token })).status, 200)
      await workspace.query(`update mikka_workspace_members set status='suspended' where "workspaceId"=$1 and "userId"=$2`, [teamWorkspace.id, owner])
      assert.equal((await request(issueId)).status, 404)
      assert.equal((await request(issueId, { bearer: pat.token })).status, 401, 'real PAT authentication refuses an inactive member')
      await workspace.query('delete from mikka_workspace_members where "workspaceId"=$1 and "userId"=$2', [teamWorkspace.id, owner])
      assert.equal((await request(issueId)).status, 404)
      assert.equal((await request(issueId, { bearer: pat.token })).status, 401, 'a removed member cannot authenticate with a previously valid PAT')
    } finally {
      try {
        await workspace.query(`insert into mikka_workspace_members("workspaceId","userId",name,email,role,status)
          values($1,$2,$3,$4,$5,'active') on conflict("workspaceId","userId") do update set status='active'`,
        [teamWorkspace.id, owner, ownerMember.name, ownerMember.email, ownerMember.role])
      } finally { await revokePersonalAccessToken(owner, own.id, { id: personalPat.id }) }
    }
  })

  await t.test('the Personal default does not grant another user Personal task', async () => {
    const otherPersonal = await seedPersonalWorkspace(workspace, other)
    const unrelated = await seedIssue(pool, other, otherPersonal)
    assert.equal((await request(unrelated, { workspaceId: null })).status, 404)
    assert.equal((await request(unrelated, { workspaceId: own.id })).status, 404)
    assert.equal((await request(unrelated)).status, 404)
    assert.equal((await request(unrelated, { workspaceId: otherPersonal })).status, 404)
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
    const listed = await (await listRequest(teamSelection)).json()
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
      const listBody = await (await listRequest(teamSelection)).json()
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

  await t.test('a native detail waiting for a membership lock rechecks a committed suspension before reading projections', async () => {
    const unselected = { workspaceId: null }
    assert.equal((await request(issueId, unselected)).status, 200)
    const blocker = await pool.connect()
    let reading: Promise<Response> | undefined
    let waiting: Promise<{ query: string }> | undefined
    try {
      const pid = Number((await blocker.query('select pg_backend_pid() as pid')).rows[0].pid)
      await blocker.query('BEGIN')
      await blocker.query(`update mikka_workspace_members set status='suspended' where "workspaceId"=$1 and "userId"=$2`, [teamWorkspace.id, owner])
      reading = request(issueId, unselected)
      const waitBlockedBy = async () => {
        for (let attempt = 0; attempt < 300; attempt++) {
          const { rows } = await pool.query<{ query: string }>(`select query from pg_stat_activity
            where datname=current_database() and $1::int=any(pg_blocking_pids(pid))`, [pid])
          if (rows.length) return rows[0]
          await new Promise(resolve => setTimeout(resolve, 10))
        }
        assert.fail('the real detail request must wait for the held membership update')
      }
      waiting = waitBlockedBy()
      const blocked = await Promise.race([
        waiting,
        reading.then(() => { throw new Error('Task detail escaped the held membership lock') }),
      ])
      assert.match(blocked.query, /mikka_workspace_members/)
      assert.match(blocked.query, /for share/i)
      await blocker.query('COMMIT')
      const denied = await reading
      assert.equal(denied.status, 404)
      assert.deepEqual(await denied.json(), { error: 'issueNotFound' })
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined)
      blocker.release()
      await Promise.allSettled([reading, waiting])
      await workspace.query(`update mikka_workspace_members set status='active' where "workspaceId"=$1 and "userId"=$2`, [teamWorkspace.id, owner])
    }
    assert.equal((await request(issueId, unselected)).status, 200)
  })

  await t.test('suspension and removal deny the creator while another active member retains access', async () => {
    const before = await persisted()
    const unselected = { workspaceId: null }
    const ownerMember = (await workspace.query(`select name,email,role from mikka_workspace_members where "workspaceId"=$1 and "userId"=$2`, [teamWorkspace.id, owner])).rows[0]
    assert.ok(ownerMember)
    try {
      assert.equal((await request(issueId, unselected)).status, 200)
      await workspace.query(`update mikka_workspace_members set status='suspended' where "workspaceId"=$1 and "userId"=$2`, [teamWorkspace.id, owner])
      assert.equal((await request(issueId, unselected)).status, 404)
      assert.equal((await request(unlinkedTask)).status, 404)
      assert.equal((await listRequest(teamSelection)).status, 403)
      assert.equal((await request(unlinkedTask, { bearer: peer.token })).status, 200)
      assert.equal((await request(secondTask, { workspaceId: secondWorkspace.id })).status, 200)
      await workspace.query(`update mikka_workspace_members set status='active' where "workspaceId"=$1 and "userId"=$2`, [teamWorkspace.id, owner])
      assert.equal((await request(issueId, unselected)).status, 200)
      await workspace.query('delete from mikka_workspace_members where "workspaceId"=$1 and "userId"=$2', [teamWorkspace.id, owner])
      assert.equal((await request(issueId, unselected)).status, 404)
      assert.equal((await listRequest(teamSelection)).status, 403)
      assert.deepEqual(await persisted(), before)
    } finally {
      await workspace.query(`insert into mikka_workspace_members("workspaceId","userId",name,email,role,status)
        values($1,$2,$3,$4,$5,'active') on conflict("workspaceId","userId") do update set status='active'`,
      [teamWorkspace.id, owner, ownerMember.name, ownerMember.email, ownerMember.role])
    }
    assert.equal((await request(issueId, unselected)).status, 200)
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
