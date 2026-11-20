// Capy's task list (S1-C): views and filters narrow the list on the server, before LIMIT, so a match older than the
// first page is still found and the cursor keeps working within the filtered list.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { disposableDatabase } from './helpers/e2e-target.mjs'
import { withActivitySession } from './fixtures/activity-runtime.mjs'
import { seedCoordinator } from './support/coordinator-bot'
import type { TaskListPageInput } from '../lib/task-list-page'

const enabled = disposableDatabase()
if (process.env.REQUIRE_DB === '1' && !enabled) throw new Error('Task list filter tests require a disposable loopback database')

test('task list views and filters apply before the page limit', { skip: !enabled }, async () => {
  const { pool } = await import('../lib/db')
  const { listWorkspaceTaskPage } = await import('../app/actions/issues')
  const me = 'task-filter-' + randomUUID(), teammate = 'task-filter-' + randomUUID()
  await pool.query('insert into "user"(id,name,email,"emailVerified","createdAt","updatedAt") values($1,$1,$2,true,now(),now())', [me, me + '@example.invalid'])
  const workspaceId = (await seedCoordinator(me)).workspaceId
  const run = <T,>(fn: () => Promise<T>) => withActivitySession(me, fn, workspaceId)
  // 150 plain tasks, newest first, bury everything below on the second page of an unfiltered list.
  await pool.query(`insert into issues(id,"userId","workspaceId","ownershipState",scope,title,content,status,priority,"updatedAt")
    select gen_random_uuid(), $1, $2, 'bound', 'personal', 'Filler ' || n, '{"type":"doc"}'::jsonb, 'todo', 'normal', '2026-01-01T00:00Z'::timestamptz + n * interval '1 minute'
    from generate_series(1, 150) n`, [me, workspaceId])
  const task = async (title: string, mikka: Record<string, unknown>, extra: { status?: string; owner?: string; body?: unknown[] } = {}) => {
    const id = randomUUID()
    const content = { type: 'doc', attrs: { mikka }, content: extra.body ?? [] }
    await pool.query(`insert into issues(id,"userId","workspaceId","ownershipState",scope,title,content,status,priority,"updatedAt")
      values ($1,$2,$3,'bound','personal',$4,$5,$6,'normal','2025-06-01T00:00Z')`, [id, extra.owner ?? me, workspaceId, title, JSON.stringify(content), extra.status ?? 'todo'])
    return id
  }
  const assignee = (id: string) => ({ assignee: { kind: 'member', id, name: id, image: null } })
  const mention = (id: string) => [{ type: 'paragraph', content: [{ type: 'text', text: 'Ping ' }, { type: 'mention', attrs: { id, label: 'Me' } }] }]
  const parent = await task('Parent', {})
  const assigned = await task('Assigned to me', { ...assignee(me), labels: [{ name: 'bug', color: 'red' }], dueDate: '2026-02-01' })
  const assignedDone = await task('Assigned and done', assignee(me), { status: 'done' })
  const theirs = await task('Assigned to a teammate', { ...assignee(teammate), labels: [{ name: 'ui', color: 'blue' }], dueDate: '2026-03-01' })
  const mentioned = await task('Mentions me', {}, { body: mention(me) })
  const followed = await task('Followed', { subscriberUserIds: [me], pullRequests: [{ url: 'https://github.com/o/r/pull/1', state: 'open' }] })
  const child = await task('Closed child', { parentId: parent, blockedByIds: [assigned] }, { status: 'canceled' })
  const openChild = await task('Open child', { parentId: parent })

  const ids = async (filters: Omit<TaskListPageInput, 'workspaceId' | 'after'>) => {
    const page = await run(() => listWorkspaceTaskPage({ workspaceId, after: null, ...filters }))
    assert.equal(page.reset, false)
    return new Set(page.items.map(item => item.id))
  }
  const same = async (filters: Omit<TaskListPageInput, 'workspaceId' | 'after'>, expected: string[], message?: string) =>
    assert.deepEqual(await ids(filters), new Set(expected), message ?? JSON.stringify(filters))

  // Unfiltered, the fixtures sit below the first page; every view below still finds them.
  const unfiltered = await ids({})
  assert.equal(unfiltered.size, 100)
  assert.equal(unfiltered.has(assigned), false)
  await same({ view: 'assigned' }, [assigned, assignedDone])
  await same({ view: 'mentioned' }, [mentioned])
  await same({ view: 'forYou' }, [assigned, mentioned, followed], 'open tasks assigned to, mentioning or followed by me')
  await same({ view: 'created', labels: ['ui'] }, [theirs])
  await same({ assignee: ['me'] }, [assigned, assignedDone])
  await same({ assignee: [teammate, 'me'], labels: ['bug', 'ui'] }, [assigned, theirs])
  await same({ dueAfter: '2026-02-15' }, [theirs])
  await same({ dueBefore: '2026-02-15', dueAfter: '2026-01-15' }, [assigned])
  await same({ hasPr: true }, [followed])
  await same({ subscribed: true }, [followed])
  await same({ relation: 'blocked' }, [child])
  await same({ relation: 'parent' }, [parent])
  await same({ relation: 'child' }, [child, openChild])
  await same({ relation: 'child', hideClosedChildren: true }, [openChild])
  // Match any joins the property filters; match all (the default) needs every one.
  await same({ labels: ['bug'], hasPr: true }, [])
  await same({ labels: ['bug'], hasPr: true, match: 'any' }, [assigned, followed])
  // A view always narrows, whatever `match` says.
  await same({ view: 'assigned', hasPr: true, labels: ['ui'], match: 'any' }, [])

  // The cursor continues inside the filtered list.
  await pool.query(`update issues set content = jsonb_set(content, '{attrs}', jsonb_build_object('mikka', jsonb_build_object('subscriberUserIds', jsonb_build_array($2::text))))
    where "workspaceId" = $1 and title like 'Filler %'`, [workspaceId, me])
  const firstPage = await run(() => listWorkspaceTaskPage({ workspaceId, after: null, subscribed: true }))
  assert.equal(firstPage.items.length, 100)
  const secondPage = await run(() => listWorkspaceTaskPage({ workspaceId, after: firstPage.next, subscribed: true }))
  assert.deepEqual(new Set(secondPage.items.map(item => item.id)).has(followed), true)
  assert.equal(firstPage.items.length + secondPage.items.length, 151)
  // An anchor outside the filtered list is stale, never silently continued.
  const outside = { id: assigned, updatedAt: '2025-06-01T00:00:00.000Z' }
  assert.equal((await run(() => listWorkspaceTaskPage({ workspaceId, after: outside, subscribed: true }))).reset, true)
  // The tabs' counts span the whole collection (the fillers are followed by now, so For you counts them too).
  const { countTaskListViews, listUnreadTaskIds, setTaskUnread } = await import('../app/actions/task-list')
  const counts = await run(() => countTaskListViews(workspaceId))
  assert.deepEqual(counts, { forYou: 153, assigned: 2, created: 158, mentioned: 1, all: 158 })
  // Mark as unread is the person's own flag; reading it clears it; a task outside the workspace list is never returned.
  assert.deepEqual(await run(() => listUnreadTaskIds(workspaceId)), [])
  assert.deepEqual(await run(() => setTaskUnread({ id: assigned, unread: true })), { unread: true })
  assert.deepEqual(await run(() => setTaskUnread({ id: assigned, unread: true })), { unread: true }, 'idempotent')
  assert.deepEqual(await run(() => listUnreadTaskIds(workspaceId)), [assigned])
  assert.deepEqual(await run(() => setTaskUnread({ id: assigned, unread: false })), { unread: false })
  assert.deepEqual(await run(() => listUnreadTaskIds(workspaceId)), [])
  assert.deepEqual(await run(() => setTaskUnread({ id: 'not-a-uuid', unread: true })), { error: 'issueOperationInvalid' })
  await pool.query(`update issues set content = jsonb_set(content, '{attrs,mikka,deletedAt}', to_jsonb(now()::text)) where id = $1`, [mentioned])
  await run(() => setTaskUnread({ id: assigned, unread: true }))
  await pool.query('insert into task_reads (user_id, issue_id, workspace_id, unread) values ($1, $2, $3, true)', [me, mentioned, workspaceId])
  assert.deepEqual(await run(() => listUnreadTaskIds(workspaceId)), [assigned], 'a deleted task is not listed')
  // Unknown values are refused before any read.
  await assert.rejects(run(() => listWorkspaceTaskPage({ workspaceId, after: null, view: 'everything' } as never)))
})
