import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { activeAgentsResponse, mergeAgentRuns, sortActiveAgents, type ActiveAgent } from './active-agents'
import { coordinatorLeaseActive } from './coordinator/lease'
import { WORKING_RUN_STATUSES, UNFINISHED_RUN_STATUSES } from './agent-run-statuses'
import { LEASED_RUN_STATUSES } from './run-retry'

const copy = { pleaseSignIn: 'sign in', unavailable: 'unavailable', noParameters: 'no params' }
const url = 'http://local/api/agent/sessions/active'
const never = async (): Promise<ActiveAgent[]> => { throw new Error('should not be called') }

test('active readers share main claimed-only lease states; queued is only in flight', () => {
  assert.deepEqual(WORKING_RUN_STATUSES, LEASED_RUN_STATUSES)
  assert.deepEqual(UNFINISHED_RUN_STATUSES, ['queued', ...LEASED_RUN_STATUSES])
  assert.ok(!WORKING_RUN_STATUSES.some(status => String(status) === 'queued'))
})

test('401 without a session, private no-store', async () => {
  const response = await activeAgentsResponse(new Request(url), null, never, copy)
  assert.equal(response.status, 401)
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store')
})

test('empty list is 200 {agents: []}', async () => {
  const response = await activeAgentsResponse(new Request(url), 'u1', async () => [], copy)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { agents: [] })
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store')
})

test('any parameter (conversationId) is 400', async () => {
  const response = await activeAgentsResponse(new Request(`${url}?conversationId=${randomUUID()}`), 'u1', never, copy)
  assert.equal(response.status, 400)
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store')
})

test('a database error is 503, private no-store', async () => {
  const response = await activeAgentsResponse(new Request(url), 'u1', async () => { throw new Error('db down') }, copy)
  assert.equal(response.status, 503)
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store')
})

test('a non-empty list carries polledAt and only the public fields', async () => {
  const agent: ActiveAgent = { id: randomUUID(), kind: 'agent', name: 'A', avatarUrl: null, startedAt: new Date().toISOString(), state: 'working', runId: randomUUID(), issueId: null }
  const body = await (await activeAgentsResponse(new Request(url), 'u1', async () => [agent], copy)).json()
  assert.ok(Date.parse(body.polledAt))
  assert.deepEqual(Object.keys(body.agents[0]).sort(), ['avatarUrl', 'id', 'issueId', 'kind', 'name', 'runId', 'startedAt', 'state'])
})

test('merge: earliest start, working wins over waiting_input', () => {
  const t = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s))
  const merged = mergeAgentRuns([
    { agentId: 'a', name: 'A', runId: 'r2', issueId: 'i2', status: 'waiting_input', startedAt: t(5) },
    { agentId: 'a', name: 'A', runId: 'r1', issueId: 'i1', status: 'running', startedAt: t(1) },
    { agentId: 'b', name: 'B', runId: 'r3', issueId: null, status: 'waiting_input', startedAt: t(2) },
  ])
  assert.deepEqual(merged.map(a => [a.id, a.runId, a.state, a.startedAt]), [['a', 'r1', 'working', t(1).toISOString()], ['b', 'r3', 'waiting_input', t(2).toISOString()]])
  assert.deepEqual(sortActiveAgents([...merged].reverse()).map(a => a.id), ['a', 'b'])
})

test('coordinator lease needs a holder and an unexpired lease', () => {
  const now = new Date()
  const later = new Date(now.getTime() + 60_000)
  assert.equal(coordinatorLeaseActive({ leaseHolder: 'h', leaseUntil: later }, now), true)
  assert.equal(coordinatorLeaseActive({ leaseHolder: null, leaseUntil: later }, now), false)
  assert.equal(coordinatorLeaseActive({ leaseHolder: 'h', leaseUntil: new Date(now.getTime() - 1) }, now), false)
  assert.equal(coordinatorLeaseActive(null, now), false)
})

// Database regressions execute only in CI against ephemeral Postgres 17.
// Local pure tests skip them; REQUIRE_DB=1 makes a missing database fail.
let databaseUrl: string | undefined
try {
  const target = new URL(process.env.E2E_DATABASE_URL ?? '')
  if (process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true'
    && ['postgres:', 'postgresql:'].includes(target.protocol)
    && target.hostname === '127.0.0.1' && target.port === '5432' && target.pathname === '/mikka_e2e'
    && !target.search && !target.hash && process.env.MIKKA_DATABASE_URL === target.href
    && process.env.DATABASE_URL === target.href) databaseUrl = target.href
} catch { /* no eligible disposable CI database */ }
if (!databaseUrl && process.env.REQUIRE_DB === '1') throw new Error('REQUIRE_DB=1 requires the matching Actions loopback mikka_e2e database')
const dbTest = databaseUrl ? test : test.skip

async function database() {
  const [{ Pool }, { drizzle }, schema, { createRequestDatabaseScope }, { renewRunLeases }] = await Promise.all([
    import('pg'), import('drizzle-orm/node-postgres'), import('./db/schema'), import('./db'), import('./run-leases'),
  ])
  const pool = new Pool({ connectionString: databaseUrl, max: 2 })
  const scope = createRequestDatabaseScope(databaseUrl!)
  const db = drizzle(pool, { schema })
  // Exercise the current server lease function, with its real request DB scope.
  // The heartbeat route records device presence before renewing claimed runs.
  const heartbeat = async (deviceId: string, runIds: readonly string[], now: Date) => {
    const { eq } = await import('drizzle-orm')
    await db.update(schema.devices).set({ harnesses: [], lastSeenAt: now, updatedAt: now }).where(eq(schema.devices.id, deviceId))
    return scope.run(() => renewRunLeases(deviceId, runIds, now))
  }
  return { pool, db, schema, heartbeat, close: async () => { await scope.close(); await pool.end() } }
}

dbTest('active agents on the database', async t => {
  const { db, schema, heartbeat, close } = await database()
  const { listActiveAgents } = await import('./active-agents')
  const { agents, agentRuns, devices, coordinatorSessions } = schema
  const { eq, inArray } = await import('drizzle-orm')
  const me = `test-mik7-${randomUUID()}`
  const other = `test-mik7-${randomUUID()}`
  const now = new Date()
  const ago = (ms: number) => new Date(now.getTime() - ms)
  const ahead = new Date(now.getTime() + 5 * 60_000)
  const onlineDevice = randomUUID(); const offlineDevice = randomUUID()
  await db.insert(devices).values([
    { id: onlineDevice, ownerId: me, name: 'on', lastSeenAt: ago(5_000) },
    { id: offlineDevice, ownerId: me, name: 'off', lastSeenAt: ago(10 * 60_000) },
  ])
  const agent = (name: string, userId = me) => ({ id: randomUUID(), userId, harness: 'codex' as const, name })
  const [a, b, c, d, e, f, mine] = [agent('A'), agent('B'), agent('C'), agent('D'), agent('E'), agent('F'), agent('Other', other)]
  await db.insert(agents).values([a, b, c, d, e, f, mine])
  const run = (agentId: string, status: string, extra: Partial<typeof agentRuns.$inferInsert> = {}, userId = me) =>
    ({ id: randomUUID(), userId, agentId, status: status as never, leaseExpiresAt: ahead, startedAt: ago(60_000), ...extra })
  const runs = [
    run(a.id, 'running', { startedAt: ago(30_000) }),
    run(a.id, 'waiting_input', { startedAt: ago(90_000) }),          // merge: earlier start, but A still working
    run(b.id, 'waiting_input', { startedAt: null, createdAt: ago(120_000) }), // startedAt falls back to createdAt
    run(c.id, 'preparing', { leaseExpiresAt: null, deviceId: onlineDevice, startedAt: ago(30_000) }),
    run(d.id, 'finishing', { leaseExpiresAt: ago(1_000) }),          // stale lease
    run(d.id, 'running', { leaseExpiresAt: null, deviceId: offlineDevice }), // device offline
    run(e.id, 'queued'),                                              // not started
    run(e.id, 'succeeded'), run(e.id, 'failed'), run(e.id, 'stopped'), run(e.id, 'cancelled'),
    run(f.id, 'running', { leaseExpiresAt: null }),                   // no lease, no device
    run(mine.id, 'running', {}, other),
  ]
  await db.insert(agentRuns).values(runs)
  // UUID owners isolate this fixture. Preserve all rows on success and failure.
  t.after(close)

  const list = await listActiveAgents(db, me, now)
  assert.deepEqual(list.map(x => x.name), ['B', 'A', 'C'], 'status inclusion, stale/offline excluded, ordered by start')
  const byName = Object.fromEntries(list.map(x => [x.name, x]))
  assert.equal(byName.A.state, 'working')
  assert.equal(byName.A.startedAt, ago(90_000).toISOString())
  assert.equal(byName.A.runId, runs[1].id)
  assert.equal(byName.B.state, 'waiting_input')
  assert.equal(byName.B.startedAt, ago(120_000).toISOString())
  assert.ok(list.every(x => x.kind === 'agent' && x.avatarUrl === null))
  assert.deepEqual((await listActiveAgents(db, other, now)).map(x => x.name), ['Other'], 'other users only see their own')
  assert.deepEqual(await listActiveAgents(db, me, now), list, 'stable order across polls')

  await t.test('ties order by id', async () => {
    const tie = ago(200_000)
    const [x, y] = [agent('X'), agent('Y')]
    await db.insert(agents).values([x, y])
    await db.insert(agentRuns).values([run(x.id, 'running', { startedAt: tie }), run(y.id, 'running', { startedAt: tie })])
    const ids = (await listActiveAgents(db, me, now)).slice(0, 2).map(z => z.id)
    assert.deepEqual(ids, [x.id, y.id].sort())
  })

  await t.test('heartbeats keep a claimed run active past the first 90s lease', async () => {
    const { isDeviceOnline, RUN_LEASE_MS } = await import('@mikka/protocol/device')
    const claimedAt = new Date(now.getTime() + 60 * 60_000) // future clock so other rows' leases do not matter
    const device = randomUUID()
    await db.insert(devices).values({ id: device, ownerId: me, name: 'beating', lastSeenAt: claimedAt })
    const worker = agent('Leased')
    await db.insert(agents).values(worker)
    const claimed = run(worker.id, 'preparing', { deviceId: device, startedAt: claimedAt, leaseExpiresAt: new Date(claimedAt.getTime() + RUN_LEASE_MS) })
    const finished = run(worker.id, 'succeeded', { deviceId: device, leaseExpiresAt: claimedAt })
    await db.insert(agentRuns).values([claimed, finished])
    let leases: Record<string, string> = {}
    for (let second = 15; second <= 120; second += 15) {
      const beatAt = new Date(claimedAt.getTime() + second * 1000)
      const result = await heartbeat(device, [claimed.id, finished.id], beatAt)
      leases = result.leases
      assert.deepEqual(result.revoked, [finished.id], 'terminal runs are revoked under main contract')
      assert.equal(leases[claimed.id], new Date(beatAt.getTime() + RUN_LEASE_MS).toISOString(), `renewed at +${second}s`)
      assert.ok((await listActiveAgents(db, me, beatAt)).some(x => x.runId === claimed.id), `still active at +${second}s`)
    }
    const at120 = new Date(claimedAt.getTime() + 120_000)
    assert.deepEqual(leases, { [claimed.id]: new Date(at120.getTime() + RUN_LEASE_MS).toISOString() }, 'real leases, only in-progress runs')
    const [row] = await db.select({ lastSeenAt: devices.lastSeenAt }).from(devices).where(eq(devices.id, device))
    assert.ok(isDeviceOnline(row.lastSeenAt, at120.getTime()), 'device still online at +120s')
    assert.ok((await listActiveAgents(db, me, at120)).some(x => x.runId === claimed.id), 'run still active at +120s')
    assert.ok(!(await listActiveAgents(db, me, new Date(at120.getTime() + RUN_LEASE_MS + 61_000))).some(x => x.runId === claimed.id), 'expires once heartbeats stop')
    await db.update(agentRuns).set({ status: 'cancelled' }).where(eq(agentRuns.agentId, worker.id))
  })

  await t.test('heartbeat renews only claimed runs; queued, foreign and invalid IDs are revoked', async () => {
    const { RUN_LEASE_MS } = await import('@mikka/protocol/device')
    const beatAt = new Date(now.getTime() + 2 * 60 * 60_000)
    const [device, otherDevice] = [randomUUID(), randomUUID()]
    await db.insert(devices).values([
      { id: device, ownerId: me, name: 'reporting', lastSeenAt: beatAt },
      { id: otherDevice, ownerId: me, name: 'elsewhere', lastSeenAt: beatAt },
    ])
    const worker = agent('Reported')
    await db.insert(agents).values(worker)
    const old = new Date(beatAt.getTime() - 1_000)
    const queued = run(worker.id, 'queued', { deviceId: device, leaseExpiresAt: old })
    const claimed = run(worker.id, 'preparing', { deviceId: device, leaseExpiresAt: old })
    const elsewhere = run(worker.id, 'running', { deviceId: otherDevice, leaseExpiresAt: old })
    const unreported = run(worker.id, 'running', { deviceId: device, leaseExpiresAt: old })
    await db.insert(agentRuns).values([queued, claimed, elsewhere, unreported])
    try {
      const result = await heartbeat(device, [claimed.id, queued.id, elsewhere.id, 'not-a-uuid'], beatAt)
      const renewedTo = new Date(beatAt.getTime() + RUN_LEASE_MS)
      assert.deepEqual(result, { leases: { [claimed.id]: renewedTo.toISOString() }, revoked: [queued.id, elsewhere.id, 'not-a-uuid'] })
      assert.deepEqual(await heartbeat(device, ['invalid-only'], beatAt), { leases: {}, revoked: ['invalid-only'] }, 'all-invalid reports avoid a UUID SQL error')
      const rows = await db.select({ id: agentRuns.id, leaseExpiresAt: agentRuns.leaseExpiresAt }).from(agentRuns).where(eq(agentRuns.agentId, worker.id))
      const lease = (id: string) => rows.find(row => row.id === id)!.leaseExpiresAt!.getTime()
      assert.equal(lease(claimed.id), renewedTo.getTime())
      assert.equal(lease(queued.id), old.getTime(), 'queued runs are not held and must not be revived')
      assert.equal(lease(elsewhere.id), old.getTime(), 'a run on another device is not renewed even if reported')
      assert.equal(lease(unreported.id), old.getTime(), 'a run the daemon did not report is left to expire')
    } finally {
      await db.update(agentRuns).set({ status: 'cancelled' }).where(eq(agentRuns.agentId, worker.id))
    }
  })

  await t.test('unauthorized access: each owner filter hides another user\'s rows on its own', async () => {
    const at = new Date(now.getTime() + 3 * 60 * 60_000)
    const [myDevice, theirDevice] = [randomUUID(), randomUUID()]
    await db.insert(devices).values([
      { id: myDevice, ownerId: me, name: 'mine', lastSeenAt: at },
      { id: theirDevice, ownerId: other, name: 'theirs', lastSeenAt: at },
    ])
    const myAgent = agent('Mine-ok'), theirAgent = agent('Theirs', other)
    const myAgentA = agent('Layer-agent'), myAgentB = agent('Layer-run'), myAgentC = agent('Layer-device')
    await db.insert(agents).values([myAgent, theirAgent, myAgentA, myAgentB, myAgentC])
    const control = run(myAgent.id, 'running', { leaseExpiresAt: null, deviceId: myDevice })
    // Layer 1, agents.userId: my run row pointing at someone else's agent.
    const viaTheirAgent = run(theirAgent.id, 'running', { leaseExpiresAt: null, deviceId: myDevice })
    // Layer 2, agent_runs.userId: someone else's run row pointing at my agent.
    const theirRunMyAgent = run(myAgentB.id, 'running', { leaseExpiresAt: null, deviceId: myDevice }, other)
    // Layer 3, devices.ownerId: no lease, kept alive only by a device that is online but not mine.
    const onTheirDevice = run(myAgentC.id, 'running', { leaseExpiresAt: null, deviceId: theirDevice })
    await db.insert(agentRuns).values([control, viaTheirAgent, theirRunMyAgent, onTheirDevice])
    try {
      const mine = await listActiveAgents(db, me, at)
      assert.ok(mine.some(x => x.runId === control.id), 'control: my run on my online device is listed')
      assert.ok(!mine.some(x => x.runId === viaTheirAgent.id), 'agents.userId filter')
      assert.ok(!mine.some(x => x.runId === theirRunMyAgent.id), 'agent_runs.userId filter')
      assert.ok(!mine.some(x => x.runId === onTheirDevice.id), 'devices.ownerId filter')
      assert.ok(!(await listActiveAgents(db, other, at)).some(x => [control.id, viaTheirAgent.id, theirRunMyAgent.id, onTheirDevice.id].includes(x.runId!)), 'the other user sees none of these either')
      // Heartbeat layer, run.deviceId: my device reporting a run that lives on their device renews nothing.
      const old = new Date(at.getTime() - 1_000)
      await db.update(agentRuns).set({ leaseExpiresAt: old }).where(eq(agentRuns.id, onTheirDevice.id))
      assert.deepEqual(await heartbeat(myDevice, [onTheirDevice.id], at), { leases: {}, revoked: [onTheirDevice.id] }, 'a run on another user\'s device is revoked, not renewed')
      const [row] = await db.select({ leaseExpiresAt: agentRuns.leaseExpiresAt }).from(agentRuns).where(eq(agentRuns.id, onTheirDevice.id))
      assert.equal(row.leaseExpiresAt!.getTime(), old.getTime())
    } finally {
      await db.update(agentRuns).set({ status: 'cancelled' }).where(inArray(agentRuns.id, [control.id, viaTheirAgent.id, theirRunMyAgent.id, onTheirDevice.id]))
    }
  })

  await t.test('coordinator listed while it holds an unexpired lease', async () => {
    await db.insert(coordinatorSessions).values({ userId: me, leaseHolder: null, leaseUntil: ahead, updatedAt: ago(1_000) })
    assert.ok(!(await listActiveAgents(db, me, now)).some(x => x.kind === 'coordinator'), 'no holder')
    await db.update(coordinatorSessions).set({ leaseHolder: 'turn-1', leaseUntil: ago(1) }).where(eq(coordinatorSessions.userId, me))
    assert.ok(!(await listActiveAgents(db, me, now)).some(x => x.kind === 'coordinator'), 'expired')
    await db.update(coordinatorSessions).set({ leaseUntil: ahead, updatedAt: ago(1_000) }).where(eq(coordinatorSessions.userId, me))
    const result = await listActiveAgents(db, me, now)
    const coordinator = result.find(x => x.kind === 'coordinator')
    assert.deepEqual(coordinator, { id: 'coordinator', kind: 'coordinator', name: 'Coordinator', avatarUrl: null, startedAt: ago(1_000).toISOString(), state: 'working', runId: null, issueId: null })
    assert.equal(result.at(-1)?.id, 'coordinator', 'sorted by start like the rest')
    assert.ok(!(await listActiveAgents(db, other, now)).some(x => x.kind === 'coordinator'), 'not shown to others')
  })
})
