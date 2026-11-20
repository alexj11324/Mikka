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
    const removedProject = { ...context, taskCommand: { ...context.taskCommand, projectId: randomUUID() } }
    const refused = new Request('http://localhost/agent', { headers: { 'x-mikka-submission-id': randomUUID(), cookie: 'fixture=1' } })
    await assert.rejects(withActivitySession(user, () => acceptEveMessage(scope, text, removedProject, refused), workspaceId), /projectMoveFailed/)
    assert.equal((await pool.query('select 1 from coordinator_events where "userId"=$1 and kind=$2', [user, 'user_message'])).rowCount, 0, 'a refused create must not leave a pending dispatch')
    assert.equal((await pool.query('select 1 from issues where "userId"=$1', [user])).rowCount, 0)
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

test('Project UUID is checked before commit and survives duplicate names, rename, retries and a subsequent move', { skip: !enabled }, async () => {
  const { pool } = await import('../lib/db')
  const { createTaskOnly } = await import('../app/actions/issues')
  const { moveIssueToProject } = await import('../app/actions/projects')
  const { seedUser, seedPersonalWorkspace, seedProject } = await import('./support/workspace-admin-db')
  const user = await seedUser(pool, 'Project-task-owner'), other = await seedUser(pool, 'Unrelated-project-owner')
  try {
    const workspaceId = await seedPersonalWorkspace(pool, user)
    const first = await seedProject(pool, user, []), target = await seedProject(pool, user, []), foreign = await seedProject(pool, other, [])
    const input: CreateOnlyCommand = { version: 1, intent: 'create_only', workspaceId, projectId: target, requestId: randomUUID(),
      title: 'Project task', content: { type: 'doc' }, status: 'todo', priority: 'normal' }
    const run = <T,>(operation: () => Promise<T>) => withActivitySession(user, operation, workspaceId)
    assert.ok((await run(() => createTaskOnly({ ...input, projectId: foreign }))).error)
    assert.equal((await pool.query('select 1 from issues where "userId"=$1', [user])).rowCount, 0)
    assert.equal((await pool.query('select 1 from task_creation_receipts where "userId"=$1', [user])).rowCount, 0)
    await pool.query('update workspace_projects set name=$2 where id=$1', [target, 'Renamed target'])
    const receipt = await run(() => createTaskOnly(input))
    assert.ok('taskId' in receipt && receipt.taskId, JSON.stringify(receipt))
    const taskId = receipt.taskId
    const relation = async () => (await pool.query('select "projectId" from workspace_project_tasks where "issueId"=$1', [taskId])).rows[0]?.projectId
    assert.equal(await relation(), target)
    assert.deepEqual(await run(() => createTaskOnly(input)), receipt)
    await pool.query('delete from workspace_project_tasks where "issueId"=$1', [taskId])
    assert.deepEqual(await run(() => createTaskOnly(input)), receipt, 'a lost Workspace commit is repairable from the original APP binding')
    assert.equal(await relation(), target)
    const revision = (await pool.query('select revision from issues where id=$1', [taskId])).rows[0].revision
    assert.ok('issue' in await run(() => moveIssueToProject({ workspaceId, projectId: first, issueId: taskId, revision })))
    assert.deepEqual(await run(() => createTaskOnly(input)), receipt)
    assert.equal(await relation(), first)
    assert.equal((await pool.query('select 1 from agent_runs where "issueId"=$1', [taskId])).rowCount, 0)
  } finally {
    await pool.query('delete from issues where "userId"=any($1::text[])', [[user, other]])
    await pool.query('delete from "user" where id=any($1::text[])', [[user, other]])
  }
})

test('the create window properties land in one create: assignee, due date, labels, specific-people access and the assigned Bot wake', { skip: !enabled }, async () => {
  const { pool } = await import('../lib/db')
  const { createTaskOnly } = await import('../app/actions/issues')
  const { updateIssueMetadata } = await import('../app/actions/issue-metadata')
  const { seedUser, seedWorkspace, seedBot } = await import('./support/workspace-admin-db')
  const owner = await seedUser(pool, 'Create-props owner'), teammate = await seedUser(pool, 'Create-props teammate'), outsider = await seedUser(pool, 'Create-props outsider')
  try {
    const workspace = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }, { userId: teammate, role: 'member' }])
    await pool.query('INSERT INTO workspace_issue_labels(workspace_id,name,color) VALUES($1,\'bug\',\'red\')', [workspace.id])
    const bot = await seedBot(pool, workspace.id, owner, 'Captain'), otherBot = await seedBot(pool, workspace.id, owner, 'Second')
    const teammateBot = await seedBot(pool, workspace.id, teammate, 'Not yours')
    const base: CreateOnlyCommand = { version: 1, intent: 'create_only', workspaceId: workspace.id, requestId: randomUUID(), title: 'Ship the new dialog',
      content: { type: 'doc' }, status: 'todo', priority: 'high' }
    const send = (command: CreateOnlyCommand) => withActivitySession(owner, () => createTaskOnly(command), workspace.id)
    const wakes = async (issueId: string) => (await pool.query(`select "userId","botId",payload from coordinator_events where kind='issue_assigned' and "issueId"=$1 order by "createdAt"`, [issueId])).rows

    // Refusals roll the whole create back: another person's Bot, a non-member assignee, a non-member in Access.
    for (const refused of [{ assignee: { kind: 'bot' as const, id: teammateBot } }, { assignee: { kind: 'user' as const, id: outsider } },
      { access: { kind: 'members' as const, memberIds: [outsider] } }]) {
      const result = await send({ ...base, requestId: randomUUID(), ...refused })
      assert.ok(result.error, JSON.stringify(result))
    }
    assert.equal((await pool.query('select 1 from issues where "userId"=$1', [owner])).rowCount, 0)

    const toBot = { ...base, assignee: { kind: 'bot' as const, id: bot }, dueDate: '2026-11-21', labels: [{ name: 'Bug', color: 'red' as const }, { name: 'bug', color: 'red' as const }],
      access: { kind: 'members' as const, memberIds: [teammate] } }
    const [first, replay] = await Promise.all([send(toBot), send(toBot)])
    assert.ok('taskId' in first && first.taskId, JSON.stringify(first))
    assert.deepEqual(replay, first)
    const [row] = (await pool.query('select status,priority,content from issues where id=$1', [first.taskId])).rows
    const meta = row.content.attrs.mikka
    assert.equal(row.priority, 'high')
    assert.deepEqual(meta.delegate, { id: bot, name: 'Captain', kind: 'bot', image: null })
    assert.equal(meta.delegateSelection, 'manual')
    assert.equal(meta.assignee, null)
    assert.equal(meta.dueDate, '2026-11-21')
    assert.deepEqual(meta.labels, [{ name: 'bug', color: 'red' }])
    assert.equal((await pool.query(`select visibility from resource_access_policies where kind='task' and id=$1`, [first.taskId])).rows[0].visibility, 'private')
    assert.deepEqual((await pool.query(`select "subjectId",capabilities from resource_access_grants where "resourceKind"='task' and "resourceId"=$1`, [first.taskId])).rows,
      [{ subjectId: teammate, capabilities: ['canReadContent', 'canComment', 'canSteer'] }])
    // The assigned Bot is woken once in its own chat, with who assigned which task; no thread starts by itself.
    // The actor is the signed-in session's name (the activity fixture names it Synthetic).
    assert.deepEqual(await wakes(first.taskId), [{ userId: owner, botId: bot, payload: { title: 'Ship the new dialog', identifier: first.identifier, actorName: 'Synthetic' } }])
    assert.equal((await pool.query('select 1 from agent_runs where "issueId"=$1', [first.taskId])).rowCount, 0)

    // A person assignee needs no wake; the workspace audience stays shared.
    const toPerson = await send({ ...base, requestId: randomUUID(), assignee: { kind: 'user', id: teammate }, access: { kind: 'workspace' } })
    assert.ok('taskId' in toPerson && toPerson.taskId)
    const personMeta = (await pool.query('select content from issues where id=$1', [toPerson.taskId])).rows[0].content.attrs.mikka
    assert.equal(personMeta.assignee.id, teammate)
    assert.equal((await pool.query(`select visibility from resource_access_policies where kind='task' and id=$1`, [toPerson.taskId])).rows[0].visibility, 'shared')
    assert.deepEqual(await wakes(toPerson.taskId), [])

    // Reassigning later through the property writer wakes the new Bot; saving the same Bot again does not.
    const revision = async () => (await pool.query('select revision from issues where id=$1', [first.taskId])).rows[0].revision as number
    const reassign = (id: string) => revision().then(current => withActivitySession(owner, () => updateIssueMetadata({ id: first.taskId, revision: current, patch: { delegate: { kind: 'bot', id } } }), workspace.id))
    assert.ok('issue' in await reassign(otherBot))
    assert.ok('issue' in await reassign(otherBot))
    assert.deepEqual((await wakes(first.taskId)).map(event => event.botId), [bot, otherBot])
  } finally {
    await pool.query('delete from issues where "userId"=any($1::text[])', [[owner, teammate, outsider]])
    await pool.query('DELETE FROM workspace_issue_labels l USING mikka_workspaces w WHERE l.workspace_id=w.id AND w."userId"=ANY($1::text[])', [[owner, teammate, outsider]])
    await pool.query('delete from "user" where id=any($1::text[])', [[owner, teammate, outsider]])
  }
})

test('a comment on a task wakes its assigned Bot, an @-mention wakes the writer’s named Bot, and a replayed save wakes neither again', { skip: !enabled }, async () => {
  const Y = await import('yjs')
  const { pool } = await import('../lib/db')
  const { createTaskOnly } = await import('../app/actions/issues')
  const { exchangeDocument } = await import('../app/actions/collaboration')
  const { createDocumentSeed } = await import('../components/workspace/issue-editor-schema')
  const { addThread } = await import('../components/blocks/rich-text-editor-4/components/rich-text-comments')
  const { seedUser, seedWorkspace, seedBot } = await import('./support/workspace-admin-db')
  const encode = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')
  const owner = await seedUser(pool, 'Comment-wake owner')
  try {
    const workspace = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }])
    const captain = await seedBot(pool, workspace.id, owner, 'Captain'), helper = await seedBot(pool, workspace.id, owner, 'Helper')
    const as = <T,>(work: () => Promise<T>) => withActivitySession(owner, work, workspace.id)
    const content = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Look at it' }] }] }
    const created = await as(() => createTaskOnly({ version: 1, intent: 'create_only', workspaceId: workspace.id, requestId: randomUUID(), title: 'Comment wake',
      content, status: 'todo', priority: 'normal', assignee: { kind: 'bot', id: captain } }))
    assert.ok('taskId' in created && created.taskId, JSON.stringify(created))
    const id = created.taskId
    const seed = createDocumentSeed(content, id)
    assert.ok(seed)
    const client = new Y.Doc()
    const first = await as(() => exchangeDocument({ id, seed: encode(seed), vector: encode(Y.encodeStateVector(client)) }))
    Y.applyUpdate(client, Buffer.from(first.update!, 'base64'))
    const activity = async () => (await pool.query(`select "botId",payload,"dedupeKey" from coordinator_events where kind='issue_activity' and "issueId"=$1 order by "dedupeKey"`, [id])).rows
    assert.deepEqual(await activity(), [])

    addThread(client, { id: 'discussion-1', author: 'Synthetic', authorUserId: owner, createdAt: new Date().toISOString(),
      messages: [{ author: 'Synthetic', authorUserId: owner, body: 'Can @Helper check the token too?', at: new Date().toISOString() }] }, 'test')
    const update = encode(Y.encodeStateAsUpdate(client))
    await as(() => exchangeDocument({ id, update, vector: encode(Y.encodeStateVector(client)) }))
    await as(() => exchangeDocument({ id, update, vector: encode(Y.encodeStateVector(client)) }))
    const rows = await activity()
    assert.deepEqual(rows.map(row => [row.botId, row.payload.activity, row.payload.text]).sort(), [
      [captain, 'comment', 'Can @Helper check the token too?'],
      [helper, 'mention', 'Can @Helper check the token too?'],
    ].sort())
    assert.ok(rows.every(row => row.payload.title === 'Comment wake' && row.payload.identifier === created.identifier))
    // The wake names its author's account and that the author owns these Bots, for the prompt's untrusted-content framing.
    assert.ok(rows.every(row => row.payload.actorId === owner && row.payload.byOwner === true))
    assert.equal((await pool.query('select 1 from agent_runs where "issueId"=$1', [id])).rowCount, 0)
  } finally {
    await pool.query('delete from issues where "userId"=$1', [owner])
    await pool.query('delete from "user" where id=$1', [owner])
  }
})
