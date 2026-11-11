import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { disposableDatabase } from './helpers/e2e-target.mjs'
import { withActivitySession } from './fixtures/activity-runtime.mjs'
import { seedCoordinator } from './support/coordinator-bot'
import type { CreateOnlyCommand } from '../lib/task-create-command'

const enabled = disposableDatabase()
if (process.env.REQUIRE_DB === '1' && !enabled) throw new Error('Task creation requires a disposable loopback database')

test('a create-only command has one durable Task receipt and no dispatch or inference', { skip: !disposableDatabase() }, async () => {
  const { pool } = await import('../lib/db')
  const { createTaskOnly } = await import('../app/actions/issues')
  const { getTaskPresentation } = await import('../app/actions/task-domain')
  const user = `new-task-${randomUUID()}`, stranger = `new-task-${randomUUID()}`
  const insert = (id: string) => pool.query(`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt")
    VALUES($1,$1,$2,true,now(),now())`, [id, `${id}@example.invalid`])
  await insert(user)
  await insert(stranger)
  try {
    const { workspaceId } = await seedCoordinator(user)
    const other = await seedCoordinator(stranger)
    const input: CreateOnlyCommand = { version: 1, intent: 'create_only', requestId: randomUUID(), workspaceId,
      title: 'Backlog task', content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Write it later' }] }] },
      status: 'todo', priority: 'normal' }
    const send = (value: CreateOnlyCommand) => withActivitySession(user, () => createTaskOnly(value), workspaceId)
    const concurrent = await Promise.all(Array.from({ length: 4 }, () => send(input)))
    const result = concurrent[0]!
    assert.ok('taskId' in result, JSON.stringify(result))
    assert.ok(result.taskId && result.identifier)
    assert.equal(result.dispatch, null)
    for (const returned of concurrent) assert.deepEqual(returned, result)
    assert.deepEqual(await send(input), result)
    assert.equal((await send({ ...input, title: 'Different request' })).error, 'submissionConflict')
    assert.equal((await send({ ...input, workspaceId: other.workspaceId })).error, 'workspaceAccessDenied')
    const invalid = { ...input, requestId: randomUUID(), content: { type: 'unknown' } }
    assert.equal((await send(invalid)).error, 'issueCreateFailed')
    assert.equal((await pool.query('SELECT 1 FROM task_creation_receipts WHERE "requestId"=$1', [invalid.requestId])).rowCount, 0)
    const state = await withActivitySession(user, () => getTaskPresentation(result.taskId), workspaceId)
    assert.equal(state.state, 'todo')
    for (const table of ['issues', 'issue_versions', 'task_creation_receipts']) {
      assert.equal((await pool.query(`SELECT 1 FROM ${table} WHERE "userId"=$1`, [user])).rowCount, 1, table)
    }
    for (const table of ['coordinator_events', 'agent_runs', 'factory_tasks']) {
      assert.equal((await pool.query(`SELECT 1 FROM ${table} WHERE "userId"=$1 AND "issueId"=$2`, [user, result.taskId])).rowCount, 0, table)
    }
    await pool.query('DELETE FROM issues WHERE id=$1', [result.taskId])
    assert.equal((await send(input)).error, 'issueNotFound')
  } finally {
    await pool.query('DELETE FROM "user" WHERE id=ANY($1::text[])', [[user, stranger]])
  }
})

test('an explicit automatic-destination dispatch is bound before execution and can recover one accepted receipt', { skip: !enabled }, async () => {
  const { pool } = await import('../lib/db')
  const { acceptEveMessage, commitEveIngress } = await import('../lib/eve/submission')
  const { getDispatchedTaskReceipt, createTaskOnly } = await import('../app/actions/issues')
  const user = 'task-dispatch-' + randomUUID()
  await pool.query('insert into "user"(id,name,email,"emailVerified","createdAt","updatedAt") values($1,$1,$2,true,now(),now())', [user, user + '@example.invalid'])
  try {
    const { botId, workspaceId } = await seedCoordinator(user)
    const scope = { ownerId: user, workspaceId, botId, surface: 'web' as const }
    const requestId = randomUUID(), text = 'Create and dispatch: Check the release notes'
    const args = { workspaceId, requestId, botId }
    const context = { expectedWorkspaceId: workspaceId, taskCommand: { version: 1, intent: 'create_and_dispatch', description: 'Check the release notes' } }
    const request = () => new Request('http://localhost/agent', { headers: { 'x-mikka-submission-id': requestId } })
    const read = () => withActivitySession(user, () => getDispatchedTaskReceipt(args), workspaceId)
    assert.equal(await read(), null)
    const first = request(), second = request()
    const [{ eventId }, replay] = await Promise.all([acceptEveMessage(scope, text, context, first), acceptEveMessage(scope, text, context, second)])
    assert.equal(eventId, replay.eventId)
    assert.equal(await read(), null, 'creation alone is not an accepted delivery')
    await Promise.all([commitEveIngress(first), commitEveIngress(second)])
    const receipt = await read()
    assert.ok(receipt?.identifier && receipt.taskId)
    assert.deepEqual(receipt.dispatch, { sourceEventId: eventId, botId })
    assert.deepEqual((await pool.query('select title,content from issues where id=$1', [receipt.taskId])).rows[0].content.content,
      [{ type: 'paragraph', content: [{ type: 'text', text: context.taskCommand.description }] }])
    assert.equal((await pool.query('select count(*)::int n from coordinator_messages where "userId"=$1', [user])).rows[0].n, 1)
    assert.equal((await pool.query('select count(*)::int n from issues where "userId"=$1', [user])).rows[0].n, 1)
    assert.equal((await acceptEveMessage(scope, text, context, request())).eventId, eventId)
    assert.deepEqual(await read(), receipt)
    await assert.rejects(acceptEveMessage(scope, text + '!', context, request()), /submissionConflict/)
    await assert.rejects(acceptEveMessage(scope, text, { ...context, expectedWorkspaceId: randomUUID() }, request()), /workspaceAccessDenied/)
    const changed = await withActivitySession(user, () => createTaskOnly({ version: 1, intent: 'create_only', requestId, workspaceId,
      title: 'Different intent', content: { type: 'doc' }, status: 'todo', priority: 'normal' }), workspaceId)
    assert.equal(changed.error, 'submissionConflict')
    const { actAs } = await import('../lib/acting-user')
    const { tokenWorkspace } = await import('../lib/tokens/principal')
    const tools = await import('../workflows/coordinator/steps')
    const asOwner = <T,>(run: () => Promise<T>) => actAs({ id: user, [tokenWorkspace]: workspaceId }, run)
    const regenerated = await asOwner(() => tools.createIssue(user, { title: 'Regenerated model title' }, randomUUID(), undefined, botId, eventId))
    assert.equal('id' in regenerated && regenerated.id, receipt.taskId)
    const route = { sourceEventId: eventId, title: 'Another generated title', body: 'Generated details', rationale: 'Explicit human command', needsSpec: false,
      missingInformation: [], missingPermissions: [] }
    const factory = await Promise.all([1, 2].map(() => asOwner(() => tools.intakeFactoryRequest(user, route, undefined, botId))))
    for (const result of factory) assert.ok(result !== null && typeof result === 'object' && !('error' in result), JSON.stringify(result))
    assert.equal((await pool.query('select count(*)::int n from issues where "userId"=$1', [user])).rows[0].n, 1)
    assert.deepEqual((await pool.query('select "issueId" from factory_tasks where "userId"=$1', [user])).rows, [{ issueId: receipt.taskId }])
    const { requestedTaskSelection } = await import('../lib/factory/profile-request')
    const selection = await requestedTaskSelection(pool, { ownerId: user, workspaceId, botId }, eventId, undefined)
    assert.equal(selection.commandIssueId, receipt.taskId)
    const { seedAgent, seedRun } = await import('./support/workspace-admin-db')
    const agentId = await seedAgent(pool, user)
    const runId = await seedRun(pool, { userId: user, agentId, workspaceId, botId, issueId: receipt.taskId, status: 'done' })
    const { rows: [boundFactory] } = await pool.query('select id from factory_tasks where "userId"=$1 and "issueId"=$2', [user, receipt.taskId])
    await pool.query('insert into factory_events ("taskId","eventId",request,result) values ($1,$2,$3,$4)', [boundFactory.id, randomUUID(),
      JSON.stringify({ key: 'fixture-physical-queue', digest: 'fixture', sourceEventId: eventId }), JSON.stringify({ runId })])
    const { dispatchToTask } = await import('../lib/thread-dispatch')
    const again = () => dispatchToTask(user, receipt.taskId, { creation: { eventId, botId, workspaceId }, note: 'Regenerated tool note',
      start: async () => { throw new Error('must not run again') } })
    const replays = await Promise.all([again(), again()])
    for (const replay of replays) assert.deepEqual(replay, { thread: 'existing', runId, threadId: runId })
    assert.equal((await pool.query('select 1 from agent_runs where "issueId"=$1', [receipt.taskId])).rowCount, 1)
    await pool.query('delete from agent_runs where "userId"=$1', [user])
    await pool.query('delete from factory_tasks where "userId"=$1', [user])
    // Deletion retains the command tombstone even if the owning user event cascades.
    await pool.query('delete from issues where id=$1', [receipt.taskId])
    assert.equal(await read(), null)
    await assert.rejects(acceptEveMessage(scope, text, context, request()), /submissionConflict|issueNotFound/)
  } finally {
    await pool.query('delete from "user" where id=$1', [user])
  }
})


test('an explicit Team backlog task checks the exact selected tenant and reconciles repeated creates without dispatch', { skip: !disposableDatabase() }, async () => {
  const { pool } = await import('../lib/db')
  const { createTaskOnly } = await import('../app/actions/issues')
  const { seedUser, seedWorkspace, seedTeam } = await import('./support/workspace-admin-db')
  const user = await seedUser(pool, 'Task team owner'), other = await seedUser(pool, 'Other workspace owner')
  try {
    const workspace = await seedWorkspace(pool, user, [{ userId: user, role: 'admin' }]), foreign = await seedWorkspace(pool, other, [{ userId: other, role: 'admin' }])
    const { id: team } = await seedTeam(pool, workspace.id, user), { id: foreignTeam } = await seedTeam(pool, foreign.id, other)
    const input = { version: 1 as const, intent: 'create_only' as const, workspaceId: workspace.id, teamId: team, requestId: randomUUID(),
      title: 'A team backlog item', content: { type: 'doc' }, priority: 'normal' as const, status: 'todo' as const }
    const send = (command: typeof input) => withActivitySession(user, () => createTaskOnly(command), workspace.id)
    assert.equal((await send({ ...input, teamId: foreignTeam })).error, 'teamIssueAccessDenied')
    assert.equal((await pool.query('select 1 from issues where "userId"=$1', [user])).rowCount, 0)
    const results = await Promise.all([send(input), send(input)])
    assert.ok('taskId' in results[0], JSON.stringify(results))
    assert.deepEqual(results[1], results[0])
    const id = results[0].taskId
    assert.deepEqual((await pool.query('select "teamId","workspaceId" from mikka_team_issues where "issueId"=$1', [id])).rows, [{ teamId: team, workspaceId: workspace.id }])
    assert.equal((await pool.query('select 1 from agent_runs where "issueId"=$1', [id])).rowCount, 0)
    assert.equal((await pool.query('select 1 from coordinator_events where "issueId"=$1', [id])).rowCount, 0)
  } finally {
    await pool.query('delete from issues where "userId"=any($1::text[])', [[user, other]])
    await pool.query('delete from "user" where id=any($1::text[])', [[user, other]])
  }
})
