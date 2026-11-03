import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Socket } from 'node:net'
import test from 'node:test'
import type { JSONContent } from '@tiptap/core'
import { disposableDatabase } from './helpers/e2e-target.mjs'

// Only a disposable loopback *_e2e database is admissible; required in CI.
const required = process.env.REQUIRE_DB === '1'
const enabled = disposableDatabase()
if (required && !enabled) throw new Error('Issue list DB test requires a loopback *_e2e database')

// Every byte the database sends to this process, over every pool's sockets.
const sockets = new Set<Socket>()
const connect = Socket.prototype.connect
Socket.prototype.connect = function (this: Socket, ...args: unknown[]) {
  sockets.add(this)
  return Reflect.apply(connect, this, args)
} as typeof Socket.prototype.connect
const received = () => [...sockets].reduce((sum, socket) => sum + socket.bytesRead, 0)
async function measured<T>(work: () => Promise<T>) {
  const before = received()
  const value = await work()
  return { value, bytes: received() - before }
}

test('the task list and a task\'s relations read metadata and checklist counts, not every body', { skip: !enabled }, async t => {
  const { pool } = await import('../lib/db')
  const { actAs } = await import('../lib/acting-user')
  const { saveIssue, listIssues, pollIssues } = await import('../app/actions/issues')
  const { listIssueConnections } = await import('../app/actions/issue-operations')
  const { updateIssueMetadata } = await import('../app/actions/issue-metadata')
  const { issueChecklist } = await import('../lib/issue-checklist')
  const owner = `issue-list-${randomUUID()}`
  const peer = `issue-list-peer-${randomUUID()}`
  const workspaceId = randomUUID(), teamId = randomUUID(), requestId = randomUUID()
  // 30 tasks of about 10 KB each, with a nested checklist (2 of 3 checked).
  const item = (checked: boolean, nested?: JSONContent[]): JSONContent => ({ type: 'taskItem', attrs: { checked }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'taskItem step' }] }, ...(nested ?? [])] })
  const content = (index: number): JSONContent => ({ type: 'doc', content: [
    ...Array.from({ length: 30 }, (_, line) => ({ type: 'paragraph', content: [{ type: 'text', text: `Task ${index}, line ${line}: ${'words '.repeat(50)}` }] })),
    { type: 'taskList', content: [item(true, [{ type: 'taskList', content: [item(false)] }]), item(true)] },
  ] })
  try {
    await pool.query('insert into "user"(id,name,email,"emailVerified","createdAt","updatedAt") values($1,$1,$2,false,now(),now())', [owner, `${owner}@example.invalid`])
    const ids: string[] = []
    for (let index = 0; index < 30; index++) {
      const saved = await actAs(owner, () => saveIssue({ title: `Task ${index}`, content: content(index), status: 'todo', priority: 'normal' }))
      assert.ok('issue' in saved && saved.issue, JSON.stringify(saved))
      ids.push(saved.issue.id)
    }
    const first = (await pool.query('select revision from issues where id=$1', [ids[0]])).rows[0].revision
    const estimated = await actAs(owner, () => updateIssueMetadata({ id: ids[0], revision: first, patch: { estimate: 5 } }))
    assert.ok('issue' in estimated && estimated.issue, JSON.stringify(estimated))

    const list = await measured(() => actAs(owner, () => listIssues()))
    assert.equal(list.value.length, 30)
    const expected = issueChecklist(content(0))
    assert.deepEqual(expected, { total: 3, checked: 2, percentage: 67 })
    for (const row of list.value) assert.deepEqual(row.checklist, expected)
    assert.equal(list.value.find(row => row.id === ids[0])?.metadata.estimate, 5)
    assert.equal('content' in list.value[0], false)

    const snapshot = await actAs(owner, () => pollIssues())
    assert.ok(snapshot.items)
    const quiet = await measured(() => actAs(owner, () => pollIssues(snapshot.version)))
    assert.equal(quiet.value.unchanged, true)
    assert.equal(quiet.value.items, undefined)
    assert.ok(quiet.bytes < list.bytes / 2, `unchanged ${quiet.bytes} B vs full ${list.bytes} B`)
    t.diagnostic(JSON.stringify({ fullListBytes: list.bytes, unchangedListBytes: quiet.bytes }))
    await pool.query('update issues set title=$2 where id=$1', [ids[0], 'Renamed without a clock change'])
    const changed = await actAs(owner, () => pollIssues(snapshot.version))
    assert.ok(changed.items?.some(row => row.title === 'Renamed without a clock change'))
    assert.notEqual(changed.version, snapshot.version)
    await pool.query('update "user" set image=$2 where id=$1', [owner, 'https://example.invalid/changed-avatar.png'])
    assert.notEqual((await actAs(owner, () => pollIssues(changed.version))).version, changed.version, 'profile changes invalidate the list too')
    await pool.query('insert into "user"(id,name,email,"emailVerified","createdAt","updatedAt") values($1,$1,$2,false,now(),now())', [peer, `${peer}@example.invalid`])
    const foreign = await actAs(peer, () => pollIssues(changed.version))
    assert.deepEqual(foreign.items, [], 'another identity cannot reuse an owner snapshot to obtain private tasks')
    assert.notEqual(foreign.version, changed.version)

    const relations = await measured(() => actAs(owner, () => listIssueConnections(ids[1])))
    assert.equal(relations.value.length, 30)
    assert.equal(relations.value.find(row => row.id === ids[0])?.metadata.estimate, 5)

    const bodies = (await pool.query('select sum(length(content::text))::int n from issues where "userId"=$1', [owner])).rows[0].n
    t.diagnostic(JSON.stringify({ tasks: 30, bodyBytes: bodies, listIssuesDbBytes: list.bytes, listIssueConnectionsDbBytes: relations.bytes }))
    // Reading every body would cost at least `bodies` bytes.
    assert.ok(list.bytes < bodies / 5, `listIssues read ${list.bytes} B for ${bodies} B of bodies`)
    assert.ok(relations.bytes < bodies / 5, `listIssueConnections read ${relations.bytes} B for ${bodies} B of bodies`)
    const { withActivitySession } = await import('./fixtures/activity-runtime.mjs')
    const { promoteExistingIssueForUser } = await import('../lib/team-issue-promotion')
    await pool.query('insert into mikka_workspaces(id,"userId",name) values($1,$2,$3)', [workspaceId, owner, 'Egress visibility fixture'])
    await pool.query('insert into mikka_workspace_members("workspaceId","userId",name,email,role) values($1,$2,$2,$3,$4)', [workspaceId, peer, `${peer}@example.invalid`, 'member'])
    await pool.query('insert into mikka_workspace_members("workspaceId","userId",name,email,role) values($1,$2,$2,$3,$4)', [workspaceId, owner, `${owner}@example.invalid`, 'admin'])
    await pool.query('insert into mikka_teams(id,"workspaceId","userId",name,identifier) values($1,$2,$3,$4,$5)', [teamId, workspaceId, owner, 'Fixture team', 'EGRESS'])
    const promotion = await promoteExistingIssueForUser(owner, { requestId, issueId: ids[1], revision: 1, teamId, expectedTeamId: null })
    assert.ok('issue' in promotion, JSON.stringify(promotion))
    const shared = await withActivitySession(peer, () => actAs(peer, () => pollIssues()), workspaceId)
    assert.equal(shared.items?.length, 1)
    await pool.query('update mikka_workspace_members set status=$3 where "workspaceId"=$1 and "userId"=$2', [workspaceId, peer, 'suspended'])
    const revoked = await withActivitySession(peer, () => actAs(peer, () => pollIssues(shared.version)), workspaceId)
    assert.deepEqual(revoked.items, [], 'revocation falls back to the personal workspace and clears the formerly shared row')
    assert.notEqual(revoked.version, shared.version, 'revocation cannot return an unchanged snapshot')
    const beforeDelete = await actAs(owner, () => pollIssues())
    await pool.query('delete from issue_versions where "issueId"=$1', [ids[0]])
    await pool.query('delete from issue_documents where "issueId"=$1', [ids[0]])
    await pool.query('delete from issues where id=$1', [ids[0]])
    const deleted = await actAs(owner, () => pollIssues(beforeDelete.version))
    assert.equal(deleted.items?.length, beforeDelete.items!.length - 1, 'deletion invalidates the snapshot even without updating another task')
  } finally {
    await pool.query('delete from team_issue_promotion_receipts where "requestId"=$1', [requestId])
    await pool.query('delete from team_issue_promotions where "requestId"=$1', [requestId])
    await pool.query('delete from mikka_team_issues where "teamId"=$1', [teamId])
    await pool.query('delete from mikka_teams where id=$1', [teamId])
    await pool.query('delete from mikka_workspace_members where "workspaceId"=$1', [workspaceId])
    await pool.query('delete from mikka_workspaces where id=$1', [workspaceId])
    await pool.query('delete from issue_versions where "userId"=$1', [owner])
    await pool.query('delete from issue_documents where "userId"=$1', [owner])
    await pool.query('delete from issues where "userId"=$1', [owner])
    await pool.query('delete from "user" where id=ANY($1::text[])', [[owner, peer]])
  }
})
