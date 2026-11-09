import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { after, type TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import type { Pool, PoolClient, QueryResult } from 'pg'
import { isE2eTarget } from '../../tests/helpers/e2e-target.mjs'
import type { HandoffPayload } from '../attention/handoff'
import type { InboxTake } from './store'
import type { CoordinatorStartupSettingsCandidate, CoordinatorStartupTake } from './startup-receipt'

// The application and the observer must address the same disposable PG17 DB.
// Importing this file without a DB is not a verification result; required CI
// fails closed instead of accepting skips.
let databaseUrl: string | undefined
try {
  const target = new URL(process.env.E2E_DATABASE_URL ?? '')
  if (isE2eTarget(target.href) && process.env.MIKKA_DATABASE_URL === target.href
    && process.env.DATABASE_URL === target.href
    && (!process.env.MIKKA_DATABASE_URL_UNPOOLED || process.env.MIKKA_DATABASE_URL_UNPOOLED === target.href)
    && (!process.env.ORVILO_DATABASE_URL || process.env.ORVILO_DATABASE_URL === target.href)) databaseUrl = target.href
} catch { /* no eligible isolated database */ }
if (!databaseUrl && process.env.REQUIRE_DB === '1') throw new Error('Startup receipt tests require matching isolated loopback *_e2e URLs')
const dbTest = databaseUrl ? test : test.skip

/** Own the real afterJob promises through @vercel/functions 3.10.2's existing
 * request-context seam. No scheduler, writer, sender or gateway is replaced.
 * Plain node has no Next after() context, so afterJob's ordinary orRun path
 * starts work and hands its actual Promise to waitUntil here. */
function ownBackgroundWork() {
  type RequestContext = { waitUntil?: (promise: Promise<unknown>) => unknown; [key: string]: unknown }
  type RequestContextProvider = { get?: () => RequestContext }
  const symbol = Symbol.for('@vercel/request-context')
  const previousDescriptor = Object.getOwnPropertyDescriptor(globalThis, symbol)
  const previous = (globalThis as unknown as Record<symbol, RequestContextProvider | undefined>)[symbol]
  const pending = new Set<Promise<void>>(), failures: unknown[] = []
  Object.defineProperty(globalThis, symbol, { configurable: true, enumerable: previousDescriptor?.enumerable ?? false, value: {
    get() {
      const original = previous?.get?.() ?? {}
      return { ...original, waitUntil(promise: Promise<unknown>) {
        const observed = Promise.resolve(promise).then(() => {}, error => { failures.push(error) })
        pending.add(observed)
        void observed.then(() => { pending.delete(observed) })
        return original.waitUntil?.(promise)
      } }
    },
  } })
  return {
    async drain() {
      const until = Date.now() + 15_000
      while (pending.size) await deadline(Promise.all(pending), 'real post-commit background work', Math.max(1, until - Date.now()))
      if (failures.length) throw new AggregateError(failures.splice(0), 'post-commit background work failed')
    },
    restore() {
      if (previousDescriptor) Object.defineProperty(globalThis, symbol, previousDescriptor)
      else Reflect.deleteProperty(globalThis, symbol)
    },
  }
}

const backgroundWork = databaseUrl ? ownBackgroundWork() : null
const runtime = databaseUrl ? await Promise.all([
  import('../db'), import('../db/schema'), import('./store'), import('../coordinator-events'),
  import('./coordinator-bot'), import('../db/listen'), import('../db/commit-effects'),
  import('../db/egress-sample'), import('../builtin-gateway/runtime'), import('../workspace-db'),
]) : null
// Capture this test process's configured runtime during setup. It is lazy:
// the real live sender opens its bus only when it actually publishes. Cleanup
// uses this reference and never calls the factory to create a new gateway.
const ownedGateway = runtime?.[8].builtinGateway() ?? null
if (runtime) after(async () => {
  try { await backgroundWork!.drain() }
  finally {
    try { await ownedGateway?.stop() }
    finally {
      try { await Promise.all([runtime[0].pool.end(), runtime[9].workspacePool.end()]) }
      finally { backgroundWork!.restore() }
    }
  }
})

const firstSettings: CoordinatorStartupSettingsCandidate = {
  computerEnabled: true, mailboxEnabled: false, writeEnabled: true, agentKitEnabled: true,
  switches: { issueTools: true, factoryRouting: false, factoryLifecycle: true },
  runtime: { harness: 'ai_sdk' },
}
const changedSettings: CoordinatorStartupSettingsCandidate = {
  computerEnabled: false, mailboxEnabled: true, writeEnabled: false, agentKitEnabled: false,
  switches: { issueTools: false, factoryRouting: true, factoryLifecycle: false },
  runtime: { harness: 'ai_sdk' },
}
const emptyInbox: InboxTake = {
  held: true, added: 0, telegramTargets: [], handoffMatterIds: [], handoffOnly: false,
  pushEvents: [], pushHidesText: false,
}
type Fixture = { owner: string; botId: string; workspaceId: string; holder: string; pool: Pool }
type Ready = Extract<CoordinatorStartupTake, { kind: 'ready' }>
const ready = (value: CoordinatorStartupTake): Ready => {
  assert.equal(value.kind, 'ready')
  if (value.kind !== 'ready') throw new Error('Expected a ready startup')
  return value
}

async function fixture(t: TestContext, work: (f: Fixture) => Promise<void>, coordinator = true) {
  const [{ createRequestDatabaseScope, pool }] = runtime!
  const scope = createRequestDatabaseScope(databaseUrl!)
  const owner = 'startup-receipt-' + randomUUID(), botId = randomUUID(), workspaceId = randomUUID()
  const f: Fixture = { owner, botId, workspaceId, holder: 'wrun_' + randomUUID(), pool }
  t.after(async () => {
    // Existing DB suites retain synthetic rows for post-failure diagnosis.
    t.diagnostic(JSON.stringify({ event: 'startup_receipt_fixture_retained', fixtureOwnerId: owner, fixtureBotId: botId, database: 'isolated_e2e' }))
    // Deferred live reads retain this request's scope. Finish their real
    // sends before ending that pool, then the file after-hook owns the bus.
    try { await backgroundWork!.drain() } finally { await scope.close() }
  })
  await scope.run(async () => {
    const version = Number((await pool.query('SHOW server_version_num')).rows[0].server_version_num)
    assert.ok(version >= 170000 && version < 180000, 'this concurrency regression must execute on PostgreSQL 17')
    await pool.query('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,$2,$3,true,now(),now())',
      [owner, 'Startup receipt fixture', owner + '@example.invalid'])
    await pool.query('INSERT INTO mikka_workspaces (id,"userId",name,slug,kind) VALUES ($1,$2,$3,$4,$5)',
      [workspaceId, owner, 'Startup receipt workspace', 'startup-' + workspaceId, 'personal'])
    await pool.query('INSERT INTO mikka_workspace_members ("workspaceId","userId",name,email,role,status) VALUES ($1,$2,$3,$4,$5,$6)',
      [workspaceId, owner, 'Fixture owner', owner + '@example.invalid', 'admin', 'active'])
    await pool.query('INSERT INTO bots (id,"ownerId","workspaceId",name) VALUES ($1,$2,$3,$4)',
      [botId, owner, workspaceId, 'Startup receipt bot'])
    if (coordinator) await pool.query('INSERT INTO coordinator_bots ("ownerId","workspaceId","botId") VALUES ($1,$2,$3)', [owner, workspaceId, botId])
    await pool.query('INSERT INTO coordinator_sessions ("userId","botId") VALUES ($1,$2)', [owner, botId])
    await work(f)
  })
}

async function event(f: Fixture, text: string, telegram = false, extra: Record<string, unknown> = {}) {
  const [{ db }, schema, , { userMessageEvent }] = runtime!
  const id = randomUUID()
  const source = userMessageEvent(f.owner, text, { botId: f.botId,
    ...(telegram ? { telegram: { threadId: 'telegram:' + randomUUID(), telegramUserId: 'synthetic-' + randomUUID(), messageId: 1 } } : {}) })
  // Direct durable inserts keep the fixture in charge of delivery. They do
  // not call a wake consumer, Workflow, model, or notification provider.
  await db.insert(schema.coordinatorEvents).values({ id, ...source, payload: { ...source.payload, ...extra } })
  return id
}
const take = (f: Fixture, candidate = firstSettings) => runtime![2].takeStartupInbox(f.owner, f.holder, f.botId, candidate)
async function receiptRows(f: Fixture) {
  return (await f.pool.query('SELECT holder,round,version,settings,inbox FROM coordinator_startup_receipts WHERE "userId"=$1 AND "botId"=$2 ORDER BY holder,round', [f.owner, f.botId])).rows
}
async function decodeReceiptRow(row: { version: unknown; settings: unknown; inbox: unknown }) {
  const { decodeStoredStartupReceipt } = await import('./startup-receipt')
  return { ...row, ...decodeStoredStartupReceipt(row.version, row.settings, row.inbox) }
}
async function lease(f: Fixture) {
  return (await f.pool.query('SELECT "leaseHolder","leaseUntil","updatedAt" FROM coordinator_sessions WHERE "userId"=$1 AND "botId"=$2', [f.owner, f.botId])).rows[0]
}
async function events(f: Fixture) {
  return (await f.pool.query('SELECT id,"deliveredAt",payload,tier FROM coordinator_events WHERE "userId"=$1 AND "botId"=$2 ORDER BY id', [f.owner, f.botId])).rows
}
async function messages(f: Fixture) {
  return (await f.pool.query('SELECT position,message FROM coordinator_messages WHERE "userId"=$1 AND "botId"=$2 ORDER BY position', [f.owner, f.botId])).rows
}
async function pending(f: Fixture, id: string) {
  const row = (await events(f)).find(row => row.id === id)
  assert.ok(row, 'the pending source row exists')
  assert.equal(row.deliveredAt, null, 'later input must remain pending')
  assert.equal(row.payload.mikkaTelegramReply, undefined, 'later input must not acquire a reply receipt')
}

type QueryMetrics = { statements: number; sqlTextUtf8Bytes: number; bindingsJsonUtf8Bytes: number; rowsJsonUtf8Bytes: number; pgProtocolReceiveBytes: number | null; pgProtocolSendBytes: number | null; pgProtocolTotalBytes: number | null }
const queryMetrics = (): QueryMetrics => ({ statements: 0, sqlTextUtf8Bytes: 0, bindingsJsonUtf8Bytes: 0, rowsJsonUtf8Bytes: 0, pgProtocolReceiveBytes: null, pgProtocolSendBytes: null, pgProtocolTotalBytes: null })
function protocolReceived(client: PoolClient): number | null {
  // Same pure-memory source as lib/db/transport-sample.ts. Read only around
  // one operation on one held client, never overlapping individual queries.
  const value = (client as unknown as { connection?: { stream?: { bytesRead?: number } } }).connection?.stream?.bytesRead
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}
function protocolSent(client: PoolClient): number | null {
  const value = (client as unknown as { connection?: { stream?: { bytesWritten?: number } } }).connection?.stream?.bytesWritten
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}
type QuerySnapshot = { metrics: QueryMetrics; received: number | null; sent: number | null }
const querySnapshot = (client: PoolClient, metrics: QueryMetrics): QuerySnapshot => ({ metrics: { ...metrics }, received: protocolReceived(client), sent: protocolSent(client) })
function queryRange(before: QuerySnapshot, after: QuerySnapshot): QueryMetrics {
  const received = before.received !== null && after.received !== null && after.received >= before.received ? after.received - before.received : null
  const sent = before.sent !== null && after.sent !== null && after.sent >= before.sent ? after.sent - before.sent : null
  return {
    statements: after.metrics.statements - before.metrics.statements,
    sqlTextUtf8Bytes: after.metrics.sqlTextUtf8Bytes - before.metrics.sqlTextUtf8Bytes,
    bindingsJsonUtf8Bytes: after.metrics.bindingsJsonUtf8Bytes - before.metrics.bindingsJsonUtf8Bytes,
    rowsJsonUtf8Bytes: after.metrics.rowsJsonUtf8Bytes - before.metrics.rowsJsonUtf8Bytes,
    pgProtocolReceiveBytes: received, pgProtocolSendBytes: sent,
    pgProtocolTotalBytes: received !== null && sent !== null ? received + sent : null,
  }
}
type QueryHook = { before?: (text: string) => Promise<void> | void; after?: (text: string, result: QueryResult) => Promise<void> | void; statements?: string[]; metrics?: QueryMetrics }
/** Only observes/gates actual PG calls; never substitutes a result row. */
function observe(client: PoolClient, hook: QueryHook) {
  const original = client.query
  client.query = new Proxy(original, { apply(target, receiver, args) {
    const text = typeof args[0] === 'string' ? args[0] : args[0]?.text
    if (typeof text !== 'string') return Reflect.apply(target, receiver, args)
    assert.ok(!args.some(arg => typeof arg === 'function'), 'the tested application uses Promise-based pg queries')
    return (async () => {
      hook.statements?.push(text)
      if (hook.metrics) {
        const bindings = Array.isArray(args[1]) ? args[1] : args[0]?.values
        hook.metrics.statements++
        hook.metrics.sqlTextUtf8Bytes += Buffer.byteLength(text)
        hook.metrics.bindingsJsonUtf8Bytes += Array.isArray(bindings) && bindings.length ? Buffer.byteLength(JSON.stringify(bindings)) : 0
      }
      await hook.before?.(text)
      const result = await Reflect.apply(target, receiver, args) as QueryResult
      // Reuse the application's existing JSON-row byte definition. These
      // counts omit protocol frames, type encoding, TLS and socket traffic.
      if (hook.metrics) hook.metrics.rowsJsonUtf8Bytes += runtime![7].describeSample(text, result, null).bytes
      await hook.after?.(text, result)
      return result
    })()
  } })
  return () => { client.query = original }
}
function gate() {
  let enter!: () => void, open!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve })
  const released = new Promise<void>(resolve => { open = resolve })
  return { entered, open, async hold() { enter(); await released } }
}
async function deadline<T>(value: Promise<T>, label: string, milliseconds = 5_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([value, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Timed out waiting for ' + label)), milliseconds)
    })])
  } finally { clearTimeout(timer) }
}
async function waitBlockedBy(observer: PoolClient, waiter: number, blocker: number) {
  const until = Date.now() + 5_000
  do {
    const row = (await observer.query<{ blocked: boolean }>('SELECT $2::int=ANY(pg_blocking_pids($1::int)) AS blocked', [waiter, blocker])).rows[0]
    if (row.blocked) return
    await delay(10)
  } while (Date.now() < until)
  assert.fail('the second real PG lease statement never waited for the first transaction')
}
async function clientFor(f: Fixture) {
  const client = await f.pool.connect()
  await client.query("SET statement_timeout='12s'")
  await client.query("SET lock_timeout='8s'")
  return client
}
function observeFailure<T>(value: Promise<T>): Promise<T> {
  // The controlling test may first wait on another client's barrier.
  // Attach a rejection observer now; assertions still await the original.
  void value.catch(() => {})
  return value
}
async function notificationBarrier(listener: PoolClient, channel: string) {
  const barrier = 'barrier-' + randomUUID()
  let receive!: () => void
  const arrived = new Promise<void>(resolve => { receive = resolve })
  const onBarrier = (value: { payload?: string }) => { if (value.payload === barrier) receive() }
  listener.on('notification', onBarrier)
  try {
    await listener.query('SELECT pg_notify($1,$2)', [channel, barrier])
    await deadline(arrived, 'notification barrier')
  } finally { listener.off('notification', onBarrier) }
}

/**
 * Negative-control adapter for the proposed widened retry scope. The old
 * shipped Workflow checkpointed takeInbox separately; this does NOT assert
 * that every bb5 prepare retry already consumed E2. It deliberately re-enters
 * the actual old store operation as an unsafe composite step would.
 */
async function unsafeComposite(f: Fixture, candidate: CoordinatorStartupSettingsCandidate): Promise<CoordinatorStartupTake> {
  const coordinator = await runtime![4].isCoordinatorBot(f.pool, f.owner, f.botId)
  const inbox = await runtime![2].takeInbox(f.owner, f.holder, f.botId)
  return inbox.held ? { kind: 'ready', settings: { ...candidate, coordinator }, inbox, replayed: false } : { kind: 'not-held', inbox }
}

dbTest('startup retry after a committed take keeps E1 and leaves E2 pending', { timeout: 30_000 }, async t => {
  await fixture(t, async f => {
    // Only this test accepts the explicit test-only negative control.
    const operation = process.env.MIKKA_TEST_STARTUP_LEGACY_COMPOSITE === '1' ? unsafeComposite : take
    const e1 = await event(f, 'E1: the original request', true, { taskDestination: { kind: 'task' } })
    const preparationError = new Error('synthetic prepare failure after the DB commit')
    const captured: { first?: Ready } = {}
    const composite = async (candidate: CoordinatorStartupSettingsCandidate, prepare: (result: Ready) => Promise<void>) => {
      const value = ready(await operation(f, candidate))
      await prepare(value)
      return value
    }
    await assert.rejects(composite(firstSettings, async result => {
      captured.first = result
      // Real DB work has returned/committed before this synthetic downstream
      // failure. A retry re-enters that same widened composite scope.
      assert.equal((await events(f)).find(row => row.id === e1)?.deliveredAt instanceof Date, true)
      throw preparationError
    }), error => error === preparationError)
    const first = captured.first
    assert.ok(first)
    assert.equal(first.inbox.sourceEventId, e1)
    assert.equal(first.inbox.taskEventId, e1)
    assert.equal(first.settings.coordinator, true)
    assert.equal(first.inbox.telegramTargets.length, 1)
    const committedMessages = await messages(f), committedEvents = await events(f)
    const e2 = await event(f, 'E2: a later request', true)
    // Fresh call, changed deployment flags, no in-memory receipt reuse.
    const retried = await composite(changedSettings, async () => {})
    // Keep this assertion first: the RED must be E2 replacing E1, not a
    // missing function/table or a receipt-count mismatch.
    assert.equal(retried.inbox.sourceEventId, e1, 'same startup retry must replay E1 rather than consume E2')
    assert.equal(retried.replayed, true)
    assert.deepEqual(retried.inbox, first.inbox)
    assert.deepEqual(retried.settings, first.settings)
    assert.deepEqual(await messages(f), committedMessages)
    assert.deepEqual((await events(f)).find(row => row.id === e1), committedEvents[0])
    await pending(f, e2)
    const receipts = await receiptRows(f)
    assert.equal(receipts.length, 1)
    assert.ok(receipts[0].settings && typeof receipts[0].settings === 'object' && !Array.isArray(receipts[0].settings))
    assert.ok(receipts[0].inbox && typeof receipts[0].inbox === 'object' && !Array.isArray(receipts[0].inbox))
    assert.deepEqual(Object.keys(receipts[0].settings).sort(), ['f', 'r'])
    assert.deepEqual(Object.keys(receipts[0].inbox).sort(), ['a', 'f', 'k', 'p', 's', 't'])
    assert.deepEqual(await decodeReceiptRow(receipts[0]), { holder: f.holder, round: 0, version: 1, settings: first.settings, inbox: first.inbox })
  })
})

dbTest('multi-event startup preserves chronological order and source timestamp bytes', { timeout: 40_000 }, async t => {
  for (const kind of ['direct-messages', 'runtime-with-background'] as const) await t.test(kind, async child => {
    await fixture(child, async f => {
      const stamps = ['2026-01-01T12:00:00.001Z', '2026-01-01T12:00:01.002Z', '2026-01-01T12:00:02.003Z']
      let expected: string[]
      if (kind === 'direct-messages') {
        // Reverse insertion order rules out insertion order accidentally
        // satisfying the chronological assertion.
        const second = await event(f, 'Second chronological human request')
        const first = await event(f, 'First chronological human request')
        expected = [first, second]
        for (const [index, id] of expected.entries()) await f.pool.query('UPDATE coordinator_events SET "createdAt"=$2 WHERE id=$1', [id, stamps[index]])
      } else {
        expected = [randomUUID(), randomUUID(), randomUUID()]
        for (const index of [2, 0, 1]) await f.pool.query('INSERT INTO coordinator_events (id,"userId","botId",kind,"dedupeKey",payload,tier,"createdAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
          [expected[index], f.owner, f.botId, 'run_report', 'startup-ordered:' + expected[index],
            { text: 'Chronological runtime item ' + index, summary: 'Chronological runtime item ' + index },
            index === 1 ? 'result' : 'background', stamps[index]])
      }
      // This invokes eventsForInbox on multiple real query rows. A raw
      // tx.execute timestamp string cast to Date must fail here on bb5-v1;
      // no test-created mapper or fake SQL result can mask that defect.
      const first = ready(await take(f))
      assert.equal(first.inbox.added, expected.length)
      const written = await messages(f)
      assert.deepEqual(written.map(row => row.position), expected.map((_, index) => index + 1))
      for (const [index, row] of written.entries()) {
        assert.match(JSON.stringify(row.message), new RegExp(expected[index]), 'the message keeps its original event provenance in chronological order')
        assert.ok(JSON.stringify(row.message).includes(stamps[index]), 'source timestamp retains the canonical ISO value')
      }
      if (kind === 'direct-messages') {
        assert.deepEqual(written.map(row => row.message.mikkaUserEvent), expected.map((id, index) => ({ id, sentAt: stamps[index] })))
        assert.equal(first.inbox.sourceEventId, expected.at(-1))
      } else {
        assert.deepEqual(first.inbox.pushEvents.map(row => row.tier), ['background', 'result', 'background'])
        assert.equal(first.inbox.sourceEventId, undefined)
      }
      const later = await event(f, 'A later input must not enter this receipt')
      const replay = ready(await take(f, changedSettings))
      assert.deepEqual(replay.inbox, first.inbox)
      assert.deepEqual(await messages(f), written)
      await pending(f, later)
    })
  })
})

dbTest('same-key waiters read a fresh receipt snapshot after the session lock', { timeout: 35_000 }, async t => {
  await fixture(t, async f => {
    const [{ withDatabaseClient }] = runtime!
    const e1 = await event(f, 'E1 before concurrent startup', true)
    const a = await clientFor(f), b = await clientFor(f), observer = await clientFor(f)
    const aPid = Number((await a.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
    const bPid = Number((await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
    const beforeBLease = gate(), beforeACommit = gate()
    const bStatements: string[] = []
    let aWork: Promise<CoordinatorStartupTake> | undefined, bWork: Promise<CoordinatorStartupTake> | undefined
    let bLeaseSeen = false
    const restoreA = observe(a, { before: text => /^\s*commit\b/i.test(text) ? beforeACommit.hold() : undefined })
    const restoreB = observe(b, { statements: bStatements, before: text => {
      if (!bLeaseSeen && /coordinator_sessions/i.test(text) && /for update/i.test(text)) {
        bLeaseSeen = true
        return beforeBLease.hold()
      }
    } })
    try {
      // B first completes ensure-session. Otherwise an INSERT conflict could
      // wait before the lease SELECT and fail to exercise the stale snapshot.
      bWork = observeFailure(withDatabaseClient(b, () => take(f, changedSettings)))
      await deadline(beforeBLease.entered, 'B reaching its actual lease statement')
      aWork = observeFailure(withDatabaseClient(a, () => take(f, firstSettings)))
      await deadline(beforeACommit.entered, 'A reaching COMMIT with E1 and receipt written')
      beforeBLease.open()
      await waitBlockedBy(observer, bPid, aPid)
      const e2 = await event(f, 'E2 arriving while B waits', true)
      beforeACommit.open()
      const [first, waiter] = (await Promise.all([aWork, bWork])).map(ready)
      assert.equal(first.replayed, false)
      assert.equal(waiter.replayed, true)
      assert.equal(waiter.inbox.sourceEventId, e1)
      assert.deepEqual(waiter.inbox, first.inbox)
      assert.deepEqual(waiter.settings, first.settings, 'the first committed settings win')
      await pending(f, e2)
      assert.equal((await messages(f)).length, 1)
      assert.equal((await receiptRows(f)).length, 1)
      const lock = bStatements.findIndex(text => /coordinator_sessions/i.test(text) && /for update/i.test(text))
      const lookup = bStatements.findIndex(text => /^\s*select\b/i.test(text) && /coordinator_startup_receipts/i.test(text))
      assert.ok(lock >= 0 && lookup > lock, 'receipt lookup is a separate post-lock statement')
    } finally {
      beforeBLease.open(); beforeACommit.open()
      await Promise.allSettled([aWork, bWork].filter((value): value is Promise<CoordinatorStartupTake> => Boolean(value)))
      restoreA(); restoreB()
      a.release(); b.release(); observer.release()
    }
  })
})

dbTest('Stop release and changed holders cannot resurrect an old startup receipt', { timeout: 40_000 }, async t => {
  for (const disposition of ['released', 'other-active', 'other-expired'] as const) await t.test(disposition, async child => {
    await fixture(child, async f => {
      const e1 = await event(f, 'E1 before Stop or ownership change')
      const first = ready(await take(f))
      assert.equal(first.inbox.sourceEventId, e1)
      await runtime![2].releaseLease(f.owner, f.holder, f.botId)
      if (disposition !== 'released') await f.pool.query('UPDATE coordinator_sessions SET "leaseHolder"=$3,"leaseUntil"=$4,"updatedAt"=$5 WHERE "userId"=$1 AND "botId"=$2',
        [f.owner, f.botId, 'wrun_replacement_' + randomUUID(), new Date(Date.now() + (disposition === 'other-active' ? 60_000 : -60_000)), new Date('2026-01-01T00:00:00Z')])
      const e2 = await event(f, 'E2 belongs to a future owner', true)
      const before = { lease: await lease(f), messages: await messages(f), receipts: await receiptRows(f) }
      const retried = await take(f, changedSettings)
      assert.equal(retried.kind, 'lost')
      assert.ok(retried.kind === 'lost')
      assert.equal(retried.replayed, true)
      assert.deepEqual(retried.settings, first.settings)
      assert.deepEqual(retried.inbox, first.inbox, 'lost preserves the original receipt rather than rewriting held')
      assert.equal(retried.inbox.held, true)
      assert.deepEqual(await lease(f), before.lease, 'an eligible temporary claim is rolled back')
      assert.deepEqual(await messages(f), before.messages)
      assert.deepEqual(await receiptRows(f), before.receipts)
      await pending(f, e2)
    })
  })
})

dbTest('the same holder may renew an expired lease without changing its receipt', { timeout: 30_000 }, async t => {
  await fixture(t, async f => {
    const e1 = await event(f, 'E1 before same-holder lease expiry')
    const first = ready(await take(f))
    await f.pool.query('UPDATE coordinator_sessions SET "leaseUntil"=$3 WHERE "userId"=$1 AND "botId"=$2', [f.owner, f.botId, new Date(Date.now() - 60_000)])
    const e2 = await event(f, 'E2 during lease expiry')
    const next = ready(await take(f, changedSettings))
    assert.equal(next.replayed, true)
    assert.equal(next.inbox.sourceEventId, e1)
    assert.deepEqual(next.inbox, first.inbox)
    assert.deepEqual(next.settings, first.settings)
    assert.equal((await lease(f)).leaseHolder, f.holder)
    assert.ok((await lease(f)).leaseUntil > new Date())
    await pending(f, e2)
  })
})

dbTest('a held competing lease returns not-held without a receipt or delivery', { timeout: 30_000 }, async t => {
  await fixture(t, async f => {
    const e1 = await event(f, 'Input for the currently active holder', true)
    await f.pool.query('UPDATE coordinator_sessions SET "leaseHolder"=$3,"leaseUntil"=$4 WHERE "userId"=$1 AND "botId"=$2',
      [f.owner, f.botId, 'wrun_other_' + randomUUID(), new Date(Date.now() + 60_000)])
    const before = await lease(f)
    const value = await take(f)
    assert.deepEqual(value, { kind: 'not-held', inbox: { ...emptyInbox, held: false } })
    assert.deepEqual(await lease(f), before)
    assert.equal((await receiptRows(f)).length, 0)
    assert.equal((await messages(f)).length, 0)
    await pending(f, e1)
  })
})

dbTest('an empty receipt stays empty and later input remains available to the ordinary next round', { timeout: 30_000 }, async t => {
  await fixture(t, async f => {
    const first = ready(await take(f))
    assert.deepEqual(first.inbox, emptyInbox)
    const e2 = await event(f, 'Input after an empty first take')
    const next = ready(await take(f, changedSettings))
    assert.equal(next.replayed, true)
    assert.deepEqual(next.inbox, emptyInbox)
    assert.deepEqual(next.settings, first.settings)
    await pending(f, e2)
    assert.equal(await runtime![2].releaseLease(f.owner, f.holder, f.botId), true)
    const roundOne = await runtime![2].takeInbox(f.owner, f.holder, f.botId)
    assert.equal(roundOne.held, true)
    assert.equal(roundOne.sourceEventId, e2)
    assert.equal(roundOne.added, 1)
    const stored = (await receiptRows(f))[0]
    assert.deepEqual(Object.keys(stored.inbox).sort(), ['a', 'f'], 'empty required arrays are absent in compact storage')
    assert.deepEqual((await decodeReceiptRow(stored)).inbox, emptyInbox, 'round one does not replace round zero')
  })
})

async function scheduledEvent(f: Fixture, valid: boolean) {
  const sourceEvent = await event(f, 'Human source for a stored scheduled read')
  await f.pool.query('UPDATE coordinator_events SET "deliveredAt"=now() WHERE id=$1', [sourceEvent])
  const scheduleId = randomUUID(), occurrenceId = randomUUID(), eventId = randomUUID(), token = randomUUID()
  const definition = { title: 'Synthetic startup read', timezone: 'UTC',
    timing: { kind: 'once', at: new Date(Date.now() + 60_000).toISOString() },
    task: { kind: 'agent_read', prompt: 'Read the synthetic issue status', allowedActions: ['get_issue'] },
    misfire: 'catch_up_once', maxLatenessMinutes: 5 }
  await f.pool.query('INSERT INTO user_schedules (id,owner_id,workspace_id,bot_id,source_event_id,request_id,definition,request_definition,status,next_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9)',
    [scheduleId, f.owner, f.workspaceId, f.botId, sourceEvent, randomUUID(), definition, 'active', new Date()])
  await f.pool.query('INSERT INTO coordinator_events (id,"userId","botId",kind,"dedupeKey",payload,tier) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [eventId, f.owner, f.botId, 'run_report', 'schedule_due:' + occurrenceId, { source: 'schedule_due', scheduleId, occurrenceId, text: definition.task.prompt }, 'attention'])
  await f.pool.query('INSERT INTO schedule_occurrences (id,schedule_id,version,due_at,definition,status,operation_id,next_retry_at,execution_decision,event_id,lease_token,lease_until,attempts) VALUES ($1,$2,1,$3,$4,$5,$6,$3,$7,$8,$9,$10,1)',
    [occurrenceId, scheduleId, new Date(), definition, 'running', randomUUID(), 'execute', eventId, token, new Date(Date.now() + (valid ? 300_000 : -60_000))])
  return { eventId, scope: { occurrenceId, leaseToken: token, allowedActions: definition.task.allowedActions, prompt: definition.task.prompt } }
}

dbTest('scheduled reads and expired schedule empty returns both persist replayable receipts', { timeout: 40_000 }, async t => {
  for (const valid of [true, false]) await t.test(valid ? 'valid scope' : 'expired scope', async child => {
    await fixture(child, async f => {
      const scheduled = await scheduledEvent(f, valid)
      const first = ready(await take(f))
      if (valid) {
        assert.equal(first.inbox.added, 1)
        assert.deepEqual(first.inbox.scheduledRead, scheduled.scope)
        assert.equal(first.inbox.sourceEventId, undefined)
        assert.equal(first.inbox.taskEventId, undefined)
      } else {
        assert.deepEqual(first.inbox, emptyInbox)
        const retired = (await events(f)).find(row => row.id === scheduled.eventId)!
        assert.ok(retired.deliveredAt)
        assert.equal(retired.tier, 'background')
        assert.equal((await messages(f)).length, 0)
      }
      const e2 = await event(f, 'Input after scheduled startup')
      const replay = ready(await take(f, changedSettings))
      assert.equal(replay.replayed, true)
      assert.deepEqual(replay.inbox, first.inbox)
      assert.deepEqual(replay.settings, first.settings)
      await pending(f, e2)
      assert.equal((await receiptRows(f)).length, 1)
    })
  })
})

dbTest('handoff privacy and human-question metadata survive a fresh receipt replay', { timeout: 40_000 }, async t => {
  for (const kind of ['matter_handoff', 'run_question'] as const) await t.test(kind, async child => {
    await fixture(child, async f => {
      const id = randomUUID(), matterId = randomUUID(), taskId = randomUUID(), questionId = randomUUID()
      let issueId: string | null = null, runId: string | null = null
      const payload: Record<string, unknown> = kind === 'matter_handoff'
        ? {
          matterId, level: 'critical', title: 'Synthetic verification-code handoff', url: null,
          assessment: { cost: false, due: 'unknown', reversible: true, verificationCode: true },
          evidence: {
            latest: { source: 'synthetic', title: 'Synthetic sign-in code', actor: null,
              occurredAt: new Date().toISOString(), url: null, excerpt: 'Synthetic sign-in code 123456' },
            earlier: [], keys: ['startup-handoff:' + id],
          },
          minutesAgo: 0, recheck: false, personAsked: false, previous: null,
          notified: { today: 0, minutesSinceLast: null },
        } satisfies HandoffPayload
        : { taskId, questionId, text: 'Synthetic human question', question: 'May this fixture continue?' }
      let decision: Record<string, unknown> | null = null
      if (kind === 'run_question') {
        issueId = randomUUID(); runId = randomUUID()
        const agentId = randomUUID()
        await f.pool.query('INSERT INTO issues (id,"userId",title,content,status,priority) VALUES ($1,$2,$3,$4,$5,$6)',
          [issueId, f.owner, 'Synthetic question issue', { type: 'doc' }, 'todo', 'normal'])
        await f.pool.query('INSERT INTO agents (id,"userId",harness,name) VALUES ($1,$2,$3,$4)', [agentId, f.owner, 'codex', 'Synthetic question agent'])
        await f.pool.query('INSERT INTO agent_runs (id,"userId","agentId","botId","issueId",status) VALUES ($1,$2,$3,$4,$5,$6)',
          [runId, f.owner, agentId, f.botId, issueId, 'running'])
        decision = { version: 1, method: 'model', chosenTier: 'attention', eventId: id, eventKind: kind,
          observedRun: { id: runId }, execution: { executionId: 'synthetic-startup-question', providerGenerationId: 'synthetic-generation', requestDigest: '0'.repeat(64) } }
      }
      await f.pool.query('INSERT INTO coordinator_events (id,"userId","botId",kind,"dedupeKey",payload,tier,"issueId","runId","triageDecision") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [id, f.owner, f.botId, kind, 'startup-metadata:' + id, payload, 'attention', issueId, runId, decision])
      const first = ready(await take(f))
      assert.equal(first.inbox.added, 1)
      assert.equal(first.inbox.sourceEventId, undefined)
      assert.deepEqual(first.inbox.pushEvents, [{ kind, tier: 'attention', issueId, runId }])
      if (kind === 'matter_handoff') {
        assert.deepEqual(first.inbox.handoffMatterIds, [matterId])
        assert.equal(first.inbox.handoffOnly, true)
        assert.equal(first.inbox.pushHidesText, true)
        assert.deepEqual(first.inbox.telegramTargets, [], 'verification codes stay out of Telegram')
      } else {
        assert.deepEqual(first.inbox.attentionQuestions, [{ eventId: id, taskId, issueId, questionId, runId }])
        assert.equal(first.inbox.handoffOnly, false)
        assert.equal(first.inbox.pushHidesText, false)
      }
      const e2 = await event(f, 'Later input after metadata-rich startup')
      const replay = ready(await take(f, changedSettings))
      assert.equal(replay.replayed, true)
      assert.deepEqual(replay.inbox, first.inbox)
      assert.deepEqual(replay.settings, first.settings)
      await pending(f, e2)
    })
  })
})

dbTest('invalid candidate settings fail before acquiring the lease or consuming input', { timeout: 30_000 }, async t => {
  await fixture(t, async f => {
    const [{ withDatabaseClient }] = runtime!
    const e1 = await event(f, 'Input before malformed settings')
    const originalLease = await lease(f), client = await clientFor(f), statements: string[] = []
    const restore = observe(client, { statements })
    try {
      const invalid = { ...firstSettings, runtime: { harness: 'native' } } as unknown as CoordinatorStartupSettingsCandidate
      await assert.rejects(withDatabaseClient(client, () => take(f, invalid)), error => {
        assert.ok(error instanceof Error)
        assert.equal((error as Error & { code: string }).code, 'agentEventConflict')
        assert.ok(error.cause)
        return true
      })
      assert.deepEqual(statements, [], 'invalid settings do not begin a database transaction')
    } finally { restore(); client.release() }
    assert.deepEqual(await lease(f), originalLease)
    await pending(f, e1)
    assert.equal((await receiptRows(f)).length, 0)
    assert.equal((await messages(f)).length, 0)
  })
})

dbTest('failure after the real receipt INSERT rolls back delivery, lease, Telegram markers and notifications', { timeout: 30_000 }, async t => {
  await fixture(t, async f => {
    const [{ withDatabaseClient }, , , , , { COORDINATOR_LEASE_CHANNEL }, { afterCommit }] = runtime!
    const e1 = await event(f, 'E1 for transaction rollback', true)
    const originalLease = await lease(f), originalEvents = await events(f)
    const worker = await clientFor(f), listener = await clientFor(f)
    const notifications: string[] = []
    const notification = (value: { channel: string; payload?: string }) => {
      if (value.channel === COORDINATOR_LEASE_CHANNEL && value.payload === f.botId) notifications.push(value.payload)
    }
    listener.on('notification', notification)
    // The channel comes from the existing closed constant, never user input.
    assert.match(COORDINATOR_LEASE_CHANNEL, /^[a-z_]+$/)
    await listener.query('LISTEN ' + COORDINATOR_LEASE_CHANNEL)
    let injected = false, committedEffects = 0
    const failure = new Error('synthetic failure after actual receipt INSERT')
    const restore = observe(worker, { after: (text, result) => {
      if (/^\s*insert\s+into\s+coordinator_startup_receipts/i.test(text)) {
        assert.equal(result.rowCount, 1)
        injected = true
        afterCommit(worker, 'startup-test-effect', () => { committedEffects++ })
        throw failure
      }
    } })
    try {
      await assert.rejects(withDatabaseClient(worker, () => take(f)), error => {
        assert.ok(error instanceof Error)
        // Drizzle wraps a real query failure. Preserve the exact injected
        // cause; requiring that wrapper itself to be the cause was incorrect.
        assert.equal(error.cause, failure)
        return true
      })
      assert.equal(injected, true)
      assert.deepEqual(await lease(f), originalLease)
      assert.deepEqual(await events(f), originalEvents)
      assert.equal((await messages(f)).length, 0)
      assert.equal((await receiptRows(f)).length, 0)
      assert.equal(committedEffects, 0)
      // A barrier notification on the SAME listener proves all earlier
      // committed notifications were delivered without an arbitrary sleep.
      await notificationBarrier(listener, COORDINATOR_LEASE_CHANNEL)
      assert.deepEqual(notifications, [], 'rolled-back lease claims emit no Stop wake notification')
      restore()
      const restoreEffect = observe(worker, { after: text => {
        if (/^\s*insert\s+into\s+coordinator_startup_receipts/i.test(text)) afterCommit(worker, 'startup-test-effect', () => { committedEffects++ })
      } })
      let retried: Ready
      try { retried = ready(await withDatabaseClient(worker, () => take(f))) } finally { restoreEffect() }
      assert.equal(retried.replayed, false)
      assert.equal(retried.inbox.sourceEventId, e1)
      assert.equal((await messages(f)).length, 1)
      assert.equal((await receiptRows(f)).length, 1)
      assert.equal(committedEffects, 1, 'the same observed commit-effect mechanism runs after a successful COMMIT')
      await notificationBarrier(listener, COORDINATOR_LEASE_CHANNEL)
      assert.deepEqual(notifications, [f.botId], 'a committed new lease wakes Stop exactly once')
      assert.equal(ready(await withDatabaseClient(worker, () => take(f))).replayed, true)
      await notificationBarrier(listener, COORDINATOR_LEASE_CHANNEL)
      assert.deepEqual(notifications, [f.botId], 'receipt replay does not publish a second lease-acquisition notification')
    } finally {
      restore()
      await listener.query('UNLISTEN ' + COORDINATOR_LEASE_CHANNEL)
      listener.off('notification', notification)
      worker.release(); listener.release()
    }
  })
})

dbTest('a real receipt key conflict fails closed and rolls back the newer inbox', { timeout: 30_000 }, async t => {
  await fixture(t, async f => {
    const [{ withDatabaseClient }] = runtime!
    const { encodeStoredStartupReceipt } = await import('./startup-receipt')
    const conflict = encodeStoredStartupReceipt({ settings: { ...firstSettings, coordinator: true }, inbox: emptyInbox })
    const e1 = await event(f, 'E1 for receipt conflict')
    const originalLease = await lease(f)
    const worker = await clientFor(f), originalQuery = worker.query.bind(worker)
    let inserted = false
    const restore = observe(worker, { after: async text => {
      if (!inserted && /^\s*select\b/i.test(text) && /coordinator_startup_receipts/i.test(text)) {
        inserted = true
        // Fault injection on this SAME real transaction, after its receipt
        // lookup. The product's INSERT must encounter a genuine PG unique
        // conflict; no synthetic empty RETURNING result is supplied.
        await originalQuery('INSERT INTO coordinator_startup_receipts ("userId","botId",holder,round,version,settings,inbox) VALUES ($1,$2,$3,0,1,$4,$5)',
          [f.owner, f.botId, f.holder, conflict.settings, conflict.inbox])
      }
    } })
    try {
      await assert.rejects(withDatabaseClient(worker, () => take(f)), error => {
        assert.ok(error instanceof Error)
        assert.equal((error as Error & { code: string }).code, 'agentEventConflict')
        assert.ok(error.cause instanceof Error)
        return true
      })
      assert.equal(inserted, true)
      assert.deepEqual(await lease(f), originalLease)
      await pending(f, e1)
      assert.equal((await messages(f)).length, 0)
      assert.equal((await receiptRows(f)).length, 0, 'both the injected conflict row and new delivery rolled back')
    } finally { restore(); worker.release() }
  })
})

dbTest('malformed stored receipts never fall back to consuming a later input', { timeout: 40_000 }, async t => {
  type DamagedReceipt = { version: number; settings: Record<string, unknown> | null; inbox: Record<string, unknown> | null }
  const corruptions: { label: string; corrupt: (row: DamagedReceipt) => void; constraint?: string }[] = [
    { label: 'false held', corrupt: row => { row.inbox!.held = false } },
    { label: 'missing settings flag', corrupt: row => { delete row.settings!.f } },
    { label: 'unknown receipt field', corrupt: row => { row.inbox!.newAuthority = true } },
    { label: 'unknown settings bit', corrupt: row => { row.settings!.f = Number(row.settings!.f) | 256 } },
    { label: 'unknown inbox bit', corrupt: row => { row.inbox!.f = Number(row.inbox!.f) | 512 } },
    { label: 'missing added', corrupt: row => { delete row.inbox!.a } },
    { label: 'null added', corrupt: row => { row.inbox!.a = null } },
    { label: 'null declared optional questions', corrupt: row => { row.inbox!.f = Number(row.inbox!.f) | 128; row.inbox!.q = null } },
    { label: 'declared source field missing', corrupt: row => { assert.equal(typeof row.inbox!.s, 'string'); delete row.inbox!.s } },
    { label: 'optional questions without presence bit', corrupt: row => { assert.equal(Object.hasOwn(row.inbox!, 'q'), false); row.inbox!.q = [] } },
    { label: 'empty declared push list', corrupt: row => { assert.ok(Array.isArray(row.inbox!.p) && row.inbox!.p.length > 0); row.inbox!.p = [] } },
    // These shapes cannot exist in the real table: retain its CHECKs and
    // prove PostgreSQL itself rejects them, without disabling constraints.
    { label: 'unknown stored version', corrupt: row => { row.version = 2 }, constraint: 'coordinator_startup_receipts_version_check' },
    { label: 'JSON null settings', corrupt: row => { row.settings = null }, constraint: 'coordinator_startup_receipts_settings_check' },
    { label: 'JSON null inbox', corrupt: row => { row.inbox = null }, constraint: 'coordinator_startup_receipts_inbox_check' },
  ]
  for (const malformed of corruptions) await t.test(malformed.label, async child => {
    await fixture(child, async f => {
      await event(f, 'Original receipt before corrupt data')
      const first = ready(await take(f)), [stored] = await receiptRows(f)
      // Start from an actually committed, valid compact row and damage only
      // the relevant compact fields; old canonical JSON is never the seed.
      assert.deepEqual(await decodeReceiptRow(stored), { holder: f.holder, round: 0, version: 1, settings: first.settings, inbox: first.inbox })
      const damaged = structuredClone(stored) as DamagedReceipt
      malformed.corrupt(damaged)
      const e2 = await event(f, 'Later input after corrupt receipt', true)
      const before = { lease: await lease(f), messages: await messages(f), receipts: await receiptRows(f) }
      const write = () => f.pool.query('UPDATE coordinator_startup_receipts SET version=$4,settings=$5::jsonb,inbox=$6::jsonb WHERE "userId"=$1 AND "botId"=$2 AND holder=$3',
        [f.owner, f.botId, f.holder, damaged.version, JSON.stringify(damaged.settings), JSON.stringify(damaged.inbox)])
      let expectedReceipts = before.receipts
      if (malformed.constraint) {
        await assert.rejects(write(), error => {
          assert.ok(error instanceof Error)
          assert.equal((error as Error & { code: string }).code, '23514')
          assert.equal((error as Error & { constraint: string }).constraint, malformed.constraint)
          return true
        })
      } else {
        await write()
        expectedReceipts = await receiptRows(f)
        await assert.rejects(take(f), error => {
          assert.ok(error instanceof Error)
          assert.equal((error as Error & { code: string }).code, 'agentEventConflict')
          assert.ok(error.cause, 'the original decoder failure remains available')
          return true
        })
      }
      assert.deepEqual(await lease(f), before.lease)
      assert.deepEqual(await messages(f), before.messages)
      assert.deepEqual(await receiptRows(f), expectedReceipts)
      await pending(f, e2)
      if (malformed.constraint) {
        const replay = ready(await take(f))
        assert.equal(replay.replayed, true)
        assert.deepEqual(replay.inbox, first.inbox)
        assert.deepEqual(replay.settings, first.settings)
        assert.deepEqual(await receiptRows(f), before.receipts)
        await pending(f, e2)
      }
    })
  })
})

dbTest('compact receipt replay preserves an explicitly stored empty optional question list', { timeout: 30_000 }, async t => {
  await fixture(t, async f => {
    const first = ready(await take(f))
    assert.equal(Object.hasOwn(first.inbox, 'attentionQuestions'), false)
    const inbox = { ...first.inbox, attentionQuestions: [] }
    const { encodeStoredStartupReceipt } = await import('./startup-receipt')
    const encoded = encodeStoredStartupReceipt({ settings: first.settings, inbox })
    await f.pool.query('UPDATE coordinator_startup_receipts SET settings=$4::jsonb,inbox=$5::jsonb WHERE "userId"=$1 AND "botId"=$2 AND holder=$3',
      [f.owner, f.botId, f.holder, JSON.stringify(encoded.settings), JSON.stringify(encoded.inbox)])
    const before = await receiptRows(f)
    assert.deepEqual(Object.keys(before[0].inbox).sort(), ['a', 'f', 'q'])
    assert.ok(Object.hasOwn(before[0].inbox, 'q'))
    assert.deepEqual(before[0].inbox.q, [])
    const e2 = await event(f, 'Input after explicit empty question metadata')
    const replay = ready(await take(f, changedSettings))
    assert.equal(replay.replayed, true)
    assert.deepEqual(replay.settings, first.settings)
    assert.deepEqual(replay.inbox, inbox)
    assert.ok(Object.hasOwn(replay.inbox, 'attentionQuestions'))
    assert.deepEqual(await receiptRows(f), before, 'replay cannot rewrite explicit empty metadata to absence')
    await pending(f, e2)
  })
})

dbTest('receipt keys keep owner, bot and holder isolated and follow session deletion', { timeout: 30_000 }, async t => {
  await fixture(t, async f => {
    const e1 = await event(f, 'Original owner input')
    const first = ready(await take(f))
    const peerOwner = 'startup-peer-' + randomUUID(), peerBot = randomUUID()
    await f.pool.query('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,$1,$2,true,now(),now())', [peerOwner, peerOwner + '@example.invalid'])
    await f.pool.query('INSERT INTO bots (id,"ownerId","workspaceId",name) VALUES ($1,$2,$3,$4)', [peerBot, f.owner, f.workspaceId, 'Other fixture bot'])
    // The store is a scoped persistence API, not the HTTP ownership gate.
    // Exercise both key dimensions independently, including the same bot
    // under a different owner, so omitting userId cannot pass by accident.
    for (const other of [{ ...f, botId: peerBot }, { ...f, owner: peerOwner }]) {
      const id = await event(other, 'Separate scope input')
      const result = ready(await take(other, changedSettings))
      assert.equal(result.replayed, false)
      assert.equal(result.settings.coordinator, false)
      assert.equal(result.inbox.sourceEventId, id)
      assert.notEqual(result.inbox.sourceEventId, e1)
    }
    assert.deepEqual(ready(await take(f)).inbox, first.inbox)
    assert.equal((await receiptRows(f)).length, 1)
    const anotherRun = { ...f, holder: 'wrun_new_' + randomUUID() }
    await runtime![2].releaseLease(f.owner, f.holder, f.botId)
    const e2 = await event(f, 'A later run has a distinct receipt')
    assert.equal(ready(await take(anotherRun)).inbox.sourceEventId, e2)
    assert.equal((await receiptRows(f)).length, 2, 'new holder does not overwrite historical round zero')
    await f.pool.query('DELETE FROM coordinator_sessions WHERE "userId"=$1 AND "botId"=$2', [f.owner, f.botId])
    assert.equal((await receiptRows(f)).length, 0, 'session FK removes only its own receipt family')
    assert.equal((await receiptRows({ ...f, owner: peerOwner })).length, 1)
    assert.equal((await receiptRows({ ...f, botId: peerBot })).length, 1)
  })
})

dbTest('startup normal paths use no more statements than old settings plus inbox', { timeout: 60_000 }, async t => {
  const personal = await import('./personal-instructions')
  const { modelMessage } = await import('./message-safety')
  const system = 'You are a helpful coordinator.', personalText = 'Keep answers concise.', memory = 'The person prefers practical examples.'
  // Both normal definitions already carry this same authorized empty snapshot.
  // Supplying it uses the real formatter without another plugin discovery phase.
  const plugins = { servers: [], skills: [] }
  for (const scenario of ['user', 'empty', 'not-held', 'telegram', 'expired-schedule'] as const) await t.test(scenario, async child => {
    const measurements: Partial<Record<'old' | 'startup', QueryMetrics>> = {}
    const promptMeasurements: Partial<Record<'old' | 'startup', QueryMetrics>> = {}
    const completeMeasurements: Partial<Record<'old' | 'startup', QueryMetrics>> = {}
    const promptInputs: Partial<Record<'old' | 'startup', unknown>> = {}
    const expectsPrompt = scenario === 'user' || scenario === 'telegram'
    for (const mode of ['old', 'startup'] as const) await fixture(child, async f => {
      let sourceEventId: string | undefined
      if (expectsPrompt) {
        sourceEventId = await event(f, 'Query budget input', scenario === 'telegram')
        // Identical short real rows, created before any measurement window.
        await runtime![0].db.insert(runtime![1].userPreferences).values({ userId: f.owner, memoryEnabled: true, personalInstructions: personalText })
        await runtime![0].db.insert(runtime![1].attentionSettings).values({ userId: f.owner, enabled: true })
        assert.equal(await runtime![2].editMemory(f.owner, () => ({ memory, result: true }), f.botId), true)
      }
      if (scenario === 'expired-schedule') await scheduledEvent(f, false)
      if (scenario === 'not-held') await f.pool.query('UPDATE coordinator_sessions SET "leaseHolder"=$3,"leaseUntil"=$4 WHERE "userId"=$1 AND "botId"=$2',
        [f.owner, f.botId, 'wrun_other_' + randomUUID(), new Date(Date.now() + 60_000)])
      const client = await clientFor(f), statements: string[] = []
      const metrics = queryMetrics(), before = querySnapshot(client, metrics)
      let middle = before, startupStatementCount = 0, promptExecuted = false
      const restore = observe(client, { statements, metrics })
      try {
        await runtime![0].withDatabaseClient(client, async () => {
          let inbox: InboxTake
          if (mode === 'old') {
            await runtime![4].isCoordinatorBot(client, f.owner, f.botId)
            inbox = await runtime![2].takeInbox(f.owner, f.holder, f.botId)
          } else inbox = (await take(f)).inbox
          // Adjacent A->B and B->C windows on this one held client. The whole
          // segment below is measured directly A->C, never across fixtures.
          middle = querySnapshot(client, metrics)
          startupStatementCount = statements.length
          if (inbox.held && inbox.added > 0 && !inbox.scheduledRead) {
            promptExecuted = true
            const conversation = mode === 'old'
              ? await runtime![2].loadConversation(f.owner, f.botId)
              : await runtime![2].loadConversationForPrompt(f.owner, f.botId)
            let instructions: string
            if (mode === 'old') instructions = await personal.withPersonalInstructions(f.owner, system, plugins)
            else {
              assert.ok('personalInstructions' in conversation && typeof conversation.personalInstructions === 'string')
              instructions = await personal.withPersonalInstructionText(f.owner, system, conversation.personalInstructions, plugins)
            }
            assert.equal(inbox.added, 1)
            assert.equal(inbox.sourceEventId, sourceEventId)
            assert.equal(conversation.memory, memory)
            assert.equal(conversation.messages.length, 1)
            assert.ok(instructions.includes(personalText))
            // Real model projection removes only each fixture's source receipt
            // metadata; SQL/result byte measurements above remain untouched.
            promptInputs[mode] = { summary: conversation.summary, memory: conversation.memory,
              messages: conversation.messages.map(row => ({ position: row.position, message: modelMessage(row.message) })), system: instructions }
          }
        })
      } finally {
        const after = querySnapshot(client, metrics)
        measurements[mode] = queryRange(before, middle)
        promptMeasurements[mode] = queryRange(middle, after)
        completeMeasurements[mode] = queryRange(before, after)
        restore(); client.release()
      }
      assert.equal(promptExecuted, expectsPrompt, 'only an actually delivered non-schedule batch enters prompt preparation')
      assert.equal(measurements[mode]!.statements, startupStatementCount)
      assert.equal(completeMeasurements[mode]!.statements, statements.length)
      const startupStatements = statements.slice(0, startupStatementCount)
      assert.ok(startupStatements.some(text => /^\s*begin\b/i.test(text)), 'count includes the actual transaction BEGIN')
      assert.ok(startupStatements.some(text => /^\s*commit\b/i.test(text)), 'count includes the actual transaction COMMIT')
    })
    assert.deepEqual(promptInputs.startup, promptInputs.old, 'real prompt inputs and complete system bytes are unchanged')
    const old = measurements.old!, startup = measurements.startup!
    const completeOld = completeMeasurements.old!, completeStartup = completeMeasurements.startup!
    child.diagnostic(JSON.stringify({ event: 'startup_receipt_statement_budget', scenario,
      method: 'SQL/bindings/rows are byte approximations; PG counters measure plaintext receive/send on one pinned client. Startup and prompt windows are adjacent; complete is directly measured over both. Excludes connection startup, TLS/TCP, billed traffic, deferred live connections and model traffic.',
      old, startup, statementDelta: startup.statements - old.statements,
      approximateByteDelta: startup.sqlTextUtf8Bytes + startup.bindingsJsonUtf8Bytes + startup.rowsJsonUtf8Bytes
        - old.sqlTextUtf8Bytes - old.bindingsJsonUtf8Bytes - old.rowsJsonUtf8Bytes,
      promptExecuted: expectsPrompt, prompt: { old: promptMeasurements.old, startup: promptMeasurements.startup },
      complete: { old: completeOld, startup: completeStartup, statementDelta: completeStartup.statements - completeOld.statements,
        pgProtocolTotalByteDelta: completeStartup.pgProtocolTotalBytes !== null && completeOld.pgProtocolTotalBytes !== null
          ? completeStartup.pgProtocolTotalBytes - completeOld.pgProtocolTotalBytes : null } }))
    assert.ok(startup.statements <= old.statements, scenario + ' must not add normal-path SQL round trips')
  })
})
