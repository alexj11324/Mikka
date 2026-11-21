import { seedFixtureWorkspace } from '../tests/helpers/task-workspace'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { activeAgentsResponse, mergeAgentRuns, sortActiveAgents, type ActiveAgent } from './active-agents'
import { coordinatorLeaseActive } from './coordinator/lease'
import { WORKING_RUN_STATUSES, UNFINISHED_RUN_STATUSES } from './agent-run-statuses'
import { LEASED_RUN_STATUSES } from './run-retry'
import { disposableDatabase } from '../tests/helpers/e2e-target.mjs'

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

// Database regressions run against a disposable loopback *_e2e database in all
// three URLs. Pure tests skip them otherwise; REQUIRE_DB=1 makes a missing database fail.
const target = process.env.E2E_DATABASE_URL
const databaseUrl = disposableDatabase() && process.env.MIKKA_DATABASE_URL === target && process.env.DATABASE_URL === target ? target : undefined
if (!databaseUrl && process.env.REQUIRE_DB === '1') throw new Error('REQUIRE_DB=1 requires the matching loopback *_e2e database')
const dbTest = databaseUrl ? test : test.skip

async function database() {
  const [{ Pool }, { drizzle }, schema, { createRequestDatabaseScope }, { applyDeviceSessionReport }] = await Promise.all([
    import('pg'), import('drizzle-orm/node-postgres'), import('./db/schema'), import('./db'), import('./device-session'),
  ])
  const pool = new Pool({ connectionString: databaseUrl, max: 2 })
  const scope = createRequestDatabaseScope(databaseUrl!)
  const db = drizzle(pool, { schema })
  // The gateway's session reports, through the real server writer and its request DB scope.
  const session = (deviceId: string, state: 'connected' | 'disconnected', at: Date) =>
    scope.run(() => applyDeviceSessionReport(deviceId, { state, at: at.toISOString(), socketId: `socket-${deviceId.slice(0, 8)}` }))
  return { pool, db, schema, session, close: async () => { await scope.close(); await pool.end() } }
}

dbTest('active agents on the database', async t => {
  const { db, pool, schema, session, close } = await database()
  const { listActiveAgents } = await import('./active-agents')
  const { agents, agentRuns, devices, coordinatorSessions } = schema
  const { eq, inArray } = await import('drizzle-orm')
  const me = `test-mik7-${randomUUID()}`
  const other = `test-mik7-${randomUUID()}`
  const workspaceId = await seedFixtureWorkspace(pool, me), otherWorkspace = await seedFixtureWorkspace(pool, other)
  const now = new Date()
  const ago = (ms: number) => new Date(now.getTime() - ms)
  const ahead = new Date(now.getTime() + 5 * 60_000)
  const onlineDevice = randomUUID(); const offlineDevice = randomUUID()
  await db.insert(devices).values([
    { id: onlineDevice, ownerId: me, name: 'on', lastSeenAt: ago(10 * 60_000), sessionOpenedAt: ago(10 * 60_000) },
    { id: offlineDevice, ownerId: me, name: 'off', lastSeenAt: ago(5_000), sessionOpenedAt: ago(60_000), sessionClosedAt: ago(5_000) },
  ])
  const agent = (name: string, userId = me) => ({ id: randomUUID(), userId, harness: 'codex' as const, name })
  const [a, b, c, d, e, f, mine] = [agent('A'), agent('B'), agent('C'), agent('D'), agent('E'), agent('F'), agent('Other', other)]
  await db.insert(agents).values([a, b, c, d, e, f, mine])
  const run = (agentId: string, status: string, extra: Partial<typeof agentRuns.$inferInsert> = {}, userId = me) =>
    ({ id: randomUUID(), userId, workspaceId: userId === me ? workspaceId : otherWorkspace, agentId, status: status as never, leaseExpiresAt: ahead, startedAt: ago(60_000), ...extra })
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
  t.after(async () => {
    try {
      await cleanup()
    } finally {
      await close()
    }
  })
  const cleanup = async () => {
    await db.delete(agentRuns).where(inArray(agentRuns.userId, [me, other]))
    await db.delete(agents).where(inArray(agents.userId, [me, other]))
    await db.delete(devices).where(eq(devices.ownerId, me))
    await db.delete(coordinatorSessions).where(inArray(coordinatorSessions.userId, [me, other]))
    await db.delete(schema.coordinatorBots).where(eq(schema.coordinatorBots.ownerId, me))
    await db.delete(schema.bots).where(eq(schema.bots.ownerId, me))
    await db.delete(schema.users).where(eq(schema.users.id, me))
  }

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

  const alternateWorkspace = await seedFixtureWorkspace(pool, me, 'team')
  assert.deepEqual(await listActiveAgents(db, me, now, alternateWorkspace), [],
    'workspace-scoped token does not return active runs belonging to another workspace')
  assert.deepEqual((await listActiveAgents(db, me, now, workspaceId)).map(row => row.name), ['B', 'A', 'C'],
    'the matching workspace still displays its active runs')

  await t.test('ties order by id', async () => {
    const tie = ago(200_000)
    const [x, y] = [agent('X'), agent('Y')]
    await db.insert(agents).values([x, y])
    await db.insert(agentRuns).values([run(x.id, 'running', { startedAt: tie }), run(y.id, 'running', { startedAt: tie })])
    const ids = (await listActiveAgents(db, me, now)).slice(0, 2).map(z => z.id)
    assert.deepEqual(ids, [x.id, y.id].sort())
  })

  await t.test('a claimed run stays active for its whole session, and the close ends it', async () => {
    const { SESSION_LEASE_MS } = await import('@mikka/protocol/device')
    const device = randomUUID(), otherDevice = randomUUID()
    const openedAt = new Date()
    await db.insert(devices).values([{ id: device, ownerId: me, name: 'session' }, { id: otherDevice, ownerId: me, name: 'elsewhere' }])
    const worker = agent('Leased')
    await db.insert(agents).values(worker)
    const soon = new Date(Date.now() + 60_000)
    const claimed = run(worker.id, 'preparing', { deviceId: device, leaseExpiresAt: soon })
    const queued = run(worker.id, 'queued', { deviceId: device, leaseExpiresAt: soon })
    const stopping = run(worker.id, 'running', { deviceId: device, leaseExpiresAt: soon, stopRequestedAt: new Date() })
    const ended = run(worker.id, 'running', { deviceId: device, leaseExpiresAt: ago(1_000) })
    const elsewhere = run(worker.id, 'running', { deviceId: otherDevice, leaseExpiresAt: soon })
    await db.insert(agentRuns).values([claimed, queued, stopping, ended, elsewhere])
    try {
      assert.deepEqual(await session(device, 'connected', openedAt), { applied: true })
      const lease = async (id: string) => (await db.select({ at: agentRuns.leaseExpiresAt }).from(agentRuns).where(eq(agentRuns.id, id)))[0].at!.getTime()
      assert.ok(await lease(claimed.id) >= openedAt.getTime() + SESSION_LEASE_MS - 60_000, 'a live lease lasts as long as the session')
      for (const id of [queued.id, stopping.id, ended.id, elsewhere.id]) assert.ok(await lease(id) < openedAt.getTime() + 120_000, 'queued, stopping, ended and foreign runs are not extended')
      const hourLater = new Date(Date.now() + 60 * 60_000)
      assert.ok((await listActiveAgents(db, me, hourLater)).some(x => x.runId === claimed.id), 'no heartbeat needed an hour later')
      assert.deepEqual(await session(device, 'disconnected', new Date()), { applied: true })
      assert.ok(await lease(claimed.id) <= Date.now(), 'the close ends the lease at once')
      assert.ok(!(await listActiveAgents(db, me, new Date(Date.now() + 1))).some(x => x.runId === claimed.id))
    } finally {
      await db.delete(agentRuns).where(eq(agentRuns.agentId, worker.id))
      await db.delete(agents).where(eq(agents.id, worker.id))
      await db.delete(devices).where(inArray(devices.id, [device, otherDevice]))
    }
  })

  await t.test('unauthorized access: each owner filter hides another user\'s rows on its own', async () => {
    const at = new Date(now.getTime() + 3 * 60 * 60_000)
    const [myDevice, theirDevice] = [randomUUID(), randomUUID()]
    await db.insert(devices).values([
      { id: myDevice, ownerId: me, name: 'mine', sessionOpenedAt: now },
      { id: theirDevice, ownerId: other, name: 'theirs', sessionOpenedAt: now },
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
      // Session layer, run.deviceId: my device's session extends nothing that lives on their device.
      const old = new Date(Date.now() + 60_000)
      await db.update(agentRuns).set({ leaseExpiresAt: old }).where(eq(agentRuns.id, onTheirDevice.id))
      await session(myDevice, 'connected', new Date())
      const [row] = await db.select({ leaseExpiresAt: agentRuns.leaseExpiresAt }).from(agentRuns).where(eq(agentRuns.id, onTheirDevice.id))
      assert.equal(row.leaseExpiresAt!.getTime(), old.getTime())
    } finally {
      await db.delete(agentRuns).where(inArray(agentRuns.id, [control.id, viaTheirAgent.id, theirRunMyAgent.id, onTheirDevice.id]))
      await db.delete(agents).where(inArray(agents.id, [myAgent.id, theirAgent.id, myAgentA.id, myAgentB.id, myAgentC.id]))
      await db.delete(devices).where(inArray(devices.id, [myDevice, theirDevice]))
    }
  })

  await t.test('coordinator listed while it holds an unexpired lease', async () => {
    // The Coordinator's chat is its bot row's (coordinator_bots); its entry carries that bot's id.
    const coordinatorBot = randomUUID(), coordinatorWorkspace = alternateWorkspace
    const { sql } = await import('drizzle-orm')
    await db.execute(sql`insert into "user" (id,name,email,"emailVerified","createdAt","updatedAt") values (${me},'Active agents fixture',${`${me}@example.invalid`},false,now(),now()) on conflict do nothing`)
    await db.insert(schema.bots).values({ id: coordinatorBot, ownerId: me, workspaceId: coordinatorWorkspace, name: 'Coordinator' })
    await db.insert(schema.coordinatorBots).values({ ownerId: me, workspaceId: coordinatorWorkspace, botId: coordinatorBot })
    await db.insert(coordinatorSessions).values({ userId: me, botId: coordinatorBot, leaseHolder: null, leaseUntil: ahead, updatedAt: ago(1_000) })
    assert.ok(!(await listActiveAgents(db, me, now)).some(x => x.kind === 'coordinator'), 'no holder')
    await db.update(coordinatorSessions).set({ leaseHolder: 'turn-1', leaseUntil: ago(1) }).where(eq(coordinatorSessions.userId, me))
    assert.ok(!(await listActiveAgents(db, me, now)).some(x => x.kind === 'coordinator'), 'expired')
    await db.update(coordinatorSessions).set({ leaseUntil: ahead, updatedAt: ago(1_000) }).where(eq(coordinatorSessions.userId, me))
    const result = await listActiveAgents(db, me, now)
    const coordinator = result.find(x => x.kind === 'coordinator')
    assert.deepEqual(coordinator, { id: coordinatorBot, kind: 'coordinator', name: 'Coordinator', avatarUrl: null, startedAt: ago(1_000).toISOString(), state: 'working', runId: null, issueId: null })
    assert.equal(result.at(-1)?.id, coordinatorBot, 'sorted by start like the rest')
    assert.deepEqual((await listActiveAgents(db, me, now, coordinatorWorkspace)).map(row => row.id), [coordinatorBot],
      'a team-scoped token sees only its active Coordinator, not personal workspace runs')
    assert.ok(!(await listActiveAgents(db, me, now, workspaceId)).some(row => row.kind === 'coordinator'),
      'a personal workspace token cannot see the active Coordinator of another workspace')
    assert.ok(!(await listActiveAgents(db, other, now)).some(x => x.kind === 'coordinator'), 'not shown to others')
  })
})
