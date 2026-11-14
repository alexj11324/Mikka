import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { disposableDatabase } from '../../tests/helpers/e2e-target.mjs'
import { seedCoordinator } from '../../tests/support/coordinator-bot'
import { seedUser } from '../../tests/support/workspace-admin-db'

const target = process.env.E2E_DATABASE_URL
const valid = target && disposableDatabase(process.env, target)
  && process.env.MIKKA_DATABASE_URL === target && process.env.DATABASE_URL === target
if (process.env.REQUIRE_DB === '1') assert.ok(valid, 'matching isolated loopback *_e2e databases are required')

test('each MCP event write wakes once, after its durable row is visible', { skip: !valid, timeout: 60_000 }, async t => {
  const scheduled: Promise<unknown>[] = []
  const direct: string[] = []
  const committed: { userId: string; rows: number }[] = []
  let wakeObserved: (() => void) | undefined
  const next = await import('next/server')
  t.mock.module('next/server', { namedExports: { ...next, after: (callback: () => Promise<void>) => { scheduled.push(callback()) } } })
  const { pool, createRequestDatabaseScope } = await import('../db')
  const { workspacePool } = await import('../workspace-db')
  const scope = createRequestDatabaseScope(target!)
  const reader = new Pool({ connectionString: target })
  t.after(async () => { await Promise.all([scope.close(), pool.end(), workspacePool.end(), reader.end()]) })
  const { coordinatorWakeTransport } = await import('../coordinator/wake-after-commit')
  t.after(() => { delete coordinatorWakeTransport.wake })
  coordinatorWakeTransport.wake = async userId => {
    const { rows } = await reader.query('SELECT count(*)::int AS n FROM coordinator_events WHERE "userId"=$1', [userId])
    committed.push({ userId, rows: rows[0].n })
    wakeObserved?.()
  }
  t.mock.module('../coordinator/wake', { namedExports: {
    coordinatorEnabled: async () => false,
    wakeCoordinator: async (userId: string) => { direct.push(userId) },
  } })
  const [{ sendToCoordinator }, worker, { actAs }, { tokenWorkspace }] = await Promise.all([
    import('./tools'), import('./worker'), import('../acting-user'), import('../tokens/principal'),
  ])
  const owner = await seedUser(pool, 'mcp-wakes')
  const { botId, workspaceId } = await scope.run(() => seedCoordinator(owner))
  const agentId = randomUUID(), runId = randomUUID()
  await pool.query('INSERT INTO agents(id,"userId",name,harness) VALUES ($1,$2,$3,$4)', [agentId, owner, 'MCP delivery test', 'codex'])
  await pool.query('INSERT INTO agent_runs(id,"userId","agentId","botId",status) VALUES ($1,$2,$3,$4,$5)', [runId, owner, agentId, botId, 'running'])
  const run = { id: runId, userId: owner, botId, issueId: null }
  const attempts: (() => Promise<unknown>)[] = [
    () => actAs({ id: owner, [tokenWorkspace]: workspaceId }, () => sendToCoordinator(owner, 'Peer report')),
    () => worker.report(run, 'Progress'),
    () => worker.ask(run, { question: 'Continue?' }),
    () => worker.blocked(run, 'Waiting'),
  ]
  try {
    for (const attempt of attempts) {
      const delivered = new Promise<void>(resolve => { wakeObserved = resolve })
      await scope.run(attempt)
      await delivered
      await Promise.all(scheduled.splice(0))
    }
    assert.deepEqual(committed, attempts.map((_, index) => ({ userId: owner, rows: index + 1 })))
    assert.deepEqual(direct, [], 'each committed event already woke its owner')
    assert.deepEqual((await pool.query('SELECT kind FROM coordinator_events WHERE "userId"=$1 ORDER BY "createdAt",id', [owner])).rows.map(row => row.kind),
      ['run_report', 'run_report', 'run_question', 'run_blocked'])
  } finally {
    await pool.query('DELETE FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=$2', [workspaceId, owner])
    await pool.query('DELETE FROM mikka_workspaces WHERE id=$1', [workspaceId])
    await pool.query('DELETE FROM "user" WHERE id=$1', [owner])
  }
})
