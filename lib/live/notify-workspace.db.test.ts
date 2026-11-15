import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { measured } from '../../tests/helpers/read-metrics'
import { dbUrl } from '../../tests/support/workspace-admin-db'

test('live work scheduled before the Workspace owner commits uses an independent transaction', { skip: !dbUrl }, async t => {
  const jobs: Promise<unknown>[] = []
  const background = mock.module(new URL('../background.ts', import.meta.url).href, {
    namedExports: { afterJob: (_label: string, work: () => unknown) => { jobs.push(Promise.resolve(work())) } },
  })
  t.after(() => background.restore())
  const { workspaceDb, workspacePool, workspaceTransactionKey } = await import('../workspace-db')
  const { pool } = await import('../db')
  const { scheduleLive } = await import('./notify')
  t.after(async () => { await Promise.all([pool.end(), workspacePool.end()]) })
  const started = Promise.withResolvers<void>()
  const finish = Promise.withResolvers<void>()
  let ownerKey: object | null = null, backgroundKey: object | null = null
  let completed = false
  try {
    await workspaceDb.transaction(async () => {
      ownerKey = workspaceTransactionKey()
      scheduleLive(async () => {
        await workspaceDb.transaction(async tx => {
          backgroundKey = workspaceTransactionKey()
          started.resolve()
          await finish.promise
          await tx.execute((await import('drizzle-orm')).sql`select 1`)
        })
        completed = true
      })
      await started.promise
    })
  } finally { finish.resolve(); await Promise.all(jobs) }
  assert.ok(ownerKey)
  assert.ok(backgroundKey)
  assert.notEqual(backgroundKey, ownerKey, 'a delayed live send must not borrow a still-active owner lease')
  assert.equal(completed, true, 'its transaction remains usable after the writer commits')
})

test('relation and PR audiences read bounded sets across independent app and workspace sessions', { skip: !dbUrl }, async () => {
  const { issueRelationTargets } = await import('./issue-detail')
  const { pullRequestStatusTargets } = await import('./pull-requests')
  const pool = new Pool({ connectionString: dbUrl, max: 2 })
  const app = await pool.connect(), workspace = await pool.connect()
  try {
    await app.query('CREATE TEMP TABLE issues (id uuid PRIMARY KEY, "userId" text, scope text, "workspaceId" uuid, "ownershipState" text, content jsonb)')
    await workspace.query('CREATE TEMP TABLE mikka_workspaces (id uuid PRIMARY KEY, "userId" text, kind text); CREATE TEMP TABLE mikka_workspace_members ("workspaceId" uuid, "userId" text, status text)')
    const home = randomUUID(), team = randomUUID()
    const ids = Array.from({ length: 50 }, () => randomUUID())
    await app.query(`INSERT INTO issues
      SELECT id,'owner','workspace',CASE WHEN i=1 THEN $2::uuid ELSE $3::uuid END,
        CASE WHEN i=3 THEN 'pending' ELSE 'bound' END,
        CASE WHEN i=2 THEN '{"attrs":{"orvilo":{"deletedAt":"2026-01-01"}}}'::jsonb ELSE '{}'::jsonb END
      FROM unnest($1::uuid[]) WITH ORDINALITY AS task(id,i)`, [ids, home, team])
    await workspace.query(`INSERT INTO mikka_workspaces VALUES ($1,'owner','personal'),($2,'owner','team')`, [home, team])
    await workspace.query(`INSERT INTO mikka_workspace_members VALUES ($1,'owner','active'),($1,'peer','active'),
      ($2,'owner','active'),($2,'peer','active'),($2,'removed','suspended')`, [home, team])
    const input = [ids[0].toUpperCase(), ...ids.slice(1), ids[4]]
    const relations = await measured(() => issueRelationTargets(app, workspace, input))
    const pullRequests = await measured(() => pullRequestStatusTargets(app, workspace, input))
    for (const [measurement, kind] of [[relations, 'issue_relations'], [pullRequests, 'pull_request_status']] as const) {
      const { value } = measurement
      assert.deepEqual(value.map(({ scope }) => [scope.ownerId, scope.workspaceId].join('@')).sort(),
        ['owner@' + home, 'owner@' + team, 'peer@' + team].sort())
      for (const { scope, events } of value) {
        assert.ok(events.every(event => event.kind === kind))
        assert.deepEqual(events.map(event => event.id), scope.workspaceId === home ? [input[0]] : ids.slice(3))
      }
    }
    assert.deepEqual([relations.statements, pullRequests.statements], [4, 2])
  } finally {
    app.release(true)
    workspace.release(true)
    await pool.end()
  }
})
