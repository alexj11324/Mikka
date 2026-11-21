// Workspace task states (decision 2026-11-19-2115) against a real PostgreSQL: the seven built-in states are seeded per
// workspace, `issues.status` and `issues.state_id` stay in step both ways, automatic moves land on the category's
// default, and the settings writers (create, rename, reorder, default, MoveAndDelete) keep the list consistent.
import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { dbUrl, seedIssue, seedUser, seedWorkspace } from './support/workspace-admin-db'

test('workspace issue states: seeding, status sync, automatic moves and MoveAndDelete', { skip: !dbUrl, timeout: 120_000 }, async t => {
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: dbUrl, max: 2 })
  // Which task lists each writer refreshes: a real copy of the live module, with workspaceListChanged recorded.
  const listCalls: { workspaceId: string; kinds: string[] }[] = []
  const real = await import(new URL('../lib/live/lists.ts?actual', import.meta.url).href)
  mock.module(new URL('../lib/live/lists.ts', import.meta.url).href, { namedExports: { ...real,
    workspaceListChanged: (executor: object, workspaceId: string, kinds: string[]) => { listCalls.push({ workspaceId, kinds: [...kinds] }); return real.workspaceListChanged(executor, workspaceId, kinds) } } })
  const refreshed = () => listCalls.splice(0).flatMap(call => call.kinds)
  const store = await import('../lib/issue-states-store')
  const { advanceIssueStatus } = await import('../lib/task-status-advance')
  const { pool: appPool, db } = await import('../lib/db')
  const owner = await seedUser(pool, 'issue-states')
  const workspace = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }])
  const other = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }])
  t.after(async () => {
    await pool.query('delete from coordinator_events where "issueId" in (select id from issues where "workspaceId" = any($1))', [[workspace.id, other.id]])
    await pool.query('delete from issue_versions where "issueId" in (select id from issues where "workspaceId" = any($1))', [[workspace.id, other.id]])
    await pool.query('delete from issues where "workspaceId" = any($1)', [[workspace.id, other.id]])
    await pool.query('delete from workspace_issue_states where workspace_id = any($1)', [[workspace.id, other.id]])
    await Promise.all([pool.end(), appPool.end()])
  })
  const actor = { actorType: 'user' as const, actorId: owner }
  const read = async (id: string) => (await pool.query<{ status: string; state_id: string; revision: number }>('select status, state_id, revision from issues where id=$1', [id])).rows[0]

  // A workspace's first task seeds the seven built-in states; every task gets its category's default.
  const task = await seedIssue(pool, owner, workspace.id)
  const states = await store.listIssueStates(db, workspace.id)
  assert.deepEqual(states.map(state => state.category), ['backlog', 'todo', 'doing', 'review', 'done', 'canceled', 'duplicate'])
  assert.ok(states.every(state => state.isDefault && state.name === null))
  assert.deepEqual(states.map(state => state.type), ['open', 'open', 'open', 'open', 'closed', 'closed', 'closed'])
  const byCategory = Object.fromEntries(states.map(state => [state.category, state]))
  assert.equal((await read(task)).state_id, byCategory.todo.id)
  assert.equal(byCategory.todo.taskCount, 1)
  // Seeding again changes nothing.
  await store.ensureIssueStates(db, workspace.id)
  assert.equal((await store.listIssueStates(db, workspace.id)).length, 7)

  // A custom open state of category doing, then made the default of its category.
  const { id: building } = await store.createIssueState({ workspaceId: workspace.id, name: 'Building', category: 'doing', icon: 'half', color: 'blue' })
  await assert.rejects(store.createIssueState({ workspaceId: workspace.id, name: ' building ', category: 'review', icon: 'half', color: 'blue' }), { code: 'issueStateNameTaken' })
  const created = (await store.listIssueStates(db, workspace.id)).find(state => state.id === building)!
  assert.equal(created.type, 'open')
  assert.ok(created.position > byCategory.review.position && created.position < byCategory.done.position + 1000 * 10, 'appended to its group')

  // Choosing a state writes its category as the status.
  await pool.query('update issues set state_id=$2 where id=$1', [task, building])
  assert.equal((await read(task)).status, 'doing')
  // A status-only write in the same category keeps the chosen state; another category takes that default.
  await pool.query(`update issues set status='doing', title='Renamed' where id=$1`, [task])
  assert.equal((await read(task)).state_id, building)
  await pool.query(`update issues set status='todo' where id=$1`, [task])
  assert.equal((await read(task)).state_id, byCategory.todo.id)
  // A state from another workspace is refused.
  await store.ensureIssueStates(db, other.id)
  const foreign = (await store.listIssueStates(db, other.id))[0]
  await assert.rejects(pool.query('update issues set state_id=$2 where id=$1', [task, foreign.id]), { code: '23503' })

  // Automatic moves (lib/task-status-advance.ts) land on the category's default, which the workspace can change.
  refreshed()
  await store.setDefaultIssueState({ workspaceId: workspace.id, id: building })
  // Tasks on a category default carry no stateId in list rows, so a new default must refresh the task lists too.
  assert.deepEqual(new Set(refreshed()), new Set(['workspace_settings', 'issue_list']))
  const defaults = (await store.listIssueStates(db, workspace.id)).filter(state => state.category === 'doing')
  assert.deepEqual(defaults.map(state => [state.id, state.isDefault]), [[byCategory.doing.id, false], [building, true]])
  assert.equal(await advanceIssueStatus(pool, { issueId: task, to: 'doing', since: null, source: 'run-started' }), true)
  assert.deepEqual(await read(task), { status: 'doing', state_id: building, revision: 2 })
  assert.equal(await advanceIssueStatus(pool, { issueId: task, to: 'review', since: null, source: 'run-review' }), true)
  assert.equal((await read(task)).state_id, byCategory.review.id)

  // Rename (and back to the translated name), recolour, reorder.
  await store.updateIssueState({ workspaceId: workspace.id, id: byCategory.review.id, name: 'In review', color: 'purple' })
  let list = await store.listIssueStates(db, workspace.id)
  assert.deepEqual(list.find(state => state.id === byCategory.review.id)!.name, 'In review')
  await store.updateIssueState({ workspaceId: workspace.id, id: byCategory.review.id, name: null })
  list = await store.listIssueStates(db, workspace.id)
  assert.equal(list.find(state => state.id === byCategory.review.id)!.name, null)
  const reversed = list.map(state => state.id).reverse()
  await store.reorderIssueStates({ workspaceId: workspace.id, ids: reversed })
  assert.deepEqual((await store.listIssueStates(db, workspace.id)).map(state => state.id), reversed)
  await assert.rejects(store.reorderIssueStates({ workspaceId: workspace.id, ids: reversed.slice(1) }), { code: 'issueStateNotFound' })
  await assert.rejects(store.reorderIssueStates({ workspaceId: workspace.id, ids: [...reversed.slice(1), foreign.id] }), { code: 'issueStateNotFound' })

  // MoveAndDelete: a default cannot go; another state moves its tasks first, each move versioned for the person.
  await assert.rejects(store.deleteIssueState({ workspaceId: workspace.id, id: building, moveTo: byCategory.todo.id }, actor), { code: 'issueStateDefaultLocked' })
  await store.setDefaultIssueState({ workspaceId: workspace.id, id: byCategory.doing.id })
  await pool.query('update issues set state_id=$2 where id=$1', [task, building])
  const second = await seedIssue(pool, owner, workspace.id)
  await pool.query('update issues set state_id=$2 where id=$1', [second, building])
  await assert.rejects(store.deleteIssueState({ workspaceId: workspace.id, id: building, moveTo: building }, actor), { code: 'issueStateMoveTargetInvalid' })
  await assert.rejects(store.deleteIssueState({ workspaceId: workspace.id, id: building, moveTo: foreign.id }, actor), { code: 'issueStateNotFound' })
  const before = (await read(task)).revision
  const eventsBefore = Number((await pool.query(`select count(*) from coordinator_events where "issueId" = any($1)`, [[task, second]])).rows[0].count)
  assert.deepEqual(await store.deleteIssueState({ workspaceId: workspace.id, id: building, moveTo: byCategory.done.id }, actor), { moved: 2 })
  // As a single status change does, each moved task tells its owner's Coordinator (doing → done is issue_done).
  const { rows: events } = await pool.query<{ kind: string; issueId: string }>(`select kind, "issueId" from coordinator_events where "issueId" = any($1) order by "createdAt" offset $2`, [[task, second], eventsBefore])
  assert.deepEqual(events.map(event => event.kind).sort(), ['issue_done', 'issue_done'])
  assert.deepEqual(new Set(events.map(event => event.issueId)), new Set([task, second]))
  for (const id of [task, second]) {
    const row = await read(id)
    assert.equal(row.state_id, byCategory.done.id)
    assert.equal(row.status, 'done')
  }
  assert.equal((await read(task)).revision, before + 1)
  const { rows: versions } = await pool.query('select status, actor_type, actor_id from issue_versions where "issueId"=$1 order by revision desc limit 1', [task])
  assert.deepEqual(versions, [{ status: 'done', actor_type: 'user', actor_id: owner }])
  assert.equal((await store.listIssueStates(db, workspace.id)).some(state => state.id === building), false)
  assert.equal(await store.readIssueState(db, workspace.id, building), null)
  assert.deepEqual(await store.readIssueState(db, workspace.id, byCategory.done.id), { id: byCategory.done.id, category: 'done' })
})
