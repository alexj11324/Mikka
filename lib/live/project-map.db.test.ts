import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mock, test } from 'node:test'
import type { LiveInvalidation } from './events'
import type { LiveScope } from './scope'
import { dbUrl, seedAgent, seedBot, seedIssue, seedPersonalWorkspace, seedProject, seedProjectTasks, seedRun, seedTeam, seedUser, seedWorkspace } from '../../tests/support/workspace-admin-db'

test('project map invalidations use current scope and only committed writes', { skip: !dbUrl }, async t => {
  const pending: (() => Promise<void>)[] = [], sent: { scope: LiveScope; events: LiveInvalidation[] }[] = []
  const revisions: number[] = []
  mock.module('./notify', { namedExports: {
    scheduleLive: (work: () => Promise<void>) => pending.push(work),
    sendLiveInvalidations: async (scope: LiveScope, events: LiveInvalidation[]) => {
      const maps = events.filter(event => event.kind === 'project_map')
      for (const event of maps) {
        assert.deepEqual(Object.keys(event).sort(), ['id', 'kind', 'rev'])
        assert.ok(Number.isSafeInteger(event.rev) && event.rev! > 0); revisions.push(event.rev!)
      }
      if (maps.length) sent.push({ scope, events: maps.map(({ kind, id }) => ({ kind, id })) })
    },
  } })
  const oldUrl = process.env.DEVICE_GATEWAY_URL, oldSecret = process.env.DEVICE_GATEWAY_PUSH_SECRET
  process.env.DEVICE_GATEWAY_URL = 'https://gateway.example.invalid'; process.env.DEVICE_GATEWAY_PUSH_SECRET = 'isolated-map-live'
  const { Pool } = await import('pg'), { observePoolCommits } = await import('../db/commit-effects')
  const connection = new Pool({ connectionString: dbUrl, max: 3 }); observePoolCommits(connection)
  const { db, pool, withDatabaseTransaction } = await import('../db/request-scope')
  const { workspacePool } = await import('../workspace-db')
  const { projectMapTargets, projectMapChanged } = await import('./project-map')
  const { recordProjectDecision } = await import('../project-map/decisions')
  const drain = async () => { while (pending.length) await Promise.all(pending.splice(0).map(work => work())); return sent.splice(0) }
  t.after(async () => {
    await drain()
    if (oldUrl === undefined) delete process.env.DEVICE_GATEWAY_URL; else process.env.DEVICE_GATEWAY_URL = oldUrl
    if (oldSecret === undefined) delete process.env.DEVICE_GATEWAY_PUSH_SECRET; else process.env.DEVICE_GATEWAY_PUSH_SECRET = oldSecret
    await Promise.all([connection.end(), pool.end(), workspacePool.end()]); mock.restoreAll()
  })
  const owner = await seedUser(connection, 'map-live-owner'), peer = await seedUser(connection, 'map-live-peer')
  const home = { id: await seedPersonalWorkspace(connection, owner) }
  await assert.rejects(connection.query(
    `INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) VALUES($1,$2,$2,$2,'member','active')`,
    [home.id, peer],
  ), { code: '23514' }, 'a Personal workspace cannot admit another owner')
  const shared = await seedWorkspace(connection, owner, [{ userId: owner, role: 'admin' }, { userId: peer, role: 'member' }])
  const team = await seedTeam(connection, shared.id, owner)
  const privateProject = await seedProject(connection, owner, []), sharedProject = await seedProject(connection, owner, [{ teamId: team.id, workspaceId: shared.id }])
  const issueId = await seedIssue(connection, owner)
  await seedProjectTasks(connection, privateProject, [issueId])
  const revision = async () => (await connection.query('SELECT revision FROM live_revisions WHERE kind=\'project_map\' AND id=$1', [privateProject])).rows[0]?.revision
  const expected = [{ scope: { ownerId: owner, workspaceId: home.id }, events: [{ kind: 'project_map', id: privateProject }] }]
  await t.test('a private project reaches its owner only; shared project excludes suspended members', async () => {
    assert.deepEqual((await projectMapTargets(connection, { projectId: privateProject })).targets, expected)
    assert.equal((await projectMapTargets(connection, { projectId: sharedProject })).targets.length, 2)
    await connection.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2', [shared.id, peer])
    assert.deepEqual((await projectMapTargets(connection, { projectId: sharedProject })).targets.map(target => target.scope.ownerId), [owner])
  })
  await t.test('transaction rollback sends nothing; duplicate registrations coalesce after COMMIT', async () => {
    const client = await connection.connect()
    try {
      await client.query('BEGIN'); await projectMapChanged(client, privateProject); assert.equal(pending.length, 0)
      await client.query('ROLLBACK'); assert.deepEqual(await drain(), []); assert.equal(await revision(), undefined)
      await client.query('BEGIN'); await projectMapChanged(client, privateProject); await projectMapChanged(client, privateProject)
      assert.equal(pending.length, 0); await client.query('COMMIT'); assert.deepEqual(await drain(), expected); assert.equal(Number(await revision()), 1)
    } finally { client.release() }
  })
  await t.test('the real decision writer waits for outer COMMIT, and an idempotent retry sends nothing', async () => {
    const actor = { kind: 'human' as const, user: owner, workspaceId: home.id }
    const input = { projectId: privateProject, workspaceId: home.id, kind: 'confirm' as const,
      title: 'A committed decision', summary: 'Keep evidence', reason: 'A rollback must not notify', idempotencyKey: randomUUID() }
    await assert.rejects(db.transaction(outer => withDatabaseTransaction(outer, async () => {
      await recordProjectDecision(actor, input); assert.equal(pending.length, 0); throw new Error('fixture rollback')
    })), /fixture rollback/)
    assert.deepEqual(await drain(), [])
    const result = await recordProjectDecision(actor, input); assert.equal(result.duplicate, false)
    assert.deepEqual(await drain(), expected)
    assert.equal((await recordProjectDecision(actor, input)).duplicate, true); assert.deepEqual(await drain(), [])
    assert.equal(Number(await revision()), 2); assert.deepEqual(revisions, [1, 2])
  })
  await t.test('state commits refresh the map; reply preview changes do not', async () => {
    const agentId = await seedAgent(connection, owner), botId = await seedBot(connection, home.id, owner)
    const runId = await seedRun(connection, { userId: owner, agentId, botId, issueId })
    const { runListChanged } = await import('./lists')
    await runListChanged(pool, runId, true); assert.deepEqual(await drain(), [])
    await runListChanged(pool, runId, false); assert.deepEqual(await drain(), expected)
  })
  await t.test('one committed shared project revision fans out equally to current members', async () => {
    await connection.query(`UPDATE mikka_workspace_members SET status='active' WHERE "workspaceId"=$1 AND "userId"=$2`, [shared.id, peer])
    const before = revisions.length
    await projectMapChanged(pool, sharedProject)
    assert.equal((await drain()).length, 2)
    assert.deepEqual(revisions.slice(before), [1, 1])
  })
  await t.test('revocation between COMMIT and delivery removes the recipient', async () => {
    await projectMapChanged(pool, privateProject)
    await connection.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2', [home.id, owner])
    assert.deepEqual(await drain(), [])
  })
})
