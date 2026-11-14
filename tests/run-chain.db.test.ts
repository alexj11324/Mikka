import { seedFixtureWorkspace } from './helpers/task-workspace'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import type { RunFailure } from '@mikka/protocol/run-failure'
import { measured } from './helpers/read-metrics'

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
    const { workspacePool } = await import('../lib/workspace-db')
    await Promise.all([appPool.end(), workspacePool.end()])
  })

  async function owner() {
    const userId = `run-chain-${randomUUID()}`, deviceId = randomUUID(), agentId = randomUUID()
    users.push(userId)
    await pool.query('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,$1,$2,true,now(),now())', [userId, `${userId}@example.invalid`])
    await pool.query('INSERT INTO devices (id,"ownerId",name,kind,harnesses,"protocolVersion") VALUES ($1,$2,\'Chain CI computer\',\'local\',$3,3)', [deviceId, userId, JSON.stringify([{ harness: 'codex', installed: true }])])
    await pool.query('INSERT INTO agents (id,"userId","deviceId",harness,name) VALUES ($1,$2,$3,\'codex\',\'Chain CI worker\')', [agentId, userId, deviceId])
    return { userId, agentId, issue: () => issue(userId) }
  }
  const issueNumbers = new Map<string, number>()
  async function issue(userId: string, scope = 'personal') {
    const id = randomUUID()
    const workspaceId = await seedFixtureWorkspace(pool, userId, scope === 'workspace' ? 'team' : 'personal')
    const number = (issueNumbers.get(userId) ?? 0) + 1
    issueNumbers.set(userId, number)
    await pool.query('INSERT INTO issues (id,"userId","workspaceId",title,content,status,priority,scope,"scopeSetBy") VALUES ($1,$2,$5,\'Chain task\',$4,\'todo\',\'normal\',$3,\'user\')', [id, userId, scope, JSON.stringify({ type: 'doc', attrs: { mikka: { number } }, content: [] }), workspaceId])
    return id
  }
  let clock = Date.parse('2026-10-01T00:00:00Z')
  const ENDED = ['succeeded', 'failed', 'cancelled', 'stopped']
  async function run(o: { userId: string; agentId: string }, issueId: string | null, status: string, link?: { origin?: string; retryOf?: string; continues?: string; workspaceId?: string; at?: number; id?: string }) {
    const id = link?.id ?? randomUUID()
    if (link?.at === undefined) clock += 1000
    const at = link?.at ?? clock
    await pool.query(`INSERT INTO agent_runs (id,"userId","issueId","agentId",status,prompt,"createdAt","finishedAt","questionContinuation","retryOf","continuesRunId","workspaceId")
      VALUES ($1,$2,$3,$4,$5,'Synthetic chain run',$6,$7,$8,$9,$10,$11)`, [id, o.userId, issueId, o.agentId, status, new Date(at),
      ENDED.includes(status) ? new Date(at + 500) : null,
      link?.origin ? JSON.stringify({ questionId: randomUUID(), originRunId: link.origin, originSessionId: 'session', followUp: 'answer', requireSessionResume: true }) : null,
      link?.retryOf ?? null, link?.continues ?? null, link?.workspaceId ?? null])
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

  await t.test('a human-controlled pause follows its attempt without changing an earlier quota pause', async () => {
    const me = await owner(), issueId = await me.issue()
    const root = await run(me, issueId, 'paused'), tail = await run(me, issueId, 'paused', cont(root))
    await pool.query(`UPDATE agent_runs SET "pauseReason"=CASE WHEN id=$1 THEN 'quota_exhausted' ELSE 'human_control' END WHERE id IN ($1,$2)`, [root, tail])
    const [listed] = await listIssueRunChains(pool, issueId, [me.userId], 20)
    const detail = await readRunChain(pool, me.userId, root)
    for (const chain of [listed, detail]) assert.deepEqual(chain?.attempts.map(attempt => attempt.pauseReason), ['quota_exhausted', 'human_control'])
  })

  await t.test('failure details follow the latest attempt without provider text in chain lists', async () => {
    const me = await owner(), issueId = await me.issue()
    const a = await run(me, issueId, 'failed'), b = await run(me, issueId, 'failed', cont(a))
    const failure: RunFailure = { schemaVersion: 1, code: 'run_api_key_invalid', category: 'api_key', provider: 'openai', status: 401,
      providerMessage: 'Private provider reply for this attempt', causes: [{ name: 'APIError' }], runId: b, appVersion: 'test', occurredAt: '2026-11-07T12:00:00.000Z' }
    await pool.query('UPDATE agent_runs SET "failureDetails"=$2 WHERE id=$1', [b, JSON.stringify(failure)])
    const listed = await measured(() => listIssueRunChains(pool, issueId, [me.userId], 20))
    assert.equal(listed.statements, 1)
    assert.equal(listed.value[0].attempts[1].failureDetails?.code, 'run_api_key_invalid')
    assert.doesNotMatch(JSON.stringify(listed.value), /Private provider reply|APIError/)
    const detail = await measured(() => readRunChain(pool, me.userId, a))
    assert.equal(detail.statements, 1)
    assert.deepEqual(detail.value?.attempts[1].failureDetails, failure)
    assert.equal(await readRunChain(pool, 'unrelated-owner', b), null)
    assert.equal(detail.value?.attempts[0].failureDetails, undefined, 'historical attempts remain compatible')
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
    await assert.rejects(run(other, theirIssue, 'running', cont(a)), /taskWorkspaceMismatch/)
    const crossOwner = await run(other, theirIssue, 'running')
    assert.deepEqual(ids(await readRunChain(pool, me.userId, a)), [a])
    assert.equal(await readRunChain(pool, me.userId, crossOwner), null)
    await assert.rejects(requestRunStop(me.userId, a), (e: { code?: string }) => e.code === 'runChainEnded')
    await assert.rejects(requestRunStop(me.userId, crossOwner), (e: { code?: string }) => e.code === 'runNotFound')
    for (const id of [otherChainLive, crossIssue, crossOwner]) assert.equal(await stopRequested(id), false)
  })

  await t.test('same issue, different owner: a teammate run pointing at my run is a separate thread', async () => {
    const me = await owner(), mate = await owner(), issueId = await issue(me.userId, 'workspace')
    const workspaceId = (await pool.query('SELECT "workspaceId" FROM issues WHERE id=$1', [issueId])).rows[0].workspaceId
    await pool.query(`INSERT INTO mikka_workspace_members ("workspaceId","userId",name,email,role,status)
      VALUES ($1,$2,$2,$3,'member','active')`, [workspaceId, mate.userId, `${mate.userId}@example.invalid`])
    const mine = await run(me, issueId, 'succeeded')
    await assert.rejects(run(mate, issueId, 'running', cont(mine)), /taskWorkspaceMismatch/)
    await assert.rejects(run(mate, issueId, 'running', { retryOf: mine }), /taskWorkspaceMismatch/)
    const theirs = await run(mate, issueId, 'running'), theirRerun = await run(mate, issueId, 'running')
    const chains = await listIssueRunChains(pool, issueId, [me.userId, mate.userId], 20)
    assert.equal(chains.length, 3)
    assert.deepEqual(chains.map(c => c.attempts.length), [1, 1, 1])
    await assert.rejects(requestRunStop(me.userId, mine), (e: { code?: string }) => e.code === 'runChainEnded')
    assert.equal(await stopRequested(theirs), false); assert.equal(await stopRequested(theirRerun), false)
  })

  await t.test('cycles are rejected by the depth limit without a fallback root', async () => {
    const me = await owner(), issueId = await me.issue()
    const a = randomUUID(), b = randomUUID()
    await run(me, issueId, 'succeeded', { id: a })
    await run(me, issueId, 'succeeded', { id: b, retryOf: a })
    await pool.query('UPDATE agent_runs SET "questionContinuation"=$2 WHERE id=$1', [a, { originRunId: b }])
    await assert.rejects(listIssueRunChains(pool, issueId, [me.userId], 20), /runChainDepthExceeded/)
    await assert.rejects(readRunChain(pool, me.userId, a), /runChainDepthExceeded/)
  })

  await t.test('64 parent links are accepted; a 65th is rejected', async () => {
    const me = await owner(), issueId = await me.issue()
    let tail = await run(me, issueId, 'succeeded')
    for (let i = 0; i < 64; i++) tail = await run(me, issueId, 'succeeded', cont(tail))
    assert.equal((await readRunChain(pool, me.userId, tail))?.attempts.length, 65)
    tail = await run(me, issueId, 'running', cont(tail))
    await assert.rejects(readRunChain(pool, me.userId, tail), /runChainDepthExceeded/)
    await assert.rejects(listIssueRunChains(pool, issueId, [me.userId], 20), /runChainDepthExceeded/)
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

  await t.test('the database rejects new task-free retry, continuation and question edges across tenants or owners', async () => {
    const me = await owner(), foreign = await owner()
    const alpha = await seedFixtureWorkspace(pool, me.userId, 'team')
    const beta = await seedFixtureWorkspace(pool, me.userId, 'team')
    const source = await run(me, null, 'succeeded', { workspaceId: alpha })
    const candidate = await run(me, null, 'running', { workspaceId: beta })
    const refs = [
      { column: 'retryOf', link: { retryOf: source }, value: source },
      { column: 'continuesRunId', link: { continues: source }, value: source },
      { column: 'questionContinuation', link: { origin: source }, value: { originRunId: source } },
    ]
    for (const ref of refs) {
      await assert.rejects(run(me, null, 'running', { ...ref.link, workspaceId: beta }), /taskWorkspaceMismatch/)
      await assert.rejects(pool.query(`UPDATE agent_runs SET "${ref.column}"=$2 WHERE id=$1`, [candidate, ref.value]), /taskWorkspaceMismatch/)
      await assert.rejects(pool.query(`UPDATE agent_runs SET status='succeeded',"${ref.column}"=$2 WHERE id=$1`, [candidate, ref.value]), /taskWorkspaceMismatch/)
      const accepted = await run(me, null, 'running', { ...ref.link, workspaceId: alpha })
      assert.ok(ids(await readRunChain(pool, me.userId, source))?.includes(accepted))
      await assert.rejects(run(foreign, null, 'running', { ...ref.link, workspaceId: alpha }), /taskWorkspaceMismatch/)
    }
    await assert.rejects(run(me, null, 'running', { workspaceId: alpha, retryOf: randomUUID() }), /taskWorkspaceMismatch/)
    await assert.rejects(pool.query('UPDATE agent_runs SET "userId"=$2 WHERE id=$1', [source, foreign.userId]), /taskWorkspaceMismatch/)
    assert.deepEqual(await row(candidate), { status: 'running', stopRequestedAt: null }, 'failed lineage writes have no effect')
    assert.deepEqual(ids(await readRunChain(pool, me.userId, candidate)), [candidate])
  })

  await t.test('historical task-free edges cannot widen chain reads or stop targets across workspaces', async () => {
    const history = await pool.connect()
    const alpha = randomUUID(), beta = randomUUID(), ownerId = `history-${randomUUID()}`
    const root = randomUUID(), tail = randomUUID(), retry = randomUUID(), continued = randomUUID(), question = randomUUID(), unresolved = randomUUID()
    try {
      await history.query('BEGIN')
      // This connection-local table represents pre-migration history. The
      // production guard remains enabled on the real table throughout.
      await history.query(`CREATE TEMP TABLE agent_runs (
        id uuid PRIMARY KEY,"userId" text,"issueId" uuid,"workspaceId" uuid,"botId" uuid,status text,outcome text,"pauseReason" text,"failureDetails" jsonb,
        "createdAt" timestamptz DEFAULT now(),"finishedAt" timestamptz,"stopRequestedAt" timestamptz,
        "questionContinuation" jsonb,"retryOf" uuid,"continuesRunId" uuid) ON COMMIT DROP`)
      await history.query(`INSERT INTO agent_runs (id,"userId","workspaceId",status,"retryOf","continuesRunId","questionContinuation","createdAt") VALUES
        ($1,$7,$8,'succeeded',NULL,NULL,NULL,now()-interval '10 seconds'),
        ($2,$7,$8,'running',$1,NULL,NULL,now()-interval '5 seconds'),
        ($3,$7,$9,'running',$1,NULL,NULL,now()),
        ($4,$7,$9,'running',NULL,$1,NULL,now()),
        ($5,$7,$9,'running',NULL,NULL,jsonb_build_object('originRunId',$1::text),now()),
        ($6,$7,NULL,'running',$1,NULL,NULL,now())`, [root, tail, retry, continued, question, unresolved, ownerId, alpha, beta])
      for (const runId of [root, tail]) assert.deepEqual(ids(await readRunChain(history, ownerId, runId)), [root, tail])
      assert.deepEqual(await resolveStopTargets(history, ownerId, root), { kind: 'stop', runIds: [tail], latestRunId: tail })
      for (const runId of [retry, continued, question]) assert.deepEqual(ids(await readRunChain(history, ownerId, runId)), [runId])
      assert.equal(await readRunChain(history, ownerId, unresolved), null)
      assert.deepEqual(await resolveStopTargets(history, ownerId, unresolved), { kind: 'notFound' })
    } finally { await history.query('ROLLBACK'); history.release() }
  })

  await t.test('task-free runs use their persisted tenant policy and current membership, without a home fallback', async () => {
    const me = await owner()
    const personal = await seedFixtureWorkspace(pool, me.userId)
    const shared = await seedFixtureWorkspace(pool, me.userId, 'team')
    const teamRun = await run(me, null, 'running', { workspaceId: shared })
    const personalRun = await run(me, null, 'running', { workspaceId: personal })
    const unresolvedRun = await run(me, null, 'running')
    await pool.query(`INSERT INTO workspace_computer_policies ("workspaceId",permission,cli_run_policy)
      VALUES ($1,'allow',$2)`, [shared, { permissions: { network: 'deny', git_push: 'deny' } }])
    const { readCliRunPolicy } = await import('../lib/agent-tool-approval/policy-store')
    const current = await readCliRunPolicy(pool, teamRun, me.userId)
    assert.equal(current.workspaceId, shared)
    assert.deepEqual(current.workspaceIds, [shared])
    assert.equal(current.policy.permissions.network, 'deny')
    assert.equal(current.policy.permissions.git_push, 'deny')
    const personalPolicy = await readCliRunPolicy(pool, personalRun, me.userId)
    assert.equal(personalPolicy.workspaceId, personal)
    assert.notEqual(personalPolicy.policy.permissions.network, 'deny')
    await assert.rejects(readCliRunPolicy(pool, unresolvedRun, me.userId), /agentPolicyUnavailable/)
    await pool.query(`UPDATE mikka_workspace_members SET status='suspended' WHERE "workspaceId"=$1 AND "userId"=$2`, [shared, me.userId])
    try { await assert.rejects(readCliRunPolicy(pool, teamRun, me.userId), /agentPolicyUnavailable/) }
    finally { await pool.query(`UPDATE mikka_workspace_members SET status='active' WHERE "workspaceId"=$1 AND "userId"=$2`, [shared, me.userId]) }
    await pool.query('UPDATE agent_runs SET cli_policy_hierarchy=$2 WHERE id=$1',
      [teamRun, { workspaceId: shared, teamId: randomUUID(), projectId: null }])
    await assert.rejects(readCliRunPolicy(pool, teamRun, me.userId), /agentPolicyUnavailable/, 'losing a task anchor cannot discard its frozen Team policy')
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
