import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'

// BE-18 run chains against a real Postgres. Loopback only, and only a disposable *_e2e
// database (CI: the Actions service 127.0.0.1:5432/mikka_e2e).
const connection = process.env.E2E_DATABASE_URL
if (connection) {
  const target = new URL(connection)
  if (!['postgres:', 'postgresql:'].includes(target.protocol) || target.hostname !== '127.0.0.1' || !/^\/[a-z0-9_]+_e2e$/.test(target.pathname) || target.search || target.hash
    || process.env.MIKKA_DATABASE_URL !== connection) throw new Error('Run chain DB tests require a loopback *_e2e database that MIKKA_DATABASE_URL also points at')
}
if (process.env.REQUIRE_DB === '1' && !connection) throw new Error('Run chain DB tests cannot skip in required CI')

test('run chains: folding, LIMIT on roots, stop forwarding and isolation', { skip: !connection, timeout: 120_000 }, async t => {
  const pool = new Pool({ connectionString: connection, max: 4 })
  const { listIssueRunChains, readRunChain, resolveStopTargets } = await import('../lib/run-chain')
  const { requestRunStop } = await import('../lib/agent-runs')
  const users: string[] = []
  t.after(async () => {
    for (const userId of users) {
      await pool.query('DELETE FROM agent_runs WHERE "userId"=$1', [userId])
      await pool.query('DELETE FROM issues WHERE "userId"=$1', [userId])
      await pool.query('DELETE FROM agents WHERE "userId"=$1', [userId])
      await pool.query('DELETE FROM devices WHERE "ownerId"=$1', [userId])
      await pool.query('DELETE FROM "user" WHERE id=$1', [userId])
    }
    await pool.end()
    const { pool: appPool } = await import('../lib/db')
    await appPool.end()
  })

  async function owner() {
    const userId = `run-chain-${randomUUID()}`, deviceId = randomUUID(), agentId = randomUUID()
    users.push(userId)
    await pool.query('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,$1,$2,true,now(),now())', [userId, `${userId}@example.invalid`])
    await pool.query('INSERT INTO devices (id,"ownerId",name,kind,harnesses,"protocolVersion") VALUES ($1,$2,\'Chain CI computer\',\'local\',$3,3)', [deviceId, userId, JSON.stringify([{ harness: 'codex', installed: true }])])
    await pool.query('INSERT INTO agents (id,"userId","deviceId",harness,name) VALUES ($1,$2,$3,\'codex\',\'Chain CI worker\')', [agentId, userId, deviceId])
    return { userId, agentId, issue: () => issue(userId) }
  }
  async function issue(userId: string, scope = 'personal') {
    const id = randomUUID()
    await pool.query('INSERT INTO issues (id,"userId",title,content,status,priority,scope,"scopeSetBy") VALUES ($1,$2,\'Chain task\',$4,\'todo\',\'normal\',$3,\'user\')', [id, userId, scope, JSON.stringify({ type: 'doc', attrs: { mikka: { number: 1 } }, content: [] })])
    return id
  }
  let clock = Date.parse('2026-10-01T00:00:00Z')
  const ENDED = ['succeeded', 'failed', 'cancelled', 'stopped']
  async function run(o: { userId: string; agentId: string }, issueId: string, status: string, link?: { origin?: string; retryOf?: string; at?: number; id?: string }) {
    const id = link?.id ?? randomUUID()
    if (link?.at === undefined) clock += 1000
    const at = link?.at ?? clock
    await pool.query(`INSERT INTO agent_runs (id,"userId","issueId","agentId",status,prompt,"createdAt","finishedAt","questionContinuation","retryOf")
      VALUES ($1,$2,$3,$4,$5,'Synthetic chain run',$6,$7,$8,$9)`, [id, o.userId, issueId, o.agentId, status, new Date(at),
      ENDED.includes(status) ? new Date(at + 500) : null,
      link?.origin ? JSON.stringify({ questionId: randomUUID(), originRunId: link.origin, originSessionId: 'session', followUp: 'answer', requireSessionResume: true }) : null,
      link?.retryOf ?? null])
    return id
  }
  const cont = (origin: string) => ({ origin })
  const row = async (id: string) => (await pool.query('SELECT status,"stopRequestedAt" FROM agent_runs WHERE id=$1', [id])).rows[0] as { status: string; stopRequestedAt: Date | null }
  const stopRequested = async (id: string) => (await row(id)).stopRequestedAt !== null
  const ids = (chain: { attempts: { runId: string }[] } | null | undefined) => chain?.attempts.map(x => x.runId)

  await t.test('three-level chain resolves root, latest and ordered attempts from any member', async () => {
    const me = await owner(), issueId = await me.issue()
    const a = await run(me, issueId, 'succeeded'), b = await run(me, issueId, 'succeeded', cont(a)), c = await run(me, issueId, 'running', cont(b))
    const chains = await listIssueRunChains(pool, issueId, [me.userId], 20)
    assert.equal(chains.length, 1)
    assert.equal(chains[0].rootRunId, a)
    assert.equal(chains[0].latestRunId, c)
    assert.deepEqual(chains[0].attempts.map(x => [x.runId, x.attempt, x.status]), [[a, 1, 'succeeded'], [b, 2, 'succeeded'], [c, 3, 'running']])
    for (const from of [a, b, c]) {
      const chain = await readRunChain(pool, me.userId, from)
      assert.equal(chain?.rootRunId, a); assert.equal(chain?.latestRunId, c)
    }
    assert.deepEqual(await requestRunStop(me.userId, a), { stoppedRunIds: [c] }, 'stop on an ended old run reaches the live tail')
    assert.equal(await stopRequested(c), true)
  })

  await t.test('QA 1: middle alive + tail alive -> stop on B stops B and C', async () => {
    const me = await owner(), issueId = await me.issue()
    const a = await run(me, issueId, 'succeeded'), b = await run(me, issueId, 'running', cont(a)), c = await run(me, issueId, 'running', cont(b))
    assert.deepEqual(await requestRunStop(me.userId, b), { stoppedRunIds: [b, c] })
    assert.equal(await stopRequested(b), true); assert.equal(await stopRequested(c), true)
    assert.equal(await stopRequested(a), false)
  })

  await t.test('QA 2: middle alive + tail ended -> only B stops, stoppedRunIds=[B], not 409', async () => {
    const me = await owner(), issueId = await me.issue()
    const a = await run(me, issueId, 'succeeded'), b = await run(me, issueId, 'running', cont(a)), c = await run(me, issueId, 'failed', cont(b))
    assert.deepEqual(await requestRunStop(me.userId, b), { stoppedRunIds: [b] })
    assert.equal(await stopRequested(b), true)
    assert.equal(await stopRequested(c), false)
    assert.deepEqual(await requestRunStop(me.userId, a), { stoppedRunIds: [b] }, 'from A too: B is the only unfinished run onward')
  })

  await t.test('QA 3: whole chain ended -> 409 runChainEnded with latestRunId; nothing written', async () => {
    const me = await owner(), issueId = await me.issue()
    const a = await run(me, issueId, 'succeeded'), b = await run(me, issueId, 'failed', cont(a)), c = await run(me, issueId, 'succeeded', cont(b))
    assert.deepEqual(await resolveStopTargets(pool, me.userId, a), { kind: 'chainEnded', latestRunId: c })
    for (const from of [a, b, c]) await assert.rejects(requestRunStop(me.userId, from), (e: { code?: string; params?: unknown }) => e.code === 'runChainEnded')
    for (const id of [a, b, c]) assert.equal(await stopRequested(id), false)
  })

  await t.test('QA 4: a chain with a retryOf rerun (continuation + retryOf mixed)', async () => {
    const me = await owner(), issueId = await me.issue()
    const a = await run(me, issueId, 'succeeded'), b = await run(me, issueId, 'failed', cont(a)), c = await run(me, issueId, 'running', { retryOf: b }), d = await run(me, issueId, 'queued', cont(c))
    const chains = await listIssueRunChains(pool, issueId, [me.userId], 20)
    assert.equal(chains.length, 1, 'the rerun does not open a second thread')
    assert.deepEqual(ids(chains[0]), [a, b, c, d])
    assert.equal(chains[0].latestRunId, d)
    assert.equal((await readRunChain(pool, me.userId, c))?.rootRunId, a)
    assert.deepEqual(await requestRunStop(me.userId, b), { stoppedRunIds: [c, d] })
    assert.equal(await stopRequested(c), true)
    assert.equal((await row(d)).status, 'stopped', 'a queued latest is ended directly (#467)')
  })

  await t.test('retryOf across issues (another workspace/scope) is not linked', async () => {
    const me = await owner(), issueA = await me.issue(), issueB = await me.issue()
    const a = await run(me, issueA, 'failed'), b = await run(me, issueB, 'running', { retryOf: a })
    assert.deepEqual(ids((await listIssueRunChains(pool, issueA, [me.userId], 20))[0]), [a])
    assert.deepEqual(ids((await listIssueRunChains(pool, issueB, [me.userId], 20))[0]), [b])
    await assert.rejects(requestRunStop(me.userId, a), (e: { code?: string }) => e.code === 'runChainEnded')
    assert.equal(await stopRequested(b), false)
  })

  await t.test('LIMIT applies to roots after folding: 22 chains with continuations still give 20 threads', async () => {
    const me = await owner(), issueId = await me.issue()
    const roots: string[] = []
    for (let i = 0; i < 22; i++) { const r = await run(me, issueId, 'succeeded'); roots.push(r); await run(me, issueId, 'succeeded', cont(r)); await run(me, issueId, 'succeeded', i % 2 ? { retryOf: r } : cont(r)) }
    const chains = await listIssueRunChains(pool, issueId, [me.userId], 20)
    assert.equal(chains.length, 20)
    assert.deepEqual(chains.map(c => c.rootRunId), roots.slice(2).reverse())
    assert.ok(chains.every(c => c.attempts.length === 3))
  })

  await t.test('links never cross owners, issues or chains', async () => {
    const me = await owner(), other = await owner(), issueId = await me.issue(), otherIssue = await me.issue(), theirIssue = await other.issue()
    const a = await run(me, issueId, 'succeeded')
    const otherChainLive = await run(me, issueId, 'running')
    const crossIssue = await run(me, otherIssue, 'running', cont(a))
    const crossOwner = await run(other, theirIssue, 'running', cont(a))
    assert.deepEqual(ids(await readRunChain(pool, me.userId, a)), [a])
    assert.equal(await readRunChain(pool, me.userId, crossOwner), null)
    await assert.rejects(requestRunStop(me.userId, a), (e: { code?: string }) => e.code === 'runChainEnded')
    await assert.rejects(requestRunStop(me.userId, crossOwner), (e: { code?: string }) => e.code === 'runNotFound')
    for (const id of [otherChainLive, crossIssue, crossOwner]) assert.equal(await stopRequested(id), false)
  })

  await t.test('same issue, different owner: a teammate run pointing at my run is a separate thread', async () => {
    const me = await owner(), mate = await owner(), issueId = await issue(me.userId, 'workspace')
    const mine = await run(me, issueId, 'succeeded')
    const theirs = await run(mate, issueId, 'running', cont(mine)), theirRerun = await run(mate, issueId, 'running', { retryOf: mine })
    const chains = await listIssueRunChains(pool, issueId, [me.userId, mate.userId], 20)
    assert.equal(chains.length, 3)
    assert.deepEqual(chains.map(c => c.attempts.length), [1, 1, 1])
    await assert.rejects(requestRunStop(me.userId, mine), (e: { code?: string }) => e.code === 'runChainEnded')
    assert.equal(await stopRequested(theirs), false); assert.equal(await stopRequested(theirRerun), false)
  })

  await t.test('cycle A <-> B (+ C off B): terminates, root falls back to earliest createdAt, thread still listed', async () => {
    const me = await owner(), issueId = await me.issue()
    const a = randomUUID(), b = randomUUID()
    await run(me, issueId, 'succeeded', { id: a, origin: b })
    await run(me, issueId, 'succeeded', { id: b, retryOf: a })
    const c = await run(me, issueId, 'running', cont(b))
    const chains = await listIssueRunChains(pool, issueId, [me.userId], 20)
    assert.equal(chains.length, 1)
    assert.equal(chains[0].rootRunId, a)
    assert.deepEqual(ids(chains[0]), [a, b, c])
    for (const from of [a, b, c]) assert.equal((await readRunChain(pool, me.userId, from))?.rootRunId, a)
    assert.deepEqual(await requestRunStop(me.userId, a), { stoppedRunIds: [c] })
  })

  await t.test('cycle with tied createdAt: root falls back to the smaller uuid', async () => {
    const me = await owner(), issueId = await me.issue()
    const [x, y] = [randomUUID(), randomUUID()].sort()
    clock += 1000
    await run(me, issueId, 'succeeded', { id: y, origin: x, at: clock })
    await run(me, issueId, 'succeeded', { id: x, origin: y, at: clock })
    const chains = await listIssueRunChains(pool, issueId, [me.userId], 20)
    assert.equal(chains.length, 1); assert.equal(chains[0].rootRunId, x); assert.equal(chains[0].latestRunId, y)
  })

  await t.test('fork with tied createdAt: latest is the larger uuid, deterministically', async () => {
    const me = await owner(), issueId = await me.issue()
    const a = await run(me, issueId, 'succeeded')
    const [lo, hi] = [randomUUID(), randomUUID()].sort()
    clock += 1000
    await run(me, issueId, 'running', { id: hi, origin: a, at: clock })
    await run(me, issueId, 'running', { id: lo, retryOf: a, at: clock })
    for (let i = 0; i < 3; i++) {
      const chain = await readRunChain(pool, me.userId, a)
      assert.deepEqual(ids(chain), [a, lo, hi]); assert.equal(chain?.latestRunId, hi)
    }
    assert.equal((await listIssueRunChains(pool, issueId, [me.userId], 20))[0].latestRunId, hi)
  })

  await t.test('malformed originRunId is ignored, not a cast error', async () => {
    const me = await owner(), issueId = await me.issue()
    const a = await run(me, issueId, 'succeeded')
    const b = await run(me, issueId, 'running')
    await pool.query(`UPDATE agent_runs SET "questionContinuation"='{"originRunId":"not-a-uuid"}' WHERE id=$1`, [b])
    assert.equal((await listIssueRunChains(pool, issueId, [me.userId], 20)).length, 2)
    assert.equal(await readRunChain(pool, me.userId, 'not-a-uuid'), null)
    void a
  })

  await t.test('race: the requested run ends between the chain read and its stop -> runChainEnded, not 404', async () => {
    const me = await owner(), issueId = await me.issue()
    const a = await run(me, issueId, 'running')
    const holder = await pool.connect()
    try {
      // Hold the row so the stop reads the chain (no locks), then blocks in stopOwnedRun's
      // FOR UPDATE; the daemon's end commits first, so the stop sees an ended run.
      await holder.query('BEGIN')
      await holder.query('SELECT 1 FROM agent_runs WHERE id=$1 FOR UPDATE', [a])
      const stop = requestRunStop(me.userId, a).then(() => null, (e: { code?: string }) => e.code ?? 'other')
      for (let i = 0; i < 100 && !(await pool.query(`SELECT 1 FROM pg_locks WHERE NOT granted AND locktype IN ('transactionid','tuple')`)).rowCount; i++) await new Promise(r => setTimeout(r, 20))
      await holder.query(`UPDATE agent_runs SET status='succeeded',"finishedAt"=now() WHERE id=$1`, [a])
      await holder.query('COMMIT')
      assert.equal(await stop, 'runChainEnded')
      assert.equal(await stopRequested(a), false)
    } finally { holder.release() }
  })

  await t.test('reads take no row locks', async () => {
    const me = await owner(), issueId = await me.issue()
    const a = await run(me, issueId, 'running')
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT 1 FROM agent_runs WHERE id=$1 FOR UPDATE NOWAIT', [a])
      const other = new Pool({ connectionString: connection, max: 1 })
      try {
        assert.equal((await listIssueRunChains(other, issueId, [me.userId], 20)).length, 1)
        assert.equal((await readRunChain(other, me.userId, a))?.rootRunId, a)
      } finally { await other.end() }
      await client.query('ROLLBACK')
    } finally { client.release() }
  })
})
