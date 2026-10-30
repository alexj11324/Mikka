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
  const { listIssueRunChains, readRunChain, resolveStopTarget } = await import('../lib/run-chain')
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
  async function issue(userId: string) {
    const id = randomUUID()
    await pool.query('INSERT INTO issues (id,"userId",title,content,status,priority,scope) VALUES ($1,$2,\'Chain task\',$3,\'todo\',\'normal\',\'personal\')', [id, userId, JSON.stringify({ type: 'doc', attrs: { mikka: { number: 1 } }, content: [] })])
    return id
  }
  let clock = Date.parse('2026-10-01T00:00:00Z')
  async function run(o: { userId: string; agentId: string }, issueId: string, status: string, origin?: string) {
    const id = randomUUID()
    clock += 1000
    await pool.query(`INSERT INTO agent_runs (id,"userId","issueId","agentId",status,prompt,"createdAt","finishedAt","questionContinuation")
      VALUES ($1,$2,$3,$4,$5,'Synthetic chain run',$6,$7,$8)`, [id, o.userId, issueId, o.agentId, status, new Date(clock),
      ['succeeded', 'failed', 'cancelled'].includes(status) ? new Date(clock + 500) : null,
      origin ? JSON.stringify({ questionId: randomUUID(), originRunId: origin, originSessionId: 'session', followUp: 'answer', requireSessionResume: true }) : null])
    return id
  }
  const stopRequested = async (id: string) => (await pool.query('SELECT "stopRequestedAt" FROM agent_runs WHERE id=$1', [id])).rows[0].stopRequestedAt !== null

  await t.test('three-level chain resolves root, latest and ordered attempts; stop on A or B lands on C', async () => {
    const me = await owner(), issueId = await me.issue()
    const a = await run(me, issueId, 'succeeded'), b = await run(me, issueId, 'succeeded', a), c = await run(me, issueId, 'running', b)
    const chains = await listIssueRunChains(pool, issueId, [me.userId], 20)
    assert.equal(chains.length, 1)
    assert.equal(chains[0].rootRunId, a)
    assert.equal(chains[0].latestRunId, c)
    assert.deepEqual(chains[0].attempts.map(x => [x.runId, x.attempt, x.status]), [[a, 1, 'succeeded'], [b, 2, 'succeeded'], [c, 3, 'running']])
    for (const from of [a, b, c]) {
      const chain = await readRunChain(pool, me.userId, from)
      assert.equal(chain?.rootRunId, a); assert.equal(chain?.latestRunId, c)
    }
    assert.deepEqual(await resolveStopTarget(pool, me.userId, a), { kind: 'stop', runId: c, forwardedFrom: a })
    assert.deepEqual(await resolveStopTarget(pool, me.userId, b), { kind: 'stop', runId: c, forwardedFrom: b })
    await requestRunStop(me.userId, b)
    assert.equal(await stopRequested(c), true, 'stop on B is forwarded to the live C')
    assert.equal(await stopRequested(b), false)
  })

  await t.test('all-ended chain returns 409 runChainEnded with latestRunId', async () => {
    const me = await owner(), issueId = await me.issue()
    const a = await run(me, issueId, 'succeeded'), b = await run(me, issueId, 'failed', a), c = await run(me, issueId, 'succeeded', b)
    assert.deepEqual(await resolveStopTarget(pool, me.userId, a), { kind: 'chainEnded', latestRunId: c })
    await assert.rejects(requestRunStop(me.userId, a), (error: { code?: string; params?: Record<string, unknown> }) => error.code === 'runChainEnded' && error.params?.latestRunId === c)
  })

  await t.test('more than 20 roots: continuations do not use up slots, LIMIT applies after folding', async () => {
    const me = await owner(), issueId = await me.issue()
    const roots: string[] = []
    for (let i = 0; i < 22; i++) roots.push(await run(me, issueId, 'succeeded'))
    // Newest 20 roots each get two newer continuations: 60 runs newer than the 20th root.
    for (const root of roots.slice(2)) await run(me, issueId, 'running', await run(me, issueId, 'succeeded', root))
    const chains = await listIssueRunChains(pool, issueId, [me.userId], 20)
    assert.equal(chains.length, 20)
    assert.deepEqual(chains.map(chain => chain.rootRunId), roots.slice(2).reverse())
    assert.ok(chains.every(chain => chain.attempts.length === 3 && chain.attempts.at(-1)!.runId === chain.latestRunId))
  })

  await t.test('cross-chain stop: another owner\'s or issue\'s run is never a forward target', async () => {
    const me = await owner(), other = await owner()
    const issueId = await me.issue(), elsewhere = await me.issue(), theirIssue = await other.issue()
    const mine = await run(me, issueId, 'succeeded')
    // A foreign owner's live run claiming my run as origin does not join my chain.
    const foreign = await run(other, theirIssue, 'running', mine)
    // My own live run on another issue claiming it as origin does not join either.
    const otherIssue = await run(me, elsewhere, 'running', mine)
    assert.deepEqual(await resolveStopTarget(pool, me.userId, mine), { kind: 'chainEnded', latestRunId: mine })
    await assert.rejects(requestRunStop(me.userId, mine), /runChainEnded/)
    assert.equal(await stopRequested(foreign), false)
    assert.equal(await stopRequested(otherIssue), false)
    // Their run is not mine to stop at all: 404, not a forward.
    const theirs = await run(other, theirIssue, 'succeeded'), theirLive = await run(other, theirIssue, 'running', theirs)
    assert.deepEqual(await resolveStopTarget(pool, me.userId, theirs), { kind: 'notFound' })
    await assert.rejects(requestRunStop(me.userId, theirs), /runNotFound/)
    assert.equal(await stopRequested(theirLive), false)
    assert.equal((await listIssueRunChains(pool, issueId, [me.userId], 20)).map(chain => chain.attempts.length).join(), '1')
  })

  await t.test('a corrupt cyclic link terminates', async () => {
    const me = await owner(), issueId = await me.issue()
    const a = await run(me, issueId, 'succeeded'), b = await run(me, issueId, 'running', a)
    await pool.query('UPDATE agent_runs SET "questionContinuation"=jsonb_build_object(\'originRunId\',$2::text) WHERE id=$1', [a, b])
    const chain = await readRunChain(pool, me.userId, a)
    assert.deepEqual(new Set(chain?.attempts.map(x => x.runId)), new Set([a, b]))
    assert.equal(chain?.attempts.length, 2)
  })

  await t.test('the list read takes no row locks', async () => {
    const me = await owner(), issueId = await me.issue()
    const a = await run(me, issueId, 'succeeded'); await run(me, issueId, 'running', a)
    const holder = await pool.connect()
    try {
      await holder.query('BEGIN'); await holder.query('SELECT id FROM agent_runs WHERE "issueId"=$1 FOR UPDATE', [issueId])
      const reader = await pool.connect()
      try {
        await reader.query('BEGIN'); await reader.query("SET LOCAL lock_timeout='500ms'")
        assert.equal((await listIssueRunChains(reader, issueId, [me.userId], 20)).length, 1)
        await reader.query('ROLLBACK')
      } finally { reader.release() }
      await holder.query('ROLLBACK')
    } finally { holder.release() }
  })
})
