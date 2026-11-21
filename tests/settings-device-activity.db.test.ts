import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { dbUrl, seedAgent, seedIssue, seedRun, seedUser, seedWorkspace } from './support/workspace-admin-db'

let principal: { id: string; workspaceId?: string } | null = null
mock.module('@/lib/auth', { namedExports: { auth: { api: { getSession: async () => principal ? {
  user: { id: principal.id, name: principal.id, email: `${principal.id}@example.invalid` },
  session: { id: 'settings-device-activity-fixture' },
  ...(principal.workspaceId ? { tokenWorkspaceId: principal.workspaceId } : {}),
} : null } } } })

test('settings device and contribution HTTP reads preserve owner, tenant and role boundaries on PG17', { skip: !dbUrl }, async t => {
  const [{ pool }, { workspacePool }, detail, activity] = await Promise.all([
    import('../lib/db'), import('../lib/workspace-db'),
    import('../app/api/devices/[deviceId]/detail/route'),
    import('../app/api/workspaces/[workspaceId]/activity/route'),
  ])
  pool.options.max = 1
  workspacePool.options.max = 1
  const fixtureUsers: string[] = [], fixtureWorkspaces: string[] = []
  t.after(async () => {
    principal = null
    try {
      await pool.query('DELETE FROM agent_runs WHERE "userId"=ANY($1::text[])', [fixtureUsers])
      await pool.query('DELETE FROM agents WHERE "userId"=ANY($1::text[])', [fixtureUsers])
      await pool.query('DELETE FROM devices WHERE "ownerId"=ANY($1::text[])', [fixtureUsers])
      await pool.query('DELETE FROM issue_versions WHERE "userId"=ANY($1::text[])', [fixtureUsers])
      await pool.query('DELETE FROM issues WHERE "userId"=ANY($1::text[])', [fixtureUsers])
      await pool.query('DELETE FROM resource_access_policies WHERE "workspaceId"=ANY($1::uuid[])', [fixtureWorkspaces])
      await workspacePool.query('DELETE FROM workspace_projects WHERE "workspaceId"=ANY($1::uuid[])', [fixtureWorkspaces])
      await workspacePool.query('DELETE FROM mikka_workspaces WHERE id=ANY($1::uuid[])', [fixtureWorkspaces])
      await pool.query('DELETE FROM "user" WHERE id=ANY($1::text[])', [fixtureUsers])
    } finally { await Promise.all([pool.end(), workspacePool.end()]) }
  })
  const owner = await seedUser(pool, 'settings-device-owner')
  const member = await seedUser(pool, 'settings-device-member')
  const outsider = await seedUser(pool, 'settings-device-outsider')
  fixtureUsers.push(owner, member, outsider)
  const workspace = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }, { userId: member, role: 'member' }])
  const foreign = await seedWorkspace(pool, outsider, [{ userId: outsider, role: 'admin' }])
  fixtureWorkspaces.push(workspace.id, foreign.id)
  const source = randomUUID()
  await pool.query(`INSERT INTO devices(id,"ownerId",name,hostname,platform,arch,"maxConcurrentRuns","sessionOpenedAt")
    VALUES($1,$2,'Source','owner-host','linux','x64',3,now())`,
  [source, owner])
  const agent = await seedAgent(pool, owner)
  const issue = await seedIssue(pool, owner, workspace.id, { registered: true })
  const run = await seedRun(pool, { userId: owner, agentId: agent, workspaceId: workspace.id, issueId: issue, status: 'running' })
  const retry = await seedRun(pool, { userId: owner, agentId: agent, workspaceId: workspace.id, issueId: issue })
  await pool.query(`UPDATE agent_runs SET "deviceId"=$1,"createdAt"='2026-11-19T12:00:00Z' WHERE id=ANY($2::uuid[])`, [source, [run, retry]])
  await pool.query('UPDATE agent_runs SET "retryOf"=$2 WHERE id=$1', [retry, run])
  await pool.query(`INSERT INTO run_checkpoints("runId","userId","baseCommit",patch,files,"takenAt")
    VALUES($1,$2,$3,$4,2,'2026-11-19T13:00:00Z')`, [run, owner, 'a'.repeat(40), Buffer.from('private-checkpoint-patch')])
  await pool.query(`INSERT INTO thread_machines("runId","workspaceId","ownerId","snapshotId","operationId",state,"deviceId","snapshotState","filesystemSnapshotId","snapshotTakenAt")
    VALUES($1,$2,$3,'private-template-id',$4,'paused',$5,'ready','private-snapshot-id','2026-11-19T13:00:00Z')`,
  [run, workspace.id, owner, randomUUID(), source])
  const directory = randomUUID(), hiddenDirectory = randomUUID(), environment = randomUUID()
  for (const [id, userId] of [[directory, owner], [hiddenDirectory, member]]) {
    await pool.query(`INSERT INTO workspace_projects(id,"userId","workspaceId",name,summary,description,status,priority,lead,team,"startDate","targetDate","issueIds",revision)
      VALUES($1,$2,$3,'Directory','','','planned','none','','','','','[]',1)`, [id, userId, workspace.id])
    await pool.query(`INSERT INTO resource_access_policies(kind,id,"workspaceId","ownerId",visibility,provenance)
      VALUES('project',$1,$2,$3,'private','created')`, [id, workspace.id, userId])
    await pool.query(`INSERT INTO device_project_checkouts("ownerId","workspaceId","projectId","deviceId",root,"updatedAt")
      VALUES($1,$2,$3,$4,$5,'2026-11-19T13:00:00Z')`, [owner, workspace.id, id, source, id === directory ? '/work/visible' : '/work/access-removed'])
  }
  await pool.query(`INSERT INTO workspace_environments(id,"workspaceId",name,configuration,"createdBy","updatedBy")
    VALUES($1,$2,'Runtime','{}',$3,$3)`, [environment, workspace.id, owner])
  await pool.query(`INSERT INTO workspace_project_environments("projectId","workspaceId","environmentId") VALUES($1,$2,$3)`, [directory, workspace.id, environment])
  const foreignAgent = await seedAgent(pool, outsider)
  const foreignRun = await seedRun(pool, { userId: outsider, agentId: foreignAgent, workspaceId: foreign.id })
  await pool.query(`UPDATE agent_runs SET "createdAt"='2026-11-19T12:00:00Z' WHERE id=$1`, [foreignRun])

  const deviceContext = (deviceId = source) => ({ params: Promise.resolve({ deviceId }) })
  const deviceRequest = (action: string, workspaceId = workspace.id) => new Request(`https://mikka.test/api/devices/${source}/${action}?workspaceId=${workspaceId}`)
  const readActivity = (query = '?from=2026-11-19&to=2026-11-19', workspaceId = workspace.id) => activity.GET(
    new Request(`https://mikka.test/api/workspaces/${workspaceId}/activity${query}`), { params: Promise.resolve({ workspaceId }) })
  await t.test('missing session and nonowners cannot read device details or checkpoints', async () => {
    for (const id of [null, member, outsider]) {
      principal = id ? { id } : null
      const response = await detail.GET(deviceRequest('detail'), deviceContext())
      assert.equal(response.status, id === member ? 404 : 403)
      assert.ok(!(await response.text()).includes('owner-host'))
    }
    principal = { id: owner }
    assert.equal((await detail.GET(deviceRequest('detail', foreign.id), deviceContext())).status, 403)
    principal = { id: owner, workspaceId: foreign.id }
    assert.equal((await detail.GET(deviceRequest('detail'), deviceContext())).status, 403)
  })

  await t.test('owner detail returns persisted status and safe checkpoints without provider identifiers or patch data', async () => {
    principal = { id: owner }
    const response = await detail.GET(deviceRequest('detail'), deviceContext())
    assert.equal(response.status, 200)
    const value = await response.json()
    assert.equal(value.device.online, true)
    assert.deepEqual(value.scheduling, { enabled: true, maxConcurrentRuns: 3, activeRuns: 1, availableSlots: 2 })
    assert.equal(value.hardware.hostname, 'owner-host')
    assert.deepEqual(value.directories, [{ environmentIds: [environment], root: '/work/visible', updatedAt: '2026-11-19T13:00:00.000Z' }])
    assert.deepEqual(value.checkpoints, [{ runId: run, kind: 'repository', baseCommit: 'a'.repeat(40), files: 2,
      capturedAt: '2026-11-19T13:00:00.000Z', available: true, unavailableReason: null }])
    assert.deepEqual(value.cloudCheckpoints, [{ runId: run, state: 'ready', capturedAt: '2026-11-19T13:00:00.000Z', available: true }])
    assert.equal(value.migration.available, false)
    assert.equal(value.migration.reason, 'machine_migration_not_supported')
    for (const secret of ['private-checkpoint-patch', 'private-template-id', 'private-snapshot-id']) assert.ok(!JSON.stringify(value).includes(secret))
    await pool.query(`UPDATE workspace_projects SET "archivedAt"=now() WHERE id=$1`, [directory])
    await pool.query(`UPDATE devices SET "sessionClosedAt"=now() WHERE id=$1`, [source])
    const offline = await (await detail.GET(deviceRequest('detail'), deviceContext())).json()
    assert.equal(offline.device.online, false)
    assert.equal(offline.scheduling.availableSlots, 0)
    assert.deepEqual(offline.directories, [])
  })

  await t.test('calendar counts transitions once and groups retry attempts under the thread root', async () => {
    const metadata = (state: string, key: string) => JSON.stringify({ type: 'doc', attrs: { [key]: { assignee: { kind: 'member', id: member, name: 'Member', image: null },
      pullRequests: state === 'open' ? {} : [{ url: 'https://github.com/example/repo/pull/1', state }] } } })
    for (const [revision, status, prState, at] of [[1, 'todo', 'open', '2026-11-18T12:00:00Z'],
      [2, 'done', 'merged', '2026-11-19T14:00:00Z'], [3, 'done', 'merged', '2026-11-19T15:00:00Z']] as const) {
      await pool.query(`INSERT INTO issue_versions(id,"issueId","userId",revision,title,content,status,priority,actor_type,actor_id,"createdAt")
        VALUES($1,$2,$3,$4,'Fixture',$5::jsonb,$6,'normal','user',$7,$8)`,
      [randomUUID(), issue, owner, revision, metadata(prState, revision < 3 ? 'orvilo' : 'mikka'), status, owner, at])
    }
    principal = { id: owner }
    const response = await readActivity()
    assert.equal(response.status, 200)
    const value = await response.json()
    assert.deepEqual(value.contributions.sort((a: { memberId: string }, b: { memberId: string }) => a.memberId.localeCompare(b.memberId)), [
      { day: '2026-11-19', memberId: owner, completedTasks: 0, mergedPullRequests: 0, threads: 1 },
      { day: '2026-11-19', memberId: member, completedTasks: 1, mergedPullRequests: 1, threads: 0 },
    ].sort((a, b) => a.memberId.localeCompare(b.memberId)))
    assert.deepEqual(value.threadCosts, { available: false, reason: 'thread_cost_ledger_pending', items: null })
    assert.equal(value.dateSource, 'recorded_events')
    assert.ok(!JSON.stringify(value).includes('https://github.com'))
    assert.deepEqual((await (await readActivity('?from=2026-11-20&to=2026-11-20')).json()).contributions, [])
    assert.equal((await readActivity('?from=2026-11-31')).status, 400)
    assert.equal((await readActivity('?groupBy=invalid')).status, 400)
  })

  await t.test('revoked task access also removes checkpoint metadata for the original run owner', async () => {
    principal = { id: owner }
    await pool.query(`UPDATE resource_access_policies SET "ownerId"=$2,visibility='private' WHERE kind='task' AND id=$1`, [issue, member])
    try {
      const value = await (await detail.GET(deviceRequest('detail'), deviceContext())).json()
      assert.deepEqual(value.checkpoints, [])
      assert.deepEqual(value.cloudCheckpoints, [])
    } finally {
      await pool.query('UPDATE resource_access_policies SET "ownerId"=$2 WHERE kind=\'task\' AND id=$1', [issue, owner])
    }
  })

  await t.test('ordinary members, outsiders, suspended administrators and other workspace tokens cannot read the administrator calendar', async () => {
    for (const id of [null, member, outsider]) {
      principal = id ? { id } : null
      assert.equal((await readActivity()).status, 403)
    }
    principal = { id: owner, workspaceId: foreign.id }
    assert.equal((await readActivity()).status, 403)
    principal = { id: owner }
    await pool.query(`UPDATE mikka_workspace_members SET status='suspended' WHERE "workspaceId"=$1 AND "userId"=$2`, [workspace.id, owner])
    assert.equal((await readActivity()).status, 403)
    assert.equal((await detail.GET(deviceRequest('detail'), deviceContext())).status, 403)
  })
})
