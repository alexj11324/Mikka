import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import test, { mock } from 'node:test'
import { Pool } from 'pg'
import { disposableDatabase } from './helpers/e2e-target.mjs'
import { dropTestDatabase } from './support/drop-test-database'
import { orderMigrations } from '../scripts/migration-order.mjs'
import { applyMigration, planMigration } from '../scripts/migration-steps.mjs'
import { scopeMigrationBeforeCommit } from '../scripts/scope-migration-history.mjs'
import { backfillProjectV2 } from '../scripts/project-v2-backfill.mjs'

const url = process.env.E2E_DATABASE_URL
if (url && !disposableDatabase()) throw new Error('Project v2 tests require a loopback *_e2e database')
if (process.env.REQUIRE_DB === '1' && !url) throw new Error('Project v2 database tests cannot skip in required CI')

test('Project v2: split database migration, canonical relationships and live tenant permissions', { skip: !url, timeout: 240_000 }, async t => {
  const suffix = randomUUID().replaceAll('-', '')
  const appName = `project_app_${suffix}_e2e`, tenantName = `project_ws_${suffix}_e2e`
  const admin = new Pool({ connectionString: url, max: 1 })
  await admin.query(`CREATE DATABASE "${appName}" TEMPLATE template0`)
  await admin.query(`CREATE DATABASE "${tenantName}" TEMPLATE template0`)
  const appUrl = new URL(url!), tenantUrl = new URL(url!)
  appUrl.pathname = `/${appName}`; tenantUrl.pathname = `/${tenantName}`
  const application = new Pool({ connectionString: appUrl.toString(), max: 5 })
  const workspace = new Pool({ connectionString: tenantUrl.toString(), max: 5 })
  const previousEnv = { app: process.env.MIKKA_DATABASE_URL, workspace: process.env.DATABASE_URL }
  process.env.MIKKA_DATABASE_URL = appUrl.toString(); process.env.DATABASE_URL = tenantUrl.toString()
  let applicationModule: Pool | undefined, workspaceModule: Pool | undefined
  let selectedWorkspace: string | undefined
  const framework = await import('next/headers')
  const headersMock = mock.module('next/headers', { namedExports: { ...framework,
    cookies: async () => ({ get: (name: string) => name === 'mikka-workspace' && selectedWorkspace ? { value: selectedWorkspace } : undefined }),
    headers: async () => new Headers(),
  } })
  const localization = await import('next-intl/server')
  const localeMock = mock.module('next-intl/server', { namedExports: { ...localization, getLocale: async () => 'en', getTranslations: async () => (key: string) => key } })
  try {
    const directory = new URL('../drizzle/', import.meta.url)
    const names = orderMigrations((await readdir(directory)).filter(name => name.endsWith('.sql')))
    const boundary = '20261107230000_project_v2.sql'
    for (const pool of [application, workspace]) await pool.query('CREATE TABLE schema_migrations(name text PRIMARY KEY,"appliedAt" timestamptz NOT NULL DEFAULT now())')
    const migrate = async (files: string[]) => {
      for (const name of files) {
        const source = await readFile(new URL(name, directory), 'utf8')
        const plan = planMigration(name, source)
        const client = await (plan.target === 'DATABASE_URL' ? workspace : application).connect()
        try {
          const scope = scopeMigrationBeforeCommit(name, source)
          await applyMigration(client, name, scope === null ? plan : { ...plan, sql: scope })
          if (scope !== null) await client.query('COMMIT')
        } finally { client.release() }
      }
    }
    await migrate(names.filter(name => name < boundary))
    const owner = `project-owner-${suffix}`, member = `project-member-${suffix}`, outsider = `project-outsider-${suffix}`
    for (const userId of [owner, member, outsider]) await application.query(`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$1,$1||'@project.example.invalid',true,now(),now())`, [userId])
    const alpha = randomUUID(), beta = randomUUID(), firstTeam = randomUUID(), secondTeam = randomUUID()
    for (const [id, userId, kind] of [[alpha, owner, 'team'], [beta, owner, 'team'], [randomUUID(), owner, 'personal'], [randomUUID(), member, 'personal']]) {
      await workspace.query(`INSERT INTO mikka_workspaces(id,"userId",name,kind) VALUES($1,$2,'Project fixture',$3)`, [id, userId, kind])
      await workspace.query(`INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) VALUES($1,$2,$2,$2,'admin','active')`, [id, userId])
    }
    await workspace.query(`INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) VALUES($1,$2,$2,$2,'member','active')`, [alpha, member])
    for (const [id, identifier] of [[firstTeam, 'PA'], [secondTeam, 'PB']]) await workspace.query(`INSERT INTO mikka_teams(id,"workspaceId","userId",name,identifier) VALUES($1,$2,$3,'Grouping',$4)`, [id, alpha, owner, identifier])
    const makeTasks = async (workspaceId: string, count: number) => {
      const ids = Array.from({ length: count }, () => randomUUID())
      await application.query(`INSERT INTO issues(id,"userId","workspaceId",title,content,status,priority,scope)
        SELECT id,$2,$3,'Project task','{"type":"doc"}'::jsonb,'todo','normal','workspace' FROM unnest($1::uuid[]) id`, [ids, owner, workspaceId])
      return ids
    }
    const initialTasks = await makeTasks(alpha, 121)
    const [foreignTask] = await makeTasks(beta, 1), [duplicateTask] = await makeTasks(alpha, 1)
    const project = randomUUID(), empty = randomUUID(), unresolved = randomUUID(), conflict = randomUUID(), duplicateA = randomUUID(), duplicateB = randomUUID()
    const milestone = { id: randomUUID(), name: 'Preserved milestone', targetDate: '2026-12-20', completed: false }
    const properties = { color: 'green' as const, members: ['me'], labels: ['Keep'], dependencyIds: [], milestones: [milestone] }
    const seedLegacy = async (id: string, taskIds: string[], teamIds: string[]) => {
      await workspace.query(`INSERT INTO workspace_projects(id,"userId",name,summary,description,status,priority,lead,team,"startDate","targetDate",properties,"issueIds",revision)
        VALUES($1,$2,'Same display name','','','planned','none','me','Mikka','','',$3,$4,7)`, [id, owner, properties, JSON.stringify(taskIds)])
      for (const teamId of teamIds) await workspace.query(`INSERT INTO mikka_team_projects("projectId","teamId","workspaceId","userId") VALUES($1,$2,$3,$4)`, [id, teamId, alpha, owner])
    }
    await seedLegacy(project, initialTasks, [firstTeam, secondTeam])
    await seedLegacy(empty, [], [firstTeam])
    await seedLegacy(unresolved, [], [])
    await seedLegacy(conflict, [foreignTask], [firstTeam])
    await seedLegacy(duplicateA, [duplicateTask], [])
    await seedLegacy(duplicateB, [duplicateTask], [])
    await workspace.query(`INSERT INTO workspace_project_events(id,"projectId","userId",message) VALUES($1,$2,$3,'Existing history')`, [randomUUID(), project, owner])
    const preserved = (await workspace.query('SELECT id,properties,revision,"createdAt","updatedAt" FROM workspace_projects WHERE id=$1', [project])).rows[0]
    await migrate(names.filter(name => name >= boundary))
    const migrated = await backfillProjectV2(application, workspace)
    assert.deepEqual(migrated, { projectsBound: 2, projectTasksBound: 121, projectsPending: 4 })
    assert.deepEqual((await workspace.query('SELECT id,properties,revision,"createdAt","updatedAt" FROM workspace_projects WHERE id=$1', [project])).rows[0], preserved)
    assert.equal((await workspace.query('SELECT "leadUserId" FROM workspace_projects WHERE id=$1', [project])).rows[0].leadUserId, owner)
    assert.deepEqual((await workspace.query('SELECT "userId" FROM workspace_project_members WHERE "projectId"=$1', [project])).rows.map(row => row.userId), [owner])
    assert.deepEqual((await backfillProjectV2(application, workspace)), { projectsBound: 0, projectTasksBound: 0, projectsPending: 4 })
    await workspace.query('DELETE FROM workspace_project_tasks WHERE "issueId"=$1', [initialTasks[0]])
    await backfillProjectV2(application, workspace)
    assert.equal((await workspace.query('SELECT 1 FROM workspace_project_tasks WHERE "issueId"=$1', [initialTasks[0]])).rowCount, 0, 'retry never restores a removed canonical link from legacy JSONB')

    const { pool } = await import('../lib/db'); applicationModule = pool
    const { workspacePool } = await import('../lib/workspace-db'); workspaceModule = workspacePool
    const { accessibleProjects, projectViewsForTasks, requireProjectWrite } = await import('../lib/project-access')
    const { projectDb } = await import('../lib/db/projects')
    const { withTaskWorkspace } = await import('../lib/task-workspace')
    const { lockTeamRelations } = await import('../lib/team-access')
    const { actAs } = await import('../lib/acting-user')
    const { tokenWorkspace } = await import('../lib/tokens/principal')
    const actions = await import('../app/actions/projects')
    selectedWorkspace = alpha

    await t.test('tenant membership alone grants Project access and quarantine has no creator bypass', async () => {
      assert.deepEqual((await accessibleProjects(member, projectDb, alpha)).map(row => row.id).sort(), [project, empty].sort())
      assert.deepEqual(await accessibleProjects(owner, projectDb), [])
      assert.deepEqual(await accessibleProjects(outsider, projectDb, alpha), [])
      assert.deepEqual(await accessibleProjects(owner, projectDb, beta), [])
      await assert.rejects(accessibleProjects({ id: owner, [tokenWorkspace]: beta }, projectDb, alpha), /workspaceAccessDenied/)
      const visible = (await accessibleProjects(owner, projectDb, alpha)).find(row => row.id === project)!
      assert.equal(visible.issueIds.length, 120)
      assert.deepEqual(visible.memberIds, [owner]); assert.equal(visible.lead, owner)
      assert.equal((await actAs(member, () => actions.listProjectEvents(project, alpha))).length, 1)
    })

    const draft = { name: 'Same display name', summary: '', description: '', status: 'planned' as const, priority: 'none' as const, lead: '', team: 'Any display text', startDate: '', targetDate: '', properties: { ...properties, members: [] }, workspaceId: alpha }
    const created = await actAs(member, () => actions.saveProject({ ...draft, leadUserId: owner, memberIds: [owner, member] }))
    assert.ok(created.project, JSON.stringify(created))
    const createdId = created.project.id

    await t.test('create and edit stable people IDs; invalid/departed identities never become assignees', async () => {
      assert.equal(created.project!.workspaceId, alpha)
      assert.equal(created.project!.createdBy, member)
      assert.equal(created.project!.leadUserId, owner)
      assert.deepEqual(created.project!.memberIds.sort(), [member, owner].sort())
      const invalid = await actAs(member, () => actions.updateProjectProperties({ id: createdId, revision: 1, changes: { leadUserId: outsider }, workspaceId: alpha }))
      assert.match(invalid.error ?? '', /memberNotJoined/)
      const unchanged = (await accessibleProjects(member, projectDb, alpha)).find(row => row.id === createdId)!
      assert.equal(unchanged.revision, 1)
      assert.equal(unchanged.leadUserId, owner)
    })

    await t.test('more than 100 tasks and a different optional Team are allowed in the same tenant', async () => {
      const many = await makeTasks(alpha, 125)
      await workspace.query(`INSERT INTO mikka_team_issues("issueId","teamId","workspaceId","userId") VALUES($1,$2,$3,$4)`, [many[0], secondTeam, alpha, owner])
      await workspace.query(`INSERT INTO mikka_team_projects("projectId","teamId","workspaceId","userId") VALUES($1,$2,$3,$4)`, [createdId, firstTeam, alpha, member])
      const assigned = await actAs(member, () => actions.setProjectIssues({ id: createdId, revision: 1, issueIds: many, workspaceId: alpha }))
      assert.ok('project' in assigned, JSON.stringify(assigned)); assert.equal(assigned.project.issueIds.length, 125)
      const crossTenant = await actAs(member, () => actions.setProjectIssues({ id: createdId, revision: assigned.project.revision, issueIds: [foreignTask], workspaceId: alpha }))
      assert.match(crossTenant.error ?? '', /issueNotFound/)
      const conflictResult = await actAs(member, () => actions.setProjectIssues({ id: createdId, revision: assigned.project.revision, issueIds: [initialTasks[1]], workspaceId: alpha }))
      assert.match(conflictResult.error ?? '', /projectIssueAlreadyLinked/)
      const moved = await actAs(member, () => actions.moveIssueToProject({ issueId: initialTasks[1], revision: 1, projectId: createdId, workspaceId: alpha }))
      assert.ok(moved.issue, JSON.stringify(moved)); assert.equal(moved.issue.id, initialTasks[1])
      assert.equal((await workspace.query('SELECT "projectId" FROM workspace_project_tasks WHERE "issueId"=$1', [initialTasks[1]])).rows[0].projectId, createdId)
      assert.equal((await application.query(`SELECT content->'attrs'->'mikka'->>'project' AS project FROM issues WHERE id=$1`, [initialTasks[1]])).rows[0].project, null, 'move does not recreate the retired project-name authority')
      await backfillProjectV2(application, workspace)
      assert.equal((await workspace.query('SELECT "projectId" FROM workspace_project_tasks WHERE "issueId"=$1', [initialTasks[1]])).rows[0].projectId, createdId)
    })

    await t.test('same names and stale JSON never establish membership; renames follow stable IDs', async () => {
      let row = (await accessibleProjects(member, projectDb, alpha)).find(item => item.id === createdId)!
      const renamed = await actAs(member, () => actions.updateProjectProperties({ id: createdId, revision: row.revision, changes: { name: 'Renamed through ID' }, workspaceId: alpha }))
      assert.ok(renamed.project, JSON.stringify(renamed))
      const views = await projectViewsForTasks([{ id: initialTasks[1], workspaceId: alpha }, { id: initialTasks[0], workspaceId: alpha }, { id: foreignTask, workspaceId: beta }])
      assert.deepEqual(views.get(initialTasks[1]), { projectId: createdId, project: 'Renamed through ID' })
      assert.equal(views.has(initialTasks[0]), false)
      assert.equal(views.has(foreignTask), false)
      assert.equal((await projectViewsForTasks([{ id: initialTasks[1], workspaceId: beta }])).size, 0)
      row = renamed.project
      const concurrent = await Promise.all(['First update', 'Second update'].map(name => actAs(member, () => actions.updateProjectProperties({ id: createdId, revision: row.revision, changes: { name }, workspaceId: alpha }))))
      assert.equal(concurrent.filter(result => result.project).length, 1)
      assert.equal(concurrent.filter(result => result.error).length, 1)
    })

    await t.test('fresh membership and pinned Workspace gate writes, including the creator', async () => {
      await withTaskWorkspace(member, alpha, async (_workspace, tx) => {
        await lockTeamRelations(tx)
        assert.equal((await requireProjectWrite(tx, member, createdId, alpha)).id, createdId)
      })
      await assert.rejects(withTaskWorkspace({ id: member, [tokenWorkspace]: beta }, alpha, async (_workspace, tx) => requireProjectWrite(tx, member, createdId, alpha)), /workspaceAccessDenied/)
      await workspace.query(`UPDATE mikka_workspace_members SET status='suspended' WHERE "workspaceId"=$1 AND "userId"=$2`, [alpha, member])
      assert.deepEqual(await accessibleProjects(member, projectDb, alpha), [])
      await assert.rejects(withTaskWorkspace(member, alpha, async (_workspace, tx) => requireProjectWrite(tx, member, createdId, alpha)), /workspaceAccessDenied/)
      assert.ok((await accessibleProjects(owner, projectDb, alpha)).some(row => row.id === createdId), 'creator departure preserves the Workspace project')
    })

    await t.test('database constraints prohibit tenant transfer, duplicate assignment and cross-tenant links', async () => {
      await assert.rejects(workspace.query('UPDATE workspace_projects SET "workspaceId"=$2 WHERE id=$1', [createdId, beta]), /projectWorkspaceTransferDenied/)
      await assert.rejects(workspace.query('INSERT INTO workspace_project_tasks("issueId","projectId","workspaceId") VALUES($1,$2,$3)', [randomUUID(), createdId, beta]), { code: '23503' })
      await assert.rejects(workspace.query('INSERT INTO workspace_project_tasks("issueId","projectId","workspaceId") VALUES($1,$2,$3)', [initialTasks[1], project, alpha]), { code: '23505' })
    })
  } finally {
    headersMock.restore(); localeMock.restore()
    await Promise.all([applicationModule?.end(), workspaceModule?.end(), application.end(), workspace.end()])
    await dropTestDatabase(admin, appName); await dropTestDatabase(admin, tenantName); await admin.end()
    if (previousEnv.app === undefined) delete process.env.MIKKA_DATABASE_URL; else process.env.MIKKA_DATABASE_URL = previousEnv.app
    if (previousEnv.workspace === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previousEnv.workspace
  }
})
