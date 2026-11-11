import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import test, { mock } from 'node:test'
import { Pool } from 'pg'
import { disposableDatabase } from './helpers/e2e-target.mjs'
import { dropTestDatabase } from './support/drop-test-database'
import { orderMigrations } from '../scripts/migration-order.mjs'
import { applyMigration, planMigration } from '../scripts/migration-steps.mjs'
import { scopeMigrationBeforeCommit } from '../scripts/scope-migration-history.mjs'
import { backfillProjectV2 } from '../scripts/project-v2-backfill.mjs'
import { backfillProjectResourceAccess } from '../scripts/resource-acl-backfill.mjs'

const url = process.env.E2E_DATABASE_URL
if (url && !disposableDatabase()) throw new Error('Project v2 tests require a loopback *_e2e database')
if (process.env.REQUIRE_DB === '1' && !url) throw new Error('Project v2 database tests cannot skip in required CI')

async function observed(check: () => Promise<boolean>, message: string) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (await check()) return
    await delay(10)
  }
  assert.fail(message)
}

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
  // lib/db/request-scope.ts builds its default pool at module load, before this
  // file can point MIKKA_DATABASE_URL at the databases it just created. A run
  // that arrives with MIKKA_DATABASE_URL already set (CI sets it to the shared
  // E2E database) therefore leaves `db` on that other database while the raw
  // Pools below use the fresh pair, and the two disagree on the same rows.
  // Hand the created pools to the module the way
  // tests/factory-workspace-admission.db.test.ts does, and restore afterwards.
  const globals = globalThis as unknown as { mikkaPool?: Pool; workspacePool?: Pool }
  const previousPools = { app: globals.mikkaPool, workspace: globals.workspacePool }
  globals.mikkaPool = application; globals.workspacePool = workspace
  let workspaceModule: Pool | undefined
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
    const boundary = '20261111030000_project_v2.sql'
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
    await t.test('old writer queued behind the real backfill cannot acknowledge a lost relationship after its receipt commits', async () => {
      const blocker = await application.connect(), writer = await workspace.connect()
      let migration: ReturnType<typeof backfillProjectV2> | undefined
      let oldWrite: Promise<unknown> | undefined
      try {
        await blocker.query('BEGIN')
        await blocker.query('SELECT id FROM issues WHERE id=$1 FOR UPDATE', [initialTasks[0]])
        const blockerPid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
        migration = backfillProjectV2(application, workspace)
        void migration.catch(() => undefined) // awaited below and during cleanup
        // The real backfill holds its Project row locks before requesting these
        // APP task locks. Observe the database wait, not an assumed timer order.
        await observed(async () => Boolean((await application.query(`SELECT 1 FROM pg_stat_activity
          WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))
            AND query LIKE 'SELECT id,"workspaceId","ownershipState" FROM issues%'`, [blockerPid])).rowCount), 'backfill did not reach its locked Task evidence read')
        const writerPid = (await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
        oldWrite = writer.query('UPDATE workspace_projects SET "issueIds"=$2,revision=revision+1,"updatedAt"=now() WHERE id=$1 RETURNING id', [project, '[]'])
          .then(() => ({ accepted: true }), (error: unknown) => ({ error }))
        await observed(async () => Boolean((await workspace.query(`SELECT 1 FROM pg_stat_activity
          WHERE pid=$1 AND wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0`, [writerPid])).rowCount), 'legacy writer did not wait behind the backfill Project lock')
        assert.equal((await workspace.query('SELECT 1 FROM workspace_project_v2_migrations WHERE "projectId"=$1', [project])).rowCount, 0)
        await blocker.query('COMMIT')
        assert.deepEqual(await migration, { projectsBound: 2, projectTasksBound: 121, projectsPending: 4 })
        const outcome = await oldWrite as { accepted?: boolean; error?: { code: string; message: string } }
        assert.equal(outcome.accepted, undefined, 'a legacy-only write must never report success')
        assert.equal(outcome.error?.code, '23514')
        assert.equal(outcome.error?.message, 'projectLegacyWriteDenied')
        assert.equal((await workspace.query('SELECT 1 FROM workspace_project_v2_migrations WHERE "projectId"=$1', [project])).rowCount, 1)
        assert.equal((await workspace.query('SELECT count(*)::int n FROM workspace_project_tasks WHERE "projectId"=$1', [project])).rows[0].n, 121)
      } finally {
        await blocker.query('ROLLBACK')
        await Promise.allSettled([...(migration ? [migration] : []), ...(oldWrite ? [oldWrite] : [])])
        blocker.release(); writer.release()
      }
    })
    assert.deepEqual((await workspace.query('SELECT id,properties,revision,"createdAt","updatedAt" FROM workspace_projects WHERE id=$1', [project])).rows[0], preserved)
    assert.equal((await workspace.query('SELECT "leadUserId" FROM workspace_projects WHERE id=$1', [project])).rows[0].leadUserId, owner)
    assert.deepEqual((await workspace.query('SELECT "userId" FROM workspace_project_members WHERE "projectId"=$1', [project])).rows.map(row => row.userId), [owner])
    assert.deepEqual((await backfillProjectV2(application, workspace)), { projectsBound: 0, projectTasksBound: 0, projectsPending: 4 })
    await workspace.query('DELETE FROM workspace_project_tasks WHERE "issueId"=$1', [initialTasks[0]])
    await backfillProjectV2(application, workspace)
    assert.equal((await workspace.query('SELECT 1 FROM workspace_project_tasks WHERE "issueId"=$1', [initialTasks[0]])).rowCount, 0, 'retry never restores a removed canonical link from legacy JSONB')
    // Production migrate runs the resource ACL backfill after Project v2. The
    // fixture must apply the same step before exercising current readers; the
    // backfill reads the canonical Workspace and relation columns above.
    await backfillProjectResourceAccess(application, workspace)

    // Import the Workspace module so this run resolves it against the Pools injected above.
    const { workspacePool } = await import('../lib/workspace-db'); workspaceModule = workspacePool
    await import('../lib/db')
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

    await t.test('Project history attributes each event to its actor in this workspace for every authorized viewer', async () => {
      await workspace.query('UPDATE mikka_workspace_members SET name=$3 WHERE "workspaceId"=$1 AND "userId"=$2', [alpha, owner, 'Alpha author'])
      await workspace.query('UPDATE mikka_workspace_members SET name=$3 WHERE "workspaceId"=$1 AND "userId"=$2', [beta, owner, 'Other workspace name'])
      const missingActorEvent = randomUUID()
      await workspace.query(`INSERT INTO workspace_project_events(id,"projectId","userId",message) VALUES($1,$2,$3,'Prior change')`, [missingActorEvent, project, outsider])
      for (const viewer of [owner, member]) {
        const history = await actAs(viewer, () => actions.listProjectEvents(project, alpha))
        assert.equal(history.length, 2)
        assert.equal(history.find(event => event.message === 'Existing history')?.actorName, 'Alpha author')
        assert.equal(history.find(event => event.id === missingActorEvent)?.actorName, null)
      }
      await assert.rejects(actAs(outsider, () => actions.listProjectEvents(project, alpha)))
    })

    const draft = { name: 'Same display name', summary: '', description: '', status: 'planned' as const, priority: 'none' as const, lead: '', team: 'Any display text', startDate: '', targetDate: '', properties: { ...properties, members: [] }, workspaceId: alpha }
    const created = await actAs(member, () => actions.saveProject({ ...draft, leadUserId: owner, memberIds: [owner, member] }))
    assert.ok('project' in created, JSON.stringify(created))
    const createdId = created.project.id

    await t.test('upgraded database rejects old inserts and canonical legacy-only writes without altering evidence', async () => {
      const before = (await workspace.query('SELECT to_jsonb(p) AS snapshot FROM workspace_projects p WHERE id=$1', [project])).rows[0].snapshot
      for (const [sql, params] of [
        ['UPDATE workspace_projects SET "issueIds"=$2 WHERE id=$1', [project, '[]']],
        ['UPDATE workspace_projects SET lead=$2 WHERE id=$1', [project, member]],
        ['UPDATE workspace_projects SET properties=jsonb_set(properties,\'{members}\',$2::jsonb) WHERE id=$1', [project, JSON.stringify([member])]],
        ['UPDATE workspace_projects SET "userId"=$2 WHERE id=$1', [project, member]],
      ] as const) await assert.rejects(workspace.query(sql, [...params]), { code: '23514', message: 'projectLegacyWriteDenied' })
      const oldId = randomUUID()
      await assert.rejects(workspace.query(`INSERT INTO workspace_projects(id,"userId",name,summary,description,status,priority,lead,team,"startDate","targetDate",properties,"issueIds",revision)
        VALUES($1,$2,'Old writer','','','planned','none','me','Mikka','','',$3,'[]',1)`, [oldId, owner, properties]), { code: '23514', message: 'projectWorkspaceRequired' })
      assert.equal((await workspace.query('SELECT 1 FROM workspace_projects WHERE id=$1', [oldId])).rowCount, 0)
      assert.deepEqual((await workspace.query('SELECT to_jsonb(p) AS snapshot FROM workspace_projects p WHERE id=$1', [project])).rows[0].snapshot, before)
      await backfillProjectV2(application, workspace)
      const visible = (await accessibleProjects(owner, projectDb, alpha)).find(row => row.id === project)!
      assert.equal(visible.issueIds.length, 120)
      assert.equal(visible.leadUserId, owner)
      assert.deepEqual(visible.memberIds, [owner])
      assert.equal((await workspace.query('SELECT "workspaceId" FROM workspace_projects WHERE id=$1', [unresolved])).rows[0].workspaceId, null, 'existing quarantined evidence is retained')
      assert.equal((await workspace.query('SELECT 1 FROM workspace_project_repairs WHERE "projectId"=$1', [unresolved])).rowCount, 1)
    })

    await t.test('legacy client fields through the current API update canonical people and never leak a writer marker', async () => {
      const saved = await actAs(member, () => actions.saveProject({ ...draft, name: 'Alias-compatible API', lead: 'me', properties: { ...draft.properties, members: ['me'] } }))
      assert.ok('project' in saved, JSON.stringify(saved))
      assert.equal(saved.project.leadUserId, member)
      assert.deepEqual(saved.project.memberIds, [member])
      const edited = await actAs(member, () => actions.updateProjectProperties({ id: saved.project!.id, revision: saved.project!.revision, workspaceId: alpha,
        changes: { lead: owner, properties: { ...draft.properties, members: [owner] } } }))
      assert.ok('project' in edited, JSON.stringify(edited))
      assert.equal(edited.project.leadUserId, owner)
      assert.deepEqual(edited.project.memberIds, [owner])
      const clients = await Promise.all(Array.from({ length: 5 }, () => workspaceModule!.connect()))
      try {
        for (const client of clients) assert.notEqual((await client.query("SELECT current_setting('mikka.project_v2_writer',true) AS marker")).rows[0].marker, '1', 'transaction marker must not survive in a pooled session')
      } finally { clients.forEach(client => client.release()) }
      const marker = await workspace.connect()
      try {
        await marker.query('BEGIN')
        await marker.query("SELECT set_config('mikka.project_v2_writer','1',true)")
        await assert.rejects(marker.query('UPDATE workspace_projects SET "issueIds"=$2 WHERE id=$1', [project, '[]']), { code: '23514', message: 'projectLegacyWriteDenied' })
      } finally { await marker.query('ROLLBACK'); marker.release() }
    })

    await t.test('create and edit stable people IDs; invalid/departed identities never become assignees', async () => {
      assert.ok('project' in created, JSON.stringify(created))
      assert.equal(created.project.workspaceId, alpha)
      assert.equal(created.project.createdBy, member)
      assert.equal(created.project.leadUserId, owner)
      assert.deepEqual(created.project.memberIds.sort(), [member, owner].sort())
      const invalid = await actAs(member, () => actions.updateProjectProperties({ id: createdId, revision: 1, changes: { leadUserId: outsider }, workspaceId: alpha }))
      assert.ok('error' in invalid, JSON.stringify(invalid))
      assert.match(invalid.error, /memberNotJoined/)
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
      assert.equal((await application.query(`SELECT visibility FROM resource_access_policies WHERE kind='task' AND id=$1`, [initialTasks[1]])).rows[0].visibility, 'shared',
        'a member reorganizing shared Projects must not privatize another owner\'s shared Task')
    })

    await t.test('same names and stale JSON never establish membership; renames follow stable IDs', async () => {
      let row = (await accessibleProjects(member, projectDb, alpha)).find(item => item.id === createdId)!
      const renamed = await actAs(member, () => actions.updateProjectProperties({ id: createdId, revision: row.revision, changes: { name: 'Renamed through ID' }, workspaceId: alpha }))
      assert.ok('project' in renamed, JSON.stringify(renamed))
      const views = await projectViewsForTasks([{ id: initialTasks[1], workspaceId: alpha }, { id: initialTasks[0], workspaceId: alpha }, { id: foreignTask, workspaceId: beta }])
      assert.deepEqual(views.get(initialTasks[1]), { projectId: createdId, project: 'Renamed through ID' })
      assert.equal(views.has(initialTasks[0]), false)
      assert.equal(views.has(foreignTask), false)
      assert.equal((await projectViewsForTasks([{ id: initialTasks[1], workspaceId: beta }])).size, 0)
      row = renamed.project
      const concurrent = await Promise.all(['First update', 'Second update'].map(name => actAs(member, () => actions.updateProjectProperties({ id: createdId, revision: row.revision, changes: { name }, workspaceId: alpha }))))
      assert.equal(concurrent.filter(result => 'project' in result).length, 1)
      assert.equal(concurrent.filter(result => 'error' in result).length, 1)
    })

    await t.test('Project audience confirmation precedes all writes and moves detach before attaching regardless of ID order', async () => {
      const candidates = await Promise.all(['First destination', 'Second destination'].map(name =>
        actAs(member, () => actions.saveProject({ ...draft, name }))))
      for (const candidate of candidates) assert.ok('project' in candidate, JSON.stringify(candidate))
      const [destination, source] = candidates.map(candidate => {
        assert.ok('project' in candidate, JSON.stringify(candidate))
        return candidate.project
      }).sort((a, b) => a.id.localeCompare(b.id))
      const [task, batchTask] = await makeTasks(alpha, 2)
      const assigned = await actAs(member, () => actions.setProjectIssues({ id: source.id, revision: source.revision, issueIds: [task], workspaceId: alpha }))
      assert.ok('project' in assigned, JSON.stringify(assigned))
      const { changeResourceAccess } = await import('../lib/resource-access/store')
      const policy = (await application.query(`SELECT revision FROM resource_access_policies WHERE kind='project' AND id=$1`, [destination.id])).rows[0]
      await changeResourceAccess(member, { kind: 'project', id: destination.id, workspaceId: alpha }, { expectedRevision: policy.revision, visibility: 'private', grants: [] })
      const snapshot = async () => ({
        projects: (await workspace.query('SELECT to_jsonb(p) AS row FROM workspace_projects p WHERE id=ANY($1::uuid[]) ORDER BY id', [[source.id, destination.id]])).rows,
        links: (await workspace.query('SELECT * FROM workspace_project_tasks WHERE "issueId"=ANY($1::uuid[]) ORDER BY "issueId"', [[task, batchTask]])).rows,
        tasks: (await application.query('SELECT to_jsonb(i) AS row FROM issues i WHERE id=ANY($1::uuid[]) ORDER BY id', [[task, batchTask]])).rows,
        policies: (await application.query(`SELECT to_jsonb(p) AS row FROM resource_access_policies p WHERE kind='task' AND id=ANY($1::uuid[]) ORDER BY id`, [[task, batchTask]])).rows,
        events: (await workspace.query('SELECT * FROM workspace_project_events WHERE "projectId"=ANY($1::uuid[]) ORDER BY id', [[source.id, destination.id]])).rows,
      })
      const before = await snapshot()
      const refusedMove = await actAs(member, () => actions.moveIssueToProject({ issueId: task, revision: 1, projectId: destination.id, workspaceId: alpha }))
      assert.equal(refusedMove.error, 'accessChangeConfirmationRequired')
      assert.equal(refusedMove.confirmable, true)
      assert.deepEqual(await snapshot(), before, 'refused move leaves both databases unchanged')
      const refusedBatch = await actAs(member, () => actions.setProjectIssues({ id: destination.id, revision: destination.revision, issueIds: [batchTask], workspaceId: alpha }))
      assert.equal(refusedBatch.error, 'accessChangeConfirmationRequired')
      assert.equal(refusedBatch.confirmable, true)
      assert.deepEqual(await snapshot(), before, 'refused batch leaves both databases unchanged')
      const moved = await actAs(member, () => actions.moveIssueToProject({ issueId: task, revision: 1, projectId: destination.id, workspaceId: alpha, confirmAccess: true }))
      assert.ok(moved.issue, JSON.stringify(moved))
      assert.equal((await workspace.query('SELECT "projectId" FROM workspace_project_tasks WHERE "issueId"=$1', [task])).rows[0].projectId, destination.id)
      assert.deepEqual((await application.query(`SELECT "parentKind","parentId",visibility FROM resource_access_policies WHERE kind='task' AND id=$1`, [task])).rows[0],
        { parentKind: 'project', parentId: destination.id, visibility: 'shared' })
      const current = (await accessibleProjects(member, projectDb, alpha)).find(project => project.id === destination.id)!
      const batched = await actAs(member, () => actions.setProjectIssues({ id: destination.id, revision: current.revision, issueIds: [task, batchTask], workspaceId: alpha, confirmAccess: true }))
      assert.ok('project' in batched, JSON.stringify(batched))
      assert.deepEqual(batched.project!.issueIds.sort(), [task, batchTask].sort())
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

    await t.test('the real acceptance seed entry point uses a trusted split-DB Workspace and preserves canonical edits on retry', async () => {
      const guestId = `acceptance-guest-${randomUUID()}`, guestEmail = `acceptance-${randomUUID()}@preview.mikka.invalid`
      await application.query(`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,'Acceptance Guest',$2,true,now(),now())`, [guestId, guestEmail])
      const seed = () => promisify(execFile)(process.execPath, [new URL('../scripts/seed-acceptance-demo.mjs', import.meta.url).pathname, guestEmail], {
        env: { ...process.env, MIKKA_DATABASE_URL: appUrl.toString(), DATABASE_URL: tenantUrl.toString() }, timeout: 60_000,
      })
      const first = JSON.parse((await seed()).stdout)
      assert.deepEqual(first, { guest: guestEmail, workspaceId: first.workspaceId, projects: 3, issues: 21, teamMembers: 4, preservedExistingData: true })
      const tenant = (await workspace.query('SELECT "userId",kind FROM mikka_workspaces WHERE id=$1', [first.workspaceId])).rows[0]
      assert.deepEqual(tenant, { userId: guestId, kind: 'team' })
      const tasks = (await application.query('SELECT id,"workspaceId","ownershipState","issuedIdentifier",content FROM issues WHERE "userId"=$1 ORDER BY id', [guestId])).rows
      assert.equal(tasks.length, 21)
      assert.ok(tasks.every(task => task.workspaceId === first.workspaceId && task.ownershipState === 'bound' && task.issuedIdentifier))
      assert.equal(new Set(tasks.map(task => task.issuedIdentifier)).size, 21)
      assert.ok(tasks.every(task => task.content.attrs.mikka.project === undefined), 'Project names are not a second relationship store')
      const seededProjects = await accessibleProjects(guestId, projectDb, first.workspaceId)
      assert.equal(seededProjects.length, 3)
      assert.ok(seededProjects.every(row => row.issueIds.length === 7 && row.leadUserId === guestId && JSON.stringify(row.memberIds) === JSON.stringify([guestId])))
      const receipts = (await workspace.query('SELECT m.* FROM workspace_project_v2_migrations m JOIN workspace_projects p ON p.id=m."projectId" WHERE p."workspaceId"=$1 ORDER BY m."projectId"', [first.workspaceId])).rows
      assert.equal(receipts.length, 3)
      assert.equal((await workspace.query('SELECT count(*)::int n FROM workspace_projects WHERE "workspaceId"=$1 AND "issueIds"=\'[]\'::jsonb', [first.workspaceId])).rows[0].n, 3)
      await workspace.query('DELETE FROM workspace_project_tasks WHERE "issueId"=$1', [tasks[0].id])
      await workspace.query('UPDATE workspace_projects SET name=\'Edited demo\' WHERE id=$1', [seededProjects[0].id])
      await application.query('UPDATE issues SET title=\'Edited task\' WHERE id=$1', [tasks[0].id])
      const beforeTasks = (await application.query('SELECT to_jsonb(i) AS snapshot FROM issues i WHERE "userId"=$1 ORDER BY id', [guestId])).rows
      const beforeProjects = (await workspace.query('SELECT to_jsonb(p) AS snapshot FROM workspace_projects p WHERE "workspaceId"=$1 ORDER BY id', [first.workspaceId])).rows
      const beforeCounter = (await application.query('SELECT * FROM workspace_task_identifier_counters WHERE "workspaceId"=$1', [first.workspaceId])).rows
      assert.deepEqual(JSON.parse((await seed()).stdout), first)
      await backfillProjectV2(application, workspace)
      assert.deepEqual((await application.query('SELECT to_jsonb(i) AS snapshot FROM issues i WHERE "userId"=$1 ORDER BY id', [guestId])).rows, beforeTasks)
      assert.deepEqual((await workspace.query('SELECT to_jsonb(p) AS snapshot FROM workspace_projects p WHERE "workspaceId"=$1 ORDER BY id', [first.workspaceId])).rows, beforeProjects)
      assert.deepEqual((await application.query('SELECT * FROM workspace_task_identifier_counters WHERE "workspaceId"=$1', [first.workspaceId])).rows, beforeCounter, 'idempotent seed does not consume more stable task numbers')
      assert.deepEqual((await workspace.query('SELECT m.* FROM workspace_project_v2_migrations m JOIN workspace_projects p ON p.id=m."projectId" WHERE p."workspaceId"=$1 ORDER BY m."projectId"', [first.workspaceId])).rows, receipts)
      assert.equal((await workspace.query('SELECT 1 FROM workspace_project_tasks WHERE "issueId"=$1', [tasks[0].id])).rowCount, 0)
      assert.equal((await application.query('SELECT count(*)::int n FROM issue_versions WHERE "userId"=$1', [guestId])).rows[0].n, 21)
      assert.equal((await workspace.query('SELECT count(*)::int n FROM workspace_project_events WHERE "userId"=$1', [guestId])).rows[0].n, 3)
    })

    await t.test('acceptance seed never adopts quarantined or other-Workspace Tasks by creator', async () => {
      for (const workspaceId of [null, alpha]) {
        const guestId = `acceptance-legacy-${randomUUID()}`, guestEmail = `acceptance-${randomUUID()}@preview.mikka.invalid`
        const hash = createHash('sha256').update(`${guestEmail}:demo-v1:issue-0-0`).digest('hex')
        const taskId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`
        await application.query(`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,'Acceptance Guest',$2,true,now(),now())`, [guestId, guestEmail])
        await application.query(`INSERT INTO issues(id,"userId","workspaceId",title,content,status,priority) VALUES($1,$2,$3,'Historical demo','{"type":"doc"}','todo','normal')`, [taskId, guestId, workspaceId])
        const before = (await application.query('SELECT to_jsonb(i) AS snapshot FROM issues i WHERE id=$1', [taskId])).rows[0].snapshot
        await assert.rejects(promisify(execFile)(process.execPath, [new URL('../scripts/seed-acceptance-demo.mjs', import.meta.url).pathname, guestEmail], {
          env: { ...process.env, MIKKA_DATABASE_URL: appUrl.toString(), DATABASE_URL: tenantUrl.toString() }, timeout: 60_000,
        }), /Existing demo Task needs reviewed ownership migration/)
        assert.deepEqual((await application.query('SELECT to_jsonb(i) AS snapshot FROM issues i WHERE id=$1', [taskId])).rows[0].snapshot, before)
        assert.equal((await workspace.query('SELECT 1 FROM workspace_projects WHERE "userId"=$1', [guestId])).rowCount, 0)
        assert.equal((await workspace.query('SELECT 1 FROM mikka_workspaces WHERE "userId"=$1', [guestId])).rowCount, 0)
      }
    })
  } finally {
    headersMock.restore(); localeMock.restore()
    // lib/db and lib/workspace-db export Proxies over the very Pools injected
    // above: `pool.end()` binds to the injected Pool, so passing both the module
    // Proxy and the Bare Pool would end one Pool twice. Restore the globals, then
    // hand dropTestDatabase only the Pools this file created; it ends them and
    // waits for their sockets before the FORCE drop.
    globals.mikkaPool = previousPools.app; globals.workspacePool = previousPools.workspace
    await dropTestDatabase(admin, appName, application)
    await dropTestDatabase(admin, tenantName, workspace)
    await admin.end()
    if (previousEnv.app === undefined) delete process.env.MIKKA_DATABASE_URL; else process.env.MIKKA_DATABASE_URL = previousEnv.app
    if (previousEnv.workspace === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previousEnv.workspace
  }
})
