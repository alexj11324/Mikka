import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { dbUrl, seedBot, seedUser, seedWorkspace } from './support/workspace-admin-db'

test('a terminal web task reports once and its existing report can still wake delivery on replay', { skip: !dbUrl, timeout: 30_000 }, async t => {
  const { pool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  const { coordinatorWakeTransport } = await import('../lib/coordinator/wake-after-commit')
  const direct: string[] = [], committed: string[] = []
  const firstWake = Promise.withResolvers<void>()
  coordinatorWakeTransport.wake = async ownerId => { committed.push(ownerId); firstWake.resolve() }
  t.mock.module('../lib/coordinator/wake', { namedExports: { wakeCoordinator: async (ownerId: string) => { direct.push(ownerId) } } })
  t.after(async () => { delete coordinatorWakeTransport.wake; await Promise.all([pool.end(), workspacePool.end()]) })

  const owner = await seedUser(pool, 'web-report')
  const workspace = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }])
  const botId = await seedBot(pool, workspace.id, owner)
  const id = randomUUID(), actor = { userId: owner, workspaceId: workspace.id }
  await pool.query(`INSERT INTO bot_subagents (id,"workspaceId","ownerId","botId",task,status,step)
    VALUES ($1,$2,$3,$4,'Check fixture','done','Finished')`, [id, workspace.id, owner, botId])
  const { tick } = await import('../workflows/subagent/steps')
  await assert.rejects(tick({ ...actor, workspaceId: randomUUID() }, botId, id), /Subagent unavailable/)
  assert.equal(await tick(actor, botId, id), 'terminal')
  await firstWake.promise
  assert.deepEqual({ committed, direct }, { committed: [owner], direct: [] })
  assert.equal(await tick(actor, botId, id), 'terminal')
  assert.deepEqual({ committed, direct }, { committed: [owner], direct: [owner] })
  const event = await pool.query('SELECT "botId","userId",kind,payload FROM coordinator_events WHERE "dedupeKey"=$1', [`subagent:${id}:done`])
  assert.equal(event.rowCount, 1)
  assert.deepEqual([event.rows[0].botId, event.rows[0].userId, event.rows[0].kind, event.rows[0].payload.subagentId], [botId, owner, 'run_report', id])
})
