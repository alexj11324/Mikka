import { seedFixtureWorkspace } from './helpers/task-workspace'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { gzipSync, gunzipSync } from 'node:zlib'
import test from 'node:test'
import { Pool, type PoolClient } from 'pg'
import { DAEMON_PROTOCOL_VERSION } from '@mikka/protocol/daemon'
import { remoteKey } from '@mikka/protocol/repository'
import { runPromptParts } from '../lib/run-prompt'
import { threadPromptView } from '../lib/thread-prompt'

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
  const { reclaimLostRuns, sweepExpiredRunLeases, latestCheckpoint, failQueuedSubscriptionRuntime } = await import('../lib/run-leases')
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
    const workspaceId = await seedFixtureWorkspace(pool, userId)
    await pool.query('INSERT INTO issues (id,"userId","workspaceId",title,content,status,priority) VALUES ($1,$2,$3,\'Recovery fixture\',\'{}\',\'todo\',\'normal\')', [issueId, userId, workspaceId])
    await pool.query('INSERT INTO devices (id,"ownerId",name,kind,enabled,harnesses,"lastSeenAt","protocolVersion") VALUES ($1,$3,\'Old device\',\'local\',true,$4,$5,$6),($2,$3,\'New device\',\'local\',$8,$4,$7,$6)',
      [deviceId, otherDeviceId, userId, JSON.stringify([{ harness: 'codex', installed: true }]), new Date(now.getTime() - 600_000), DAEMON_PROTOCOL_VERSION, now, otherTakesPart])
    await pool.query('INSERT INTO agents (id,"userId","deviceId",harness,name) VALUES ($1,$2,$3,\'codex\',\'Recovery worker\')', [agentId, userId, deviceId])
    await pool.query('INSERT INTO device_repos (id,"deviceId","userId","repoPath","remoteUrl") VALUES ($1,$2,$3,$4,$5)', [repoId, deviceId, userId, remoteKey(remote), remote])
    await pool.query('INSERT INTO agent_runs (id,"userId","issueId","agentId","deviceId","deviceRepoId",status,prompt,attempt,"leaseExpiresAt","agentDefinition") VALUES ($1,$2,$3,$4,$5,$6,\'running\',\'Controlled recovery fixture\',$7,$8,$9)',
      [id, userId, issueId, agentId, deviceId, repoId, attempt, new Date(now.getTime() - 1000), definition])
    return { id, userId, workspaceId, deviceId, otherDeviceId, issueId, agentId, repoId }
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

  await t.test('a queued subscription that loses its runtime ends once with a readable report and a durable event', async () => {
    const expected = { harness: 'codex' as const, bindingId: randomUUID() }
    const run = await fixture(1, { harness: 'codex', subscription: { ...expected, modelId: 'fixture-model', route: 'codex_cli' } })
    const token = await issueRunToken({ id: run.id, userId: run.userId })
    await pool.query(`UPDATE agent_runs SET status='queued',"startedAt"=NULL,"leaseExpiresAt"=NULL WHERE id=$1`, [run.id])
    // A contradictory old broker flag must not override a failed self-test.
    await pool.query('UPDATE devices SET harnesses=$2 WHERE id=$1', [run.deviceId, JSON.stringify([{ harness: 'codex', installed: true, toolApproval: true, subscriptionBroker: true, subscriptionPreflight: 'env_not_clean' }])])
    const attempts = await Promise.all(Array.from({ length: 6 }, () => failQueuedSubscriptionRuntime(run.id, run.deviceId, run.userId, expected, now)))
    assert.equal(attempts.filter(Boolean).length, 1)
    const { rows: [ended] } = await pool.query('SELECT status,"stopReason",error,report,"startedAt","leaseExpiresAt" FROM agent_runs WHERE id=$1', [run.id])
    assert.equal(ended.status, 'failed')
    assert.equal(ended.stopReason, 'error')
    assert.equal(ended.error, 'subscription_local_runtime_unavailable (env_not_clean)')
    assert.equal(ended.startedAt, null)
    assert.equal(ended.leaseExpiresAt, null)
    assert.match(ended.report.summary, /更新 Mikka/)
    assert.doesNotMatch(ended.report.summary, /subscription_local_runtime_unavailable|env_not_clean/)
    const { rows: events } = await pool.query(`SELECT payload FROM coordinator_events WHERE "runId"=$1 AND kind='run_finished'`, [run.id])
    assert.equal(events.length, 1)
    assert.equal(events[0].payload.summary, ended.report.summary)
    assert.equal(events[0].payload.verification, 'not_run')
    assert.equal(Boolean(await verifyRunToken(new Request('http://localhost/mikka/api/mcp'), token.token)), false)
    assert.ok((await pool.query('SELECT "revokedAt" FROM run_tokens WHERE "runId"=$1', [run.id])).rows.every(row => row.revokedAt))
  })

  await t.test('runtime refusal cannot end another owner/device, claimed work, STOP, a live lease or a different assignment', async () => {
    for (const condition of ['owner', 'device', 'started', 'session', 'lease', 'stop', 'claimed', 'binding', 'api-key'] as const) {
      const expected = { harness: 'codex' as const, bindingId: randomUUID() }
      const run = await fixture(1, { harness: 'codex', subscription: { bindingId: expected.bindingId, modelId: 'fixture-model', route: 'codex_cli' } })
      await pool.query(`UPDATE agent_runs SET status='queued',"leaseExpiresAt"=NULL WHERE id=$1`, [run.id])
      if (condition === 'started') await pool.query('UPDATE agent_runs SET "startedAt"=now() WHERE id=$1', [run.id])
      if (condition === 'session') await pool.query('UPDATE agent_runs SET "sessionId"=$2 WHERE id=$1', [run.id, 'existing-native-session'])
      if (condition === 'lease') await pool.query('UPDATE agent_runs SET "leaseExpiresAt"=$2 WHERE id=$1', [run.id, new Date(now.getTime() + 60_000)])
      if (condition === 'stop') await pool.query('UPDATE agent_runs SET "stopRequestedAt"=now() WHERE id=$1', [run.id])
      if (condition === 'claimed') await pool.query(`UPDATE agent_runs SET status='preparing' WHERE id=$1`, [run.id])
      if (condition === 'api-key') await pool.query('UPDATE agent_runs SET "agentDefinition"=$2 WHERE id=$1', [run.id, JSON.stringify({ harness: 'codex', apiKey: { keyId: randomUUID() } })])
      const changed = await failQueuedSubscriptionRuntime(run.id, condition === 'device' ? run.otherDeviceId : run.deviceId,
        condition === 'owner' ? 'another-owner' : run.userId, condition === 'binding' ? { ...expected, bindingId: randomUUID() } : expected, now)
      assert.equal(changed, false, condition)
      assert.equal((await pool.query('SELECT status FROM agent_runs WHERE id=$1', [run.id])).rows[0].status, condition === 'claimed' ? 'preparing' : 'queued', condition)
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM coordinator_events WHERE "runId"=$1 AND kind='run_finished'`, [run.id])).rows[0].n, 0, condition)
    }
  })

  await t.test('a fresh device self-test or a concurrent claim wins over an older refusal snapshot', async () => {
    for (const recovery of ['device', 'claim', 'stop'] as const) {
      const expected = { harness: 'codex' as const, bindingId: randomUUID() }
      const run = await fixture(1, { harness: 'codex', subscription: { bindingId: expected.bindingId, modelId: 'fixture-model', route: 'codex_cli' } })
      await pool.query(`UPDATE agent_runs SET status='queued',"leaseExpiresAt"=NULL WHERE id=$1`, [run.id])
      await locked(async blocker => {
        if (recovery === 'device') await blocker.query('UPDATE devices SET harnesses=$2 WHERE id=$1', [run.deviceId, JSON.stringify([{ harness: 'codex', installed: true, toolApproval: true, subscriptionBroker: true }])])
        else if (recovery === 'claim') await blocker.query(`UPDATE agent_runs SET status='preparing',"startedAt"=now(),"leaseExpiresAt"=now()+interval '1 minute' WHERE id=$1`, [run.id])
        else await blocker.query('UPDATE agent_runs SET "stopRequestedAt"=now() WHERE id=$1', [run.id])
        const refused = failQueuedSubscriptionRuntime(run.id, run.deviceId, run.userId, expected, now)
        try { await waitForLock(recovery === 'device' ? 'devices' : 'agent_runs') }
        finally { await blocker.query('COMMIT') }
        assert.equal(await refused, false, recovery)
      })
      assert.equal((await pool.query('SELECT status FROM agent_runs WHERE id=$1', [run.id])).rows[0].status, recovery === 'claim' ? 'preparing' : 'queued')
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM coordinator_events WHERE "runId"=$1 AND kind='run_finished'`, [run.id])).rows[0].n, 0)
    }
  })

  await t.test('subscription takeover ignores a failed target harness without excluding a different healthy provider', async () => {
    for (const failedHarness of ['codex', 'claude_code']) {
      const run = await fixture(1, { harness: 'codex', subscription: { bindingId: randomUUID(), modelId: 'fixture-model', route: 'codex_cli' } })
      await pool.query('UPDATE devices SET harnesses=$2 WHERE id=$1', [run.otherDeviceId, JSON.stringify([
        { harness: 'codex', installed: true, subscriptionBroker: true, ...(failedHarness === 'codex' ? { subscriptionPreflight: 'env_not_clean' } : {}) },
        { harness: 'claude_code', installed: true, subscriptionBroker: true, ...(failedHarness === 'claude_code' ? { subscriptionPreflight: 'env_not_clean' } : {}) },
      ])])
      await reclaimLostRuns(run.userId, now)
      const { rows } = await pool.query('SELECT "deviceId" FROM agent_runs WHERE "retryOf"=$1', [run.id])
      assert.deepEqual(rows, failedHarness === 'codex' ? [] : [{ deviceId: run.otherDeviceId }], failedHarness)
    }
  })

  await t.test('ten independent cron scans create one retry and fence the old attempt', async () => {
    const run = await fixture()
    const { prompt, taskLength } = runPromptParts('Recovery 🧪', 'Keep the task body.', 'SYNTHETIC_INTERNAL_STANDING_INSTRUCTION')
    const prefix = 'Factory host guidance 🔍\n\n'
    await pool.query('UPDATE agent_runs SET prompt=$2,"promptTaskStart"=$3,"promptTaskLength"=$4 WHERE id=$1',
      [run.id, prefix + prompt, Array.from(prefix).length, taskLength])
    const old = await issueRunToken({ id: run.id, userId: run.userId })
    await Promise.all(Array.from({ length: 10 }, () => sweepExpiredRunLeases(now)))
    const { rows } = await pool.query('SELECT id,status,attempt,"deviceId",prompt,"promptTaskStart","promptTaskLength" FROM agent_runs WHERE "retryOf"=$1', [run.id])
    assert.equal(rows.length, 1)
    assert.equal(rows[0].attempt, 2)
    assert.equal(rows[0].deviceId, run.otherDeviceId)
    assert.equal(threadPromptView(rows[0].prompt, rows[0].promptTaskStart, rows[0].promptTaskLength).task, '# Recovery 🧪\n\nKeep the task body.')
    assert.ok(rows[0].prompt.includes('SYNTHETIC_INTERNAL_STANDING_INSTRUCTION'))
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

  await t.test('checkpoint ancestry rejects foreign owner/tenant writes and cannot cross task or repository boundaries', async () => {
    const run = await fixture(), foreign = await fixture()
    await saveCheckpoint(run.id, 'authorized same-task checkpoint')
    await saveCheckpoint(foreign.id, 'foreign owner checkpoint')
    const retryId = await checkpointRetry(run.id)
    const otherWorkspaceId = await seedFixtureWorkspace(pool, run.userId, 'team')
    const foreignTaskId = randomUUID(), foreignRunId = randomUUID()
    await pool.query('INSERT INTO issues (id,"userId","workspaceId",title,content,status,priority) VALUES ($1,$2,$3,\'Other tenant recovery task\',\'{}\',\'todo\',\'normal\')', [foreignTaskId, run.userId, otherWorkspaceId])
    await pool.query(`INSERT INTO agent_runs (id,"userId","issueId","agentId","deviceId","deviceRepoId",status)
      SELECT $2,"userId",$3,"agentId","deviceId","deviceRepoId",'failed' FROM agent_runs WHERE id=$1`, [run.id, foreignRunId, foreignTaskId])
    await saveCheckpoint(foreignRunId, 'same owner other tenant checkpoint')
    const lineage = async () => (await pool.query('SELECT "userId","workspaceId","issueId","retryOf","deviceRepoId",status FROM agent_runs WHERE id=$1', [retryId])).rows[0]
    const beforeLineage = await lineage()
    const checkpoint = await latestCheckpoint(retryId)
    assert.ok(checkpoint)
    assert.equal(gunzipSync(Buffer.from(checkpoint.patch, 'base64')).toString(), 'authorized same-task checkpoint')
    for (const [label, parentId] of [['foreign owner', foreign.id], ['same owner, other tenant', foreignRunId]]) {
      await assert.rejects(pool.query('UPDATE agent_runs SET "retryOf"=$2 WHERE id=$1', [retryId, parentId]), { code: '23514' }, label)
      assert.deepEqual(await lineage(), beforeLineage, `${label}: no persisted lineage or execution changes`)
      assert.deepEqual(await latestCheckpoint(retryId), checkpoint, `${label}: the rejected parent cannot replace the authorized checkpoint`)
    }
    const otherIssueId = randomUUID()
    await pool.query('INSERT INTO issues (id,"userId","workspaceId",title,content,status,priority) VALUES ($1,$2,$3,\'Other recovery task\',\'{}\',\'todo\',\'normal\')', [otherIssueId, run.userId, run.workspaceId])
    // A same-tenant relation can still be unsuitable for checkpoint recovery.
    // Keep the independent task and repository read fences below.
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

  await t.test('task-free unresolved runs cannot receive or recover checkpoints despite matching owner and repository', async () => {
    const run = await fixture(), unresolvedId = randomUUID(), boundId = randomUUID()
    // A historical task-free row may have no provable tenant. This is a legal
    // row with no lineage edge; never disable the tenant trigger to create it.
    await pool.query(`INSERT INTO agent_runs (id,"userId","agentId","deviceId","deviceRepoId",status)
      SELECT $2,"userId","agentId","deviceId","deviceRepoId",'failed' FROM agent_runs WHERE id=$1`, [run.id, unresolvedId])
    await assert.rejects(saveCheckpoint(unresolvedId, 'unresolved legacy checkpoint'), { code: '23514' })
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM run_checkpoints WHERE "runId"=$1', [unresolvedId])).rows[0].count, 0,
      'the child-row tenant guard rejects the write without storing checkpoint bytes')
    assert.deepEqual((await pool.query('SELECT "issueId","botId","workspaceId" FROM agent_runs WHERE id=$1', [unresolvedId])).rows[0],
      { issueId: null, botId: null, workspaceId: null })
    assert.equal(await latestCheckpoint(unresolvedId), null, 'owner and repository do not infer a legacy tenant')
    await pool.query(`INSERT INTO agent_runs (id,"userId","workspaceId","agentId","deviceId","deviceRepoId",status)
      SELECT $2,"userId","workspaceId","agentId","deviceId","deviceRepoId",'failed' FROM agent_runs WHERE id=$1`, [run.id, boundId])
    await saveCheckpoint(boundId, 'bound task-free checkpoint')
    const recovered = await latestCheckpoint(boundId)
    assert.ok(recovered, 'a legitimately bound task-free run retains its own recovery snapshot')
    assert.equal(gunzipSync(Buffer.from(recovered.patch, 'base64')).toString(), 'bound task-free checkpoint')
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
