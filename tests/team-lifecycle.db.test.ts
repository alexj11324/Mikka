import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { count, dbUrl, seedAgent, seedIssue, seedPersonalWorkspace, seedProject, seedRun, seedTeam, seedTeamIssue, seedUser, seedWorkspace } from './support/workspace-admin-db'

test('Team lifecycle preserves canonical workspace objects and their history', { skip: !dbUrl }, async t => {
  const intl = await import('next-intl/server')
  mock.module('next-intl/server', { namedExports: { ...intl, getLocale: async () => 'en',
    getTranslations: async () => Object.assign((key: string) => key, { has: () => true }) } })
  t.after(() => mock.restoreAll())
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: dbUrl, max: 4 })
  const lifecycle = await import('../lib/workspace-admin/teams')
  const { WorkspaceError } = await import('../lib/workspace-access')
  const { accessibleTeams, accessibleTeamScopes, lockTeamRelations, requireActiveTeam } = await import('../lib/team-access')
  const { pool: appPool } = await import('../lib/db')
  const { workspaceDb, workspacePool } = await import('../lib/workspace-db')
  t.after(async () => { await Promise.all([pool.end(), appPool.end(), workspacePool.end()]) })
  const rejects = (promise: Promise<unknown>, code: string) => assert.rejects(promise, (error: unknown) => error instanceof WorkspaceError && error.code === code)
  const admin = await seedUser(pool, 'lifecycle-admin'), member = await seedUser(pool, 'lifecycle-member'), foreignAdmin = await seedUser(pool, 'lifecycle-foreign')
  const workspace = await seedWorkspace(pool, admin, [{ userId: admin, role: 'admin' }, { userId: member, role: 'member' }])
  const foreign = await seedWorkspace(pool, foreignAdmin, [{ userId: foreignAdmin, role: 'admin' }])
  const team = await seedTeam(pool, workspace.id, admin, 'Platform'), sibling = await seedTeam(pool, workspace.id, admin, 'Design')
  const foreignTeam = await seedTeam(pool, foreign.id, foreignAdmin)
  const task = await seedTeamIssue(pool, workspace.id, team.id, admin)
  const ungrouped = await seedIssue(pool, member, workspace.id)
  const foreignTask = await seedTeamIssue(pool, foreign.id, foreignTeam.id, foreignAdmin)
  const project = await seedProject(pool, admin, [{ teamId: team.id, workspaceId: workspace.id }, { teamId: sibling.id, workspaceId: workspace.id }])
  await pool.query('insert into workspace_project_tasks ("issueId","projectId","workspaceId") values ($1,$2,$3)', [task, project, workspace.id])
  const event = randomUUID()
  await pool.query('insert into workspace_project_events (id,"projectId","userId",message) values ($1,$2,$3,\'history\')', [event, project, admin])
  const agent = await seedAgent(pool, admin)
  const run = await seedRun(pool, { userId: admin, agentId: agent, issueId: task, workspaceId: workspace.id, status: 'succeeded' })
  const publication = { url: 'https://github.com/example/fixture/pull/17', state: 'merged' }
  await pool.query(`insert into run_publications ("runId","userId","issueId","remoteUrl","remoteKey",identifier,branch,status,"pullRequest")
    values ($1,$2,$3,'https://github.com/example/fixture.git','example/fixture','PLAT-17','mikka/PLAT-17','published',$4)`, [run, admin, task, JSON.stringify(publication)])
  const history = async () => ({
    task: (await pool.query('select * from issues where id=$1', [task])).rows,
    run: (await pool.query('select * from agent_runs where id=$1', [run])).rows,
    publication: (await pool.query('select * from run_publications where "runId"=$1', [run])).rows,
    project: (await pool.query('select * from workspace_projects where id=$1', [project])).rows,
    relation: (await pool.query('select * from workspace_project_tasks where "issueId"=$1', [task])).rows,
    event: (await pool.query('select * from workspace_project_events where id=$1', [event])).rows,
  })
  const before = await history()

  await t.test('personal workspaces reject Team creation at the database boundary', async () => {
    const personal = await seedPersonalWorkspace(pool, admin)
    await assert.rejects(seedTeam(pool, personal, admin), /teamPersonalWorkspace/)
    assert.equal(await count(pool, 'mikka_teams where "workspaceId"=$1', [personal]), 0)
  })

  await t.test('legacy Personal Teams stay repairable but cannot receive new grouping or members', async () => {
    const legacyOwner = await seedUser(pool, 'legacy-personal-team')
    const legacyWorkspace = { id: await seedPersonalWorkspace(pool, legacyOwner) }
    await assert.rejects(pool.query('update mikka_workspaces set kind=\'team\' where id=$1', [legacyWorkspace.id]), {
      code: '23514', message: 'workspace kind and personal ownership are immutable',
    })
    const personalTask = await seedIssue(pool, legacyOwner, legacyWorkspace.id)
    // Like the model-order migration fixture, create historical rows only in
    // connection-private copies, before attaching the real current guards.
    // The public tables and their guards stay enabled throughout this case.
    await workspaceDb.transaction(async () => {
      await workspacePool.query('SET LOCAL search_path=pg_temp,public')
      await workspacePool.query('CREATE TEMP TABLE mikka_teams (LIKE public.mikka_teams INCLUDING ALL) ON COMMIT DROP')
      await workspacePool.query('CREATE TEMP TABLE mikka_team_members (LIKE public.mikka_team_members INCLUDING ALL) ON COMMIT DROP')
      const legacyTeam = await seedTeam(workspacePool, legacyWorkspace.id, legacyOwner, 'Legacy Personal Team')
      await workspacePool.query(`CREATE TRIGGER check_team_workspace_kind BEFORE INSERT OR UPDATE OF "workspaceId" ON pg_temp.mikka_teams
        FOR EACH ROW EXECUTE FUNCTION public.check_team_workspace_kind();
        CREATE TRIGGER check_active_team_relation BEFORE INSERT OR UPDATE ON pg_temp.mikka_team_members
        FOR EACH ROW EXECUTE FUNCTION public.check_active_team_relation()`)
      assert.equal(await count(pool, 'public.mikka_teams where id=$1', [legacyTeam.id]), 0,
        'the legacy Team exists only on the pinned Workspace connection')
      assert.deepEqual(await accessibleTeams(legacyOwner, legacyWorkspace.id, { includeArchived: true }), [])
      // Expected SQL errors need their own savepoint; otherwise PostgreSQL
      // would abort the outer transaction before the lifecycle is exercised.
      const guarded = (text: string, values: unknown[]) => workspaceDb.transaction(() => workspacePool.query(text, values))
      await assert.rejects(workspaceDb.transaction(() => seedTeam(workspacePool, legacyWorkspace.id, legacyOwner)), /teamPersonalWorkspace/)
      await assert.rejects(guarded('insert into mikka_team_issues("issueId","teamId","workspaceId","userId") values($1,$2,$3,$4)', [personalTask, legacyTeam.id, legacyWorkspace.id, legacyOwner]), /teamPersonalWorkspace/)
      await assert.rejects(guarded('insert into mikka_team_projects("projectId","teamId","workspaceId","userId") values($1,$2,$3,$4)', [randomUUID(), legacyTeam.id, legacyWorkspace.id, legacyOwner]), /teamPersonalWorkspace/)
      await assert.rejects(guarded('insert into mikka_team_members("teamId","userId") values($1,$2)', [legacyTeam.id, member]), /teamPersonalWorkspace/)
      // Each real lifecycle operation must find the connection-private Team;
      // falling back to a second pool connection would raise teamNotFound.
      assert.ok((await lifecycle.archiveTeamData(legacyOwner, legacyTeam.id)).archivedAt)
      assert.equal((await lifecycle.restoreTeamData(legacyOwner, legacyTeam.id)).archivedAt, null)
      await lifecycle.removeTeamGroupingData(legacyOwner, legacyTeam.id, legacyTeam.name)
      assert.equal(await count(workspacePool, 'pg_temp.mikka_teams where id=$1', [legacyTeam.id]), 0)
    })
    assert.equal(await count(pool, 'issues where id=$1 and "workspaceId"=$2', [personalTask, legacyWorkspace.id]), 1)
  })

  await t.test('only active workspace admins can inspect or mutate the lifecycle', async () => {
    for (const actor of [member, foreignAdmin]) {
      await rejects(lifecycle.teamLifecycleImpact(actor, team.id), 'workspaceAccessDenied')
      await rejects(lifecycle.archiveTeamData(actor, team.id), 'workspaceAccessDenied')
      await rejects(lifecycle.restoreTeamData(actor, team.id), 'workspaceAccessDenied')
      await rejects(lifecycle.removeTeamGroupingData(actor, team.id, team.name), 'workspaceAccessDenied')
      await rejects(lifecycle.deleteTeamData(actor, team.id, team.name), 'workspaceAccessDenied')
      await rejects(lifecycle.readTeamLifecycleAudit(actor, workspace.id, team.id), 'workspaceAccessDenied')
    }
    await rejects(lifecycle.archiveTeamData(admin, foreignTeam.id), 'workspaceAccessDenied')
    assert.equal(await count(pool, 'team_lifecycle_events where "teamId"=$1', [team.id]), 0)
  })

  await t.test('concurrent Team writes keep shared workspace authority without a lock upgrade', async () => {
    const { sql } = await import('drizzle-orm')
    const { withTaskWorkspace } = await import('../lib/task-workspace')
    let arrived = 0
    let release!: () => void
    const ready = new Promise<void>(resolve => { release = resolve })
    const write = async () => {
      try {
        return await withTaskWorkspace(admin, workspace.id, async (_scope, tx) => {
          await tx.execute(sql`set local lock_timeout = '2s'`)
          // Reproduce the two real setIssueTeam/setProjectTeams callbacks:
          // both hold Workspace/member SHARE before asking for the relation lock.
          if (++arrived === 2) release()
          await ready
          await lockTeamRelations(tx)
          return (await requireActiveTeam(tx, team.id, admin)).id
        })
      } catch (error) {
        release()
        throw error
      }
    }
    assert.deepEqual(await Promise.all([write(), write()]), [team.id, team.id])
  })

  await t.test('a foreign Team is rejected before taking any destination workspace lock', async () => {
    const { sql } = await import('drizzle-orm')
    const { withTaskWorkspace } = await import('../lib/task-workspace')
    const blockedTenant = await pool.connect()
    try {
      await blockedTenant.query('begin')
      await blockedTenant.query('select id from mikka_workspaces where id=$1 for update', [foreign.id])
      await rejects(withTaskWorkspace(admin, workspace.id, async (_scope, tx) => {
        await tx.execute(sql`set local lock_timeout = '150ms'`)
        await lockTeamRelations(tx)
        await requireActiveTeam(tx, foreignTeam.id, admin, false, workspace.id)
      }), 'workspaceAccessDenied')
    } finally {
      await blockedTenant.query('rollback')
      blockedTenant.release()
    }
  })

  await t.test('preview counts shared projects and real Run/PR references; nonempty hard delete refuses', async () => {
    assert.deepEqual(await lifecycle.teamDeletionImpact(admin, team.id), {
      teamId: team.id, name: team.name, tasks: 1, projects: 1, runs: 1, pullRequests: 1,
      archivedAt: null, canDelete: false, recovery: 'restore_archive',
    })
    await rejects(lifecycle.deleteTeamData(admin, team.id, 'wrong'), 'teamDeleteNameMismatch')
    await rejects(lifecycle.deleteTeamData(admin, team.id, team.name), 'teamDeleteReferenced')
    assert.deepEqual(await history(), before)
  })

  await t.test('archive is idempotent and restores the same group with unchanged business history', async () => {
    const archived = await lifecycle.archiveTeamData(admin, team.id)
    assert.ok(archived.archivedAt)
    assert.ok(archived.auditId)
    assert.deepEqual(await lifecycle.archiveTeamData(admin, team.id), { teamId: team.id, archivedAt: archived.archivedAt, auditId: null })
    assert.equal((await accessibleTeams(member, workspace.id)).some(row => row.id === team.id), false)
    assert.equal((await accessibleTeams(member, workspace.id, { includeArchived: true })).some(row => row.id === team.id), true)
    assert.equal((await accessibleTeamScopes(member, workspace.id)).some(row => row.id === team.id), true, 'archive does not revoke access to history')
    assert.equal(await count(pool, 'mikka_team_issues where "teamId"=$1', [team.id]), 1)
    assert.deepEqual(await history(), before)
    const restored = await lifecycle.restoreTeamData(admin, team.id)
    assert.equal(restored.archivedAt, null)
    assert.ok(restored.auditId)
    assert.deepEqual(await lifecycle.restoreTeamData(admin, team.id), { teamId: team.id, archivedAt: null, auditId: null })
    assert.equal((await accessibleTeams(member, workspace.id)).some(row => row.id === team.id), true)
    assert.deepEqual(await history(), before)
    assert.deepEqual((await lifecycle.readTeamLifecycleAudit(admin, workspace.id, team.id)).map(row => row.action).sort(), ['archived', 'restored'])
  })

  await t.test('archived Team rejects new tasks, projects and members before any APP saga write', async () => {
    await lifecycle.archiveTeamData(admin, team.id)
    const newTask = await seedIssue(pool, admin, workspace.id)
    await assert.rejects(pool.query('insert into mikka_team_issues ("issueId","teamId","workspaceId","userId") values ($1,$2,$3,$4)', [newTask, team.id, workspace.id, admin]), /teamArchived/)
    await assert.rejects(pool.query('insert into mikka_team_projects ("projectId","teamId","workspaceId","userId") values ($1,$2,$3,$4)', [randomUUID(), team.id, workspace.id, admin]), /teamArchived/)
    await assert.rejects(pool.query('insert into mikka_team_members ("teamId","userId") values ($1,$2)', [team.id, member]), /teamArchived/)
    const requestId = randomUUID(), title = `archived-${requestId}`
    const { createTeamIssueForUser } = await import('../lib/team-issue-create')
    const created = await createTeamIssueForUser(admin, { requestId, teamId: team.id, title, content: { type: 'doc', content: [] }, status: 'todo', priority: 'normal' })
    assert.equal('error' in created && created.error, 'teamIssueAccessDenied')
    assert.equal(await count(pool, 'issues where title=$1', [title]), 0)
    assert.equal(await count(pool, 'team_issue_create_requests where "requestId"=$1', [requestId]), 0)
    assert.deepEqual(await history(), before)
  })

  await t.test('remove-grouping leaves Task/Project/Run/PR/event and stable aliases in their workspace', async () => {
    const aliases = (await pool.query('select identifier from mikka_task_identifier_aliases where "issueId"=$1 order by identifier', [task])).rows
    assert.ok(aliases.length)
    await rejects(lifecycle.removeTeamGroupingData(admin, team.id, 'wrong'), 'teamDeleteNameMismatch')
    const removed = await lifecycle.removeTeamGroupingData(admin, team.id, team.name)
    assert.deepEqual(removed.removed, { teamId: team.id, tasks: 1, projects: 1 })
    assert.equal(await count(pool, 'mikka_teams where id=$1', [team.id]), 0)
    assert.equal(await count(pool, 'mikka_team_issues where "teamId"=$1', [team.id]), 0)
    assert.equal(await count(pool, 'mikka_team_projects where "projectId"=$1 and "teamId"=$2', [project, sibling.id]), 1)
    assert.deepEqual(await history(), before)
    assert.equal(await count(pool, 'issues where id=$1 and "workspaceId"=$2', [ungrouped, workspace.id]), 1)
    assert.equal(await count(pool, 'issues where id=$1 and "workspaceId"=$2', [foreignTask, foreign.id]), 1)
    assert.deepEqual((await pool.query('select identifier from mikka_task_identifier_aliases where "issueId"=$1 order by identifier', [task])).rows, aliases)
    const audit = (await lifecycle.readTeamLifecycleAudit(admin, workspace.id, team.id)).find(row => row.id === removed.auditId)
    assert.equal(audit?.action, 'grouping_removed')
    assert.equal(audit?.snapshot.tasks[0].id, task)
    assert.equal(audit?.snapshot.projects[0].id, project)
    assert.equal(audit?.snapshot.runs, 1)
    assert.equal(audit?.snapshot.pullRequests, 1)
    await rejects(lifecycle.restoreTeamData(admin, team.id), 'teamNotFound')
  })

  await t.test('empty hard delete is explicit and audited, frozen Run references still block it', async () => {
    const empty = await seedTeam(pool, workspace.id, admin, 'Empty')
    assert.equal((await lifecycle.teamDeletionImpact(admin, empty.id)).canDelete, true)
    const deleted = await lifecycle.deleteTeamData(admin, empty.id, empty.name)
    assert.deepEqual(deleted.deleted, { tasks: 0, projects: 0 })
    assert.equal((await lifecycle.readTeamLifecycleAudit(admin, workspace.id, empty.id))[0]?.action, 'deleted')
    const historical = await seedTeam(pool, workspace.id, admin, 'Historical')
    const historyRun = await seedRun(pool, { userId: admin, agentId: agent, workspaceId: workspace.id })
    await pool.query('update agent_runs set cli_policy_hierarchy=$2 where id=$1', [historyRun, JSON.stringify({ teamId: historical.id, workspaceId: workspace.id })])
    assert.equal((await lifecycle.teamDeletionImpact(admin, historical.id)).runs, 1)
    await rejects(lifecycle.deleteTeamData(admin, historical.id, historical.name), 'teamDeleteReferenced')
    await lifecycle.removeTeamGroupingData(admin, historical.id, historical.name)
    assert.equal(await count(pool, 'agent_runs where id=$1', [historyRun]), 1)
  })

  await t.test('pending legacy ownership cannot lose its only Team evidence', async () => {
    const legacyTeam = await seedTeam(pool, workspace.id, admin, 'Legacy'), legacyTask = randomUUID()
    await pool.query(`insert into issues (id,"userId",title,content,status,priority) values ($1,$2,'Legacy','{}','todo','normal')`, [legacyTask, admin])
    await pool.query('insert into mikka_team_issues ("issueId","teamId","workspaceId","userId") values ($1,$2,$3,$4)', [legacyTask, legacyTeam.id, workspace.id, admin])
    await rejects(lifecycle.removeTeamGroupingData(admin, legacyTeam.id, legacyTeam.name), 'teamLifecycleConflict')
    assert.equal(await count(pool, 'mikka_team_issues where "issueId"=$1', [legacyTask]), 1)
    assert.equal(await count(pool, 'team_lifecycle_events where "teamId"=$1', [legacyTeam.id]), 0)
  })

  await t.test('a stale cross-tenant Task link cannot expose foreign impact or be removed as if it were local', async () => {
    const malformed = await seedTeam(pool, workspace.id, admin, 'Malformed'), foreignIssue = await seedIssue(pool, foreignAdmin, foreign.id)
    const foreignAgent = await seedAgent(pool, foreignAdmin)
    await seedRun(pool, { userId: foreignAdmin, agentId: foreignAgent, issueId: foreignIssue, workspaceId: foreign.id })
    // Simulate historical split-database evidence: the WS pair is valid but the
    // Task's canonical APP tenant is different. The link must never grant ACL.
    await pool.query('insert into mikka_team_issues ("issueId","teamId","workspaceId","userId") values ($1,$2,$3,$4)', [foreignIssue, malformed.id, workspace.id, foreignAdmin])
    const impact = await lifecycle.teamLifecycleImpact(admin, malformed.id)
    assert.equal(impact.tasks, 0)
    assert.equal(impact.runs, 0)
    assert.equal(impact.canDelete, false)
    await rejects(lifecycle.removeTeamGroupingData(admin, malformed.id, malformed.name), 'teamLifecycleConflict')
    assert.equal(await count(pool, 'issues where id=$1 and "workspaceId"=$2', [foreignIssue, foreign.id]), 1)
  })

  await t.test('archive row lock serializes a concurrent direct relation insertion', async () => {
    const concurrent = await seedTeam(pool, workspace.id, admin, 'Concurrent'), newTask = await seedIssue(pool, admin, workspace.id)
    const archive = await pool.connect(), writer = await pool.connect()
    try {
      await archive.query('begin')
      await archive.query('update mikka_teams set "archivedAt"=now(),"archivedBy"=$2 where id=$1', [concurrent.id, admin])
      await writer.query("set lock_timeout='150ms'")
      await assert.rejects(writer.query('insert into mikka_team_issues ("issueId","teamId","workspaceId","userId") values ($1,$2,$3,$4)', [newTask, concurrent.id, workspace.id, admin]), (error: unknown) => (error as { code?: string }).code === '55P03')
      await archive.query('commit')
      await assert.rejects(writer.query('insert into mikka_team_issues ("issueId","teamId","workspaceId","userId") values ($1,$2,$3,$4)', [newTask, concurrent.id, workspace.id, admin]), /teamArchived/)
      assert.equal(await count(pool, 'mikka_team_issues where "issueId"=$1', [newTask]), 0)
    } finally {
      await archive.query('rollback')
      await writer.query('reset lock_timeout')
      archive.release(); writer.release()
    }
  })
})
