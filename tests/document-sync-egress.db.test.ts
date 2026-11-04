import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Socket } from 'node:net'
import test from 'node:test'
import * as Y from 'yjs'
import { disposableDatabase } from './helpers/e2e-target.mjs'

// Only a disposable loopback *_e2e database is admissible; required in CI.
const required = process.env.REQUIRE_DB === '1'
const enabled = disposableDatabase()
if (required && !enabled) throw new Error('Document sync DB test requires a loopback *_e2e database')

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

const encode = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')

test('a document poll with no edits on either side reads a version, not the body or state', { skip: !enabled }, async t => {
  const { pool } = await import('../lib/db')
  const { actAs } = await import('../lib/acting-user')
  const { saveIssue } = await import('../app/actions/issues')
  const { exchangeDocument } = await import('../app/actions/collaboration')
  const { createDocumentSeed } = await import('../components/workspace/issue-editor-schema')
  const owner = `doc-sync-${randomUUID()}`
  const stranger = `doc-sync-stranger-${randomUUID()}`
  // About 20 KB of body: an ordinary long task description.
  const content = { type: 'doc', content: Array.from({ length: 80 }, (_, index) => ({ type: 'paragraph', content: [{ type: 'text', text: `Paragraph ${index}: ${'body text '.repeat(24)}` }] })) }
  try {
    for (const id of [owner, stranger]) await pool.query('insert into "user"(id,name,email,"emailVerified","createdAt","updatedAt") values($1,$1,$2,false,now(),now())', [id, `${id}@example.invalid`])
    const saved = await actAs(owner, () => saveIssue({ title: 'Document sync egress', content, status: 'todo', priority: 'normal' }))
    assert.ok('issue' in saved && saved.issue, JSON.stringify(saved))
    const id = saved.issue.id
    const seed = createDocumentSeed(content, id)
    assert.ok(seed)
    const client = new Y.Doc()

    // First exchange: seeds the stored document and returns its version.
    const first = await actAs(owner, () => exchangeDocument({ id, seed: encode(seed), vector: encode(Y.encodeStateVector(client)) }))
    assert.ok(first.update)
    assert.match(first.version, /^[0-9a-f]{32}$/)
    Y.applyUpdate(client, Buffer.from(first.update, 'base64'))
    const state = encode(Y.encodeStateAsUpdate(client))
    const vector = encode(Y.encodeStateVector(client))
    assert.equal((await pool.query('select md5(state) v from issue_documents where "issueId"=$1', [id])).rows[0].v, first.version)

    // Before: every 1.5 s poll uploaded the whole state with no version, so the server read body and state.
    const legacy = await measured(() => actAs(owner, () => exchangeDocument({ id, seed: encode(seed), vector, update: state })))
    assert.equal(legacy.value.version, first.version)
    // After: a quiet poll sends the version it holds.
    const quiet = await measured(() => actAs(owner, () => exchangeDocument({ id, seed: encode(seed), vector, known: first.version })))
    assert.deepEqual(quiet.value, { version: first.version, workspaceId: first.workspaceId })
    t.diagnostic(JSON.stringify({ bodyBytes: JSON.stringify(content).length, stateBytes: state.length, legacyPollDbBytes: legacy.bytes, quietPollDbBytes: quiet.bytes }))
    assert.ok(quiet.bytes * 5 < legacy.bytes, `quiet poll read ${quiet.bytes} B, legacy ${legacy.bytes} B`)

    // Another writer (Linear, an agent) changes the stored document: the next quiet poll gets the change.
    const other = new Y.Doc()
    Y.applyUpdate(other, Buffer.from(state, 'base64'))
    other.getXmlFragment('default').insert(0, [new Y.XmlText('From elsewhere')])
    await pool.query('update issue_documents set state=$2 where "issueId"=$1', [id, encode(Y.encodeStateAsUpdate(other))])
    const changed = await actAs(owner, () => exchangeDocument({ id, seed: encode(seed), vector, known: first.version }))
    assert.ok(changed.update)
    assert.notEqual(changed.version, first.version)
    Y.applyUpdate(client, Buffer.from(changed.update, 'base64'))
    assert.match(client.getXmlFragment('default').toString(), /From elsewhere/)

    // A known version never bypasses access: a stranger is refused before any document read.
    await assert.rejects(actAs(stranger, () => exchangeDocument({ id, vector, known: changed.version })), { code: 'issueNotFound' })
  } finally {
    await pool.query('delete from issue_documents where "userId"=$1', [owner])
    await pool.query('delete from issue_versions where "userId"=$1', [owner])
    await pool.query('delete from issues where "userId"=$1', [owner])
    await pool.query('delete from "user" where id = any($1)', [[owner, stranger]])
  }
})
