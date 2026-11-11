import assert from 'node:assert/strict'
import test from 'node:test'
import { Pool } from 'pg'
import { seedIssue, seedWorkspace } from './support/workspace-admin-db'

/**
 * The task collaboration surface over real HTTP: comments and their replies, the
 * caller's seen marker, the subscription switch, links and the two counters.
 *
 * Every request is a real HTTP call to a running server — its own route handlers,
 * its own database, a real signed session cookie from the product's sign-in route.
 * Nothing here mocks the route, the access check or the SQL.
 *
 *   COLLABORATION_BASE_URL=http://localhost:3100/mikka \
 *   E2E_DATABASE_URL=postgresql://…/…_e2e \
 *   node --import tsx --test tests/issue-collaboration-http.db.test.ts
 */

const base = process.env.COLLABORATION_BASE_URL
const database = process.env.E2E_DATABASE_URL
const enabled = Boolean(base && database)
if (process.env.REQUIRE_COLLABORATION_HTTP === '1') {
  assert.ok(enabled, 'Collaboration HTTP tests need COLLABORATION_BASE_URL and E2E_DATABASE_URL')
}

const origin = base ? new URL(base).origin : ''
const apiPath = (path: string) => `${base}${path}`
const authPath = (path: string) => `${origin}${base ? new URL(base).pathname : ''}/api/auth/${path}`

type Person = { id: string; email: string; cookie: string }

/**
 * A person with a real signed-in browser: signed up and signed in through the
 * product's own auth routes, so the cookie is the one a browser gets.
 */
async function person(label: string): Promise<Person> {
  const email = `${label}-${crypto.randomUUID()}@example.invalid`
  const password = 'collaboration-fixture-password'
  const send = (path: string, body: unknown) => fetch(authPath(path), {
    method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  const signup = await send('sign-up/email', { name: label, email, password })
  assert.equal(signup.status, 200, `sign-up: ${signup.status} ${await signup.clone().text()}`)
  const { user } = await signup.json() as { user: { id: string } }
  // Sign-up itself answers with a session, so a fixture does not spend the sign-in
  // route's rate budget (three a window) on people who only need to be signed in.
  const cookie = signup.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  assert.ok(cookie, 'sign-up sets a session cookie')
  return { id: user.id, email, cookie }
}

/**
 * A task's ACL row. `seedIssue` writes the task itself; the product registers the
 * row that makes it readable when it creates one, so a fixture that inserts the
 * row directly has to register it too — otherwise the visibility predicate
 * correctly hides it and the route answers 404.
 */
async function grantTask(pool: Pool, issueId: string, workspaceId: string, ownerId: string, shared = true) {
  await pool.query(`insert into resource_access_policies(kind,id,"workspaceId","ownerId",visibility,provenance)
    values('task',$1,$2,$3,$4,'created') on conflict do nothing`, [issueId, workspaceId, ownerId, shared ? 'shared' : 'private'])
}

/**
 * A request as the browser sends it: the session cookie plus the workspace the
 * person is acting in. `x-mikka-workspace-id` is an ordinary request preference
 * (lib/workspace-selection.ts), never an access grant — the ACL still decides —
 * but without it the server resolves the person's home workspace, which is not
 * where a fixture's task has to live.
 */
const call = (path: string, cookie: string, workspaceId: string, init: RequestInit = {}) => fetch(apiPath(path), {
  ...init, headers: { cookie, 'content-type': 'application/json', 'x-mikka-workspace-id': workspaceId, ...init.headers },
})

test('a task page can post a comment, reply to it, and read the thread back nested', { skip: !enabled, timeout: 120_000 }, async t => {
  const pool = new Pool({ connectionString: database, max: 2 })
  t.after(async () => { await pool.end() })
  const author = await person('collab-author')
  const reader = await person('collab-reader')
  const workspace = await seedWorkspace(pool, author.id, [{ userId: author.id, role: 'admin' }, { userId: reader.id, role: 'member' }])
  const issueId = await seedIssue(pool, author.id, workspace.id)
  await grantTask(pool, issueId, workspace.id, author.id)

  // 1. A comment.
  const posted = await call(`/api/issues/${issueId}/comments`, author.cookie, workspace.id, {
    method: 'POST', body: JSON.stringify({ body: 'The board loses its column order after a refresh.' }),
  })
  assert.equal(posted.status, 201, `post comment: ${posted.status} ${await posted.clone().text()}`)
  const root = await posted.json() as { id: string; parentId: string | null; createdAt: string }
  assert.equal(root.parentId, null, 'a comment with no replyTo is top-level')

  // 2. A reply to it, written by another account through the same route.
  const replied = await call(`/api/issues/${issueId}/comments`, reader.cookie, workspace.id, {
    method: 'POST', body: JSON.stringify({ body: 'Which browser? I cannot reproduce in Safari.', replyTo: root.id }),
  })
  assert.equal(replied.status, 201, `post reply: ${replied.status} ${await replied.clone().text()}`)
  const child = await replied.json() as { id: string; parentId: string | null }
  assert.equal(child.parentId, root.id, 'the reply names the comment it answers')

  // 3. The thread reads back nested: one top-level comment carrying one reply.
  const listed = await call(`/api/issues/${issueId}/comments`, author.cookie, workspace.id)
  assert.equal(listed.status, 200)
  const thread = await listed.json() as { comments: Array<{ id: string; body: string; author: { id: string }; replies: Array<{ id: string; body: string; author: { id: string } }> }>; total: number }
  assert.equal(thread.total, 2)
  assert.equal(thread.comments.length, 1, 'one thread, not two top-level comments')
  assert.equal(thread.comments[0].id, root.id)
  assert.equal(thread.comments[0].body, 'The board loses its column order after a refresh.')
  assert.equal(thread.comments[0].author.id, author.id)
  assert.equal(thread.comments[0].replies.length, 1, 'the reply is nested under its parent')
  assert.equal(thread.comments[0].replies[0].id, child.id)
  assert.equal(thread.comments[0].replies[0].author.id, reader.id)

  // 4. A reply may not be grafted onto another task's comment.
  const otherIssue = await seedIssue(pool, author.id, workspace.id)
  await grantTask(pool, otherIssue, workspace.id, author.id)
  const grafted = await call(`/api/issues/${otherIssue}/comments`, author.cookie, workspace.id, {
    method: 'POST', body: JSON.stringify({ body: 'cross-task reply', replyTo: root.id }),
  })
  assert.equal(grafted.status, 400, 'a reply target must belong to the same task')

  // 5. An empty body is refused rather than stored.
  const empty = await call(`/api/issues/${issueId}/comments`, author.cookie, workspace.id, { method: 'POST', body: JSON.stringify({ body: '   ' }) })
  assert.equal(empty.status, 400)

  // 6. Every answer is private and uncached: a task's page data is not shared.
  assert.equal(listed.headers.get('cache-control'), 'private, no-store')
})

test('a task nobody shared with the caller answers 404, never 403', { skip: !enabled, timeout: 120_000 }, async t => {
  const pool = new Pool({ connectionString: database, max: 2 })
  t.after(async () => { await pool.end() })
  const owner = await person('collab-private-owner')
  const outsider = await person('collab-outsider')
  const ownerWorkspace = await seedWorkspace(pool, owner.id, [{ userId: owner.id, role: 'admin' }])
  const outsiderWorkspace = await seedWorkspace(pool, outsider.id, [{ userId: outsider.id, role: 'admin' }])
  const issueId = await seedIssue(pool, owner.id, ownerWorkspace.id)
  await grantTask(pool, issueId, ownerWorkspace.id, owner.id)

  for (const [method, path, body] of [
    ['GET', `/api/issues/${issueId}/comments`, undefined],
    ['POST', `/api/issues/${issueId}/comments`, JSON.stringify({ body: 'should not land' })],
    ['POST', `/api/issues/${issueId}/seen`, undefined],
    ['PUT', `/api/issues/${issueId}/subscription`, JSON.stringify({ subscribed: true })],
    ['GET', `/api/issues/${issueId}/links`, undefined],
    ['POST', `/api/issues/${issueId}/links`, JSON.stringify({ ref: 'https://example.invalid/x' })],
  ] as const) {
    const response = await call(path, outsider.cookie, outsiderWorkspace.id, { method, body })
    assert.equal(response.status, 404, `${method} ${path} answers 404, not a confirmation the task exists`)
    assert.deepEqual(await response.json(), { error: 'issueNotFound' })
  }
  // And nothing was written on the way in.
  const rows = await pool.query('select count(*)::int as count from issue_comments where "issueId"=$1', [issueId])
  assert.equal(rows.rows[0].count, 0)
  const links = await pool.query('select count(*)::int as count from issue_links where "issueId"=$1', [issueId])
  assert.equal(links.rows[0].count, 0)
})

test('seen and the two counters reflect a real visit, and mention-count clears for the reader', { skip: !enabled, timeout: 120_000 }, async t => {
  const pool = new Pool({ connectionString: database, max: 2 })
  t.after(async () => { await pool.end() })
  const owner = await person('collab-count-owner')
  const assignee = await person('collab-count-assignee')
  const workspace = await seedWorkspace(pool, owner.id, [{ userId: owner.id, role: 'admin' }, { userId: assignee.id, role: 'member' }])
  const issueId = await seedIssue(pool, owner.id, workspace.id)
  await grantTask(pool, issueId, workspace.id, owner.id)
  await pool.query(`update issues set content = jsonb_set(content, '{attrs,mikka,assignee}', $2::jsonb) where id=$1`,
    [issueId, JSON.stringify({ kind: 'member', id: assignee.id, name: 'assignee', image: null })])

  const assigned = await call('/api/issues/assigned-count', assignee.cookie, workspace.id)
  assert.equal(assigned.status, 200)
  assert.ok((await assigned.json() as { count: number }).count >= 1, 'the assigned task is counted')
  const notMine = await call('/api/issues/assigned-count', owner.cookie, workspace.id)
  assert.equal((await notMine.json() as { count: number }).count, 0, 'the owner is not the assignee')

  // A mention is "comments that arrived since this reader last looked", so the
  // reader looks once first: that visit is the baseline, and it must not itself
  // turn the task's existing history into a badge.
  const firstLook = await call(`/api/issues/${issueId}/seen`, assignee.cookie, workspace.id, { method: 'POST' })
  assert.equal(firstLook.status, 200)
  const fresh = await call('/api/issues/mention-count', assignee.cookie, workspace.id)
  assert.equal((await fresh.json() as { count: number }).count, 0, 'a first look never counts the history it just read')

  // Someone else comments after that look: that is one unread mention.
  await call(`/api/issues/${issueId}/comments`, owner.cookie, workspace.id, { method: 'POST', body: JSON.stringify({ body: 'Please pick this up today.' }) })
  const before = await call('/api/issues/mention-count', assignee.cookie, workspace.id)
  assert.equal(before.status, 200)
  assert.equal((await before.json() as { count: number }).count, 1, 'one unread comment from someone else is one mention')

  // Looking again marks it seen and answers with both counters.
  const seen = await call(`/api/issues/${issueId}/seen`, assignee.cookie, workspace.id, { method: 'POST' })
  assert.equal(seen.status, 200, `seen: ${seen.status} ${await seen.clone().text()}`)
  const seenBody = await seen.json() as { seenAt: string; assigned: number; mentions: number }
  assert.ok(Date.parse(seenBody.seenAt) > 0)
  assert.equal(seenBody.assigned, 1)
  // The answer is the state after the mark, which is what a sidebar badge needs:
  // the visit that just happened clears the mention it was about.
  assert.equal(seenBody.mentions, 0, 'the visit clears the mention it was about, and the answer says so')

  const after = await call('/api/issues/mention-count', assignee.cookie, workspace.id)
  assert.equal((await after.json() as { count: number }).count, 0, 'a visit clears the mentions the reader has now seen')

  // The author's own comment is never their own mention, and the owner never
  // looked at this task, so nothing of theirs is counted either.
  const ownerMentions = await call('/api/issues/mention-count', owner.cookie, workspace.id)
  assert.equal((await ownerMentions.json() as { count: number }).count, 0)

  // Marking seen twice is idempotent and leaves one row per reader.
  await call(`/api/issues/${issueId}/seen`, assignee.cookie, workspace.id, { method: 'POST' })
  const seenRows = await pool.query('select count(*)::int as count from issue_seen where "issueId"=$1 and "userId"=$2', [issueId, assignee.id])
  assert.equal(seenRows.rows[0].count, 1)
})

test('the subscription switch flips, is idempotent, and is the same fact the task list filters on', { skip: !enabled, timeout: 120_000 }, async t => {
  const pool = new Pool({ connectionString: database, max: 2 })
  t.after(async () => { await pool.end() })
  const owner = await person('collab-sub-owner')
  const follower = await person('collab-sub-follower')
  const workspace = await seedWorkspace(pool, owner.id, [{ userId: owner.id, role: 'admin' }, { userId: follower.id, role: 'member' }])
  const issueId = await seedIssue(pool, owner.id, workspace.id)
  await grantTask(pool, issueId, workspace.id, owner.id)

  const on = await call(`/api/issues/${issueId}/subscription`, follower.cookie, workspace.id, { method: 'PUT', body: JSON.stringify({ subscribed: true }) })
  assert.equal(on.status, 200, `subscribe: ${on.status} ${await on.clone().text()}`)
  assert.deepEqual(await on.json(), { subscribed: true })
  // Sent twice on purpose: a page re-sending the state it shows must not toggle it away.
  const again = await call(`/api/issues/${issueId}/subscription`, follower.cookie, workspace.id, { method: 'PUT', body: JSON.stringify({ subscribed: true }) })
  assert.deepEqual(await again.json(), { subscribed: true }, 'setting the state that already holds is not a toggle')

  const stored = await pool.query(`select content->'attrs'->'mikka'->'subscriberUserIds' as ids from issues where id=$1`, [issueId])
  assert.deepEqual(stored.rows[0].ids, [follower.id], 'the one fact is the metadata array the 关注 filter reads')

  const off = await call(`/api/issues/${issueId}/subscription`, follower.cookie, workspace.id, { method: 'PUT', body: JSON.stringify({ subscribed: false }) })
  assert.deepEqual(await off.json(), { subscribed: false })
  const cleared = await pool.query(`select content->'attrs'->'mikka'->'subscriberUserIds' as ids from issues where id=$1`, [issueId])
  assert.deepEqual(cleared.rows[0].ids, [])

  // A body that is not a boolean is refused rather than coerced.
  const bad = await call(`/api/issues/${issueId}/subscription`, follower.cookie, workspace.id, { method: 'PUT', body: JSON.stringify({ subscribed: 'yes' }) })
  assert.equal(bad.status, 400)
})

test('links attach, dedupe by their normal form, list and unlink', { skip: !enabled, timeout: 120_000 }, async t => {
  const pool = new Pool({ connectionString: database, max: 2 })
  t.after(async () => { await pool.end() })
  const owner = await person('collab-link-owner')
  const workspace = await seedWorkspace(pool, owner.id, [{ userId: owner.id, role: 'admin' }])
  const issueId = await seedIssue(pool, owner.id, workspace.id)
  await grantTask(pool, issueId, workspace.id, owner.id)

  const first = await call(`/api/issues/${issueId}/links`, owner.cookie, workspace.id, { method: 'POST', body: JSON.stringify({ ref: 'https://github.com/Owner/Repo/pull/7' }) })
  assert.equal(first.status, 201, `link: ${first.status} ${await first.clone().text()}`)
  // The same pull written differently is the same link, not a second row.
  const duplicate = await call(`/api/issues/${issueId}/links`, owner.cookie, workspace.id, { method: 'POST', body: JSON.stringify({ ref: 'https://github.com/owner/repo/pull/7/' }) })
  assert.equal(duplicate.status, 201)

  const listed = await call(`/api/issues/${issueId}/links`, owner.cookie, workspace.id)
  const { links } = await listed.json() as { links: Array<{ ref: string; target: string }> }
  assert.equal(links.length, 1, 'the normalized target keeps one row')
  assert.equal(links[0].target, 'https://github.com/owner/repo/pull/7')

  const removed = await call(`/api/issues/${issueId}/links`, owner.cookie, workspace.id, { method: 'DELETE', body: JSON.stringify({ target: 'https://github.com/Owner/Repo/pull/7' }) })
  assert.equal(removed.status, 200)
  const afterRemoval = await call(`/api/issues/${issueId}/links`, owner.cookie, workspace.id)
  assert.deepEqual((await afterRemoval.json() as { links: unknown[] }).links, [])

  // A scheme that would execute in a reader's page is refused, not stored.
  const unsafe = await call(`/api/issues/${issueId}/links`, owner.cookie, workspace.id, { method: 'POST', body: JSON.stringify({ ref: 'javascript:alert(1)' }) })
  assert.equal(unsafe.status, 400)
})

test('a task is addressable by its identifier as well as its uuid', { skip: !enabled, timeout: 120_000 }, async t => {
  const pool = new Pool({ connectionString: database, max: 2 })
  t.after(async () => { await pool.end() })
  const owner = await person('collab-code-owner')
  const workspace = await seedWorkspace(pool, owner.id, [{ userId: owner.id, role: 'admin' }])
  const issueId = await seedIssue(pool, owner.id, workspace.id)
  await grantTask(pool, issueId, workspace.id, owner.id)
  // An identifier alias is a lookup hint; the ACL read still decides whether this
  // caller may see the task, so a code and a uuid reach the same comment list.
  const identifier = `COLB-${issueId.slice(0, 8)}`
  await pool.query(`insert into task_identifier_aliases ("issueId","workspaceId","ownerId",identifier,kind,"wasWorkspace")
    values ($1,$2,$3,$4,'issued',true) on conflict do nothing`, [issueId, workspace.id, owner.id, identifier])

  const byCode = await call(`/api/issues/${identifier}/comments`, owner.cookie, workspace.id)
  assert.equal(byCode.status, 200, `identifier lookup: ${byCode.status} ${await byCode.clone().text()}`)
  const byId = await call(`/api/issues/${issueId}/comments`, owner.cookie, workspace.id)
  assert.equal(byId.status, 200)
  assert.deepEqual(await byCode.json(), await byId.json(), 'a code and a uuid name the same task')
})
