import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import test from 'node:test'
import { Pool } from 'pg'
import { dbUrl, seedBot, seedUser, seedWorkspace } from '../../tests/support/workspace-admin-db'
import type { Command, Definition } from './contract'

type Schedule = { id: string; version: number; status: string; source_event_id: string | null; next_at: Date | null }
type Occurrence = { id: string; status: string; error: string | null; result: { id: string; title: string; identifier: string | null; eventId: string } | null }

test('dispatch_task automations run as their creator through the existing create-and-dispatch path', { skip: !dbUrl, timeout: 120_000 }, async t => {
  // Own the database: the store sweeps every due occurrence it can see.
  const database = `schedule_dispatch_${randomUUID().replaceAll('-', '')}_e2e`
  const target = new URL(dbUrl!)
  target.pathname = `/${database}`
  const admin = new Pool({ connectionString: dbUrl, max: 1 })
  await admin.query(`CREATE DATABASE ${database}`)
  const previous = Object.fromEntries(['E2E_DATABASE_URL', 'DATABASE_URL', 'MIKKA_DATABASE_URL', 'BETTER_AUTH_URL'].map(key => [key, process.env[key]]))
  for (const key of ['E2E_DATABASE_URL', 'DATABASE_URL', 'MIKKA_DATABASE_URL']) process.env[key] = target.href
  // No live gateway here: a deferred live notify would outlive the pools this test closes before dropping its database.
  delete process.env.BETTER_AUTH_URL
  const fixture = new Pool({ connectionString: target.href })
  let closeRuntime = async () => {}
  t.after(async () => {
    await closeRuntime()
    await fixture.end()
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await admin.query(`DROP DATABASE ${database}`)
    await admin.end()
  })
  execFileSync(process.execPath, ['--experimental-strip-types', 'scripts/setup-e2e-db.mjs'], { env: process.env, stdio: 'pipe' })
  const app = await import('../db/request-scope')
  const { workspacePool } = await import('../workspace-db')
  const { coordinatorWakeTransport } = await import('../coordinator/wake-after-commit')
  // Observe database work only: this seam keeps a report from starting a model turn.
  const originalWake = coordinatorWakeTransport.wake
  coordinatorWakeTransport.wake = async () => undefined
  const runtime = await import('./runtime')
  closeRuntime = async () => {
    coordinatorWakeTransport.wake = originalWake
    await Promise.all([app.pool.end(), workspacePool.end()])
  }

  const owner = await seedUser(fixture, 'automation-owner')
  const member = await seedUser(fixture, 'automation-member')
  const workspace = await seedWorkspace(fixture, owner, [{ userId: owner, role: 'admin' }, { userId: member, role: 'member' }])
  const chat = await seedBot(fixture, workspace.id, owner, 'Reports')
  const builder = await seedBot(fixture, workspace.id, owner, 'Builder')
  const memberChat = await seedBot(fixture, workspace.id, member, 'Member reports')
  const definition = (botId: string | null = builder, timing: Definition['timing'] = { kind: 'manual' }): Definition => ({
    title: 'Nightly CI check', timezone: 'UTC', timing, misfire: 'skip', maxLatenessMinutes: 30,
    task: { kind: 'dispatch_task', botId, prompt: 'Check the failing CI on main and fix it', title: 'Fix main CI' },
  })
  const page = <T>(who: string, bot: string, command: Command) => runtime.executeScheduleCommand(who, bot, undefined, command, { direct: true }) as Promise<T>
  const create = async (def = definition(), requestId = randomUUID()) => (await page<{ schedule: Schedule; replayed: boolean }>(owner, chat, { action: 'create', requestId, definition: def }))
  const runNow = (schedule: Schedule, requestId = randomUUID(), who = owner, bot = chat) =>
    page<{ occurrence: Occurrence; replayed: boolean }>(who, bot, { action: 'run_now', scheduleId: schedule.id, version: schedule.version, requestId })
  const occurrence = async (id: string) => (await fixture.query<Occurrence>('SELECT id,status,error,result FROM schedule_occurrences WHERE id=$1', [id])).rows[0]!
  const tick = () => runtime.schedules().tick()

  await t.test('the page creates as the signed-in person; a chat command still needs the person’s message', async () => {
    const requestId = randomUUID()
    const first = await create(definition(), requestId)
    assert.equal(first.replayed, false)
    assert.equal(first.schedule.status, 'active')
    assert.equal(first.schedule.source_event_id, null)
    assert.equal(first.schedule.next_at, null, 'a manual automation waits for 立即运行')
    const replay = await create(definition(), requestId)
    assert.deepEqual([replay.replayed, replay.schedule.id], [true, first.schedule.id])
    assert.equal((await fixture.query('SELECT request_origin FROM user_schedules WHERE id=$1', [first.schedule.id])).rows[0].request_origin, 'page')
    await assert.rejects(runtime.executeScheduleCommand(owner, chat, undefined, { action: 'create', requestId: randomUUID(), definition: definition() }), /scheduleUserSourceRequired/)
    await assert.rejects(fixture.query(`INSERT INTO user_schedules(id,owner_id,workspace_id,bot_id,visibility,source_event_id,request_id,request_origin,definition,request_definition,status)
      VALUES($1,$2,$3,$4::uuid,'workspace',NULL,'x','bot:'||$4::uuid::text,$5,$5,'paused')`, [randomUUID(), owner, workspace.id, chat, definition()]), { code: '23514' })
  })

  await t.test('立即运行 creates the task and hands it to the Bot once, keyed by the run', async () => {
    const { schedule } = await create()
    const requestId = randomUUID()
    const started = await runNow(schedule, requestId)
    assert.equal(started.occurrence.status, 'pending')
    const again = await runNow(schedule, requestId)
    assert.deepEqual([again.replayed, again.occurrence.id], [true, started.occurrence.id], 'the same request never adds a second run')
    await assert.rejects(runNow(schedule), /scheduleConcurrencyLimit/, 'maxConcurrent counts the waiting run')
    const swept = await tick()
    assert.deepEqual(swept.wakeOwners, [owner], 'the creator’s chats are woken to deliver the request')
    const run = await occurrence(started.occurrence.id)
    assert.equal(run.status, 'succeeded')
    assert.equal(run.result?.title, 'Fix main CI')
    const event = (await fixture.query('SELECT "userId","botId",kind,"issueId",payload FROM coordinator_events WHERE id=$1', [run.result!.eventId])).rows[0]
    assert.deepEqual([event.userId, event.botId, event.kind, event.issueId], [owner, builder, 'user_message', run.result!.id])
    assert.deepEqual(event.payload.taskCommand, { version: 1, intent: 'create_and_dispatch', description: 'Check the failing CI on main and fix it' })
    assert.deepEqual(event.payload.schedule, { scheduleId: schedule.id, occurrenceId: run.id })
    assert.equal(event.payload.taskTitle, 'Fix main CI')
    const receipt = (await fixture.query('SELECT "taskId",identifier FROM task_creation_receipts WHERE "userId"=$1 AND "requestId"=$2', [owner, run.id])).rows[0]
    assert.deepEqual([receipt.taskId, receipt.identifier], [run.result!.id, run.result!.identifier])
    const task = (await fixture.query('SELECT "userId","workspaceId",title FROM issues WHERE id=$1', [run.result!.id])).rows[0]
    assert.deepEqual([task.userId, task.workspaceId, task.title], [owner, workspace.id, 'Fix main CI'], 'an ordinary task of its creator, in its workspace')
    const report = (await fixture.query('SELECT message FROM coordinator_messages WHERE id=(SELECT operation_id FROM schedule_occurrences WHERE id=$1)', [run.id])).rows[0]
    assert.equal(report.message.mikkaDisplay.line.issueId, run.result!.id, 'the reports chat shows the task line')

    // A worker that crashed after dispatching repeats the same run: no second request event or task.
    await fixture.query(`UPDATE schedule_occurrences SET status='running',result=NULL,finished_at=NULL,reported_at=NULL,lease_token=gen_random_uuid(),lease_until=now()-interval '1 second' WHERE id=$1`, [run.id])
    await tick()
    const repeated = await occurrence(run.id)
    assert.deepEqual([repeated.status, repeated.result?.id, repeated.result?.eventId], ['succeeded', run.result!.id, run.result!.eventId])
    assert.equal(Number((await fixture.query(`SELECT count(*) FROM coordinator_events WHERE payload#>>'{schedule,occurrenceId}'=$1`, [run.id])).rows[0].count), 1)
    assert.equal(Number((await fixture.query('SELECT count(*) FROM task_creation_receipts WHERE "requestId"=$1', [run.id])).rows[0].count), 1)
    assert.equal(Number((await fixture.query(`SELECT count(*) FROM coordinator_events WHERE "dedupeKey"=$1`, [`schedule_result:${run.id}`])).rows[0].count), 1)
  })

  await t.test('the Coordinator takes the request when no Bot is named', async () => {
    const { schedule } = await create(definition(null))
    const { occurrence: started } = await runNow(schedule)
    await tick()
    const run = await occurrence(started.id)
    assert.equal(run.status, 'succeeded')
    const event = (await fixture.query('SELECT "botId" FROM coordinator_events WHERE id=$1', [run.result!.eventId])).rows[0]
    const coordinator = (await fixture.query('SELECT "botId" FROM coordinator_bots WHERE "ownerId"=$1 AND "workspaceId"=$2', [owner, workspace.id])).rows[0]
    assert.equal(event.botId, coordinator.botId)
  })

  await t.test('authority is checked again at each run and a lost one fails the run with its reason', async () => {
    const lost = await seedBot(fixture, workspace.id, owner, 'Retiring')
    const { schedule } = await create(definition(lost))
    const { occurrence: started } = await runNow(schedule)
    await fixture.query('UPDATE bots SET "archivedAt"=now() WHERE id=$1', [lost])
    await tick()
    assert.deepEqual(await occurrence(started.id).then(run => [run.status, run.error]), ['failed', 'scheduleBotUnavailable'])
    assert.equal(Number((await fixture.query(`SELECT count(*) FROM coordinator_events WHERE payload#>>'{schedule,occurrenceId}'=$1`, [started.id])).rows[0].count), 0, 'nothing was dispatched')
    const stopped = (await fixture.query<{ status: string; version: number; disabled_reason: string | null }>('SELECT status,version,disabled_reason FROM user_schedules WHERE id=$1', [schedule.id])).rows[0]!
    assert.deepEqual([stopped.status, stopped.disabled_reason], ['paused', 'scheduleBotUnavailable'], 'the automation stops and says why')
    await assert.rejects(page(owner, chat, { action: 'resume', scheduleId: schedule.id, version: stopped.version }), /scheduleBotUnavailable/, 'resuming checks again')
    await fixture.query('UPDATE bots SET "archivedAt"=NULL WHERE id=$1', [lost])
    const resumed = (await page<{ schedule: Schedule & { disabled_reason: string | null } }>(owner, chat, { action: 'resume', scheduleId: schedule.id, version: stopped.version })).schedule
    assert.deepEqual([resumed.status, resumed.disabled_reason], ['active', null])
    await fixture.query('UPDATE bots SET "archivedAt"=now() WHERE id=$1', [lost])
    await assert.rejects(runNow(resumed), /scheduleBotUnavailable/, '立即运行 refuses at once')

    const repository = await seedBot(fixture, workspace.id, owner, 'Repository Bot')
    await fixture.query('UPDATE bots SET repository=$2 WHERE id=$1', [repository, 'acme/removed'])
    await assert.rejects(create(definition(repository)), /scheduleRepositoryUnavailable/)

    const second = await create()
    const pending = await runNow(second.schedule)
    await fixture.query(`UPDATE mikka_workspace_members SET status='suspended' WHERE "workspaceId"=$1 AND "userId"=$2`, [workspace.id, owner])
    try {
      await tick()
      assert.deepEqual(await occurrence(pending.occurrence.id).then(run => [run.status, run.error]), ['failed', 'scheduleWorkspaceAccessDenied'])
      assert.equal((await fixture.query('SELECT disabled_reason FROM user_schedules WHERE id=$1', [second.schedule.id])).rows[0].disabled_reason, 'scheduleWorkspaceAccessDenied')
    } finally {
      await fixture.query(`UPDATE mikka_workspace_members SET status='active' WHERE "workspaceId"=$1 AND "userId"=$2`, [workspace.id, owner])
    }
  })

  await t.test('pausing fences a waiting run; a paused automation does not run until resumed', async () => {
    const { schedule } = await create()
    const { occurrence: waiting } = await runNow(schedule)
    const paused = (await page<{ schedule: Schedule }>(owner, chat, { action: 'pause', scheduleId: schedule.id, version: schedule.version })).schedule
    assert.equal(paused.status, 'paused')
    await tick()
    assert.deepEqual(await occurrence(waiting.id).then(run => [run.status, run.error]), ['cancelled', 'scheduleChanged'])
    await assert.rejects(runNow(paused), /scheduleNotActive/)
    const resumed = (await page<{ schedule: Schedule }>(owner, chat, { action: 'resume', scheduleId: schedule.id, version: paused.version })).schedule
    assert.equal(resumed.status, 'active', 'a manual automation resumes to active, not completed')
    assert.equal((await runNow(resumed)).occurrence.status, 'pending')
  })

  await t.test('members list and pause; only the creator or an admin runs, changes or resumes', async () => {
    const { schedule } = await create()
    const listed = await page<{ schedules: Schedule[] }>(member, memberChat, { action: 'list', scheduleId: schedule.id })
    assert.deepEqual(listed.schedules.map(row => row.id), [schedule.id])
    await assert.rejects(runNow(schedule, randomUUID(), member, memberChat), /scheduleAdminRequired/)
    await assert.rejects(page(member, memberChat, { action: 'update', scheduleId: schedule.id, version: schedule.version, definition: definition(null) }), /scheduleAdminRequired/)
    const paused = (await page<{ schedule: Schedule }>(member, memberChat, { action: 'pause', scheduleId: schedule.id, version: schedule.version })).schedule
    await assert.rejects(page(member, memberChat, { action: 'resume', scheduleId: schedule.id, version: paused.version }), /scheduleAdminRequired/)
  })

  await t.test('a timed dispatch_task materializes like any schedule and records its run', async () => {
    const at = new Date(Date.now() + 1500).toISOString()
    const { schedule } = await create(definition(builder, { kind: 'once', at }))
    assert.ok(schedule.next_at)
    await new Promise(resolve => setTimeout(resolve, 1700))
    await tick()
    const runs = await page<{ occurrences: Occurrence[] }>(owner, chat, { action: 'history', scheduleId: schedule.id })
    assert.equal(runs.occurrences.length, 1)
    assert.equal(runs.occurrences[0]!.status, 'succeeded')
    assert.equal((runs.occurrences[0]!.result as { title: string }).title, 'Fix main CI')
    const hidden = await page<{ occurrences: Occurrence[] }>(member, memberChat, { action: 'history', scheduleId: schedule.id })
    assert.equal(hidden.occurrences[0]!.result, null, 'another member sees the run, not its task')
  })
  await t.test('a GitHub event runs each automation that takes it once, with the event marked as GitHub data', async () => {
    for (const repo of ['acme/web', 'acme/limits', 'acme/gate']) await fixture.query(`INSERT INTO github_repository_installations("userId","remoteKey","githubAccountId","installationId","repositoryId") VALUES($1,$2,'1',1,$3)`, [owner, `v2/github.com/${repo}`, repo.length])
    const triggered = (repository: string, extra: Partial<NonNullable<Definition['events']>[number]> = {}, max = 1): Definition => ({
      ...definition(builder), maxConcurrent: max, events: [{ source: 'github', event: 'pull_request_opened', repositories: [`v2/github.com/${repository}`], ...extra }],
    })
    const pr = (repository: string, number: number, sender = 'User') => ({ action: 'opened', sender: { login: 'ada', type: sender },
      repository: { full_name: repository }, pull_request: { number, title: `PR ${number}`, html_url: `https://github.com/${repository}/pull/${number}`, base: { ref: 'main' }, labels: [], user: { login: 'ada' } } })
    const runs = async (id: string) => (await fixture.query<{ status: string; error: string | null; trigger: { event: { number: number } } | null; reported_at: Date | null; id: string }>('SELECT id,status,error,trigger,reported_at FROM schedule_occurrences WHERE schedule_id=$1 ORDER BY created_at', [id])).rows

    await assert.rejects(create(triggered('acme/api')), /scheduleRepositoryUnavailable/, 'a repository nobody here installed cannot be named')
    const { schedule } = await create(triggered('Acme/Web'.toLowerCase()))
    assert.equal(await runtime.fireGitHubAutomations('github:d1', 'pull_request', pr('Acme/Web', 7)), 1)
    assert.equal(await runtime.fireGitHubAutomations('github:d1', 'pull_request', pr('Acme/Web', 7)), 0, 'a redelivery adds nothing')
    assert.equal(await runtime.fireGitHubAutomations('github:d2', 'pull_request', pr('Acme/Web', 8, 'Bot')), 0, 'a bot’s own activity does not trigger')
    assert.equal(await runtime.fireGitHubAutomations('github:d3', 'pull_request', pr('Acme/Other', 9)), 0)
    const [run] = await runs(schedule.id)
    assert.deepEqual([run!.status, run!.trigger?.event.number], ['pending', 7])
    await tick()
    const done = await occurrence(run!.id)
    assert.equal(done.status, 'succeeded')
    const request = (await fixture.query('SELECT payload FROM coordinator_events WHERE id=$1', [done.result!.eventId])).rows[0].payload
    assert.match(request.text, /^Check the failing CI on main and fix it\n\n<github_event>\nevent: pull_request_opened\nrepository: acme\/web\nnumber: #7/)
    assert.equal(request.schedule.event, true)

    const limited = (await create(triggered('acme/limits'))).schedule
    assert.equal(await runtime.fireGitHubAutomations('github:d4', 'pull_request', pr('acme/limits', 1)), 1)
    assert.equal(await runtime.fireGitHubAutomations('github:d5', 'pull_request', pr('acme/limits', 2)), 0, 'over maxConcurrent the event is recorded as skipped')
    const [first, second] = await runs(limited.id)
    assert.deepEqual([first!.status, second!.status, second!.error, Boolean(second!.reported_at)], ['pending', 'skipped', 'concurrencyLimit', true])
    await tick()
  })

  await t.test('a trigger’s condition is judged before the run; a miss is skipped quietly and no answer is retried', async () => {
    const gated = (await create({ ...definition(builder), events: [{ source: 'github', event: 'pull_request_opened', repositories: ['v2/github.com/acme/gate'], runWhen: 'The PR changes billing.' }] })).schedule
    const pr = (number: number) => ({ action: 'opened', sender: { login: 'ada', type: 'User' }, repository: { full_name: 'acme/gate' },
      pull_request: { number, title: `PR ${number}`, base: { ref: 'main' }, labels: [] } })
    const original = runtime.automationSeams.runWhen
    const asked: string[] = []
    try {
      runtime.automationSeams.runWhen = async input => { asked.push(input.condition); return false }
      await runtime.fireGitHubAutomations('github:g1', 'pull_request', pr(1))
      await tick()
      const [missed] = (await fixture.query<{ id: string; status: string; error: string; reported_at: Date | null }>('SELECT id,status,error,reported_at FROM schedule_occurrences WHERE schedule_id=$1', [gated.id])).rows
      assert.deepEqual([missed!.status, missed!.error, Boolean(missed!.reported_at)], ['skipped', 'runWhenNotMet', true])
      assert.deepEqual(asked, ['The PR changes billing.'])
      assert.equal(Number((await fixture.query(`SELECT count(*) FROM coordinator_events WHERE "dedupeKey"=$1`, [`schedule_result:${missed!.id}`])).rows[0].count), 0, 'a skipped event posts nothing to the chat')

      runtime.automationSeams.runWhen = async () => null
      await runtime.fireGitHubAutomations('github:g2', 'pull_request', pr(2))
      await tick()
      const unanswered = (await fixture.query<{ status: string; error: string }>(`SELECT status,error FROM schedule_occurrences WHERE schedule_id=$1 AND trigger#>>'{event,number}'='2'`, [gated.id])).rows[0]!
      assert.deepEqual([unanswered.status, unanswered.error], ['pending', 'scheduleRunWhenUnavailable'], 'no answer is retried, never a silent pass')

      runtime.automationSeams.runWhen = async () => true
      await fixture.query(`UPDATE schedule_occurrences SET next_retry_at=now() WHERE schedule_id=$1 AND status='pending'`, [gated.id])
      await tick()
      await runtime.fireGitHubAutomations('github:g3', 'pull_request', pr(3))
      await tick()
      const statuses = (await fixture.query<{ status: string }>(`SELECT status FROM schedule_occurrences WHERE schedule_id=$1 ORDER BY created_at`, [gated.id])).rows.map(row => row.status)
      assert.deepEqual(statuses, ['skipped', 'succeeded', 'succeeded'])
    } finally { runtime.automationSeams.runWhen = original }
  })
  await t.test('maxRunsPerDay skips timed and event runs and refuses 立即运行 past the cap; usage counts each day', async () => {
    await fixture.query(`INSERT INTO github_repository_installations("userId","remoteKey","githubAccountId","installationId","repositoryId") VALUES($1,'v2/github.com/acme/capped','1',1,77) ON CONFLICT DO NOTHING`, [owner])
    const capped = (await create({ ...definition(builder), maxConcurrent: 5, maxRunsPerDay: 2,
      events: [{ source: 'github', event: 'pull_request_opened', repositories: ['v2/github.com/acme/capped'] }] })).schedule
    await runNow(capped)
    const pr = (number: number) => ({ action: 'opened', sender: { login: 'ada', type: 'User' }, repository: { full_name: 'acme/capped' }, pull_request: { number, title: `PR ${number}`, base: { ref: 'main' }, labels: [] } })
    assert.equal(await runtime.fireGitHubAutomations('github:c1', 'pull_request', pr(1)), 1)
    assert.equal(await runtime.fireGitHubAutomations('github:c2', 'pull_request', pr(2)), 0, 'the third run of the day is recorded as skipped')
    await assert.rejects(runNow(capped), /scheduleDailyRunLimit/)
    await tick()
    const statuses = (await fixture.query<{ status: string; error: string | null }>('SELECT status,error FROM schedule_occurrences WHERE schedule_id=$1 ORDER BY created_at', [capped.id])).rows
    assert.deepEqual(statuses.map(row => [row.status, row.error]), [['succeeded', null], ['succeeded', null], ['skipped', 'dailyRunLimit']])
    const usage = await page<{ maxRunsPerDay: number; days: { runs: number; skipped: number; tasks: number; costMicroUsd: number | null }[] }>(owner, chat, { action: 'usage', scheduleId: capped.id })
    assert.equal(usage.maxRunsPerDay, 2)
    assert.deepEqual(usage.days.map(day => [day.runs, day.skipped, day.tasks, day.costMicroUsd]), [[2, 1, 2, 0]])
    const seen = await page<{ days: { costMicroUsd: number | null }[] }>(member, memberChat, { action: 'usage', scheduleId: capped.id })
    assert.equal(seen.days[0]!.costMicroUsd, null, 'another member sees runs, not spend')
  })
  await t.test('追加到同一个任务: later runs add to the first run’s task; a deleted task pauses the automation', async () => {
    const standing = (await create({ ...definition(builder), maxConcurrent: 3, eachRun: 'same_task' })).schedule
    const first = await runNow(standing)
    await tick()
    const made = await occurrence(first.occurrence.id)
    assert.equal(made.status, 'succeeded')
    const taskId = made.result!.id
    const second = await runNow(standing)
    await tick()
    assert.deepEqual(await occurrence(second.occurrence.id).then(run => [run.status, run.error]), ['pending', 'scheduleStandingTaskNotStarted'], 'until the Bot starts the task, a later run waits; it never makes a second task')
    const agent = randomUUID(), run = randomUUID()
    await fixture.query(`INSERT INTO agents(id,"userId",name,harness) VALUES ($1,$2,'Coding','codex')`, [agent, owner])
    await fixture.query(`INSERT INTO agent_runs(id,"userId","workspaceId","issueId","agentId",status,prompt,"promptTaskStart","promptTaskLength",title,"titleSource")
      VALUES ($1,$2,$3,$4,$5,'running','Fix main CI',0,11,'Fix main CI','manual')`, [run, owner, workspace.id, taskId, agent])
    await fixture.query(`UPDATE schedule_occurrences SET next_retry_at=now() WHERE id=$1`, [second.occurrence.id])
    await tick()
    const added = await occurrence(second.occurrence.id)
    assert.equal(added.status, 'succeeded')
    assert.deepEqual([added.result!.id, (added.result as { continued?: boolean }).continued], [taskId, true])
    assert.equal(Number((await fixture.query('SELECT count(*) FROM run_messages WHERE "runId"=$1', [run])).rows[0].count), 1, 'the request reached the running thread once')
    assert.equal(Number((await fixture.query(`SELECT count(*) FROM schedule_occurrences WHERE schedule_id=$1 AND result ? 'eventId'`, [standing.id])).rows[0].count), 1, 'one task in all')
    await fixture.query('DELETE FROM agent_runs WHERE id=$1', [run])
    await fixture.query('DELETE FROM issues WHERE id=$1', [taskId])
    const current = (await fixture.query<{ version: number }>('SELECT version FROM user_schedules WHERE id=$1', [standing.id])).rows[0]!
    const third = await runNow({ ...standing, version: current.version })
    await tick()
    assert.deepEqual(await occurrence(third.occurrence.id).then(row => [row.status, row.error]), ['failed', 'scheduleStandingTaskUnavailable'])
    assert.deepEqual((await fixture.query('SELECT status,disabled_reason FROM user_schedules WHERE id=$1', [standing.id])).rows[0], { status: 'paused', disabled_reason: 'scheduleStandingTaskUnavailable' })
  })
})
