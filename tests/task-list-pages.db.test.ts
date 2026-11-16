import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { disposableDatabase } from './helpers/e2e-target.mjs'
import { withActivitySession } from './fixtures/activity-runtime.mjs'
import { seedCoordinator } from './support/coordinator-bot'
import { nextTaskListCursor } from '../lib/task-list-page'

const enabled = disposableDatabase()
if (process.env.REQUIRE_DB === '1' && !enabled) throw new Error('Task page tests require a disposable loopback database')

test('authorized Task collection traverses every threadless issue, including microsecond ties and the last page', { skip: !enabled }, async () => {
  const { pool } = await import('../lib/db')
  const { countAssignedWorkspaceTasks, listWorkspaceIssues, listWorkspaceTaskPage } = await import('../app/actions/issues')
  const user = 'task-page-' + randomUUID(), other = 'task-page-' + randomUUID()
  async function createUser(id: string) {
    await pool.query('insert into "user"(id,name,email,"emailVerified","createdAt","updatedAt") values($1,$1,$2,true,now(),now())', [id, id+'@example.invalid'])
    return (await seedCoordinator(id)).workspaceId
  }
  try {
    const workspaceId = await createUser(user), foreign = await createUser(other)
    const insert = (id: string, owner: string, count: number) => pool.query(`insert into issues(id,"userId","workspaceId","ownershipState",scope,title,content,status,priority,"updatedAt")
      select gen_random_uuid(), $1, $2, 'bound', 'personal', 'Threadless ' || n, '{"type":"doc"}'::jsonb,'todo','normal',
      '2022-09-12T00:00Z'::timestamptz + (n % 3) * interval '1 microsecond' from generate_series(1,$3::int) n`, [owner,id,count])
    await insert(workspaceId, user, 205); await insert(foreign, other, 1)
    const run = <T,>(fn: () => Promise<T>) => withActivitySession(user, fn, workspaceId)
    // Only explicit human assignments count, including Tasks beyond the first page.
    await pool.query(`update issues set content=jsonb_build_object('type','doc','attrs',jsonb_build_object('mikka',
      jsonb_build_object('assignee', jsonb_build_object('kind','member','id',$1::text,'name','Assignee','image',null))))
      where "workspaceId"=$2`, [user,workspaceId])
    assert.deepEqual(await run(() => countAssignedWorkspaceTasks(workspaceId)), { count: 205 })
    assert.deepEqual(await withActivitySession(other, () => countAssignedWorkspaceTasks(foreign), foreign), { count: 0 })
    await assert.rejects(run(() => countAssignedWorkspaceTasks(foreign)), /workspaceAccessDenied/)
    const first = await run(() => listWorkspaceIssues(workspaceId))
    assert.equal(first.length, 100)
    const cursor = nextTaskListCursor(first)!
    const middle = await run(() => listWorkspaceTaskPage({ workspaceId, after: cursor }))
    assert.equal(middle.reset, false)
    assert.equal(middle.items.length, 100)
    const last = await run(() => listWorkspaceTaskPage({ workspaceId, after: middle.next! }))
    assert.equal(last.items.length, 5)
    assert.equal(last.next, null)
    const expected = await pool.query('select id from issues where "userId"=$1 order by "updatedAt" desc, id desc', [user])
    assert.deepEqual([...first,...middle.items,...last.items].map(row => row.id), expected.rows.map(row => row.id))
    await assert.rejects(run(() => listWorkspaceTaskPage({ workspaceId: foreign, after: cursor })), /workspaceAccessDenied/)
    const anchor = (await pool.query('select id from issues where "userId"=$1', [other])).rows[0].id
    assert.deepEqual(await run(() => listWorkspaceTaskPage({ workspaceId, after: { ...cursor, id: anchor } })), { workspaceId, items: [], next: null, reset: true })
    const parentId = expected.rows[0].id, otherParent = expected.rows[1].id
    const children = expected.rows.slice(2, 107).map(row => row.id)
    await pool.query(`update issues set content=jsonb_build_object('attrs',jsonb_build_object(
      'mikka',jsonb_build_object('parentId',$1::text)))
      where id=any($2::uuid[])`, [parentId, children])
    const byParent = (id: string, after: Parameters<typeof listWorkspaceTaskPage>[0]['after'] = null) =>
      run(() => listWorkspaceTaskPage({ workspaceId, parentId: id, after }))
    const firstChildren = await byParent(parentId)
    assert.equal(firstChildren.items.length, 100)
    const moreChildren = await byParent(parentId, firstChildren.next)
    assert.deepEqual([...firstChildren.items, ...moreChildren.items].map(row => row.id), children)
    assert.equal(moreChildren.next, null)
    assert.equal((await byParent(otherParent, firstChildren.next)).reset, true)
    await assert.rejects(byParent(anchor), /issueNotFound/)
    const { seedAgent, seedBot, seedRun } = await import('./support/workspace-admin-db')
    const agent = await seedAgent(pool, user)
    const firstBot = await seedBot(pool, workspaceId, user, 'First dispatcher'), laterBot = await seedBot(pool, workspaceId, user, 'Later dispatcher')
    const foreignBot = await seedBot(pool, foreign, other, 'Private dispatcher')
    const shared = last.items[0].id, laterOnly = last.items[1].id
    for (const [id, botId] of [[shared, firstBot], [shared, laterBot], [laterOnly, laterBot]]) {
      await seedRun(pool, { userId: user, agentId: agent, workspaceId, botId, issueId: id, status: 'done' })
    }
    const undispatched = last.items[2].id
    const mcp = await seedRun(pool, { userId: user, agentId: agent, workspaceId, botId: firstBot, issueId: undispatched })
    await pool.query("update agent_runs set source='mcp' where id=$1", [mcp])
    const { readTaskPresentations } = await import('../lib/task-presentation-read')
    const index = await readTaskPresentations({ id: user }, { workspaceId, issueIds: [shared, laterOnly, undispatched, anchor], includeBotDispatches: true })
    assert.deepEqual(new Set(index.items[shared].botDispatches?.map(row => row.botId)), new Set([firstBot, laterBot]))
    assert.deepEqual(index.items[laterOnly].botDispatches?.map(row => row.botId), [laterBot])
    assert.deepEqual(index.items[undispatched].botDispatches, [])
    assert.equal(index.items[anchor], undefined, 'a foreign private Task and its dispatches are omitted')
    assert.equal((await readTaskPresentations({ id: user }, { workspaceId, issueIds: [shared] })).items[shared].botDispatches, undefined)
    const { botWorkTree } = await import('../components/nav/bot-work-tree')
    const previousBot = botWorkTree(workspaceId, [firstBot], [], last.items, index.items).get(firstBot)?.[0]
    assert.equal(previousBot?.issueId, shared)
    assert.equal(previousBot?.state, index.items[shared].state)
    assert.equal(previousBot?.runs[0].name, 'First dispatcher')
    assert.equal(previousBot?.runs[0].harness, 'codex')
    assert.equal(previousBot?.runs[0].id, (await pool.query('select id from agent_runs where "issueId"=$1 and "botId"=$2', [shared, firstBot])).rows[0].id)
    const byBot = (dispatchedBy: string) => run(() => listWorkspaceTaskPage({ workspaceId, after: null, dispatchedBy }))
    assert.deepEqual((await byBot(firstBot)).items.map(row => row.id), [shared])
    assert.deepEqual(new Set((await byBot(laterBot)).items.map(row => row.id)), new Set([shared, laterOnly]))
    assert.deepEqual((await byBot(foreignBot)).items, [])
    assert.equal((await run(() => listWorkspaceTaskPage({ workspaceId, after: cursor, dispatchedBy: firstBot }))).reset, true, 'cursor must belong to the filtered set')
    await pool.query('delete from agent_runs where "userId"=$1', [user])
    await pool.query('update issues set "updatedAt"=now() where id=$1', [cursor.id])
    assert.equal((await run(() => listWorkspaceTaskPage({ workspaceId, after: cursor }))).reset, true)
  } finally {
    for (const id of [user, other]) {
      await pool.query('delete from issues where "userId"=$1', [id])
      await pool.query('delete from "user" where id=$1', [id])
    }
  }
})

test('Views counts all seven statuses and each reader’s preferences across pages of the selected visible collection', { skip: !enabled }, async () => {
  const { pool } = await import('../lib/db')
  const { countWorkspaceTaskViews } = await import('../app/actions/issues')
  const owner = 'task-view-' + randomUUID(), peer = 'task-view-' + randomUUID()
  try {
    for (const id of [owner, peer]) {
      await pool.query('insert into "user"(id,name,email,"emailVerified","createdAt","updatedAt") values($1,$1,$2,true,now(),now())', [id, id+'@example.invalid'])
    }
    const { workspaceId } = await seedCoordinator(owner)
    const { workspaceId: personal } = await seedCoordinator(peer)
    await pool.query(`insert into issues(id,"userId","workspaceId","ownershipState",scope,title,content,status,priority)
      select gen_random_uuid(),$1,$2,'bound','personal','Status '||n,jsonb_build_object('type','doc','attrs',
        jsonb_build_object('mikka',
          jsonb_build_object('favoriteUserIds',jsonb_build_array($1::text),'subscriberUserIds',jsonb_build_array($3::text))
          || case when n = 109 then '{"deletedAt":"2026-10-01T00:00:00.000Z"}'::jsonb else '{}'::jsonb end)),
        case when n > 7 then 'todo' else (array['backlog','todo','doing','review','done','canceled','duplicate'])[n] end,
        'normal' from generate_series(1,109) n`, [owner, workspaceId, peer])
    const counts = await withActivitySession(owner, () => countWorkspaceTaskViews(workspaceId), workspaceId)
    assert.deepEqual(counts, { backlog: 1, todo: 102, doing: 1, review: 1, done: 1, canceled: 1, duplicate: 1, favorites: 108, following: 0 })
    const empty = await withActivitySession(peer, () => countWorkspaceTaskViews(personal), personal)
    assert.ok(Object.values(empty).every(value => value === 0))
    await assert.rejects(withActivitySession(peer, () => countWorkspaceTaskViews(workspaceId), personal), /workspaceAccessDenied/)
  } finally {
    for (const id of [owner, peer]) {
      await pool.query('delete from issues where "userId"=$1', [id])
      await pool.query('delete from "user" where id=$1', [id])
    }
  }
})
