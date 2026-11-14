import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { dbUrl, seedUser, seedWorkspace } from './support/workspace-admin-db'
import type { LinearIssueSnapshot } from '../lib/linear-sync/client'

test('a linked Linear status update wakes its Bot from the committed revision', { skip: !dbUrl, timeout: 30_000 }, async t => {
  const next = await import('next/server')
  const jobs: Promise<unknown>[] = []
  t.mock.module('next/server', { namedExports: { ...next, after: (job: () => Promise<unknown>) => { jobs.push(job()) } } })
  const { db, pool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  const { linearTeamSyncs } = await import('../lib/db/schema')
  const owner = await seedUser(pool, 'linear-wake'), committed: string[] = [], direct: string[] = [], modelReads: string[] = []
  const workspace = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }])
  const [team] = await db.insert(linearTeamSyncs).values({ id: randomUUID(), ownerId: owner, workspaceId: workspace.id,
    linearTeamId: randomUUID(), linearTeamKey: 'LWK', linearTeamName: 'Synthetic team' }).returning()
  const model = await import('../lib/default-model')
  t.mock.module('../lib/default-model', { namedExports: { ...model, defaultModelAvailable: async (ownerId: string) => { modelReads.push(ownerId); return true } } })
  const wake = await import('../lib/coordinator/wake')
  t.mock.module('../lib/coordinator/wake', { namedExports: { ...wake, wakeCoordinator: async (ownerId: string) => { direct.push(ownerId) } } })
  const { coordinatorWakeTransport } = await import('../lib/coordinator/wake-after-commit')
  const delivered = Promise.withResolvers<void>()
  coordinatorWakeTransport.wake = async ownerId => { committed.push(ownerId); delivered.resolve() }
  t.after(async () => { delete coordinatorWakeTransport.wake; await Promise.all([pool.end(), workspacePool.end()]) })
  const { applyLinearIssueToApp, createAppIssueFromLinear } = await import('../lib/linear-sync/issue-sync')
  const original: LinearIssueSnapshot = {
    id: randomUUID(), identifier: 'LWK-1', title: 'Linked issue', description: '', dueDate: null, priority: 0,
    url: 'https://fixture.invalid/linear', updatedAt: '2020-01-01T00:00:00.000Z', state: null, assignee: null, labels: [],
    team: { id: team.linearTeamId, key: team.linearTeamKey, name: team.linearTeamName },
  }
  const issue = await createAppIssueFromLinear(team, original)
  assert.ok(issue)
  const updated = { ...original, updatedAt: new Date(Date.now() + 60_000).toISOString(), state: { id: randomUUID(), name: 'Done', type: 'completed' } }
  assert.equal(await applyLinearIssueToApp(team, { ...updated, team: { ...updated.team, id: randomUUID() } }), null)
  const saved = await applyLinearIssueToApp(team, updated, true)
  assert.equal(saved?.status, 'done')
  await delivered.promise
  await applyLinearIssueToApp(team, updated, true)
  await Promise.all(jobs)
  const event = await pool.query('SELECT c."userId",b."workspaceId",c."dedupeKey",c.payload FROM coordinator_events c JOIN bots b ON b.id=c."botId" WHERE c."issueId"=$1 AND kind=$2', [issue.id, 'issue_done'])
  assert.equal(event.rowCount, 1)
  assert.deepEqual([event.rows[0].userId, event.rows[0].workspaceId, event.rows[0].dedupeKey, event.rows[0].payload.previousStatus], [owner, workspace.id, `issue_done:${issue.id}:${saved.revision}`, issue.status])
  assert.deepEqual(committed, [owner])
  assert.deepEqual({ direct, modelReads }, { direct: [], modelReads: [] })
})
