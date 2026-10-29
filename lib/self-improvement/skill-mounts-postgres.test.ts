import { isolatedPostgresURL } from '../../tests/helpers/isolated-postgres.mjs'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import test from 'node:test'
import { emptyRunReport } from '@mikka/protocol/run'
import { Pool } from 'pg'
import { orderMigrations } from '../../scripts/migration-order.mjs'
import { improvementTestDatabase } from './test-database'
import { createSkillAssignments } from './assignments'
import { recordSkillMount, recordCompletionSkillMount } from './skill-mounts'

const databaseURL = improvementTestDatabase(process.env)
test('PG mount ledger accepts current actual session evidence atomically and rejects forged/stale evidence',
  { skip: !databaseURL, timeout: 120000 }, async t => {
    const target = new URL(await isolatedPostgresURL(databaseURL!)), schema = `skill_mount_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: target.toString(), max: 1 })
    await admin.query(`CREATE SCHEMA "${schema}"`)
    target.searchParams.set('options', `-c search_path=${schema}`)
    const pool = new Pool({ connectionString: target.toString(), max: 5 })
    t.after(async () => { await pool.end(); await admin.end() })
    const dir = new URL('../../drizzle/', import.meta.url)
    for (const name of orderMigrations((await readdir(dir)).filter(n => n.endsWith('.sql'))))
      await pool.query(await readFile(new URL(name, dir), 'utf8'))
    const userId = `synthetic-${randomUUID()}`, issueId = randomUUID(), agentId = randomUUID(), deviceId = randomUUID(), repoId = randomUUID()
    await pool.query(`INSERT INTO issues(id,"userId",title,content,status,priority) VALUES($1,$2,'Mount boundary fixture','{}','todo','normal')`, [issueId, userId])
    await pool.query(`INSERT INTO devices(id,"ownerId",name,enabled) VALUES($1,$2,'Synthetic device',true)`, [deviceId, userId])
    await pool.query(`INSERT INTO agents(id,"userId",name,harness,"deviceId") VALUES($1,$2,'Synthetic agent','codex',$3)`, [agentId, userId, deviceId])
    await pool.query(`INSERT INTO device_repos(id,"deviceId","userId","repoPath") VALUES($1,$2,$3,'/synthetic/mount')`, [repoId, deviceId, userId])
    let allowed = true
    const authorize = async (u: string, i: string) => allowed && u === userId && i === issueId
    const assignments = createSkillAssignments(pool, authorize)
    async function prepare() {
      const runId = randomUUID(), sessionId = randomUUID(), lease = new Date(Date.now() + 60000).toISOString()
      await pool.query(`INSERT INTO agent_runs(id,"userId","issueId","agentId","deviceId","deviceRepoId",status)
        VALUES($1,$2,$3,$4,$5,$6,'queued')`, [runId, userId, issueId, agentId, deviceId, repoId])
      await assignments.selectBaseline(userId, runId)
      await pool.query(`UPDATE agent_runs SET status='preparing',"startedAt"=now(),"leaseExpiresAt"=$2,"sessionId"=$3 WHERE id=$1`, [runId, lease, sessionId])
      const { skillReceipt: receipt } = await assignments.recordClaim(userId, deviceId, runId, lease, true)
      assert.ok(receipt)
      return { runId, mount: { receiptId: receipt.id, versionId: receipt.artifact.versionId, sha256: receipt.artifact.sha256,
        sessionId, mountedAt: new Date().toISOString() } }
    }
    async function record(runId: string, mount: Parameters<typeof recordSkillMount>[3], rollback = false) {
      const tx = await pool.connect()
      try {
        await tx.query('BEGIN')
        await recordSkillMount(tx, userId, runId, mount, authorize)
        const updated = await tx.query(`UPDATE agent_runs SET status='succeeded',"finishedAt"=now() WHERE id=$1
          AND status=ANY($2::text[]) RETURNING id`, [runId, ['preparing', 'running', 'finishing']])
        await tx.query(rollback ? 'ROLLBACK' : 'COMMIT')
        return updated.rowCount
      } catch (error) { await tx.query('ROLLBACK'); throw error } finally { tx.release() }
    }
    const first = await prepare()
    await record(first.runId, first.mount, true)
    assert.equal((await pool.query('SELECT * FROM improvement_skill_mounts')).rowCount, 0)
    assert.equal((await pool.query('SELECT status FROM agent_runs WHERE id=$1', [first.runId])).rows[0].status, 'preparing')
    for (const altered of [{ receiptId: randomUUID() }, { versionId: randomUUID() }, { sha256: 'f'.repeat(64) }, { sessionId: 'model-fake' }])
      await assert.rejects(record(first.runId, { ...first.mount, ...altered }), /sourceMismatch/)
    allowed = false
    await assert.rejects(record(first.runId, first.mount), /notFound/)
    allowed = true
    await pool.query('UPDATE devices SET enabled=false WHERE id=$1', [deviceId])
    await assert.rejects(record(first.runId, first.mount), /notFound/)
    await pool.query('UPDATE devices SET enabled=true WHERE id=$1', [deviceId])
    await record(first.runId, first.mount)
    const stored = (await pool.query('SELECT * FROM improvement_skill_mounts WHERE "runId"=$1', [first.runId])).rows[0]
    assert.equal(stored.receiptId, first.mount.receiptId)
    assert.equal(stored.sessionId, first.mount.sessionId)
    assert.equal(stored.sha256, first.mount.sha256)
    await assert.rejects(pool.query(`UPDATE improvement_skill_mounts SET "sessionId"='forged'`), /immutable/)
    await assert.rejects(pool.query('DELETE FROM improvement_skill_mounts'), /immutable/)
    // A duplicate completion that raced the first pre-read is accepted without another ledger row.
    const raced = await prepare()
    const completions = await Promise.all([record(raced.runId, raced.mount), record(raced.runId, raced.mount)])
    assert.deepEqual(completions.sort(), [0, 1])
    const expired = await prepare()
    await pool.query('UPDATE agent_runs SET "leaseExpiresAt"=now() WHERE id=$1', [expired.runId])
    await assert.rejects(record(expired.runId, expired.mount), /sourceMismatch/)
    const cancelled = await prepare()
    await pool.query('UPDATE agent_runs SET "stopRequestedAt"=now() WHERE id=$1', [cancelled.runId])
    await assert.rejects(record(cancelled.runId, cancelled.mount), /sourceMismatch/)
    for (const [fixture, reason] of [[expired, 'device_lost'], [cancelled, 'cancelled']] as const) {
      const tx = await pool.connect()
      try {
        await tx.query('BEGIN')
        const settled = await recordCompletionSkillMount(tx, userId, fixture.runId, reason,
          { ...emptyRunReport(), skillMount: fixture.mount }, authorize)
        assert.equal(settled?.skillMount, undefined)
        await tx.query(`UPDATE agent_runs SET status='cancelled',"finishedAt"=now() WHERE id=$1`, [fixture.runId])
        await tx.query('COMMIT')
      } catch (error) { await tx.query('ROLLBACK'); throw error } finally { tx.release() }
    }
    assert.equal((await pool.query('SELECT * FROM improvement_skill_mounts')).rowCount, 2)
    console.log(JSON.stringify({ layer: 'actual-PG-mount-boundary', sessions: 'synthetic', modelCalls: 0, retainedSchema: schema }))
  })
