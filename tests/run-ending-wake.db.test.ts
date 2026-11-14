import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { disposableDatabase } from './helpers/e2e-target.mjs'
import { seedCoordinator } from './support/coordinator-bot'
import { seedAgent, seedIssue, seedRun, seedUser } from './support/workspace-admin-db'

const target = process.env.E2E_DATABASE_URL
const ready = Boolean(target && disposableDatabase(process.env, target) && process.env.DATABASE_URL === target && process.env.MIKKA_DATABASE_URL === target)
if (process.env.REQUIRE_DB === '1') assert.ok(ready, 'matching isolated loopback *_e2e databases are required')

test('run endings wake their committed owner once, including a pre-existing cloud completion event', { skip: !ready, timeout: 30_000 }, async t => {
  const tasks: Promise<unknown>[] = []
  const next = await import('next/server')
  t.mock.module('next/server', { namedExports: { ...next, after: (work: () => Promise<unknown>) => { tasks.push(work()) } } })
  const { pool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  const { coordinatorWakeTransport } = await import('../lib/coordinator/wake-after-commit')
  const committed: string[] = [], direct: string[] = []
  let delivered = Promise.withResolvers<void>()
  coordinatorWakeTransport.wake = async owner => { committed.push(owner); delivered.resolve() }
  t.after(async () => {
    delete coordinatorWakeTransport.wake
    await Promise.all([pool.end(), workspacePool.end()])
  })
  const existingWake = await import('../lib/coordinator/wake')
  t.mock.module('../lib/coordinator/wake', { namedExports: { ...existingWake, wakeCoordinator: async (owner: string) => { direct.push(owner) } } })
  const { failRunForDaemonUpgrade, failUnclaimedCloudStart } = await import('../lib/run-leases')
  const { issueRunToken, verifyRunToken } = await import('../lib/mcp/worker')
  const userId = await seedUser(pool, 'terminal-run')
  const { workspaceId, botId } = await seedCoordinator(userId)
  const agentId = await seedAgent(pool, userId)
  const deviceId = randomUUID()
  await pool.query('INSERT INTO devices(id,"ownerId",name) VALUES ($1,$2,$3)', [deviceId, userId, 'Old daemon'])
  await t.test('four concurrent upgrade refusals terminate the run and revoke its token once', async () => {
    const runId = await seedRun(pool, { userId, workspaceId, botId, agentId, status: 'queued' })
    await pool.query('UPDATE agent_runs SET "deviceId"=$1 WHERE id=$2', [deviceId, runId])
    const token = await issueRunToken({ id: runId, userId })
    assert.equal(await failRunForDaemonUpgrade(runId, deviceId, 'unrelated-owner'), false)
    const outcomes = await Promise.all(Array.from({ length: 4 }, () => failRunForDaemonUpgrade(runId, deviceId, userId)))
    assert.equal(outcomes.filter(Boolean).length, 1)
    await delivered.promise
    await Promise.all(tasks)
    const events = await pool.query('SELECT "userId","botId",payload FROM coordinator_events WHERE "runId"=$1 AND kind=$2', [runId, 'run_finished'])
    assert.equal(events.rowCount, 1)
    assert.deepEqual([events.rows[0].userId, events.rows[0].botId, events.rows[0].payload.daemonUpgradeRequired], [userId, botId, true])
    assert.equal(Boolean(await verifyRunToken(new Request('http://localhost/mikka/api/mcp'), token.token)), false)
    assert.deepEqual(committed, [userId])
    assert.deepEqual(direct, [])
  })
  await t.test('a real cloud transition also wakes once when its event key already exists', async () => {
    committed.length = 0
    direct.length = 0
    delivered = Promise.withResolvers<void>()
    const issueId = await seedIssue(pool, userId, workspaceId)
    const runId = await seedRun(pool, { userId, workspaceId, botId, issueId, agentId, status: 'queued' })
    await pool.query('INSERT INTO computer_run_bindings("runId","ownerId","workspaceId","botId") VALUES ($1,$2,$3,$4)', [runId, userId, workspaceId, botId])
    const eventId = randomUUID()
    await pool.query(`INSERT INTO coordinator_events(id,"userId","botId","runId","issueId",kind,"dedupeKey",payload)
      VALUES ($1,$2,$3,$4,$5,'run_finished',$6,'{"status":"failed","stopReason":"device_lost"}')`, [eventId, userId, botId, runId, issueId, `run_finished:${runId}`])
    const fail = () => failUnclaimedCloudStart({ userId, workspaceId }, runId, new Error('Isolated provision refusal'))
    const reject = 'reject_terminal_' + runId.replaceAll('-', '')
    await pool.query(`CREATE FUNCTION ${reject}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.id='${runId}'::uuid AND NEW.status='failed' THEN RAISE EXCEPTION 'rollback terminal decision'; END IF; RETURN NEW; END $$`)
    try {
      await pool.query(`CREATE CONSTRAINT TRIGGER ${reject} AFTER UPDATE ON agent_runs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${reject}()`)
      await assert.rejects(fail(), (error: { cause?: unknown }) => String(error.cause ?? error).includes('rollback terminal decision'))
      await Promise.all(tasks)
      assert.deepEqual(committed, [])
      assert.deepEqual(direct, [])
    } finally {
      await pool.query(`DROP TRIGGER IF EXISTS ${reject} ON agent_runs`)
      await pool.query(`DROP FUNCTION ${reject}()`)
    }
    assert.equal(await fail(), true)
    await delivered.promise
    assert.equal(await fail(), false)
    await Promise.all(tasks)
    assert.deepEqual((await pool.query('SELECT id FROM coordinator_events WHERE "runId"=$1 AND kind=$2', [runId, 'run_finished'])).rows, [{ id: eventId }])
    assert.deepEqual(committed, [userId])
    assert.deepEqual(direct, [])
  })
})
