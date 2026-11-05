import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Socket } from 'node:net'
import test from 'node:test'
import pg from 'pg'
import { disposableDatabase } from './helpers/e2e-target.mjs'
import { withActivitySession } from './fixtures/activity-runtime.mjs'
import type { TabChannel } from '../lib/live/tab-share'

// Only a disposable loopback *_e2e database is admissible; required in CI.
const required = process.env.REQUIRE_DB === '1'
const enabled = disposableDatabase()
if (required && !enabled) throw new Error('Read single-flight DB test requires a loopback *_e2e database')

const sockets = new Set<Socket>()
const connect = Socket.prototype.connect
Socket.prototype.connect = function (this: Socket, ...args: unknown[]) { sockets.add(this); return Reflect.apply(connect, this, args) } as typeof Socket.prototype.connect
const received = () => [...sockets].reduce((sum, socket) => sum + socket.bytesRead, 0)
let queries = 0
const query = pg.Client.prototype.query
pg.Client.prototype.query = function (this: pg.Client, ...args: unknown[]) { queries++; return Reflect.apply(query, this, args) } as typeof pg.Client.prototype.query

/** Same-origin BroadcastChannel: same name, other instances, asynchronous delivery. */
function hub() {
  const named = new Map<string, Set<TabChannel>>()
  return (name: string): TabChannel => {
    const channel: TabChannel = {
      onmessage: null,
      postMessage(data: unknown) { const copy = structuredClone(data); for (const other of named.get(name) ?? []) if (other !== channel) setImmediate(() => other.onmessage?.({ data: copy } as MessageEvent)) },
      close() { named.get(name)?.delete(channel) },
    }
    if (!named.has(name)) named.set(name, new Set())
    named.get(name)!.add(channel)
    return channel
  }
}

async function fixture(prefix: string) {
  const { pool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  const { actAs } = await import('../lib/acting-user')
  const { saveIssue } = await import('../app/actions/issues')
  const owner = `${prefix}-${randomUUID()}`
  await pool.query('insert into "user"(id,name,email,"emailVerified","createdAt","updatedAt") values($1,$1,$2,false,now(),now())', [owner, `${owner}@example.invalid`])
  const personal = randomUUID()
  await workspacePool.query(`insert into mikka_workspaces(id,"userId",name,kind) values($1,$2,'Personal','personal')`, [personal, owner])
  await workspacePool.query(`insert into mikka_workspace_members("workspaceId","userId",name,email,role) values($1,$2,$2,$3,'admin')`, [personal, owner, `${owner}@example.invalid`])
  for (let index = 0; index < 20; index++) {
    const saved = await withActivitySession(owner, () => actAs(owner, () => saveIssue({ title: `Task ${index}`, content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'words '.repeat(80) }] }] }, status: 'todo', priority: 'normal' })))
    assert.ok('issue' in saved && saved.issue)
  }
  return { owner, personal }
}

test('one push to 3 tabs and 2 devices of one person: one list read instead of five', { skip: !enabled, timeout: 180_000 }, async t => {
  const { actAs } = await import('../lib/acting-user')
  const { pollIssues } = await import('../app/actions/issues')
  const { TabShare } = await import('../lib/live/tab-share')
  const { measureWithoutSingleFlight, singleFlightJoined } = await import('../lib/single-flight')
  const results: Record<string, { listReads: number; queries: number; bytes: number }> = {}
  for (const mode of ['before', 'after'] as const) {
    const { owner, personal } = await fixture(`single-flight-${mode}`)
    const open = hub()
    const read = () => withActivitySession(owner, () => actAs(owner, () => pollIssues()), personal)
    const tabs = [0, 1, 2].map(() => new TabShare(`mikka-live-read:${owner}:${personal}`, open))
    let listReads = 0
    const counted = () => { listReads++; return read() }
    measureWithoutSingleFlight(mode === 'before')
    const joined = singleFlightJoined()
    queries = 0; const before = received()
    // Every client flushes its key at the same moment after the push.
    const tabReads = tabs.map(tab => mode === 'after' ? tab.run('issues', counted, () => {}) : counted())
    const deviceReads = [counted(), counted()]
    const values = await Promise.all([...tabReads, ...deviceReads]) as Awaited<ReturnType<typeof read>>[]
    results[mode] = { listReads, queries, bytes: received() - before }
    for (const value of values.filter(Boolean)) assert.equal(value.items?.length, 20, 'every client shows the whole list')
    t.diagnostic(JSON.stringify({ mode, ...results[mode], sharedOnServer: singleFlightJoined() - joined }))
    for (const tab of tabs) tab.close()
  }
  measureWithoutSingleFlight(false)
  assert.equal(results.before.listReads, 5)
  assert.equal(results.after.listReads, 3, 'the tabs read once; each device asks the server')
  assert.ok(results.after.queries < results.before.queries / 2 && results.after.bytes < results.before.bytes / 2, JSON.stringify(results))
  t.diagnostic(JSON.stringify({ measured: results }))
})

test('concurrent reads of two people, or of a removed member, are never shared', { skip: !enabled, timeout: 180_000 }, async () => {
  const { workspacePool } = await import('../lib/workspace-db')
  const { actAs } = await import('../lib/acting-user')
  const { pollIssues } = await import('../app/actions/issues')
  const owner = await fixture('single-flight-owner'), peer = await fixture('single-flight-peer')
  const read = (who: { owner: string; personal: string }, workspace?: string) => withActivitySession(who.owner, () => actAs(who.owner, () => pollIssues()), workspace ?? who.personal)
  const [mine, theirs] = await Promise.all([read(owner), read(peer)])
  assert.ok(mine.items?.every((item: { ownerId: string }) => item.ownerId === owner.owner))
  assert.ok(theirs.items?.every((item: { ownerId: string }) => item.ownerId === peer.owner))
  // The peer joins the owner's personal workspace as a member, then is suspended. Its next
  // concurrent read resolves its own authorization first and never takes the owner's list.
  await workspacePool.query(`insert into mikka_workspace_members("workspaceId","userId",name,email,role) values($1,$2,$2,$3,'member')`, [owner.personal, peer.owner, `${peer.owner}@example.invalid`])
  await workspacePool.query(`update mikka_workspace_members set status='suspended' where "workspaceId"=$1 and "userId"=$2`, [owner.personal, peer.owner])
  const [ownerRead, revoked] = await Promise.all([read(owner), read(peer, owner.personal)])
  assert.equal(ownerRead.items?.length, 20)
  assert.notEqual(revoked.live.selectedWorkspaceId, owner.personal)
  assert.ok(revoked.items?.every((item: { ownerId: string }) => item.ownerId === peer.owner), 'a removed member sees none of the workspace list')
})
