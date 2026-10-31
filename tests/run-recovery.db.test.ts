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
  async function fixture(attempt = 1, definition: unknown = null) {
    const userId = `recovery-${randomUUID()}`, issueId = randomUUID(), agentId = randomUUID()
    const deviceId = randomUUID(), otherDeviceId = randomUUID(), repoId = randomUUID(), id = randomUUID()
    const remote = 'https://github.com/isolated/recovery-fixture.git'
    await pool.query('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,$1,$2,true,now(),now())', [userId, `${userId}@example.invalid`])
    await pool.query('INSERT INTO issues (id,"userId",title,content,status,priority) VALUES ($1,$2,\'Recovery fixture\',\'{}\',\'todo\',\'normal\')', [issueId, userId])
    await pool.query('INSERT INTO devices (id,"ownerId",name,kind,enabled,harnesses,"lastSeenAt","protocolVersion") VALUES ($1,$3,\'Old device\',\'local\',true,$4,$5,$6),($2,$3,\'New device\',\'local\',true,$4,$7,$6)',
      [deviceId, otherDeviceId, userId, JSON.stringify([{ harness: 'codex', installed: true }]), new Date(now.getTime() - 600_000), DAEMON_PROTOCOL_VERSION, now])
    await pool.query('INSERT INTO agents (id,"userId","deviceId",harness,name) VALUES ($1,$2,$3,\'codex\',\'Recovery worker\')', [agentId, userId, deviceId])
    await pool.query('INSERT INTO device_repos (id,"deviceId","userId","repoPath","remoteUrl") VALUES ($1,$2,$3,$4,$5)', [repoId, deviceId, userId, remoteKey(remote), remote])
    await pool.query('INSERT INTO agent_runs (id,"userId","issueId","agentId","deviceId","deviceRepoId",status,prompt,attempt,"leaseExpiresAt","agentDefinition") VALUES ($1,$2,$3,$4,$5,$6,\'running\',\'Controlled recovery fixture\',$7,$8,$9)',
      [id, userId, issueId, agentId, deviceId, repoId, attempt, new Date(now.getTime() - 1000), definition])
    return { id, userId, deviceId, otherDeviceId }
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

  await t.test('a pinned retry still ends after the existing thirty-minute queue bound', async () => {
    const run = await fixture()
    await pool.query('UPDATE agent_runs SET status=\'failed\' WHERE id=$1', [run.id])
    const retryId = randomUUID()
    await pool.query('INSERT INTO agent_runs (id,"userId","issueId","agentId","deviceId","deviceRepoId",status,prompt,attempt,"retryOf","createdAt","agentDefinition") SELECT $2,"userId","issueId","agentId","deviceId","deviceRepoId",\'queued\',prompt,2,id,$3,$4 FROM agent_runs WHERE id=$1',
      [run.id, retryId, new Date(now.getTime() - 31 * 60_000), JSON.stringify({ pinnedDeviceId: run.deviceId })])
    await reclaimLostRuns(run.userId, now)
    assert.equal((await pool.query('SELECT status,error FROM agent_runs WHERE id=$1', [retryId])).rows[0].status, 'failed')
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
    await pool.query('INSERT INTO agent_runs (id,"userId","agentId",status,"retryOf") SELECT $2,"userId","agentId",\'failed\',id FROM agent_runs WHERE id=$1', [run.id, retryId])
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
