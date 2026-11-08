import 'next/dist/server/node-environment-baseline'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { createTranslator } from 'next-intl'
import messages from '../messages/en.json'
import { dbUrl, seedAgent, seedBot, seedIssue, seedRun, seedTeam, seedUser, seedWorkspace } from './support/workspace-admin-db'
import { tokenWorkspace } from '../lib/tokens/principal'
import { measured } from './helpers/read-metrics'

test('mobile task endpoints with real task ACL, current workspace membership and run history', { skip: !dbUrl }, async t => {
  let selectedWorkspace = ''
  let user: { id: string; name: string; email: string; [tokenWorkspace]?: string } | null = null
  mock.module('next/headers', { namedExports: { headers: async () => new Headers(), cookies: async () => ({ get: (key: string) => key === 'mikka-workspace' ? { value: selectedWorkspace } : undefined }) } })
  mock.module('next-intl/server', { namedExports: { getLocale: async () => 'en', getTranslations: async (namespace: string) => namespace === 'MobileTaskSchedule'
    ? createTranslator({ locale: 'en', messages, namespace: 'MobileTaskSchedule' }) : Object.assign((key: string) => key, { has: () => true }) } })
  mock.module(new URL('../lib/mobile-api.ts', import.meta.url).href, { namedExports: { mobileUser: async () => user, json: (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } }), unauthorized: () => Response.json({ error: 'authRequired' }, { status: 401 }) } })
  mock.module(new URL('../lib/session.ts', import.meta.url).href, { namedExports: { getSession: async () => user ? { user } : null } })
  mock.module(new URL('../lib/request-log.ts', import.meta.url).href, { namedExports: { withRequestLog: (_: string, handler: unknown) => handler, noteLogUser: () => {} } })
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: dbUrl, max: 3 })
  const { pool: appPool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  const { GET } = await import('../app/api/mobile/tasks/[id]/route')
  const { GET: list } = await import('../app/api/mobile/tasks/route')
  const { newestTaskRuns } = await import('../lib/task-block-runs')
  const owner = await seedUser(pool, 'owner'), other = await seedUser(pool, 'other')
  const own = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }])
  await pool.query(`update mikka_workspaces set kind='personal' where id=$1`, [own.id])
  const teamWorkspace = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }, { userId: other, role: 'member' }])
  const team = await seedTeam(pool, teamWorkspace.id, owner)
  const workspaceTask = async () => {
    const id = randomUUID()
    await pool.query(`insert into issues (id,"userId",title,content,status,priority,scope) values ($1,$2,'Task','{"type":"doc"}','todo','normal','workspace')`, [id, owner])
    await pool.query('insert into mikka_team_issues ("issueId","teamId","workspaceId","userId") values ($1,$2,$3,$4)', [id, team.id, teamWorkspace.id, owner])
    return id
  }
  const issueId = await workspaceTask()
  await pool.query(`update issues set title='Full title',"shortTitle"='Short title',"shortTitleFrom"='Full title',content=$2,"createdAt"='2026-01-01T00:00:00Z' where id=$1`, [issueId, { type: 'doc', attrs: { mikka: { pullRequests: [{ url: 'https://github.com/acme/app/pull/1', state: 'open' }] } }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Description' }] }] }])
  const bot = await seedBot(pool, teamWorkspace.id, owner, 'Dispatcher'), agent = await seedAgent(pool, owner)
  const first = await seedRun(pool, { userId: owner, agentId: agent, botId: bot, issueId, status: 'failed' })
  const latest = await seedRun(pool, { userId: owner, agentId: agent, botId: bot, issueId })
  await pool.query(`update agent_runs set "createdAt"='2026-01-02T00:00:00Z',"threadReplacedBy"=$2,error='PRIVATE_RAW_ERROR' where id=$1`, [first, latest])
  await pool.query(`update agent_runs set "createdAt"=now(),outcome='idle',"agentDefinition"='{"harness":"codex","model":"fixture-model","modelDispatch":{"location":"cloud"}}' where id=$1`, [latest])
  const noRun = await workspaceTask()
  const schedule = randomUUID()
  await pool.query(`insert into user_schedules (id,owner_id,workspace_id,bot_id,source_event_id,request_id,definition,request_definition,status,next_at) values ($1,$2,$3,$4,$5,$6,$7,$7,'active','2030-01-01T09:00:00Z')`, [schedule, owner, teamWorkspace.id, bot, randomUUID(), randomUUID(), { title: 'Daily task', timezone: 'UTC', timing: { kind: 'daily', time: '09:00', fold: 'earlier', gap: 'skip' }, task: { kind: 'issue_snapshot', issueId: noRun }, misfire: 'skip', maxLatenessMinutes: 60 }])
  await pool.query(`insert into run_publications ("runId","userId","issueId","remoteUrl","remoteKey",status,"pullRequest") values ($1,$2,$3,'https://github.com/acme/app','github.com/acme/app','published',$4)`, [latest, owner, issueId, { url: 'https://github.com/acme/app/pull/42', state: 'open' }])
  const personalTask = await seedIssue(pool, owner)
  user = { id: owner, name: 'Owner', email: `${owner}@example.invalid` }; selectedWorkspace = teamWorkspace.id
  const request = (id: string) => GET(new Request(`https://app.test/api/mobile/tasks/${id}`), { params: Promise.resolve({ id }) })
  t.after(async () => {
    await pool.query('delete from agent_runs where "userId"=any($1)', [[owner, other]])
    await pool.query('delete from devices where "ownerId"=any($1)', [[owner, other]])
    await pool.query('delete from issues where "userId"=any($1)', [[owner, other]])
    await pool.query('delete from mikka_workspaces where "userId"=any($1)', [[owner, other]])
    await pool.query('delete from "user" where id=any($1)', [[owner, other]])
    await Promise.all([pool.end(), appPool.end(), workspacePool.end()])
  })

  await t.test('detail includes contract fields, every attempt, replacement time and creation; excludes raw errors', async () => {
    const response = await request(issueId)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store')
    const body = await response.json()
    assert.deepEqual(Object.keys(body).sort(), ['activity', 'live', 'task'])
    assert.equal(body.task.title, 'Short title')
    assert.equal(body.task.description, 'Description')
    assert.equal(body.task.group, 'pending', 'PR metadata wins over idle')
    assert.deepEqual([body.task.state, body.task.reason, body.task.blockedBy], ['waiting', 'pr_review', null])
    assert.equal(body.task.bot.id, bot)
    assert.deepEqual(body.task.agent, { harness: 'codex', model: 'fixture-model' })
    assert.deepEqual(body.task.place, { kind: 'cloud', name: 'Cloud' })
    assert.equal(body.task.schedule, null)
    assert.deepEqual(body.live, { workspaceId: teamWorkspace.id })
    assert.deepEqual(body.activity.map((row: { kind: string }) => row.kind), ['attempt', 'replaced', 'attempt', 'created'])
    assert.deepEqual(body.activity.filter((row: { kind: string }) => row.kind === 'attempt').map((row: { runId: string; n: number }) => [row.runId, row.n]), [[latest, 2], [first, 1]])
    assert.equal(body.activity[0].state, 'done')
    assert.deepEqual(body.activity[0].pullRequest, { number: 42, url: 'https://github.com/acme/app/pull/42' })
    assert.equal(body.activity[2].state, 'replaced')
    assert.equal(body.activity[2].pullRequest, null)
    assert.equal(body.activity[0].group, 'waiting', 'attempts retain the five thread groups consumed by iOS')
    assert.equal(body.activity[0].createdAt, body.activity[1].createdAt)
    assert.equal(body.activity.at(-1).by, 'owner')
    assert.doesNotMatch(JSON.stringify(body), /PRIVATE_RAW_ERROR|failureDetails|"error"/)
  })
  await t.test('list decorations share one batched read, cover no-thread schedules and preserve blocked', async () => {
    const measurement = await measured(() => newestTaskRuns(owner, [issueId, noRun], teamWorkspace.id))
    assert.equal(measurement.statements, 1)
    assert.equal(measurement.value.find(row => row.issueId === noRun)?.runId, null)
    const body = await (await list(new Request('https://app.test/api/mobile/tasks'))).json()
    const row = body.tasks.find((item: { id: string }) => item.id === issueId)
    assert.equal(row.group, 'pending'); assert.equal(row.bot.id, bot); assert.ok(row.createdAt)
    assert.ok(Object.hasOwn(row, 'blocked'))
    const scheduled = body.tasks.find((item: { id: string }) => item.id === noRun)
    assert.equal(scheduled.group, 'running'); assert.equal(scheduled.state, 'queued'); assert.equal(scheduled.bot, null)
    assert.equal(scheduled.schedule.label, 'Every day at 09:00')
    assert.equal(Date.parse(scheduled.schedule.nextAt), Date.parse('2030-01-01T09:00:00Z'))
    await pool.query(`update issues set status='done' where id=$1`, [issueId])
    const closed = await (await list(new Request('https://app.test/api/mobile/tasks'))).json()
    assert.equal(closed.tasks.find((item: { id: string }) => item.id === issueId).group, 'done')
    assert.equal((await (await request(issueId)).json()).task.group, 'done')
  })
  await t.test('without a thread, flags and dependencies preserve todo with matching reasons and visible identifiers', async () => {
    await pool.query(`update user_schedules set status='cancelled',next_at=null where id=$1`, [schedule])
    const groups = async () => {
      const listBody = await (await list(new Request('https://app.test/api/mobile/tasks'))).json()
      const row = listBody.tasks.find((item: { id: string }) => item.id === noRun)
      const detail = await (await request(noRun)).json()
      for (const field of ['state', 'reason', 'blockedBy', 'group']) assert.equal(row[field], detail.task[field], `list/detail ${field}`)
      return [row.group, detail.task.group, row.reason, row.blockedBy]
    }
    const metadata = async (value: unknown) => pool.query('update issues set content=$2 where id=$1', [noRun, { type: 'doc', attrs: { mikka: value } }])
    await metadata({ block: { blocked: true, runId: null } })
    assert.deepEqual(await groups(), ['todo', 'todo', 'flagged', null])
    await pool.query(`update issues set status='done' where id=$1`, [noRun])
    assert.deepEqual(await groups(), ['done', 'done', null, null])
    await pool.query(`update issues set status='todo' where id=$1`, [noRun])
    const blocker = await workspaceTask()
    await metadata({ blockedByIds: [blocker] })
    const identifier = (await (await request(blocker)).json()).task.identifier
    assert.ok(identifier)
    assert.deepEqual(await groups(), ['todo', 'todo', 'blocked_by', identifier])
    await pool.query(`update issues set status='done' where id=$1`, [blocker])
    assert.deepEqual(await groups(), ['todo', 'todo', null, null])
    await pool.query(`update issues set status='todo' where id=$1`, [blocker])
    await metadata({ blockedByIds: [blocker], block: { blocked: false, runId: null } })
    assert.deepEqual(await groups(), ['todo', 'todo', null, null], 'an explicitly cleared board block stays clear')
  })
  await t.test('all task states/reasons are projected identically by real GET routes', async () => {
    const id = await workspaceTask()
    const runId = await seedRun(pool, { userId: owner, agentId: agent, issueId: id })
    const scenarios = [
      ['todo', 'waiting_input', null, null, null, 'waiting', 'needs_input', 'pending'],
      ['todo', 'paused', null, 'human_control', null, 'waiting', 'approval', 'pending'],
      ['review', 'succeeded', 'done', null, null, 'waiting', 'pr_review', 'pending'],
      ['todo', 'succeeded', 'blocked', null, null, 'blocked', 'blocked', 'pending'],
      ['todo', 'paused', null, 'quota_exhausted', null, 'blocked', 'quota', 'pending'],
      ['todo', 'failed', null, null, 'device_lost', 'blocked', 'offline', 'pending'],
      ['todo', 'failed', null, null, null, 'failed', null, 'pending'],
      ['todo', 'preparing', null, null, null, 'running', null, 'running'],
      ['todo', 'running', null, null, null, 'running', null, 'running'],
      ['todo', 'finishing', null, null, null, 'running', null, 'running'],
      ['todo', 'queued', null, null, null, 'queued', null, 'running'],
      ['todo', 'succeeded', 'done', null, null, 'todo', null, 'todo'],
      ['done', 'running', null, null, null, 'done', null, 'done'],
      ['canceled', 'running', null, null, null, 'canceled', null, 'done'],
      ['duplicate', 'running', null, null, null, 'duplicate', null, 'done'],
    ]
    for (const [taskStatus, status, outcome, pauseReason, stopReason, state, reason, group] of scenarios) {
      await pool.query('update issues set status=$2 where id=$1', [id, taskStatus])
      await pool.query('update agent_runs set status=$2,outcome=$3,"pauseReason"=$4,"stopReason"=$5 where id=$1', [runId, status, outcome, pauseReason, stopReason])
      const detail = (await (await request(id)).json()).task
      const body = await (await list(new Request('https://app.test/api/mobile/tasks'))).json()
      const row = body.tasks.find((item: { id: string }) => item.id === id)
      for (const task of [detail, row]) assert.deepEqual([task.state, task.reason, task.blockedBy, task.group], [state, reason, null, group], `${taskStatus}/${status}/${outcome}`)
    }
    // Queued local devices use presence, while completed attempts ignore later device loss.
    const device = randomUUID()
    await pool.query(`insert into devices (id,"ownerId",name,kind,"lastSeenAt") values ($1,$2,'Test device','local',now()-interval '1 day')`, [device, owner])
    await pool.query(`update issues set status='todo' where id=$1`, [id])
    await pool.query(`update agent_runs set status='queued',outcome=null,"stopReason"=null,"deviceId"=$2 where id=$1`, [runId, device])
    const compare = async (state: string, reason: string | null) => {
      const task = (await (await request(id)).json()).task
      const row = (await (await list(new Request('https://app.test/api/mobile/tasks'))).json()).tasks.find((item: { id: string }) => item.id === id)
      for (const value of [task, row]) assert.deepEqual([value.state, value.reason], [state, reason])
    }
    await compare('blocked', 'offline')
    await pool.query('update devices set "lastSeenAt"=now() where id=$1', [device])
    await compare('queued', null)
    await pool.query('update devices set enabled=false where id=$1', [device])
    await compare('blocked', 'offline')
    await pool.query(`update agent_runs set status='succeeded',outcome='done' where id=$1`, [runId])
    await compare('todo', null)
    // Pending CLI approval is run-scoped and expires instead of remaining waiting forever.
    await pool.query(`update agent_runs set status='running',outcome=null where id=$1`, [runId])
    await pool.query(`insert into agent_tool_approvals (id,"runId","userId","deviceId","requestId",harness,method,input,digest,status,"expiresAt") values ($1,$2,$3,$4,'request','codex','fixture','{}','digest','pending',now()+interval '1 hour')`, [randomUUID(), runId, owner, device])
    await compare('waiting', 'approval')
    await pool.query(`update agent_tool_approvals set "expiresAt"=now()-interval '1 hour' where "runId"=$1`, [runId])
    await compare('running', null)
    await pool.query(`insert into local_computer_reviews (id,"runId","deviceId","userId",target,call,digest,"expiresAt","seenAt") values ($1,$2,$3,$4,'fixture','{}','digest',now()+interval '1 hour',now())`, [randomUUID(), runId, device, owner])
    await compare('waiting', 'approval')
    await pool.query('update local_computer_reviews set decision=true where "runId"=$1', [runId])
    await compare('running', null)

    await pool.query(`update issues set status='todo' where id=$1`, [id])
    await pool.query(`update agent_runs set status='succeeded',outcome='done',"stopReason"=null where id=$1`, [runId])
    await pool.query(`insert into run_publications ("runId","userId","issueId","remoteUrl","remoteKey",status) values ($1,$2,$3,'https://github.com/acme/app','github.com/acme/app','awaiting_approval')`, [runId, owner, id])
    for (const task of [(await (await request(id)).json()).task, (await (await list(new Request('https://app.test/api/mobile/tasks'))).json()).tasks.find((item: { id: string }) => item.id === id)]) {
      assert.deepEqual([task.state, task.reason], ['waiting', 'approval'])
    }
  })
  await t.test('cross-workspace reads return 404 even for the same owner, and workspace tokens stay scoped', async () => {
    selectedWorkspace = own.id
    assert.equal((await request(issueId)).status, 404)
    selectedWorkspace = teamWorkspace.id
    assert.equal((await request(personalTask)).status, 404)
    user = { ...user!, [tokenWorkspace]: own.id }
    assert.equal((await request(issueId)).status, 404)
    user = { ...user!, [tokenWorkspace]: teamWorkspace.id }
    assert.equal((await request(issueId)).status, 200)
    await pool.query(`update mikka_workspace_members set status='suspended' where "workspaceId"=$1 and "userId"=$2`, [teamWorkspace.id, owner])
    assert.equal((await request(issueId)).status, 404)
    await pool.query(`delete from mikka_workspace_members where "workspaceId"=$1 and "userId"=$2`, [teamWorkspace.id, owner])
    assert.equal((await request(issueId)).status, 404)
  })
  await t.test('invalid/missing IDs are 404; unauthenticated requests are 401', async () => {
    assert.equal((await request('invalid')).status, 404)
    assert.equal((await request(randomUUID())).status, 404)
    user = null
    assert.equal((await request(issueId)).status, 401)
  })
})
