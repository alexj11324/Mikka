import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Socket } from 'node:net'
import test from 'node:test'
import pg from 'pg'
import { disposableDatabase } from './helpers/e2e-target.mjs'
import { withActivitySession } from './fixtures/activity-runtime.mjs'
import type { TabChannel } from '../lib/live/tab-share'
import { mergeList, type ListPosition } from '../lib/list-poll'

// Only a disposable loopback *_e2e database is admissible; required in CI.
const required = process.env.REQUIRE_DB === '1'
const enabled = disposableDatabase()
if (required && !enabled) throw new Error('Read single-flight DB test requires a loopback *_e2e database')

const sockets = new Set<Socket>()
const connect = Socket.prototype.connect
Socket.prototype.connect = function (this: Socket, ...args: unknown[]) { sockets.add(this); return Reflect.apply(connect, this, args) } as typeof Socket.prototype.connect
const received = () => [...sockets].reduce((sum, socket) => sum + socket.bytesRead, 0)
let queries = 0, payloadQueries = 0
type ListRowsBarrier = { armed: boolean; reached: () => void; gate: Promise<void> }
let listRowsBarrier: ListRowsBarrier | undefined
let queryCompletionCheckpoint: (() => void) | undefined
function checkpointAfterQuery() {
  const checkpoint = queryCompletionCheckpoint
  // After the last manifest query, continuation microtasks can reach
  // singleFlight before this checkpoint, without a timer loop.
  if (checkpoint) setImmediate(() => { if (queryCompletionCheckpoint === checkpoint) checkpoint() })
}
const query = pg.Client.prototype.query
// Pool instrumentation binds this wrapper when a client connects. Arm its
// state later; replacing the prototype after fixture setup misses those clients.
pg.Client.prototype.query = function (this: pg.Client, ...args: unknown[]) {
  queries++
  const argument = args[0]
  const sql = typeof argument === 'string' ? argument : argument && typeof argument === 'object' && 'text' in argument ? String(argument.text) : ''
  // Only the outer payload SELECT has this predicate; manifest/version/auth
  // queries must remain free to complete while the leader's rows are held.
  const payload = sql.includes('"task_list" where "task_list"."id" in (')
  if (payload) payloadQueries++
  const barrier = payload && listRowsBarrier?.armed ? listRowsBarrier : undefined
  if (barrier) barrier.armed = false
  const callback = args.at(-1)
  if (typeof callback === 'function' && (barrier || queryCompletionCheckpoint)) {
    return Reflect.apply(query, this, [...args.slice(0, -1), (error: unknown, result: unknown) => {
      const complete = () => {
        const value: unknown = callback(error, result)
        checkpointAfterQuery()
        return value
      }
      if (error || !barrier) return complete()
      barrier.reached()
      void barrier.gate.then(complete)
    }])
  }
  const result: unknown = Reflect.apply(query, this, args)
  const pending = barrier ? Promise.resolve(result).then(async value => { barrier.reached(); await barrier.gate; return value }) : result
  return queryCompletionCheckpoint && pending instanceof Promise
    ? pending.then(value => { checkpointAfterQuery(); return value }) : pending
} as typeof pg.Client.prototype.query

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
    const saved = await withActivitySession(owner, () => actAs(owner, () => saveIssue({ title: `Task ${index}`, content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'words '.repeat(80) }] }] }, status: 'todo', priority: 'normal' })), personal)
    assert.ok('issue' in saved && saved.issue)
  }
  return { owner, personal }
}

/** Hold a completed payload query, so another request definitely enters while
 * the first single-flight is pending. The manifest/version reads stay live. */
function holdNextListRows() {
  assert.equal(listRowsBarrier, undefined, 'only one payload barrier may be active')
  let reached!: () => void, release!: () => void
  const atRows = new Promise<void>(resolve => { reached = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  const barrier = { armed: true, reached, gate }
  listRowsBarrier = barrier
  return { atRows, release, restore: () => { release(); if (listRowsBarrier === barrier) listRowsBarrier = undefined } }
}

function timely<T>(promise: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('read did not cross the held-query barrier')), 10_000) })]).finally(() => clearTimeout(timer))
}

test('one push to 3 tabs and 2 devices: tab sharing reduces five list requests to three and lowers DB traffic', { skip: !enabled, timeout: 180_000 }, async t => {
  const { actAs } = await import('../lib/acting-user')
  const { pollIssues } = await import('../app/actions/issues')
  const { TabShare, tabShareChannelName } = await import('../lib/live/tab-share')
  const { readCacheNamespace } = await import('../lib/swr/persistent-cache')
  const { measureWithoutSingleFlight, singleFlightJoined } = await import('../lib/single-flight')
  const results: Record<string, { listReads: number; queries: number; bytes: number }> = {}
  for (const mode of ['before', 'after'] as const) {
    const { owner, personal } = await fixture(`single-flight-${mode}`)
    const open = hub()
    const read = () => withActivitySession(owner, () => actAs(owner, () => pollIssues()), personal)
    const namespace = readCacheNamespace({ userId: owner, workspaceId: personal, build: 'fixture-build', role: 'admin' })
    const tabs = [0, 1, 2].map(() => new TabShare(tabShareChannelName(namespace, personal), open))
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
  // Each remaining request still reauthorizes its complete manifest. These
  // short reads need not overlap on the server; payload joining is tested below.
  assert.ok(results.after.queries < results.before.queries, `tab sharing reduces SQL queries: ${JSON.stringify(results)}`)
  assert.ok(results.after.bytes < results.before.bytes, `tab sharing reduces received socket bytes: ${JSON.stringify(results)}`)
  t.diagnostic(JSON.stringify({ measured: results }))
})

test('overlapping reads with identical authorization and proofs join exactly one list payload query', { skip: !enabled, timeout: 180_000 }, async () => {
  const { actAs } = await import('../lib/acting-user')
  const { pollIssues } = await import('../app/actions/issues')
  const { singleFlightJoined } = await import('../lib/single-flight')
  const { owner, personal } = await fixture('single-flight-identical')
  const read = () => withActivitySession(owner, () => actAs(owner, () => pollIssues()), personal)
  const beforePayloads = payloadQueries, beforeJoined = singleFlightJoined()
  const barrier = holdNextListRows(), leader = read()
  let follower: ReturnType<typeof read> | undefined
  try {
    await timely(barrier.atRows)
    const joined = new Promise<void>(resolve => {
      queryCompletionCheckpoint = () => { if (singleFlightJoined() > beforeJoined) resolve() }
    })
    follower = read()
    await timely(joined)
    queryCompletionCheckpoint = undefined
    assert.equal(singleFlightJoined() - beforeJoined, 1)
    assert.equal(payloadQueries - beforePayloads, 1, 'the follower has not issued another payload SELECT')
    barrier.release()
    const [first, second] = await timely(Promise.all([leader, follower]))
    assert.equal(first.items?.length, 20)
    assert.deepEqual(second, first)
    assert.equal(payloadQueries - beforePayloads, 1)
  } finally {
    queryCompletionCheckpoint = undefined
    barrier.restore()
    await Promise.allSettled([leader, ...(follower ? [follower] : [])])
  }
})

test('concurrent reads of two people, or of a removed member, are never shared', { skip: !enabled, timeout: 180_000 }, async () => {
  const { workspacePool } = await import('../lib/workspace-db')
  const { actAs } = await import('../lib/acting-user')
  const { pollIssues, saveIssue } = await import('../app/actions/issues')
  const owner = await fixture('single-flight-owner'), peer = await fixture('single-flight-peer')
  const read = (who: { owner: string; personal: string }, workspace?: string) => withActivitySession(who.owner, () => actAs(who.owner, () => pollIssues()), workspace ?? who.personal)
  const [mine, theirs] = await Promise.all([read(owner), read(peer)])
  assert.ok(mine.items?.every((item: { ownerId: string }) => item.ownerId === owner.owner))
  assert.ok(theirs.items?.every((item: { ownerId: string }) => item.ownerId === peer.owner))
  // A peer joins a real Shared workspace. Its next concurrent read after
  // suspension must resolve fresh authority before it can share a list flight.
  const shared = randomUUID()
  await workspacePool.query(`insert into mikka_workspaces(id,"userId",name,kind) values($1,$2,'Shared read fixture','team')`, [shared, owner.owner])
  await workspacePool.query(`insert into mikka_workspace_members("workspaceId","userId",name,email,role) values($1,$2,$2,$3,'admin'),($1,$4,$4,$5,'member')`, [shared, owner.owner, `${owner.owner}@example.invalid`, peer.owner, `${peer.owner}@example.invalid`])
  for (let index = 0; index < 20; index++) {
    const saved = await withActivitySession(owner.owner, () => actAs(owner.owner, () => saveIssue({ title: `Shared task ${index}`, content: { type: 'doc', content: [] }, status: 'todo', priority: 'normal' })), shared)
    assert.ok('issue' in saved && saved.issue)
  }
  assert.equal((await read(peer, shared)).items?.length, 20, 'the peer can read before membership is suspended')
  await workspacePool.query(`update mikka_workspace_members set status='suspended' where "workspaceId"=$1 and "userId"=$2`, [shared, peer.owner])
  const [ownerRead, revoked] = await Promise.all([read(owner, shared), read(peer, shared)])
  assert.equal(ownerRead.items?.length, 20)
  assert.notEqual(revoked.live.selectedWorkspaceId, shared)
  assert.ok(revoked.items?.every((item: { ownerId: string }) => item.ownerId === peer.owner), 'a removed member sees none of the workspace list')
})

test('concurrent empty, partial and full snapshots of one owner each receive the rows they need', { skip: !enabled, timeout: 180_000 }, async () => {
  const { actAs } = await import('../lib/acting-user')
  const { pollIssues } = await import('../app/actions/issues')
  const { owner, personal } = await fixture('single-flight-proofs')
  const read = (positions?: readonly ListPosition[]) => withActivitySession(owner, () => actAs(owner, () => pollIssues(undefined, positions)), personal)
  const cold = await read()
  assert.ok(cold.items); assert.ok(cold.positions)
  const [left, right] = [cold.positions.slice(0, 10), cold.positions.slice(10)]
  const barrier = holdNextListRows(), pending = read(left)
  try {
    await timely(barrier.atRows)
    const [rightRead, emptyRead, fullRead] = await timely(Promise.all([read(right), read([]), read()]))
    barrier.release()
    const leftRead = await pending
    const held = (positions: readonly ListPosition[]) => cold.items!.filter(row => positions.some(position => position.id === row.id))
    assert.deepEqual(leftRead.items?.map(row => row.id), right.map(row => row.id))
    assert.deepEqual(rightRead.items?.map(row => row.id), left.map(row => row.id))
    assert.deepEqual(mergeList(held(left), leftRead), cold.items)
    assert.deepEqual(mergeList(held(right), rightRead), cold.items)
    assert.equal(emptyRead.items?.length, 20); assert.equal(fullRead.items?.length, 20)
    assert.equal(emptyRead.delta, true); assert.equal(fullRead.delta, undefined)
  } finally { barrier.restore(); await pending.catch(() => undefined) }
})

test('a request after membership revocation cannot join the older authorized manifest still in flight', { skip: !enabled, timeout: 180_000 }, async () => {
  const { workspacePool } = await import('../lib/workspace-db')
  const { actAs } = await import('../lib/acting-user')
  const { pollIssues, saveIssue } = await import('../app/actions/issues')
  const { promoteExistingIssueForUser } = await import('../lib/team-issue-promotion')
  const owner = await fixture('single-flight-revoke-owner'), peer = await fixture('single-flight-revoke-peer')
  const first = await withActivitySession(owner.owner, () => actAs(owner.owner, () => pollIssues()), owner.personal)
  assert.ok(first.items?.length)
  const workspaceId = randomUUID(), teamId = randomUUID()
  await workspacePool.query(`insert into mikka_workspaces(id,"userId",name) values($1,$2,'Flight team')`, [workspaceId, owner.owner])
  for (const [userId, role] of [[owner.owner, 'admin'], [peer.owner, 'member']]) {
    await workspacePool.query(`insert into mikka_workspace_members("workspaceId","userId",name,email,role) values($1,$2,$2,$3,$4)`, [workspaceId, userId, `${userId}@example.invalid`, role])
  }
  await workspacePool.query(`insert into mikka_teams(id,"workspaceId","userId",name,identifier) values($1,$2,$3,'Flight team','FLIGHT')`, [teamId, workspaceId, owner.owner])
  const saved = await withActivitySession(owner.owner, () => actAs(owner.owner, () => saveIssue({ title: 'Shared flight task', content: { type: 'doc', content: [] }, status: 'todo', priority: 'normal' })), workspaceId)
  assert.ok('issue' in saved && saved.issue)
  const issueId = saved.issue.id
  const promotion = await withActivitySession(owner.owner, () => promoteExistingIssueForUser(owner.owner, { requestId: randomUUID(), issueId, revision: 1, teamId, expectedTeamId: null }), workspaceId)
  assert.ok('issue' in promotion)
  const read = () => withActivitySession(peer.owner, () => actAs(peer.owner, () => pollIssues()), workspaceId)
  assert.ok((await read()).items?.some(item => item.id === issueId))

  const barrier = holdNextListRows(), pending = read()
  try {
    await timely(barrier.atRows)
    // Team metadata is unchanged; the next request must recheck membership.
    await workspacePool.query('update mikka_workspace_members set status=\'suspended\' where "workspaceId"=$1 and "userId"=$2', [workspaceId, peer.owner])
    const revoked = await timely(read())
    assert.ok(revoked.items?.every(item => item.id !== issueId))
    assert.ok(revoked.positions?.every(position => position.id !== issueId))
    barrier.release()
    assert.ok((await pending).items?.some(item => item.id === issueId), 'the held leader proves the two reads overlapped')
  } finally {
    barrier.restore()
    await pending.catch(() => undefined)
  }
})
