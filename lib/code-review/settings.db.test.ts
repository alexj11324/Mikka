import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { after, before, mock, test } from 'node:test'
import type { DispatchInput, Schedule } from '@/lib/schedules/store'
import { disposableDatabase } from '../../tests/helpers/e2e-target.mjs'

const target = process.env.E2E_DATABASE_URL
const available = disposableDatabase() && process.env.MIKKA_DATABASE_URL === target && process.env.DATABASE_URL === target
if (!available && process.env.REQUIRE_DB === '1') throw new Error('Code review settings require an isolated loopback *_e2e database')
const dbTest = available ? test : test.skip
const owner = `review-admin-${randomUUID()}`, member = `review-member-${randomUUID()}`, outsider = `review-outsider-${randomUUID()}`
const workspaceId = randomUUID(), otherWorkspaceId = randomUUID()
const repository = `v2/github.com/review-fixture/r-${randomUUID()}`
const foreignRepository = `v2/github.com/review-fixture/r-${randomUUID()}`
const homes: string[] = []
let currentUser: { id: string; email: string; name: string } | null = null
let pool: (typeof import('@/lib/db'))['pool']
let workspacePool: (typeof import('@/lib/workspace-db'))['workspacePool']
let personal: typeof import('@/app/api/settings/personal/route')
let workspace: typeof import('@/app/api/settings/workspace/[workspaceId]/route')
let personalReset: typeof import('@/app/api/settings/personal/reset/route')
let workspaceReset: typeof import('@/app/api/settings/workspace/[workspaceId]/reset/route')
let repositories: typeof import('@/app/api/settings/workspace/[workspaceId]/review-repositories/route')
let runtime: typeof import('@/lib/schedules/runtime')
let wake: (typeof import('@/lib/coordinator/wake-after-commit'))['coordinatorWakeTransport']
let priorWake: typeof wake.wake
const as = (id: string | null) => { currentUser = id ? { id, email: `${id}@example.invalid`, name: id } : null }
const request = (path: string, method = 'GET', body?: unknown) => new Request(`http://127.0.0.1/api/settings/${path}`, {
  method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
})
const context = () => ({ params: Promise.resolve({ workspaceId }) })
const path = `workspace/${workspaceId}/review-repositories`
const patch = (values: Record<string, unknown>) => ({ values })
const saveRepository = (input: Record<string, unknown>) => repositories.PATCH(request(path, 'PATCH', input), context())
const readSchedule = async () => (await pool.query<Schedule>(`SELECT s.* FROM workspace_code_review_repositories r
  JOIN user_schedules s ON s.id=r."scheduleId" WHERE r."workspaceId"=$1 AND r.repository=$2`, [workspaceId, repository])).rows[0]!

before(async () => {
  if (!available) return
  mock.module('@/lib/server-runtime/headers', { namedExports: { headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) } })
  mock.module('@/lib/intl/i18n-server', { namedExports: { getLocale: async () => 'en', getTranslations: async () => Object.assign((key: string) => key, { has: () => true }) } })
  mock.module('@/lib/session', { namedExports: { getSession: async () => currentUser ? { user: currentUser, session: { id: 'code-review-test-session' } } : null } })
  mock.module('@/lib/suggestions/sources', { namedExports: { connectedComposioApps: async () => [] } })
  ;({ pool } = await import('@/lib/db'))
  ;({ workspacePool } = await import('@/lib/workspace-db'))
  ;({ coordinatorWakeTransport: wake } = await import('@/lib/coordinator/wake-after-commit'))
  priorWake = wake.wake
  // Preserve actual requests, permissions and queues; do not start model work.
  wake.wake = async () => undefined
  personal = await import('@/app/api/settings/personal/route')
  workspace = await import('@/app/api/settings/workspace/[workspaceId]/route')
  personalReset = await import('@/app/api/settings/personal/reset/route')
  workspaceReset = await import('@/app/api/settings/workspace/[workspaceId]/reset/route')
  repositories = await import('@/app/api/settings/workspace/[workspaceId]/review-repositories/route')
  runtime = await import('@/lib/schedules/runtime')
  for (const id of [owner, member, outsider]) {
    await pool.query('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,$1,$2,true,now(),now())', [id, `${id}@example.invalid`])
    const home = randomUUID(); homes.push(home)
    await workspacePool.query('INSERT INTO mikka_workspaces (id,"userId",name,kind) VALUES ($1,$2,\'Personal\',\'personal\')', [home, id])
    await workspacePool.query('INSERT INTO mikka_workspace_members ("workspaceId","userId",name,email,role,status) VALUES ($1,$2,$2,$3,\'admin\',\'active\')', [home, id, `${id}@example.invalid`])
  }
  for (const [id, person] of [[workspaceId, owner], [otherWorkspaceId, outsider]]) {
    await workspacePool.query('INSERT INTO mikka_workspaces (id,"userId",name,kind) VALUES ($1,$2,\'Review team\',\'team\')', [id, person])
    await workspacePool.query('INSERT INTO mikka_workspace_members ("workspaceId","userId",name,email,role,status) VALUES ($1,$2,$2,$3,\'admin\',\'active\')', [id, person, `${person}@example.invalid`])
  }
  await workspacePool.query('INSERT INTO mikka_workspace_members ("workspaceId","userId",name,email,role,status) VALUES ($1,$2,$2,$3,\'member\',\'active\')', [workspaceId, member, `${member}@example.invalid`])
  for (const [person, repo] of [[owner, repository], [outsider, foreignRepository]]) {
    await pool.query('INSERT INTO github_repository_installations ("userId","remoteKey","githubAccountId","installationId","repositoryId") VALUES ($1,$2,\'1\',1,1)', [person, repo])
  }
})

after(async () => {
  if (!available) return
  wake.wake = priorWake
  const workspaceIds = [workspaceId, otherWorkspaceId, ...homes]
  await pool.query('DELETE FROM workspace_code_review_repositories WHERE "workspaceId"=ANY($1::uuid[])', [workspaceIds])
  await pool.query('DELETE FROM user_schedules WHERE workspace_id=ANY($1::uuid[])', [workspaceIds])
  await pool.query('DELETE FROM pull_request_defaults WHERE "workspaceId"=ANY($1::uuid[])', [workspaceIds])
  await pool.query('DELETE FROM workspace_code_review_configuration WHERE "workspaceId"=ANY($1::uuid[])', [workspaceIds])
  await pool.query('DELETE FROM workspace_setting_values WHERE "workspaceId"=ANY($1::uuid[])', [workspaceIds])
  await pool.query('DELETE FROM issues WHERE "userId"=ANY($1)', [[owner, member, outsider]])
  await pool.query('DELETE FROM bots WHERE "workspaceId"=ANY($1::uuid[])', [workspaceIds])
  await workspacePool.query('DELETE FROM mikka_workspaces WHERE id=ANY($1::uuid[])', [workspaceIds])
  await pool.query('DELETE FROM "user" WHERE id=ANY($1)', [[owner, member, outsider]])
  await (await import('@/lib/builtin-gateway/runtime')).builtinGateway()?.stop()
  await Promise.all([pool.end(), workspacePool.end()])
})

dbTest('review repository endpoints enforce authentication, current workspace membership and administrator writes', async () => {
  for (const [person, expected] of [[null, 401], [outsider, 403]] as const) {
    as(person)
    for (const response of [
      await repositories.GET(request(path), context()), await saveRepository({ repository }),
      await repositories.DELETE(request(path, 'DELETE', { repository }), context()),
    ]) assert.equal(response.status, expected)
  }
  as(member)
  const read = await repositories.GET(request(path), context())
  assert.equal(read.status, 200)
  assert.deepEqual((await read.json()).availableRepositories, [repository])
  assert.equal((await saveRepository({ repository })).status, 403)
  assert.equal((await repositories.DELETE(request(path, 'DELETE', { repository }), context())).status, 403)
  assert.equal((await workspace.PATCH(request(`workspace/${workspaceId}`, 'PATCH', patch({ codeReviewOutput: 'comments' })), context())).status, 403)
  assert.equal((await workspaceReset.POST(request(`workspace/${workspaceId}/reset`, 'POST', { group: 'code-review' }), context())).status, 403)
  assert.equal((await personal.PATCH(request(`personal?workspaceId=${workspaceId}`, 'PATCH', patch({ codeReviewOutput: 'comments' })))).status, 400)
  as(owner)
  assert.equal((await saveRepository({ repository, ownerId: outsider })).status, 400)
  assert.equal((await saveRepository({ repository: foreignRepository })).status, 400)
  assert.equal((await saveRepository({ repository: 'v2/github.com/invalid/../repo' })).status, 400)
  assert.equal((await pool.query('SELECT 1 FROM workspace_code_review_repositories WHERE "workspaceId"=$1', [workspaceId])).rowCount, 0)
})

dbTest('registry writes typed PR defaults and review configuration, including false overrides and group reset', async () => {
  as(owner)
  const saved = await workspace.PATCH(request(`workspace/${workspaceId}`, 'PATCH', patch({
    prTitlePrefix: '[team]', prBranchPrefix: 'team/review/', prAutoMerge: true, prDraft: true,
    codeReviewModel: 'fixture-review-model', codeReviewSeverity: 'high', codeReviewIgnoredPaths: ['vendor/**', 'vendor/**'], codeReviewOutput: 'summary',
  })), context())
  assert.equal(saved.status, 200)
  const view = await saved.json()
  assert.deepEqual(view.values.prBranchPrefix, { value: 'team/review', source: 'workspace' })
  assert.deepEqual(view.values.codeReviewIgnoredPaths, { value: ['vendor/**'], source: 'workspace' })
  const { publicationDefaults, codeReviewConfiguration } = await import('./settings-storage')
  assert.deepEqual(await publicationDefaults({ userId: member, workspaceId }), { titlePrefix: '[team]', branchPrefix: 'team/review', autoMerge: true, draft: true })
  assert.deepEqual(await codeReviewConfiguration(workspaceId), { model: 'fixture-review-model', severity: 'high', ignoredPaths: ['vendor/**'], output: 'summary' })
  as(member)
  const own = await personal.PATCH(request(`personal?workspaceId=${workspaceId}`, 'PATCH', patch({ prTitlePrefix: '', prAutoMerge: false, prDraft: false })))
  assert.equal(own.status, 200)
  assert.deepEqual((await own.json()).values.prAutoMerge, { value: false, source: 'personal' })
  assert.deepEqual(await publicationDefaults({ userId: member, workspaceId }), { titlePrefix: '', branchPrefix: 'team/review', autoMerge: false, draft: false })
  const reset = await personalReset.POST(request(`personal/reset?workspaceId=${workspaceId}`, 'POST', { group: 'git' }))
  assert.deepEqual((await reset.json()).values.prTitlePrefix, { value: '[team]', source: 'workspace' })
  assert.equal((await publicationDefaults({ userId: member, workspaceId })).autoMerge, true)
  as(owner)
  assert.equal((await workspace.PATCH(request(`workspace/${workspaceId}`, 'PATCH', patch({ prBranchPrefix: '../escape', prAutoMerge: false })), context())).status, 400)
  assert.equal((await publicationDefaults({ userId: member, workspaceId })).autoMerge, true, 'failed multi-field parsing writes no fields')
  const cleared = await workspaceReset.POST(request(`workspace/${workspaceId}/reset`, 'POST', { group: 'git' }), context())
  assert.deepEqual((await cleared.json()).values.prBranchPrefix, { value: 'mikka', source: 'default' })
  assert.deepEqual(await publicationDefaults({ userId: member, workspaceId }), { titlePrefix: '', branchPrefix: 'mikka', autoMerge: false, draft: false })
  const migration = await readFile(new URL('../../drizzle/20261120192100_settings_git_review.sql', import.meta.url), 'utf8')
  await pool.query(migration)
  await pool.query(migration)
  assert.equal((await codeReviewConfiguration(workspaceId)).output, 'summary', 'replaying additive SQL preserves current settings')
})

dbTest('repository configuration uses the native durable GitHub event queue and current admin authority at dispatch', async () => {
  as(owner)
  const created = await saveRepository({ repository })
  assert.equal(created.status, 200, JSON.stringify(await created.clone().json()))
  let schedule = await readSchedule()
  assert.equal(schedule.owner_id, owner)
  assert.equal(schedule.definition.timing.kind, 'manual')
  assert.equal(schedule.definition.task.kind, 'dispatch_task')
  assert.deepEqual(schedule.definition.events?.map(event => event.event), ['pull_request_opened', 'pull_request_pushed'])
  assert.equal(schedule.status, 'active')
  const name = repository.replace('v2/github.com/', '')
  const payload = { action: 'opened', sender: { login: 'fixture', type: 'User' }, repository: { full_name: name },
    pull_request: { number: 7, title: 'Synthetic review target', html_url: `https://github.com/${name}/pull/7`, base: { ref: 'main' }, labels: [], user: { login: 'fixture' } } }
  const delivery = `review-fixture:${randomUUID()}`
  assert.equal(await runtime.fireGitHubAutomations(delivery, 'pull_request', payload), 1)
  assert.equal(await runtime.fireGitHubAutomations(delivery, 'pull_request', payload), 0)
  const occurrence = (await pool.query('SELECT id,trigger FROM schedule_occurrences WHERE schedule_id=$1', [schedule.id])).rows[0]
  const { describeGitHubEvent } = await import('@/lib/schedules/github-events')
  assert.equal(schedule.definition.task.kind, 'dispatch_task')
  if (schedule.definition.task.kind !== 'dispatch_task') throw new Error('Expected native review dispatch')
  const input: DispatchInput = { ownerId: owner, workspaceId, scheduleId: schedule.id, occurrenceId: occurrence.id,
    task: schedule.definition.task, source: 'github', event: describeGitHubEvent(occurrence.trigger.event) }
  const { configuredReviewDispatch } = await import('./automation')
  const configured = await configuredReviewDispatch(input, async value => value)
  assert.equal(configured.run?.model?.id, 'fixture-review-model')
  assert.match(configured.task.prompt, /severity high or higher/)
  assert.match(configured.task.prompt, /vendor\/\*\*/)
  assert.match(configured.task.prompt, /No GitHub write is authorized by summary mode/)
  assert.equal((await saveRepository({ repository })).status, 200)
  assert.equal((await readSchedule()).id, schedule.id, 'saving twice keeps one native automation')
  for (const invalid of [{ ...input, ownerId: member }, { ...input, ownerId: outsider }, { ...input, workspaceId: otherWorkspaceId }, { ...input, source: 'webhook' as const }]) {
    await assert.rejects(configuredReviewDispatch(invalid, async () => assert.fail('Unauthorized dispatch reached task creation')))
  }
  await workspacePool.query('UPDATE mikka_workspace_members SET role=\'member\' WHERE "workspaceId"=$1 AND "userId"=$2', [workspaceId, owner])
  assert.equal((await saveRepository({ repository })).status, 403)
  assert.equal((await workspace.PATCH(request(`workspace/${workspaceId}`, 'PATCH', patch({ codeReviewOutput: 'comments' })), context())).status, 403)
  await assert.rejects(runtime.automationSeams.dispatch!(input), /workspaceAccessDenied/)
  await workspacePool.query('UPDATE mikka_workspace_members SET role=\'admin\',status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2', [workspaceId, owner])
  await assert.rejects(runtime.automationSeams.dispatch!(input), /workspaceMembershipSuspended|workspaceAccessDenied/)
  await workspacePool.query('UPDATE mikka_workspace_members SET status=\'active\' WHERE "workspaceId"=$1 AND "userId"=$2', [workspaceId, owner])
  await pool.query('UPDATE user_schedules SET owner_id=$2 WHERE id=$1', [schedule.id, member])
  await assert.rejects(runtime.automationSeams.dispatch!(input), /scheduleDispatchUnavailable/)
  await pool.query('UPDATE user_schedules SET owner_id=$2 WHERE id=$1', [schedule.id, owner])
  await pool.query('DELETE FROM github_repository_installations WHERE "userId"=$1 AND "remoteKey"=$2', [owner, repository])
  await assert.rejects(runtime.automationSeams.dispatch!(input), /scheduleRepositoryUnavailable/)
  await pool.query('INSERT INTO github_repository_installations ("userId","remoteKey","githubAccountId","installationId","repositoryId") VALUES ($1,$2,\'1\',1,1)', [owner, repository])
  assert.equal((await saveRepository({ repository, enabled: false })).status, 200)
  schedule = await readSchedule()
  assert.equal(schedule.status, 'paused')
  assert.equal((await pool.query('SELECT status FROM schedule_occurrences WHERE id=$1', [occurrence.id])).rows[0].status, 'cancelled')
  await assert.rejects(runtime.automationSeams.dispatch!(input), /scheduleDispatchUnavailable/)
  assert.equal((await repositories.DELETE(request(path, 'DELETE', { repository }), context())).status, 200)
  const deleted = (await pool.query('SELECT status,status_before_delete FROM user_schedules WHERE id=$1', [schedule.id])).rows[0]
  assert.equal(deleted.status, 'cancelled')
  assert.ok(deleted.status_before_delete, 'the native automation preserves its deletion history')
  assert.equal((await pool.query('SELECT 1 FROM workspace_code_review_repositories WHERE "workspaceId"=$1', [workspaceId])).rowCount, 0)
})
