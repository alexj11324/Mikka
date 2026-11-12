import { seedFixtureWorkspace } from './helpers/task-workspace'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import test from 'node:test'
import { Pool } from 'pg'
import { observePoolCommits } from '../lib/db/commit-effects'
import { runCheckpointReceiptSchema, type RunCheckpoint, type RunCheckpointReceipt } from '@mikka/protocol/device'
import { emptyRunReport } from '@mikka/protocol/run'
import { observePoolCommits } from '../lib/db/commit-effects'

const connection = process.env.E2E_DATABASE_URL
if (connection) {
  const target = new URL(connection)
  if (target.hostname !== '127.0.0.1' || !/^\/[a-z0-9_]+_e2e$/.test(target.pathname)
    || process.env.MIKKA_DATABASE_URL !== connection || process.env.DATABASE_URL !== connection)
    throw new Error('Checkpoint DB tests require matching isolated loopback *_e2e targets')
}
if (process.env.REQUIRE_DB === '1' && !connection) throw new Error('Checkpoint DB tests cannot skip when required')

test('checkpoint recovery availability persists through the actual authenticated route', { skip: !connection, timeout: 60_000 }, async t => {
  const pool = new Pool({ connectionString: connection, max: 4 })
  observePoolCommits(pool)
  const { POST } = await import('../app/v1/runs/[runId]/checkpoint/route')
  const { issueDeviceToken } = await import('../lib/device-link')
  const userId = `checkpoint-${randomUUID()}`, runId = randomUUID(), deviceId = randomUUID(), agentId = randomUUID()
  await pool.query('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,$1,$2,true,now(),now())', [userId, `${userId}@example.invalid`])
  const workspaceId = await seedFixtureWorkspace(pool, userId)
  await pool.query('INSERT INTO devices (id,"ownerId",name) VALUES ($1,$2,\'Checkpoint fixture\')', [deviceId, userId])
  await pool.query('INSERT INTO agents (id,"userId","deviceId",harness,name) VALUES ($1,$2,$3,\'codex\',\'Checkpoint worker\')', [agentId, userId, deviceId])
  await pool.query('INSERT INTO agent_runs (id,"userId","agentId","deviceId","workspaceId",status,"leaseExpiresAt") VALUES ($1,$2,$3,$4,$6,\'running\',$5)', [runId, userId, agentId, deviceId, new Date(Date.now() + 300_000), workspaceId])
  const token = await issueDeviceToken(userId)
  t.after(async () => {
    await (await import('../lib/builtin-gateway/runtime')).builtinGateway()?.stop()
    await pool.end()
    await (await import('../lib/db')).pool.end()
  })
  const checkpoint = { baseCommit: 'a'.repeat(40), patch: gzipSync(Buffer.from('initial patch fixture\n')).toString('base64'), files: 1, takenAt: '2099-01-01T00:00:00Z' }
  const uploadFor = (id: string, value: RunCheckpoint = checkpoint) => POST(new Request(`http://localhost/mikka/v1/runs/${id}/checkpoint`, {
    method: 'POST', headers: { 'x-mikka-client-version': '0.0.456', authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(value),
  }), { params: Promise.resolve({ runId: id }) })
  const upload = (value: RunCheckpoint = checkpoint) => uploadFor(runId, value)
  const acknowledge = async (id: string, value: RunCheckpoint = checkpoint) => {
    const response = await uploadFor(id, value)
    assert.equal(response.status, 200)
    return runCheckpointReceiptSchema.parse(await response.json())
  }
  const stored = async (id = runId) => (await pool.query('SELECT patch,files,"takenAt","unavailableReason" FROM run_checkpoints WHERE "runId"=$1', [id])).rows[0]

  await t.test('the server upload clock is authoritative despite device clock skew', async () => {
    const before = Date.now()
    const receipt = await acknowledge(runId)
    const row = await stored()
    assert.ok(row.takenAt.getTime() >= before && row.takenAt.getTime() <= Date.now())
    assert.deepEqual(receipt, { runId, takenAt: row.takenAt.toISOString() })
    assert.notEqual(receipt.takenAt, checkpoint.takenAt)
    assert.equal(row.unavailableReason, null)
  })
  await t.test('a known oversize snapshot replaces the older patch and a later clean snapshot clears it', async () => {
    const empty = gzipSync(Buffer.alloc(0)).toString('base64')
    assert.equal((await upload({ ...checkpoint, patch: empty, unavailableReason: 'too_large' })).status, 200)
    assert.equal((await stored()).unavailableReason, 'too_large')
    assert.equal((await upload({ ...checkpoint, patch: empty, files: 0 })).status, 200)
    const row = await stored()
    assert.equal(row.files, 0)
    assert.equal(row.unavailableReason, null)
  })
  await t.test('an expired lease cannot replace a stored snapshot', async () => {
    await pool.query('UPDATE agent_runs SET "leaseExpiresAt"=$2 WHERE id=$1', [runId, new Date(Date.now() - 1)])
    assert.equal((await upload()).status, 409)
    assert.equal((await stored()).files, 0)
    await pool.query('UPDATE agent_runs SET "leaseExpiresAt"=$2 WHERE id=$1', [runId, new Date(Date.now() + 300_000)])
  })
  await t.test('STOP winning while the snapshot write waits cannot overwrite recovery state', async () => {
    const blocker = await pool.connect()
    await blocker.query('BEGIN')
    await blocker.query('LOCK TABLE run_checkpoints IN ACCESS EXCLUSIVE MODE')
    const pending = upload()
    try {
      const end = Date.now() + 5000
      let reached = false
      while (Date.now() < end) {
        const waiting = await pool.query('SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type=\'Lock\' AND query ILIKE \'%INSERT INTO run_checkpoints%\'')
        if (waiting.rowCount) { reached = true; break }
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      assert.equal(reached, true)
      await pool.query('UPDATE agent_runs SET "stopRequestedAt"=now() WHERE id=$1', [runId])
    } finally { await blocker.query('COMMIT'); blocker.release() }
    assert.equal((await pending).status, 409)
    assert.equal((await stored()).files, 0)
  })
  await t.test('another owner cannot write the checkpoint of an otherwise live eligible run', async () => {
    await pool.query('UPDATE agent_runs SET "stopRequestedAt"=NULL,"leaseExpiresAt"=$2 WHERE id=$1', [runId, new Date(Date.now() + 300_000)])
    assert.equal((await upload()).status, 200)
    const peer = `checkpoint-peer-${randomUUID()}`
    await pool.query('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,$1,$2,true,now(),now())', [peer, `${peer}@example.invalid`])
    const peerToken = await issueDeviceToken(peer)
    const response = await POST(new Request(`http://localhost/mikka/v1/runs/${runId}/checkpoint`, {
      method: 'POST', headers: { 'x-mikka-client-version': '0.0.456', authorization: `Bearer ${peerToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ ...checkpoint, files: 9 }),
    }), { params: Promise.resolve({ runId }) })
    assert.equal(response.status, 409)
    assert.equal((await stored()).files, 1)
  })

  for (const evidence of ['current receipt', 'replaced receipt', 'no receipt'] as const)
    await t.test(`automatic retirement follows the real upload with ${evidence}`, async () => {
      const { CLOSED_TASK_RETENTION_MS, reconcileThreadMachine } = await import('../lib/cloud-computer/thread-lifecycle')
      const { parkThreadMachine, threadMachineAction, threadMachineProvider } = await import('../lib/cloud-computer/thread-machines')
      const { persistRunCompletion } = await import('../lib/run-publications')
      const id = randomUUID(), issueId = randomUUID(), cloudDevice = randomUUID(), cloudAgent = randomUUID()
      const actor = { userId, workspaceId }, sandboxId = `checkpoint-fixture-${randomUUID()}`
      await pool.query(`INSERT INTO devices(id,"ownerId",name,kind) VALUES ($1,$2,'Checkpoint retirement fixture','cloud')`, [cloudDevice, userId])
      await pool.query(`INSERT INTO agents(id,"userId","deviceId",harness,name) VALUES ($1,$2,$3,'codex',$4)`, [cloudAgent, userId, cloudDevice, `Unstarted checkpoint fixture ${id}`])
      await pool.query(`INSERT INTO issues(id,"userId","workspaceId","ownershipState",title,content,status,priority,scope) VALUES ($1,$2,$3,'bound','Checkpoint retirement','{"type":"doc","content":[]}','doing','normal','personal')`, [issueId, userId, workspaceId])
      await pool.query(`INSERT INTO agent_runs(id,"userId","agentId","deviceId","issueId","workspaceId",status,"leaseExpiresAt") VALUES ($1,$2,$3,$4,$5,$6,'running',now()+interval '5 minutes')`, [id, userId, cloudAgent, cloudDevice, issueId, workspaceId])
      await pool.query(`INSERT INTO thread_machines("runId","ownerId","workspaceId","issueId","sandboxId","snapshotId","operationId",state,"deviceId")
        VALUES ($1,$2,$3,$4,$5,'checkpoint-fixture',$6,'running',$7)`, [id, userId, actor.workspaceId, issueId, sandboxId, randomUUID(), cloudDevice])
      const receipt = await acknowledge(id)
      if (evidence === 'replaced receipt') {
        // Receipts use milliseconds; ensure the actual second upload is a
        // different server snapshot, without rewriting its stored timestamp.
        await pool.query('SELECT pg_sleep(0.002)')
        const newer = await acknowledge(id, { ...checkpoint, files: 2, patch: gzipSync(Buffer.from('newer final checkpoint\n')).toString('base64') })
        assert.notEqual(newer.takenAt, receipt.takenAt)
      }
      const acknowledged: RunCheckpointReceipt | undefined = evidence === 'no receipt' ? undefined : receipt
      const report = { ...emptyRunReport('Controlled final checkpoint'), safePoint: acknowledged
        ? { session: 'exited' as const, checkpoint: 'ready' as const, checkpointTakenAt: acknowledged.takenAt, observedAt: acknowledged.takenAt }
        : { session: 'exited' as const, checkpoint: 'unavailable' as const, observedAt: new Date().toISOString() } }
      assert.ok(await persistRunCompletion(userId, id, { stopReason: 'turn_ended', report }))
      let pauses = 0, kills = 0, retirementCalls = 0
      await parkThreadMachine(pool, actor, id, async owned => { assert.equal(owned, sandboxId); pauses++ }, async () => null)
      assert.equal(pauses, 1)
      await pool.query(`UPDATE issues SET status='done' WHERE id=$1`, [issueId])
      await pool.query(`UPDATE thread_machines SET lifecycle=jsonb_set(lifecycle,'{pausedAt}',to_jsonb($2::bigint)),"lifecycleAt"=now() WHERE "runId"=$1`,
        [id, Date.now() - CLOSED_TASK_RETENTION_MS - 1000])
      const before = await stored(id)
      const originalKill = threadMachineProvider.kill
      threadMachineProvider.kill = async (owned, owner) => { assert.equal(owned, sandboxId); assert.equal(owner, userId); kills++ }
      try {
        const reconcile = () => reconcileThreadMachine(pool, actor, id, {
          provider: { info: async owned => { assert.equal(owned, sandboxId); return { state: 'paused', endAt: null } },
            keepAlive: async () => { assert.fail('terminal work must not renew its provider lease') } },
          end: async (p, a, run, fence) => {
            retirementCalls++
            assert.equal(fence.requireClosedTask, true)
            assert.equal(fence.requireArchived, true)
            return threadMachineAction(p, a, run, 'end', fence)
          },
        })
        await reconcile()
        const machine = (await pool.query('SELECT state,"sandboxId",lifecycle FROM thread_machines WHERE "runId"=$1', [id])).rows[0]
        if (evidence === 'current receipt') {
          assert.equal(retirementCalls, 1)
          assert.equal(kills, 1)
          assert.equal(machine.state, 'ended')
          assert.equal(machine.sandboxId, null)
          assert.equal(await reconcile(), false)
          assert.equal(kills, 1)
        } else {
          assert.equal(retirementCalls, 0)
          assert.equal(kills, 0)
          assert.equal(machine.state, 'paused')
          assert.equal(machine.sandboxId, sandboxId)
          assert.equal(machine.lifecycle.reason, 'checkpoint_unverified')
          const fence = (await pool.query('SELECT epoch,"sandboxId" FROM thread_machines WHERE "runId"=$1', [id])).rows[0]
          assert.equal((await threadMachineAction(pool, actor, id, 'end', { ...fence, requireClosedTask: true, requireArchived: true })).state, 'paused')
          assert.equal(kills, 0, 'the final lock rechecks the same archive proof')
        }
        assert.deepEqual(await stored(id), before, 'retirement preserves the actual uploaded snapshot')
        assert.deepEqual((await pool.query('SELECT report FROM agent_runs WHERE id=$1', [id])).rows[0].report, report)
        assert.equal((await pool.query('SELECT status FROM issues WHERE id=$1', [issueId])).rows[0].status, 'done')
      } finally { threadMachineProvider.kill = originalKill }
    })
})
