import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import test from 'node:test'
import { Pool } from 'pg'
import type { RunCheckpoint } from '@mikka/protocol/device'

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
  const { POST } = await import('../app/v1/runs/[runId]/checkpoint/route')
  const { issueDeviceToken } = await import('../lib/device-link')
  const userId = `checkpoint-${randomUUID()}`, runId = randomUUID(), deviceId = randomUUID(), agentId = randomUUID()
  await pool.query('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,$1,$2,true,now(),now())', [userId, `${userId}@example.invalid`])
  await pool.query('INSERT INTO devices (id,"ownerId",name) VALUES ($1,$2,\'Checkpoint fixture\')', [deviceId, userId])
  await pool.query('INSERT INTO agents (id,"userId","deviceId",harness,name) VALUES ($1,$2,$3,\'codex\',\'Checkpoint worker\')', [agentId, userId, deviceId])
  await pool.query('INSERT INTO agent_runs (id,"userId","agentId","deviceId",status,"leaseExpiresAt") VALUES ($1,$2,$3,$4,\'running\',$5)', [runId, userId, agentId, deviceId, new Date(Date.now() + 300_000)])
  const token = await issueDeviceToken(userId)
  t.after(async () => { await pool.end(); await (await import('../lib/db')).pool.end() })
  const checkpoint = { baseCommit: 'a'.repeat(40), patch: gzipSync(Buffer.from('initial patch fixture\n')).toString('base64'), files: 1, takenAt: '2099-01-01T00:00:00Z' }
  const upload = (value: RunCheckpoint = checkpoint) => POST(new Request(`http://localhost/mikka/v1/runs/${runId}/checkpoint`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(value),
  }), { params: Promise.resolve({ runId }) })
  const stored = async () => (await pool.query('SELECT patch,files,"takenAt","unavailableReason" FROM run_checkpoints WHERE "runId"=$1', [runId])).rows[0]

  await t.test('the server upload clock is authoritative despite device clock skew', async () => {
    const before = Date.now()
    assert.equal((await upload()).status, 204)
    const row = await stored()
    assert.ok(row.takenAt.getTime() >= before && row.takenAt.getTime() <= Date.now())
    assert.equal(row.unavailableReason, null)
  })
  await t.test('a known oversize snapshot replaces the older patch and a later clean snapshot clears it', async () => {
    const empty = gzipSync(Buffer.alloc(0)).toString('base64')
    assert.equal((await upload({ ...checkpoint, patch: empty, unavailableReason: 'too_large' })).status, 204)
    assert.equal((await stored()).unavailableReason, 'too_large')
    assert.equal((await upload({ ...checkpoint, patch: empty, files: 0 })).status, 204)
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
    assert.equal((await upload()).status, 204)
    const peer = `checkpoint-peer-${randomUUID()}`
    await pool.query('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,$1,$2,true,now(),now())', [peer, `${peer}@example.invalid`])
    const peerToken = await issueDeviceToken(peer)
    const response = await POST(new Request(`http://localhost/mikka/v1/runs/${runId}/checkpoint`, {
      method: 'POST', headers: { authorization: `Bearer ${peerToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ ...checkpoint, files: 9 }),
    }), { params: Promise.resolve({ runId }) })
    assert.equal(response.status, 409)
    assert.equal((await stored()).files, 1)
  })
})
