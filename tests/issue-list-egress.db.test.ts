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
  const { saveIssue, listIssues } = await import('../app/actions/issues')
  const { listIssueConnections } = await import('../app/actions/issue-operations')
  const { updateIssueMetadata } = await import('../app/actions/issue-metadata')
  const { issueChecklist } = await import('../lib/issue-checklist')
  const owner = `issue-list-${randomUUID()}`
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

    const relations = await measured(() => actAs(owner, () => listIssueConnections(ids[1])))
    assert.equal(relations.value.length, 30)
    assert.equal(relations.value.find(row => row.id === ids[0])?.metadata.estimate, 5)

    const bodies = (await pool.query('select sum(length(content::text))::int n from issues where "userId"=$1', [owner])).rows[0].n
    t.diagnostic(JSON.stringify({ tasks: 30, bodyBytes: bodies, listIssuesDbBytes: list.bytes, listIssueConnectionsDbBytes: relations.bytes }))
    // Reading every body would cost at least `bodies` bytes.
    assert.ok(list.bytes < bodies / 5, `listIssues read ${list.bytes} B for ${bodies} B of bodies`)
    assert.ok(relations.bytes < bodies / 5, `listIssueConnections read ${relations.bytes} B for ${bodies} B of bodies`)
  } finally {
    await pool.query('delete from issue_versions where "userId"=$1', [owner])
    await pool.query('delete from issue_documents where "userId"=$1', [owner])
    await pool.query('delete from issues where "userId"=$1', [owner])
    await pool.query('delete from "user" where id=$1', [owner])
  }
})
