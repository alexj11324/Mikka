import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { gzipSync, gunzipSync } from 'node:zlib'
import test from 'node:test'
import { Pool, type PoolClient } from 'pg'
import { DAEMON_PROTOCOL_VERSION } from '@mikka/protocol/daemon'
import { remoteKey } from '@mikka/protocol/repository'

const connection = process.env.E2E_DATABASE_URL
if (connection) {
  const target = new URL(connection)
  if (target.hostname !== '127.0.0.1' || !/^\/[a-z0-9_]+_e2e$/.test(target.pathname)
    || process.env.MIKKA_DATABASE_URL !== connection || process.env.DATABASE_URL !== connection)
    throw new Error('Recovery DB tests require matching isolated loopback *_e2e targets')
}
if (process.env.REQUIRE_DB === '1' && !connection) throw new Error('Recovery DB tests cannot skip when required')

test('independent run recovery: concurrency, STOP, renewed leases and attempt fencing', { skip: !connection, timeout: 120_000 }, async t => {
  const pool = new Pool({ connectionString: connection, max: 14 })
  const { reclaimLostRuns, sweepExpiredRunLeases, latestCheckpoint } = await import('../lib/run-leases')
  const { checkpointRecoveryError } = await import('../lib/run-retry')
  const { issueRunToken, verifyRunToken } = await import('../lib/mcp/worker')
  t.after(async () => {
    await pool.end()
    await (await import('../lib/db')).pool.end()
  })
  const now = new Date()
  // The other device takes part in dispatch (参与调度) unless a test says otherwise (decision 2026-11-02-1400).
  async function fixture(attempt = 1, definition: unknown = null, otherTakesPart = true) {
    const userId = `recovery-${randomUUID()}`, issueId = randomUUID(), agentId = randomUUID()
    const deviceId = randomUUID(), otherDeviceId = randomUUID(), repoId = randomUUID(), id = randomUUID()
    const remote = 'https://github.com/isolated/recovery-fixture.git'
    await pool.query('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,$1,$2,true,now(),now())', [userId, `${userId}@example.invalid`])
    await pool.query('INSERT INTO issues (id,"userId",title,content,status,priority) VALUES ($1,$2,\'Recovery fixture\',\'{}\',\'todo\',\'normal\')', [issueId, userId])
    await pool.query('INSERT INTO devices (id,"ownerId",name,kind,enabled,harnesses,"lastSeenAt","protocolVersion") VALUES ($1,$3,\'Old device\',\'local\',true,$4,$5,$6),($2,$3,\'New device\',\'local\',$8,$4,$7,$6)',
      [deviceId, otherDeviceId, userId, JSON.stringify([{ harness: 'codex', installed: true }]), new Date(now.getTime() - 600_000), DAEMON_PROTOCOL_VERSION, now, otherTakesPart])
    await pool.query('INSERT INTO agents (id,"userId","deviceId",harness,name) VALUES ($1,$2,$3,\'codex\',\'Recovery worker\')', [agentId, userId, deviceId])
    await pool.query('INSERT INTO device_repos (id,"deviceId","userId","repoPath","remoteUrl") VALUES ($1,$2,$3,$4,$5)', [repoId, deviceId, userId, remoteKey(remote), remote])
    await pool.query('INSERT INTO agent_runs (id,"userId","issueId","agentId","deviceId","deviceRepoId",status,prompt,attempt,"leaseExpiresAt","agentDefinition") VALUES ($1,$2,$3,$4,$5,$6,\'running\',\'Controlled recovery fixture\',$7,$8,$9)',
      [id, userId, issueId, agentId, deviceId, repoId, attempt, new Date(now.getTime() - 1000), definition])
    return { id, userId, deviceId, otherDeviceId, issueId, agentId, repoId }
  }
  async function checkpointRetry(previousId: string, stopReason = 'provider_failure') {
    const id = randomUUID()
    await pool.query(`INSERT INTO agent_runs (id,"userId","issueId","agentId","botId","deviceId","deviceRepoId",status,"stopReason","retryOf")
      SELECT $2,"userId","issueId","agentId","botId","deviceId","deviceRepoId",'failed',$3,id FROM agent_runs WHERE id=$1`, [previousId, id, stopReason])
    return id
  }
  async function saveCheckpoint(runId: string, content = 'checkpoint fixture') {
    await pool.query(`INSERT INTO run_checkpoints ("runId","userId","baseCommit",patch,files,"takenAt","updatedAt")
      SELECT id,"userId",$2,$3,1,now(),now() FROM agent_runs WHERE id=$1`, [runId, 'a'.repeat(40), gzipSync(Buffer.from(content))])
  }
  async function waitForLock(fragment: string) {
    const end = Date.now() + 5000
    while (Date.now() < end) {
      const blocked = await pool.query('SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type=\'Lock\' AND query ILIKE $1', [`%${fragment}%`])
      if (blocked.rowCount) return
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error('Expected real PostgreSQL barrier was not reached')
  }
  async function locked(work: (client: PoolClient) => Promise<void>) {
    const client = await pool.connect()
    await client.query('BEGIN')
    try { await work(client) }
    finally { await client.query('ROLLBACK'); client.release() }
  }

  await t.test('ten independent cron scans create one retry and fence the old attempt', async () => {
    const run = await fixture()
    const old = await issueRunToken({ id: run.id, userId: run.userId })
    await Promise.all(Array.from({ length: 10 }, () => sweepExpiredRunLeases(now)))
    const { rows } = await pool.query('SELECT id,status,attempt,"deviceId" FROM agent_runs WHERE "retryOf"=$1', [run.id])
    assert.equal(rows.length, 1)
    assert.equal(rows[0].attempt, 2)
    assert.equal(rows[0].deviceId, run.otherDeviceId)
    assert.equal((await pool.query('SELECT status FROM agent_runs WHERE id=$1', [run.id])).rows[0].status, 'failed')
    assert.equal(Boolean(await verifyRunToken(new Request('http://localhost/mikka/api/mcp'), old.token)), false)
    await pool.query('UPDATE agent_runs SET status=\'preparing\',"leaseExpiresAt"=$2 WHERE id=$1', [rows[0].id, new Date(Date.now() + 90_000)])
    const fresh = await issueRunToken({ id: rows[0].id, userId: run.userId })
    assert.equal(Boolean(await verifyRunToken(new Request('http://localhost/mikka/api/mcp'), fresh.token)), true)
  })

  await t.test('ending runs inside transactions that hold every app connection needs no second connection', async () => {
    // Each ending keeps its transaction open while it records the event; the event's
    // credential check must read through that transaction, or a full pool stalls every one.
    const { db, pool: appPool } = await import('../lib/db')
    const { recordCoordinatorEvent } = await import('../lib/coordinator-event-store')
    const { runFinishedEvent } = await import('../lib/coordinator-events')
    const { agentRuns } = await import('../lib/db/schema')
    const { eq } = await import('drizzle-orm')
    const size = appPool.options.max ?? 10
    const runs = await Promise.all(Array.from({ length: size }, () => fixture()))
    let holding = 0
    let release!: () => void
    const full = new Promise<void>(resolve => { release = resolve })
    const endings = Promise.all(runs.map(run => db.transaction(async tx => {
      await tx.update(agentRuns).set({ status: 'failed' }).where(eq(agentRuns.id, run.id))
      if (++holding === size) release()
      await full
      await recordCoordinatorEvent(tx, runFinishedEvent({ id: run.id, userId: run.userId, issueId: null, kind: 'run', status: 'failed', stopReason: 'device_lost' }))
    })))
    let timer: NodeJS.Timeout | undefined
    const stalled = new Promise<'stalled'>(resolve => { timer = setTimeout(() => resolve('stalled'), 5000) })
    try { assert.notEqual(await Promise.race([endings, stalled]), 'stalled', 'an ending waited for a second connection from a full pool') }
    finally { clearTimeout(timer); await endings.catch(() => undefined) }
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM coordinator_events WHERE kind=\'run_finished\' AND "runId"=ANY($1)', [runs.map(run => run.id)])
    assert.equal(rows[0].n, size)
  })

  await t.test('STOP arriving during target lookup cannot create a new retry', async () => {
    const run = await fixture()
    await locked(async blocker => {
      await blocker.query('LOCK TABLE device_repos IN ACCESS EXCLUSIVE MODE')
      const scan = reclaimLostRuns(run.userId, now)
      try {
        await waitForLock('device_repos')
        await pool.query('UPDATE agent_runs SET "stopRequestedAt"=now() WHERE id=$1', [run.id])
      } finally { await blocker.query('COMMIT') }
      await scan
    })
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_runs WHERE "retryOf"=$1', [run.id])).rows[0].n, 0)
    await reclaimLostRuns(run.userId, now)
    assert.equal((await pool.query('SELECT status FROM agent_runs WHERE id=$1', [run.id])).rows[0].status, 'stopped')
  })

  await t.test('a lease renewed after the scanner snapshot is not ended at the retry cap', async () => {
    const run = await fixture(3)
    await locked(async blocker => {
      await blocker.query('SELECT id FROM agent_runs WHERE id=$1 FOR UPDATE', [run.id])
      const scan = reclaimLostRuns(run.userId, now)
      try {
        await waitForLock('update "agent_runs"')
        await blocker.query('UPDATE agent_runs SET "leaseExpiresAt"=$2 WHERE id=$1', [run.id, new Date(now.getTime() + 90_000)])
      } finally { await blocker.query('COMMIT') }
      await scan
    })
    assert.equal((await pool.query('SELECT status FROM agent_runs WHERE id=$1', [run.id])).rows[0].status, 'running')
  })

  await t.test('a retry queued on an offline device ends at once with the card when no other machine may take it', async () => {
    const run = await fixture(1, null, false)
    await pool.query('UPDATE agent_runs SET status=\'failed\' WHERE id=$1', [run.id])
    const retryId = randomUUID()
    await pool.query('INSERT INTO agent_runs (id,"userId","issueId","agentId","deviceId","deviceRepoId",status,prompt,attempt,"retryOf","createdAt","agentDefinition") SELECT $2,"userId","issueId","agentId","deviceId","deviceRepoId",\'queued\',prompt,2,id,$3,$4 FROM agent_runs WHERE id=$1',
      [run.id, retryId, now, JSON.stringify({ pinnedDeviceId: run.deviceId })])
    await reclaimLostRuns(run.userId, now)
    assert.equal((await pool.query('SELECT status FROM agent_runs WHERE id=$1', [retryId])).rows[0].status, 'failed', 'nothing waits on an offline device')
    const event = (await pool.query('SELECT payload FROM coordinator_events WHERE "runId"=$1 AND kind=\'run_finished\'', [retryId])).rows[0]
    // 没有可用的电脑 is the same two rows whatever devices there are (Alex): 连接电脑 and 填入 E2B Key.
    assert.deepEqual(event.payload.noMachine.options.map((option: { action: string }) => option.action), ['connectServer', 'e2bKey'])
  })

  await t.test('a lost run with no cloud and no other computer that takes part ends with the card instead of a retry', async () => {
    const run = await fixture(1, null, false)
    await reclaimLostRuns(run.userId, now)
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_runs WHERE "retryOf"=$1', [run.id])).rows[0].n, 0)
    assert.equal((await pool.query('SELECT status FROM agent_runs WHERE id=$1', [run.id])).rows[0].status, 'failed')
    const event = (await pool.query('SELECT payload FROM coordinator_events WHERE "runId"=$1 AND kind=\'run_finished\'', [run.id])).rows[0]
    assert.ok(event.payload.noMachine, 'the bot gets the card of what the person can do')
  })

  await t.test('a run handed to another device records where it went', async () => {
    const run = await fixture()
    await reclaimLostRuns(run.userId, now)
    const event = (await pool.query('SELECT payload FROM coordinator_events WHERE "runId"=$1 AND kind=\'run_retried\'', [run.id])).rows[0]
    assert.deepEqual(event.payload.movedTo, { kind: 'device', deviceId: run.otherDeviceId })
  })

  await t.test('STOP wins over a retry-cap ending and over an offline queued takeover', async () => {
    const run = await fixture(3)
    await locked(async blocker => {
      await blocker.query('SELECT id FROM agent_runs WHERE id=$1 FOR UPDATE', [run.id])
      const scan = reclaimLostRuns(run.userId, now)
      try {
        await waitForLock('update "agent_runs"')
        await blocker.query('UPDATE agent_runs SET "stopRequestedAt"=now() WHERE id=$1', [run.id])
      } finally { await blocker.query('COMMIT') }
      await scan
    })
    await reclaimLostRuns(run.userId, now)
    assert.equal((await pool.query('SELECT status FROM agent_runs WHERE id=$1', [run.id])).rows[0].status, 'stopped')
    const retryId = randomUUID()
    await pool.query('INSERT INTO agent_runs (id,"userId","issueId","agentId","deviceId","deviceRepoId",status,"retryOf","stopRequestedAt") SELECT $2,"userId","issueId","agentId","deviceId","deviceRepoId",\'queued\',id,now() FROM agent_runs WHERE id=$1', [run.id, retryId])
    await reclaimLostRuns(run.userId, now)
    const row = (await pool.query('SELECT status,"deviceId" FROM agent_runs WHERE id=$1', [retryId])).rows[0]
    assert.equal(row.status, 'stopped')
    assert.equal(row.deviceId, run.deviceId)
  })

  await t.test('the closest attempt snapshot supersedes ancestor clock skew and keeps unavailable/clean states', async () => {
    const run = await fixture()
    await pool.query('UPDATE agent_runs SET status=\'failed\' WHERE id=$1', [run.id])
    const retryId = randomUUID()
    await pool.query('INSERT INTO agent_runs (id,"userId","issueId","agentId","botId","deviceId","deviceRepoId",status,"retryOf") SELECT $2,"userId","issueId","agentId","botId","deviceId","deviceRepoId",\'failed\',id FROM agent_runs WHERE id=$1', [run.id, retryId])
    const empty = gzipSync(Buffer.alloc(0))
    await pool.query('INSERT INTO run_checkpoints ("runId","userId","baseCommit",patch,files,"takenAt","updatedAt","unavailableReason") VALUES ($1,$3,$4,$5,1,\'2099-01-01\',now(),NULL),($2,$3,$4,$6,1,now(),now(),\'too_large\')',
      [run.id, retryId, run.userId, 'a'.repeat(40), gzipSync(Buffer.from('ancestor fixture')), empty])
    const unavailable = await latestCheckpoint(retryId)
    assert.equal(unavailable?.unavailableReason, 'too_large')
    assert.match(checkpointRecoveryError(unavailable) ?? '', /size limit/)
    await pool.query('UPDATE run_checkpoints SET "unavailableReason"=NULL,files=0 WHERE "runId"=$1', [retryId])
    const clean = await latestCheckpoint(retryId)
    assert.equal(clean?.unavailableReason, undefined)
    assert.equal(clean?.files, 0)
    assert.equal(gunzipSync(Buffer.from(clean!.patch, 'base64')).length, 0)
    await pool.query('UPDATE run_checkpoints SET "updatedAt"=$2 WHERE "runId"=$1', [retryId, new Date(Date.now() - 31 * 60_000)])
    assert.match(checkpointRecoveryError(await latestCheckpoint(retryId)) ?? '', /thirty-minute/)
  })

  await t.test('provider continuations can find a snapshot beyond three attempts without extending infrastructure retries', async () => {
    const provider = await fixture(), infrastructure = await fixture()
    await pool.query('UPDATE agent_runs SET status=\'failed\',"stopReason"=\'provider_failure\' WHERE id=$1', [provider.id])
    await saveCheckpoint(provider.id, 'provider ancestor')
    await saveCheckpoint(infrastructure.id, 'infrastructure ancestor')
    let providerHead = provider.id, infrastructureHead = infrastructure.id
    for (let index = 0; index < 5; index++) providerHead = await checkpointRetry(providerHead)
    for (let index = 0; index < 3; index++) infrastructureHead = await checkpointRetry(infrastructureHead, 'device_lost')
    const recovered = await latestCheckpoint(providerHead)
    assert.ok(recovered)
    assert.equal(gunzipSync(Buffer.from(recovered.patch, 'base64')).toString(), 'provider ancestor')
    assert.equal(await latestCheckpoint(infrastructureHead), null, 'a fourth infrastructure attempt remains outside the recovery cap')
  })

  await t.test('provider traversal is bounded independently and terminates cyclic history', async () => {
    const run = await fixture()
    await pool.query('UPDATE agent_runs SET status=\'failed\',"stopReason"=\'provider_failure\' WHERE id=$1', [run.id])
    await saveCheckpoint(run.id)
    const ids = Array.from({ length: 128 }, () => randomUUID())
    await pool.query(`INSERT INTO agent_runs (id,"userId","issueId","agentId","botId","deviceId","deviceRepoId",status,"stopReason","retryOf")
      SELECT seq.id,r."userId",r."issueId",r."agentId",r."botId",r."deviceId",r."deviceRepoId",'failed','provider_failure',
        CASE WHEN seq.position=1 THEN r.id ELSE ($2::uuid[])[seq.position::int-1] END
      FROM agent_runs r CROSS JOIN unnest($2::uuid[]) WITH ORDINALITY AS seq(id,position) WHERE r.id=$1`, [run.id, ids])
    assert.equal(await latestCheckpoint(ids.at(-1)!), null, 'a 129th provider node cannot extend the bounded walk')
    const cycle = await fixture(), next = await checkpointRetry(cycle.id)
    await pool.query('UPDATE agent_runs SET "retryOf"=$2,"stopReason"=\'provider_failure\' WHERE id=$1', [cycle.id, next])
    assert.equal(await latestCheckpoint(next), null)
  })

  await t.test('an unavailable final provider upload bars stale snapshots through a later machine retry', async () => {
    const run = await fixture()
    await pool.query('UPDATE agent_runs SET status=\'failed\',"stopReason"=\'provider_failure\',report=$2 WHERE id=$1',
      [run.id, { providerCheckpoint: 'unavailable' }])
    await saveCheckpoint(run.id, 'stale before the final provider error')
    const retryId = await checkpointRetry(run.id, 'device_lost')
    assert.equal(await latestCheckpoint(run.id), null)
    assert.equal(await latestCheckpoint(retryId), null)
    await saveCheckpoint(retryId, 'confirmed newer worktree')
    assert.equal(gunzipSync(Buffer.from((await latestCheckpoint(retryId))!.patch, 'base64')).toString(), 'confirmed newer worktree')
  })

  await t.test('checkpoint ancestry cannot cross owner, task or repository boundaries', async () => {
    const run = await fixture(), foreign = await fixture()
    await saveCheckpoint(run.id)
    await saveCheckpoint(foreign.id)
    const retryId = await checkpointRetry(run.id)
    await pool.query('UPDATE agent_runs SET "retryOf"=$2 WHERE id=$1', [retryId, foreign.id])
    assert.equal(await latestCheckpoint(retryId), null, 'a foreign owner cannot supply the patch')
    const otherIssueId = randomUUID()
    await pool.query('INSERT INTO issues (id,"userId",title,content,status,priority) VALUES ($1,$2,\'Other recovery task\',\'{}\',\'todo\',\'normal\')', [otherIssueId, run.userId])
    await pool.query('UPDATE agent_runs SET "retryOf"=$2,"issueId"=$3 WHERE id=$1', [retryId, run.id, otherIssueId])
    assert.equal(await latestCheckpoint(retryId), null, 'a different task cannot supply the patch')
    const otherRepoId = randomUUID(), otherRemote = 'https://github.com/isolated/other-recovery-repo.git'
    await pool.query('INSERT INTO device_repos (id,"deviceId","userId","repoPath","remoteUrl") VALUES ($1,$2,$3,$4,$5)',
      [otherRepoId, run.deviceId, run.userId, remoteKey(otherRemote), otherRemote])
    await pool.query('UPDATE agent_runs SET "issueId"=$2,"deviceRepoId"=$3 WHERE id=$1', [retryId, run.issueId, otherRepoId])
    assert.equal(await latestCheckpoint(retryId), null, 'a different repository cannot supply the patch')
  })

  await t.test('the same confirmed repository on another device retains its checkpoint ancestry', async () => {
    const run = await fixture(), repoId = randomUUID()
    const remote = 'git@github.com:isolated/recovery-fixture.git'
    await saveCheckpoint(run.id, 'same repository work')
    await pool.query('INSERT INTO device_repos (id,"deviceId","userId","repoPath","remoteUrl") VALUES ($1,$2,$3,$4,$5)',
      [repoId, run.otherDeviceId, run.userId, remoteKey(remote), remote])
    const retryId = await checkpointRetry(run.id)
    await pool.query('UPDATE agent_runs SET "deviceId"=$2,"deviceRepoId"=$3 WHERE id=$1', [retryId, run.otherDeviceId, repoId])
    const recovered = await latestCheckpoint(retryId)
    assert.equal(gunzipSync(Buffer.from(recovered!.patch, 'base64')).toString(), 'same repository work')
  })

  await t.test('post-commit cleanup failure cannot lose the terminal event needed after a worker restart', async () => {
    const run = await fixture(3)
    const token = await issueRunToken({ id: run.id, userId: run.userId })
    const name = `recovery_cleanup_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    await pool.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'synthetic postcommit cleanup'; END$$`)
    await pool.query(`CREATE TRIGGER ${name} BEFORE UPDATE OF "revokedAt" ON run_tokens FOR EACH ROW WHEN (OLD."runId"='${run.id}'::uuid) EXECUTE FUNCTION ${name}()`)
    try {
      await assert.rejects(reclaimLostRuns(run.userId, now), error => {
        const outer = error as { code?: string; cause?: { code?: string } }
        assert.equal(outer.cause?.code ?? outer.code, 'P0001')
        return true
      })
      assert.equal((await pool.query('SELECT status FROM agent_runs WHERE id=$1', [run.id])).rows[0].status, 'failed')
      assert.equal(Boolean(await verifyRunToken(new Request('http://localhost/mikka/api/mcp'), token.token)), false)
      const events = await pool.query('SELECT "deliveredAt" FROM coordinator_events WHERE "runId"=$1 AND kind=\'run_finished\'', [run.id])
      assert.equal(events.rowCount, 1)
      assert.equal(events.rows[0].deliveredAt, null)
    } finally {
      await pool.query(`DROP TRIGGER ${name} ON run_tokens`)
      await pool.query(`DROP FUNCTION ${name}()`)
    }
    await reclaimLostRuns(run.userId, now)
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM coordinator_events WHERE "runId"=$1 AND kind=\'run_finished\'', [run.id])).rows[0].n, 1)
  })
})
