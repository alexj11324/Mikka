import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Socket } from 'node:net'
import test from 'node:test'
import pg from 'pg'
import { disposableDatabase } from './helpers/e2e-target.mjs'
import { withActivitySession } from './fixtures/activity-runtime.mjs'
import type { LiveInvalidation } from '../lib/live/events'

// Only a disposable loopback *_e2e database is admissible; required in CI.
const required = process.env.REQUIRE_DB === '1'
const enabled = disposableDatabase()
if (required && !enabled) throw new Error('Live revision DB test requires a loopback *_e2e database')

// Every byte the database sends to this process, and every query it is sent.
const sockets = new Set<Socket>()
const connect = Socket.prototype.connect
Socket.prototype.connect = function (this: Socket, ...args: unknown[]) {
  sockets.add(this)
  return Reflect.apply(connect, this, args)
} as typeof Socket.prototype.connect
const received = () => [...sockets].reduce((sum, socket) => sum + socket.bytesRead, 0)
let queries = 0
const query = pg.Client.prototype.query
pg.Client.prototype.query = function (this: pg.Client, ...args: unknown[]) { queries++; return Reflect.apply(query, this, args) } as typeof pg.Client.prototype.query

type Fake = { onopen: ((event: unknown) => void) | null; onmessage: ((event: { data: string }) => void) | null; onclose: unknown; onerror: unknown; readyState: 0 | 1 | 2 | 3; send(): void; close(): void }

/** One browser tab or device: a real LiveChannel whose key's read is the real list reader. */
async function client(ownerId: string, workspaceId: string, version: 1 | 2) {
  const { LiveChannel } = await import('../lib/live/channel')
  const { pollIssues } = await import('../app/actions/issues')
  const { actAs } = await import('../lib/acting-user')
  const { heldRevision } = await import('../lib/live/revisions')
  const { LIVE_KINDS, LIVE_REVISION_KINDS } = await import('../lib/live/events')
  let now = 0, socket: Fake | null = null
  const timers = new Map<number, { at: number; callback: () => void }>()
  let next = 0, reads = 0, known: string | undefined
  const channel = new LiveChannel({
    ticket: async () => ({ url: 'wss://gateway.test/socket', protocol: 'ticket', expiresAt: Date.now() + 600_000 }),
    socket: () => (socket = { onopen: null, onmessage: null, onclose: null, onerror: null, readyState: 0, send() {}, close() {} }),
    visible: () => true, watchVisibility: () => () => {}, now: () => Date.now(), monotonicNow: () => now,
    later: (callback, ms) => { timers.set(++next, { at: now + ms, callback }); return next },
    cancel: id => { timers.delete(id as number) },
  })
  let inflight = 0
  const read = async () => {
    reads++; inflight++
    try { const data = await withActivitySession(ownerId, () => actAs(ownerId, () => pollIssues(known)), workspaceId)
    known = data.version
    subscription.update({ revisions: { list: heldRevision(data, 'issue_list', workspaceId) } }) } finally { inflight-- }
  }
  const subscription = channel.subscribe('issue_list', workspaceId, ['list'], read)
  // A read is a real database round trip: wait for it, not a fixed number of turns.
  const settle = async () => { do { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)) } while (inflight) }
  const advance = async (ms: number) => {
    const until = now + ms
    for (;;) {
      const due = [...timers].sort((a, b) => a[1].at - b[1].at)[0]
      if (!due || due[1].at > until) break
      now = due[1].at; timers.delete(due[0]); due[1].callback(); await settle()
    }
    now = until; await settle()
  }
  await settle()
  socket!.readyState = 1; socket!.onopen?.({})
  socket!.onmessage?.({ data: JSON.stringify(version === 2
    ? { type: 'live_ready', version: 2, kinds: LIVE_KINDS, revisions: LIVE_REVISION_KINDS }
    : { type: 'live_ready', version: 1, kinds: LIVE_KINDS }) })
  await advance(200)
  return {
    // What the Worker sends this socket: a version 1 socket gets the plain key.
    push: (events: LiveInvalidation[]) => { for (const event of events) socket!.onmessage?.({ data: JSON.stringify(version === 2 ? event : { kind: event.kind, id: event.id }) }) },
    read, advance, reads: () => reads, reset: () => { reads = 0 }, dispose: () => channel.dispose(),
  }
}

test('one write seen by 3 tabs and 2 devices: the echo and a duplicate push read nothing again', { skip: !enabled, timeout: 120_000 }, async t => {
  const { pool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  const { actAs } = await import('../lib/acting-user')
  const { saveIssue } = await import('../app/actions/issues')
  const { issueListTargets } = await import('../lib/live/lists')
  const { sendLiveTargets } = await import('../lib/live/publish')
  const { ownerLiveScope } = await import('../lib/live/owner-scope')
  const previous = { url: process.env.DEVICE_GATEWAY_URL, secret: process.env.DEVICE_GATEWAY_PUSH_SECRET }
  process.env.DEVICE_GATEWAY_URL = 'https://gateway.example.invalid'
  process.env.DEVICE_GATEWAY_PUSH_SECRET = 'fixture-only-live-revision'
  const pushed: LiveInvalidation[][] = []
  t.mock.method(globalThis, 'fetch', async (input: string | URL, init?: RequestInit) => {
    assert.equal(new URL(String(input)).hostname, 'gateway.example.invalid')
    pushed.push(JSON.parse(String(init?.body)))
    return new Response(null, { status: 204 })
  })
  try {
    const results: Record<string, { reads: number; queries: number; bytes: number }> = {}
    for (const version of [1, 2] as const) {
      // A fresh owner per protocol version: both runs read the same list.
      const owner = `live-revision-${version}-${randomUUID()}`
      await pool.query('insert into "user"(id,name,email,"emailVerified","createdAt","updatedAt") values($1,$1,$2,false,now(),now())', [owner, `${owner}@example.invalid`])
      const personal = randomUUID()
      await workspacePool.query(`insert into mikka_workspaces(id,"userId",name,kind) values($1,$2,'Personal','personal')`, [personal, owner])
      await workspacePool.query(`insert into mikka_workspace_members("workspaceId","userId",name,email,role) values($1,$2,$2,$3,'admin')`, [personal, owner, `${owner}@example.invalid`])
      const first = await withActivitySession(owner, () => actAs(owner, () => saveIssue({ title: 'Seed', content: { type: 'doc', content: [] }, status: 'todo', priority: 'normal' })))
      assert.ok('issue' in first && first.issue)
      const home = await ownerLiveScope(workspacePool, owner)
      assert.ok(home, 'the owner has a personal home')
      const clients = await Promise.all(Array.from({ length: 5 }, () => client(owner, home.workspaceId, version)))
      for (const value of clients) value.reset()
      queries = 0; const before = received()
      // Tab 1 writes. The post-commit publisher runs right after the write's response: the same
      // targets and revision raise the after-commit job runs. Tab 1's own refresh (SWR after a
      // write) is a new request, so it arrives after that raise.
      const saved = await withActivitySession(owner, () => actAs(owner, () => saveIssue({ title: `Write ${version}`, content: { type: 'doc', content: [] }, status: 'todo', priority: 'normal' })))
      assert.ok('issue' in saved && saved.issue)
      pushed.length = 0
      await sendLiveTargets(pool, await issueListTargets(pool, workspacePool, saved.issue.id))
      await clients[0].read()
      const writeQueries = queries, writeBytes = received() - before
      const events = pushed.flat().filter(event => event.kind === 'issue_list' && event.id === home.workspaceId)
      assert.equal(events.length, 1)
      assert.ok(typeof events[0].rev === 'number' && events[0].rev > 0, 'the push carries its revision')
      queries = 0; const pushBefore = received()
      for (const value of clients) value.push(events)
      await Promise.all(clients.map(value => value.advance(3_000)))
      // A retry or a second publisher for the same commit delivers the same key again.
      for (const value of clients) value.push(events)
      await Promise.all(clients.map(value => value.advance(3_000)))
      results[`v${version}`] = { reads: clients.reduce((sum, value) => sum + value.reads(), 0) - 1, queries, bytes: received() - pushBefore }
      t.diagnostic(JSON.stringify({ version, perClient: clients.map(value => value.reads()) }))
      t.diagnostic(JSON.stringify({ version, writeAndOwnRefresh: { queries: writeQueries, bytes: writeBytes }, afterPush: results[`v${version}`] }))
      for (const value of clients) value.dispose()
    }
    // Version 1: every client reads on each delivery. Version 2: the writer's tab skips its echo
    // and nobody reads the duplicate.
    assert.equal(results.v1.reads, 10)
    assert.equal(results.v2.reads, 4)
    assert.ok(results.v2.queries < results.v1.queries && results.v2.bytes < results.v1.bytes, JSON.stringify(results))
    t.diagnostic(JSON.stringify({ measured: results }))
  } finally {
    if (previous.url === undefined) delete process.env.DEVICE_GATEWAY_URL; else process.env.DEVICE_GATEWAY_URL = previous.url
    if (previous.secret === undefined) delete process.env.DEVICE_GATEWAY_PUSH_SECRET; else process.env.DEVICE_GATEWAY_PUSH_SECRET = previous.secret
  }
})

test('a revision rises once per publish across its fan-out and a reader sees the latest', { skip: !enabled }, async t => {
  const { pool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  const { readLiveRevisions } = await import('../lib/live/revisions')
  const { sendLiveTargets } = await import('../lib/live/publish')
  const { resetLiveRevisionFallback } = await import('../lib/live/notify')
  const { liveChannelId } = await import('../lib/live/scope')
  const previous = { url: process.env.DEVICE_GATEWAY_URL, secret: process.env.DEVICE_GATEWAY_PUSH_SECRET }
  process.env.DEVICE_GATEWAY_URL = 'https://gateway.example.invalid'
  process.env.DEVICE_GATEWAY_PUSH_SECRET = 'fixture-only-live-revision'
  const group = randomUUID(), workspaceId = randomUUID()
  const ownerA = `live-revision-fanout-a-${randomUUID()}`, ownerB = `live-revision-fanout-b-${randomUUID()}`
  const scopeA = { ownerId: ownerA, workspaceId }, scopeB = { ownerId: ownerB, workspaceId }
  const channels = [liveChannelId(scopeA), liveChannelId(scopeB)]
  const bodies: LiveInvalidation[][] = []
  const destinations = new WeakMap<LiveInvalidation[], number>()
  let refuse = false
  t.mock.method(globalThis, 'fetch', async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    assert.equal(url.hostname, 'gateway.example.invalid')
    const destination = channels.findIndex(channel => url.pathname === `/v1/live/${channel}/push`)
    assert.ok(destination >= 0, 'the push targets one of the two real workspace members')
    const body: LiveInvalidation[] = JSON.parse(String(init?.body))
    destinations.set(body, destination)
    bodies.push(body)
    // Separate membership reads may finish in either order. Compare recipients
    // in target order while retaining the exact send/retry order per recipient.
    bodies.sort((a, b) => destinations.get(a)! - destinations.get(b)!)
    // An older Worker refuses a third field.
    return new Response(null, { status: refuse && body.some(event => 'rev' in event) ? 400 : 204 })
  })
  try {
    // A real Shared workspace gives both recipients current authority. The
    // production source barrier must not deliver to fabricated owner/W pairs.
    await pool.query('insert into "user"(id,name,email,"emailVerified","createdAt","updatedAt") values($1,$1,$2,false,now(),now()),($3,$3,$4,false,now(),now())',
      [ownerA, `${ownerA}@example.invalid`, ownerB, `${ownerB}@example.invalid`])
    await workspacePool.query(`insert into mikka_workspaces(id,"userId",name,kind) values($1,$2,'Live revision fan-out','team')`, [workspaceId, ownerA])
    await workspacePool.query(`insert into mikka_workspace_members("workspaceId","userId",name,email,role,status)
      values($1,$2,$2,$3,'admin','active'),($1,$4,$4,$5,'member','active')`,
      [workspaceId, ownerA, `${ownerA}@example.invalid`, ownerB, `${ownerB}@example.invalid`])
    const key = { kind: 'group_chat' as const, id: group }
    await sendLiveTargets(pool, [{ scope: scopeA, events: [key] }, { scope: scopeB, events: [key, { kind: 'factory_task', id: group }] }])
    assert.deepEqual(bodies, [[{ ...key, rev: 1 }], [{ ...key, rev: 1 }, { kind: 'factory_task', id: group }]], 'one raise for every member; a kind without revisions stays plain')
    assert.deepEqual(await readLiveRevisions(pool, [key, { kind: 'issue_list', id: randomUUID() }]), { [`group_chat:${group}`]: 1 })
    bodies.length = 0; refuse = true
    await sendLiveTargets(pool, [{ scope: scopeA, events: [key] }])
    assert.deepEqual(bodies, [[{ ...key, rev: 2 }], [key]], 'refused once, then the same key without its revision')
    bodies.length = 0
    await sendLiveTargets(pool, [{ scope: scopeA, events: [key] }])
    assert.deepEqual(bodies, [[key]], 'this instance stops sending revisions for a while after a refusal')
    assert.deepEqual(await readLiveRevisions(pool, [key]), { [`group_chat:${group}`]: 3 })
  } finally {
    resetLiveRevisionFallback()
    await pool.query('delete from live_revisions where id=$1', [group])
    await workspacePool.query('delete from mikka_workspace_members where "workspaceId"=$1', [workspaceId])
    await workspacePool.query('delete from mikka_workspaces where id=$1', [workspaceId])
    await pool.query('delete from "user" where id=any($1::text[])', [[ownerA, ownerB]])
    if (previous.url === undefined) delete process.env.DEVICE_GATEWAY_URL; else process.env.DEVICE_GATEWAY_URL = previous.url
    if (previous.secret === undefined) delete process.env.DEVICE_GATEWAY_PUSH_SECRET; else process.env.DEVICE_GATEWAY_PUSH_SECRET = previous.secret
  }
})

test('prepared owner-list revisions share one PostgreSQL read without duplicate team refs or rows', { skip: !enabled }, async t => {
  const { pool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  const { ownerLiveReadScope } = await import('../lib/live/owner-scope')
  const { readBatchOwnerRevisions, withReadBatchContext } = await import('../lib/desktop-rpc/read-batch-context')
  const { bumpLiveRevisions } = await import('../lib/live/revisions')
  const owner = `batch-revision-${randomUUID()}`, homeId = randomUUID(), teamId = randomUUID()
  await pool.query('insert into "user"(id,name,email,"emailVerified","createdAt","updatedAt") values($1,$1,$2,false,now(),now())', [owner, `${owner}@example.invalid`])
  await workspacePool.query(`insert into mikka_workspaces(id,"userId",name,kind) values($1,$2,'Personal','personal')`, [homeId, owner])
  await workspacePool.query(`insert into mikka_workspace_members("workspaceId","userId",name,email,role) values($1,$2,$2,$3,'admin')`, [homeId, owner, `${owner}@example.invalid`])
  await workspacePool.query(`insert into mikka_workspaces(id,"userId",name,kind) values($1,$2,'Shared','team')`, [teamId, owner])
  await workspacePool.query(`insert into mikka_workspace_members("workspaceId","userId",name,email,role) values($1,$2,$2,$3,'admin')`, [teamId, owner, `${owner}@example.invalid`])
  const kinds = ['task_run_list', 'thread_list', 'bot_chat_list'] as const
  const plan = ['task-runs.pollTaskRuns', 'task-runs.syncThreadList', 'coordinator.pollBotChatSummaries', 'issues.syncIssueList'] as const
  await bumpLiveRevisions(pool, [...kinds.map(kind => ({ kind, id: homeId })), { kind: 'issue_list', id: homeId }, { kind: 'issue_list', id: teamId }])
  const measure = async (selected: string, planned: boolean) => {
    const statements: { refs: number; rows: number; rowJsonBytes: number }[] = []
    let homeQueries = 0
    const homes = { query: async (sql: string, values: string[]) => {
      homeQueries++; return workspacePool.query(sql, values)
    } } as unknown as Parameters<typeof ownerLiveReadScope>[0]
    const database = { query: async (sql: string, values: string[][]) => {
      const result = await pool.query(sql, values)
      statements.push({ refs: values[0].length, rows: result.rows.length, rowJsonBytes: Buffer.byteLength(JSON.stringify(result.rows)) })
      return result
    } } as unknown as Parameters<typeof readBatchOwnerRevisions>[0]
    const read = async (kind: typeof kinds[number] | 'issue_list', selected?: string) => {
      const home = await ownerLiveReadScope(homes, owner)
      assert.ok(home)
      return readBatchOwnerRevisions(database, [{ kind, id: homeId }, ...selected ? [{ kind: 'issue_list' as const, id: selected }] : []], home)
    }
    const values = await withReadBatchContext(async () => {
      const early = await Promise.all(kinds.map(kind => read(kind)))
      // Same legal readiness order as an issue reader's workspace resolution.
      return [...early, await read('issue_list', selected)]
    }, planned ? plan : [])
    return { statements, values, homeQueries }
  }
  for (const selected of [homeId, teamId]) {
    const before = await measure(selected, false), after = await measure(selected, true)
    assert.deepEqual(after.values, before.values)
    assert.equal(before.homeQueries, 1); assert.equal(after.homeQueries, 1)
    assert.equal(before.statements.length, 2)
    assert.equal(after.statements.length, selected === homeId ? 1 : 2)
    const expected = selected === homeId ? 4 : 5
    for (const sample of [before, after]) {
      assert.equal(sample.statements.reduce((sum, row) => sum + row.refs, 0), expected)
      assert.equal(sample.statements.reduce((sum, row) => sum + row.rows, 0), expected)
    }
    assert.ok(after.statements.reduce((sum, row) => sum + row.rowJsonBytes, 0) <= before.statements.reduce((sum, row) => sum + row.rowJsonBytes, 0))
    t.diagnostic(JSON.stringify({ scope: selected === homeId ? 'personal' : 'team-key', before: before.statements, after: after.statements,
      byteMeaning: 'UTF-8 JSON of actual pg result rows, not transport/TLS bytes' }))
  }
})

test('authorized selected-workspace revision plan co-reads exactly the requested Team keys', { skip: !enabled }, async t => {
  const { pool } = await import('../lib/db')
  const context = await import('../lib/desktop-rpc/read-batch-context')
  const { bumpLiveRevisions } = await import('../lib/live/revisions')
  const readWorkspace = context.readBatchWorkspaceRevisions ?? ((database: Parameters<typeof context.readBatchRevisions>[0], refs: Parameters<typeof context.readBatchRevisions>[1]) => context.readBatchRevisions(database, refs))
  const teamId = randomUUID(), ownerId = `workspace-revision-${randomUUID()}`
  const kinds = ['thread_list', 'task_run_list', 'issue_list'] as const
  const plan = ['task-runs.syncThreadList', 'task-runs.pollTaskRuns', 'issues.syncIssueList'] as const
  await bumpLiveRevisions(pool, kinds.map(kind => ({ kind, id: teamId })))
  try {
    const measure = async (planned: boolean) => {
      const statements: { refs: number; rows: number; rowJsonBytes: number }[] = []
      const database = { query: async (sql: string, values: string[][]) => {
        const result = await pool.query(sql, values)
        statements.push({ refs: values[0].length, rows: result.rows.length, rowJsonBytes: Buffer.byteLength(JSON.stringify(result.rows)) })
        return result
      } } as unknown as Parameters<typeof context.readBatchRevisions>[0]
      const values = await context.withReadBatchContext(async () => {
        const reads = []
        for (const kind of kinds) reads.push(await readWorkspace(database, [{ kind, id: teamId }], { ownerId, workspaceId: teamId }))
        return reads
      }, planned ? plan : [])
      return { statements, values }
    }
    const before = await measure(false), after = await measure(true)
    assert.deepEqual(after.values, before.values)
    assert.equal(before.statements.length, 3)
    assert.equal(after.statements.length, 1)
    for (const sample of [before, after]) {
      assert.equal(sample.statements.reduce((sum, row) => sum + row.refs, 0), 3)
      assert.equal(sample.statements.reduce((sum, row) => sum + row.rows, 0), 3)
    }
    assert.ok(after.statements.reduce((sum, row) => sum + row.rowJsonBytes, 0) <= before.statements.reduce((sum, row) => sum + row.rowJsonBytes, 0))
    t.diagnostic(JSON.stringify({ scope: 'authorized-selected-workspace', before: before.statements, after: after.statements,
      byteMeaning: 'UTF-8 JSON of actual pg result rows, not transport/TLS bytes', authorityMeaning: 'revision helper after caller authorization; not a test of membership admission' }))
  } finally {
    await pool.query('delete from live_revisions where id=$1', [teamId])
  }
})
