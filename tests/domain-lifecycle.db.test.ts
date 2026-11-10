import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import test from 'node:test'
import { Pool } from 'pg'
import { orderMigrations } from '../scripts/migration-order.mjs'
import { applyMigration, planMigration } from '../scripts/migration-steps.mjs'
import { scopeMigrationBeforeCommit } from '../scripts/scope-migration-history.mjs'
import { dropTestDatabase } from './support/drop-test-database'
import { count, dbUrl, seedAgent, seedIssue, seedPersonalWorkspace, seedProject, seedProjectTasks, seedRun, seedTeam, seedTeamIssue, seedUser, seedWorkspace } from './support/workspace-admin-db'

test('account and workspace deletion preserve the canonical Project history boundary', { skip: !dbUrl, timeout: 180_000 }, async t => {
  const admin = new Pool({ connectionString: dbUrl, max: 1 })
  const database = 'domain_lifecycle_' + randomUUID().replaceAll('-', '') + '_e2e'
  const isolated = new URL(dbUrl!); isolated.pathname = '/' + database
  const connection = new Pool({ connectionString: isolated.toString(), max: 3 })
  const modulePools: Pool[] = []
  const previousEnv = { E2E_DATABASE_URL: process.env.E2E_DATABASE_URL,
    MIKKA_DATABASE_URL: process.env.MIKKA_DATABASE_URL, DATABASE_URL: process.env.DATABASE_URL }
  t.after(async () => {
    try { await dropTestDatabase(admin, database, connection, ...modulePools) }
    finally {
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      await admin.end()
    }
  })
  await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`)
  Object.assign(process.env, { E2E_DATABASE_URL: isolated.toString(), MIKKA_DATABASE_URL: isolated.toString(), DATABASE_URL: isolated.toString() })
  await connection.query('CREATE TABLE schema_migrations(name text PRIMARY KEY,"appliedAt" timestamptz NOT NULL DEFAULT now())')
  const directory = new URL('../drizzle/', import.meta.url)
  const names = orderMigrations((await readdir(directory)).filter(name => name.endsWith('.sql')))
  const boundary = '20261110151008_project_writer_fence.sql'
  const migrate = async (files: string[]) => {
    for (const name of files) {
      const source = await readFile(new URL(name, directory), 'utf8')
      const plan = planMigration(name, source)
      const client = await connection.connect()
      try {
        const scope = scopeMigrationBeforeCommit(name, source)
        await applyMigration(client, name, scope === null ? plan : { ...plan, sql: scope })
        if (scope !== null) await client.query('COMMIT')
      } finally { client.release() }
    }
  }
  await migrate(names.filter(name => name < boundary))
  // These are historical unbound rows, created under the real pre-fence
  // schema. Current writers must never fabricate new quarantined Projects.
  const legacyProjectSql = `insert into workspace_projects(id,"userId",name,summary,description,status,priority,lead,team,"startDate","targetDate","issueIds",revision)
    values($1,$2,'Legacy lifecycle project','','','planned','none','','','','','[]',1)`
  const legacyPending: Array<{ departing: string; pendingProject: string }> = []
  for (const label of ['domain-old-receipt', 'domain-empty-project-journal']) {
    const departing = await seedUser(connection, label), pendingProject = randomUUID()
    await connection.query(legacyProjectSql, [pendingProject, departing])
    legacyPending.push({ departing, pendingProject })
  }
  const [oldReceipt, oldJournal] = legacyPending
  await migrate(names.filter(name => name >= boundary))
  assert.equal(await count(connection, 'schema_migrations where name=$1', [boundary]), 1)
  await assert.rejects(connection.query(legacyProjectSql, [randomUUID(), oldReceipt.departing]), { code: '23514', message: 'projectWorkspaceRequired' })
  assert.equal(await count(connection, 'workspace_projects where id=any($1::uuid[]) and "workspaceId" is null', [legacyPending.map(row => row.pendingProject)]), 2)
  assert.equal(await count(connection, 'workspace_project_v2_migrations where "projectId"=any($1::uuid[])', [legacyPending.map(row => row.pendingProject)]), 0)

  const { observePoolCommits } = await import('../lib/db/commit-effects')
  observePoolCommits(connection)
  const { workspaceDb, workspacePool } = await import('../lib/workspace-db')
  modulePools.push(workspacePool)
  const { pool: appPool } = await import('../lib/db')
  modulePools.push(appPool)
  const account = await import('../lib/account/delete')
  const teamLifecycle = await import('../lib/workspace-admin/teams')
  const general = await import('../lib/workspace-admin/general')

  const seedUngroupedProject = async (creator: string, workspaceId: string) => {
    const id = randomUUID()
    await connection.query(`insert into workspace_projects(id,"userId","workspaceId",name,summary,description,status,priority,lead,team,"startDate","targetDate","issueIds",revision)
      values($1,$2,$3,'Lifecycle project','','','planned','none','','','','','[]',1)`, [id, creator, workspaceId])
    return id
  }
  const seedDecision = async (creator: string, workspaceId: string, projectId: string, issueId: string | null) => {
    const decisionId = randomUUID(), sourceId = randomUUID()
    await connection.query(`insert into project_decisions(id,"ownerId","workspaceId","projectId","issueId",kind,title,summary,reason,provenance,"captureMode","decidedBy","recordedBy","occurredAt","idempotencyKey","payloadHash")
      values($1,$2,$3,$4,$5,'confirm','Retain history','Historical decision','The workspace keeps its project evidence','recorded','human_marked',$6,$7,now(),$8,$9)`,
    [decisionId, creator, workspaceId, projectId, issueId, JSON.stringify({ kind: 'human', id: creator }),
      JSON.stringify({ kind: 'human', id: creator, userId: creator, botId: null, runId: null, modelId: null, harness: null, identityAssurance: 'human_session' }), randomUUID(), 'a'.repeat(64)])
    await connection.query(`insert into project_decision_sources(id,"decisionId","ownerId","workspaceId",role,"sourceType","sourceId",locator,relation,"normalizedKey","verifiedAt")
      values($1,$2,$3,$4,'evidence','issue',$5,$6,'declared',$7,now())`, [sourceId, decisionId, creator, workspaceId, issueId ?? projectId, JSON.stringify({ type: 'issue', id: issueId ?? projectId }), randomUUID()])
    return { decisionId, sourceId }
  }
  const seedResources = async (creator: string, workspaceId: string, projectId: string) => {
    const environmentId = randomUUID(), eventId = randomUUID()
    await connection.query('insert into workspace_environments(id,"workspaceId",name,configuration,"createdBy","updatedBy") values($1,$2,\'Lifecycle environment\',\'{}\',$3,$3)', [environmentId, workspaceId, creator])
    await connection.query('insert into workspace_project_environments("projectId","workspaceId","environmentId","isDefault") values($1,$2,$3,true)', [projectId, workspaceId, environmentId])
    await connection.query('insert into workspace_project_repositories("projectId","workspaceId","repositoryKey","environmentId","isPrimary") values($1,$2,\'example/lifecycle-fixture\',$3,true)', [projectId, workspaceId, environmentId])
    await connection.query('insert into workspace_resource_events(id,"workspaceId","actorId",kind,"resourceId",detail) values($1,$2,$3,\'project_resources_updated\',$4,\'{}\')', [eventId, workspaceId, creator, projectId])
    return { environmentId, eventId }
  }

  await t.test('account deletion retains ungrouped shared Projects, decisions/sources, Team aliases and other owners runs', async () => {
    const departing = await seedUser(connection, 'domain-departing'), admin = await seedUser(connection, 'domain-admin')
    const personal = await seedPersonalWorkspace(connection, departing)
    const soloShared = await seedWorkspace(connection, departing, [{ userId: departing, role: 'admin' }])
    await seedIssue(connection, departing, soloShared.id)
    const shared = await seedWorkspace(connection, admin, [{ userId: admin, role: 'admin' }, { userId: departing, role: 'member' }])
    const former = await seedWorkspace(connection, admin, [{ userId: admin, role: 'admin' }])
    const team = await seedTeam(connection, shared.id, admin)
    const task = await seedTeamIssue(connection, shared.id, team.id, departing)
    const privateTask = await seedIssue(connection, departing, personal)
    const project = await seedUngroupedProject(departing, shared.id)
    const formerProject = await seedUngroupedProject(departing, former.id)
    const privateProject = await seedProject(connection, departing, [])
    const sharedResources = await seedResources(departing, shared.id, project)
    const privateResources = await seedResources(departing, personal, privateProject)
    await seedProjectTasks(connection, project, [task])
    await seedProjectTasks(connection, privateProject, [privateTask])
    await connection.query('update workspace_projects set "leadUserId"=$2 where id=$1', [project, departing])
    await connection.query('insert into workspace_project_members("projectId","workspaceId","userId") values($1,$2,$3)', [project, shared.id, departing])
    const event = randomUUID()
    await connection.query('insert into workspace_project_events(id,"projectId","userId",message) values($1,$2,$3,\'Kept event\')', [event, project, departing])
    const sharedDecision = await seedDecision(departing, shared.id, project, task)
    const formerDecision = await seedDecision(departing, former.id, formerProject, null)
    const privateDecision = await seedDecision(departing, personal, privateProject, privateTask)
    const agent = await seedAgent(connection, admin)
    const run = await seedRun(connection, { userId: admin, agentId: agent, issueId: task, workspaceId: shared.id })
    await teamLifecycle.archiveTeamData(admin, team.id)
    const appAliases = (await connection.query('select * from task_identifier_aliases where "issueId"=$1 order by identifier,kind', [task])).rows
    const workspaceAliases = (await connection.query('select * from mikka_task_identifier_aliases where "issueId"=$1 order by identifier', [task])).rows
    assert.ok(appAliases.length)
    assert.ok(workspaceAliases.length)
    assert.equal(await count(connection, 'workspace_task_identifier_counters where "workspaceId"=$1', [soloShared.id]), 1)
    assert.equal(await count(connection, 'workspace_task_identifier_counters where "workspaceId"=$1', [shared.id]), 1)
    const decisionsBefore = (await connection.query('select * from project_decisions where id=any($1::uuid[]) order by id', [[sharedDecision.decisionId, formerDecision.decisionId]])).rows
    const sourcesBefore = (await connection.query('select * from project_decision_sources where id=any($1::uuid[]) order by id', [[sharedDecision.sourceId, formerDecision.sourceId]])).rows
    const planned = await workspaceDb.transaction(tx => account.planWorkspaces(tx, departing))
    assert.ok(!('soleAdminOf' in planned))
    assert.ok(planned.keptProjectIds.includes(project))
    assert.ok(planned.keptProjectIds.includes(formerProject), 'prior membership is unnecessary to preserve a Project in another surviving Workspace')
    assert.ok(!planned.keptProjectIds.includes(privateProject))
    assert.deepEqual(planned.keptIssueIds, [], 'Workspace planning cannot decide APP task retention before its rows are locked')
    let retained = planned
    const client = await connection.connect()
    try {
      await client.query('begin')
      retained = await account.freezeTaskRetention(client, departing, planned)
      assert.ok(retained.keptIssueIds.includes(task))
      assert.ok(!retained.keptIssueIds.includes(privateTask))
      await account.deleteMainAccountData(client, departing, retained)
      await client.query('commit')
    } catch (error) { await client.query('rollback'); throw error } finally { client.release() }
    await workspaceDb.transaction(tx => account.deleteWorkspaceData(tx, departing, createHash('sha256').update(`${departing}@example.invalid`).digest('hex'), retained))
    assert.equal(await count(connection, '"user" where id=$1', [departing]), 0, 'exercise the final user DELETE and its real foreign keys')
    assert.equal(await count(connection, 'workspace_projects where id=any($1::uuid[])', [[project, formerProject]]), 2)
    assert.equal(await count(connection, 'workspace_projects where id=$1', [privateProject]), 0)
    assert.equal(await count(connection, 'project_decisions where id=$1', [privateDecision.decisionId]), 0)
    assert.equal(await count(connection, 'project_decision_sources where id=$1', [privateDecision.sourceId]), 0)
    assert.deepEqual((await connection.query('select * from project_decisions where id=any($1::uuid[]) order by id', [[sharedDecision.decisionId, formerDecision.decisionId]])).rows, decisionsBefore)
    assert.deepEqual((await connection.query('select * from project_decision_sources where id=any($1::uuid[]) order by id', [[sharedDecision.sourceId, formerDecision.sourceId]])).rows, sourcesBefore)
    assert.deepEqual((await connection.query('select * from task_identifier_aliases where "issueId"=$1 order by identifier,kind', [task])).rows, appAliases)
    assert.deepEqual((await connection.query('select * from mikka_task_identifier_aliases where "issueId"=$1 order by identifier', [task])).rows, workspaceAliases)
    assert.equal(await count(connection, 'workspace_project_tasks where "projectId"=$1 and "issueId"=$2 and "workspaceId"=$3', [project, task, shared.id]), 1)
    assert.equal(await count(connection, 'workspace_project_members where "userId"=$1', [departing]), 0)
    assert.equal((await connection.query('select "leadUserId" from workspace_projects where id=$1', [project])).rows[0].leadUserId, null)
    assert.equal(await count(connection, 'workspace_project_events where id=$1', [event]), 1)
    assert.equal(await count(connection, 'agent_runs where id=$1', [run]), 1)
    assert.equal(await count(connection, 'workspace_environments where id=$1', [sharedResources.environmentId]), 1)
    assert.equal(await count(connection, 'workspace_resource_events where id=$1', [sharedResources.eventId]), 1)
    assert.equal(await count(connection, 'workspace_project_repositories where "projectId"=$1', [project]), 1)
    assert.equal(await count(connection, 'workspace_environments where id=$1', [privateResources.environmentId]), 0)
    assert.equal(await count(connection, 'workspace_resource_events where id=$1', [privateResources.eventId]), 0)
    assert.equal(await count(connection, 'workspace_task_identifier_counters where "workspaceId"=$1', [soloShared.id]), 0)
    assert.equal(await count(connection, 'workspace_task_identifier_counters where "workspaceId"=$1', [shared.id]), 1)
    assert.equal((await teamLifecycle.readTeamLifecycleAudit(admin, shared.id, team.id)).length, 1)
  })

  await t.test('a creator who has already left every Workspace still cannot erase surviving Projects', async () => {
    const departed = await seedUser(connection, 'domain-already-left'), admin = await seedUser(connection, 'domain-retainer')
    const workspace = await seedWorkspace(connection, admin, [{ userId: admin, role: 'admin' }])
    const project = await seedUngroupedProject(departed, workspace.id)
    const plan = await workspaceDb.transaction(tx => account.planWorkspaces(tx, departed))
    assert.ok(!('soleAdminOf' in plan))
    assert.deepEqual(plan.keptProjectIds, [project])
    await workspaceDb.transaction(tx => account.deleteWorkspaceData(tx, departed, '0'.repeat(64), plan))
    assert.equal(await count(connection, 'workspace_projects where id=$1', [project]), 1)
  })

  await t.test('old deletion receipts retain shared history and quarantined Project repair evidence', async () => {
    const { departing, pendingProject } = oldReceipt
    const admin = await seedUser(connection, 'domain-old-admin')
    const personal = await seedPersonalWorkspace(connection, departing)
    const shared = await seedWorkspace(connection, admin, [{ userId: admin, role: 'admin' }, { userId: departing, role: 'member' }])
    const sharedProject = await seedUngroupedProject(departing, shared.id)
    const privateProject = await seedProject(connection, departing, [])
    await connection.query('insert into workspace_project_repairs("projectId",reason,evidence) values($1,\'workspace_evidence_missing\',$2)', [pendingProject, JSON.stringify([{ reason: 'legacy_without_trusted_workspace' }])])
    const pendingEvent = randomUUID()
    await connection.query('insert into workspace_project_events(id,"projectId","userId",message) values($1,$2,$3,\'Pending evidence\')', [pendingEvent, pendingProject, departing])
    const sharedDecision = await seedDecision(departing, shared.id, sharedProject, null)
    const planned = await workspaceDb.transaction(tx => account.planWorkspaces(tx, departing))
    assert.ok(!('soleAdminOf' in planned))
    assert.ok(planned.keptProjectIds.includes(pendingProject))
    // Exact pre-v2 receipt shape; do not smuggle the newly computed field in.
    const legacyPlan = { solo: [personal], shared: [shared.id], keptIssueIds: [] }
    const client = await connection.connect()
    try {
      await client.query('begin')
      await account.deleteMainAccountData(client, departing, legacyPlan)
      await client.query('commit')
    } catch (error) { await client.query('rollback'); throw error } finally { client.release() }
    await workspaceDb.transaction(tx => account.deleteWorkspaceData(tx, departing, '0'.repeat(64), legacyPlan))
    assert.equal(await count(connection, '"user" where id=$1', [departing]), 0)
    assert.equal(await count(connection, 'workspace_projects where id=$1', [privateProject]), 0)
    assert.equal(await count(connection, 'workspace_projects where id=$1 and "workspaceId"=$2', [sharedProject, shared.id]), 1)
    assert.equal(await count(connection, 'project_decisions where id=$1', [sharedDecision.decisionId]), 1)
    assert.equal(await count(connection, 'project_decision_sources where id=$1', [sharedDecision.sourceId]), 1)
    assert.equal(await count(connection, 'workspace_projects where id=$1 and "workspaceId" is null', [pendingProject]), 1)
    assert.equal(await count(connection, 'workspace_project_repairs where "projectId"=$1', [pendingProject]), 1)
    assert.equal(await count(connection, 'workspace_project_events where id=$1', [pendingEvent]), 1)
    const { accessibleProjects } = await import('../lib/project-access')
    assert.equal((await accessibleProjects(admin, workspaceDb, shared.id)).some(project => project.id === pendingProject), false)
  })

  await t.test('replaying an old journal with an explicit empty Project set freezes surviving canonical history and prior receipts', async () => {
    const { applyAccountDeletionManifest, exportAccountDeletionManifest } = await import('../lib/account/deletion-jobs')
    const { auditDigest } = await import('../lib/audit/integrity')
    const { departing, pendingProject } = oldJournal
    const admin = await seedUser(connection, 'domain-replay-admin')
    const personal = await seedPersonalWorkspace(connection, departing)
    const shared = await seedWorkspace(connection, admin, [{ userId: admin, role: 'admin' }, { userId: departing, role: 'member' }])
    const former = await seedWorkspace(connection, admin, [{ userId: admin, role: 'admin' }])
    const sharedTask = await seedIssue(connection, departing, shared.id), privateTask = await seedIssue(connection, departing, personal)
    const sharedProject = await seedUngroupedProject(departing, shared.id), formerProject = await seedUngroupedProject(departing, former.id)
    const privateProject = await seedUngroupedProject(departing, personal)
    await seedProjectTasks(connection, sharedProject, [sharedTask])
    await seedProjectTasks(connection, privateProject, [privateTask])
    const sharedDecision = await seedDecision(departing, shared.id, sharedProject, sharedTask)
    const formerDecision = await seedDecision(departing, former.id, formerProject, null)
    const privateDecision = await seedDecision(departing, personal, privateProject, privateTask)
    await connection.query('insert into workspace_project_repairs("projectId",reason,evidence) values($1,\'workspace_evidence_missing\',$2)', [pendingProject, JSON.stringify([{ reason: 'legacy_without_trusted_workspace' }])])
    for (const projectId of [sharedProject, formerProject, pendingProject]) {
      await connection.query('insert into workspace_project_events(id,"projectId","userId",message) values($1,$2,$3,\'Restored historical event\')', [randomUUID(), projectId, departing])
    }
    // A previous replay can retain an ID absent from an older backup. Its
    // receipt must remain monotonic even when current discovery cannot find it.
    const previousProject = await seedUngroupedProject(departing, former.id)
    await connection.query('delete from workspace_projects where id=$1', [previousProject])
    const keptProjects = [sharedProject, formerProject, pendingProject].sort()
    const keptDecisions = [sharedDecision.decisionId, formerDecision.decisionId].sort()
    const keptSources = [sharedDecision.sourceId, formerDecision.sourceId].sort()
    const snapshot = async () => ({
      projects: (await connection.query('select * from workspace_projects where id=any($1::uuid[]) order by id', [keptProjects])).rows,
      tasks: (await connection.query('select id,"userId","workspaceId","ownershipState","issuedIdentifier" from issues where id=$1', [sharedTask])).rows,
      relations: (await connection.query('select * from workspace_project_tasks where "projectId"=any($1::uuid[]) order by "issueId"', [keptProjects])).rows,
      decisions: (await connection.query('select * from project_decisions where id=any($1::uuid[]) order by id', [keptDecisions])).rows,
      sources: (await connection.query('select * from project_decision_sources where id=any($1::uuid[]) order by id', [keptSources])).rows,
      events: (await connection.query('select * from workspace_project_events where "projectId"=any($1::uuid[]) order by id', [keptProjects])).rows,
      repairs: (await connection.query('select * from workspace_project_repairs where "projectId"=$1', [pendingProject])).rows,
    })
    const before = await snapshot()
    const jobId = randomUUID(), emailHash = createHash('sha256').update(`${departing}@example.invalid`).digest('hex')
    const legacyPlan = { solo: [personal], shared: [shared.id], keptIssueIds: [], keptProjectIds: [] }
    // This is the actual durable journal format, with an explicitly present
    // empty keep set from the old Team-derived planner, not a missing v2 field.
    await connection.query(`insert into account_deletion_jobs(id,"subjectUserId","subjectEmailHash",stage,plan,"completedAt")
      values($1,$2,$3,'completed',$4,now())`, [jobId, departing, emailHash, JSON.stringify(legacyPlan)])
    const exported = await exportAccountDeletionManifest({ mainPool: connection, workspacePool })
    const { digest: _exportedDigest, ...body } = exported
    body.jobs = body.jobs.filter(job => job.id === jobId)
    const manifest = { ...body, digest: auditDigest(body) }
    assert.equal(manifest.jobs.length, 1)
    assert.deepEqual(manifest.jobs[0].plan!.keptProjectIds, [])
    assert.ok(Object.hasOwn(manifest.jobs[0].plan!, 'keptProjectIds'))
    await connection.query('update account_deletion_jobs set plan=$2 where id=$1', [jobId, JSON.stringify({ ...legacyPlan, keptProjectIds: [previousProject] })])
    const options = { mainPool: connection, workspacePool, deleteObject: async () => { throw new Error('No object cleanup belongs to this Project history fixture') } }
    const expectedKept = [...keptProjects, previousProject].sort()
    for (let replay = 0; replay < 2; replay++) {
      assert.deepEqual(await applyAccountDeletionManifest(manifest, options), { applied: 1 })
      assert.deepEqual(await snapshot(), before, 'canonical Project/Task identity, Decisions, evidence and quarantine repair rows remain byte-for-byte stable')
      const journal = (await connection.query('select stage,plan from account_deletion_jobs where id=$1', [jobId])).rows[0]
      assert.equal(journal.stage, 'completed')
      assert.deepEqual(journal.plan.keptProjectIds, expectedKept, 'replay unions the prior receipt and current canonical Project evidence')
      assert.deepEqual(journal.plan.keptIssueIds, [sharedTask])
      assert.deepEqual(journal.plan.solo, [personal], 'reconciliation never expands the destructive Workspace set')
    }
    assert.equal(await count(connection, '"user" where id=$1', [departing]), 0)
    assert.equal(await count(connection, 'mikka_workspace_members where "userId"=$1', [departing]), 0)
    assert.equal(await count(connection, 'mikka_workspaces where id=$1', [personal]), 0)
    assert.equal(await count(connection, 'mikka_workspaces where id=any($1::uuid[])', [[shared.id, former.id]]), 2)
    assert.equal(await count(connection, 'workspace_projects where id=$1', [privateProject]), 0)
    assert.equal(await count(connection, 'project_decisions where id=$1', [privateDecision.decisionId]), 0)
    assert.equal(await count(connection, 'project_decision_sources where id=$1', [privateDecision.sourceId]), 0)
    assert.equal(await count(connection, 'issues where id=$1', [privateTask]), 0)
  })

  await t.test('deleting a Workspace removes ungrouped Projects and lifecycle journals only in that tenant', async () => {
    const admin = await seedUser(connection, 'domain-workspace-admin')
    const doomed = await seedWorkspace(connection, admin, [{ userId: admin, role: 'admin' }], 'Doomed domain')
    const kept = await seedWorkspace(connection, admin, [{ userId: admin, role: 'admin' }], 'Kept domain')
    const doomedProject = await seedUngroupedProject(admin, doomed.id), keptProject = await seedUngroupedProject(admin, kept.id)
    const doomedResources = await seedResources(admin, doomed.id, doomedProject), keptResources = await seedResources(admin, kept.id, keptProject)
    await seedIssue(connection, admin, doomed.id)
    await seedIssue(connection, admin, kept.id)
    const doomedTeam = await seedTeam(connection, doomed.id, admin), keptTeam = await seedTeam(connection, kept.id, admin)
    const doomedDecision = await seedDecision(admin, doomed.id, doomedProject, null), keptDecision = await seedDecision(admin, kept.id, keptProject, null)
    await teamLifecycle.archiveTeamData(admin, doomedTeam.id)
    await teamLifecycle.archiveTeamData(admin, keptTeam.id)
    assert.equal(await count(connection, 'workspace_task_identifier_counters where "workspaceId"=any($1::uuid[])', [[doomed.id, kept.id]]), 2)
    const removed = await general.deleteWorkspaceData(admin, doomed.id, doomed.name)
    assert.equal(removed.deleted.projects, 1)
    assert.equal(await count(connection, 'workspace_projects where id=$1', [doomedProject]), 0)
    assert.equal(await count(connection, 'project_decisions where id=$1', [doomedDecision.decisionId]), 0)
    assert.equal(await count(connection, 'project_decision_sources where id=$1', [doomedDecision.sourceId]), 0)
    assert.equal(await count(connection, 'team_lifecycle_events where "workspaceId"=$1', [doomed.id]), 0)
    assert.equal(await count(connection, 'workspace_resource_events where id=$1', [doomedResources.eventId]), 0)
    assert.equal(await count(connection, 'workspace_environments where id=$1', [doomedResources.environmentId]), 0)
    assert.equal(await count(connection, 'workspace_project_repositories where "projectId"=$1', [doomedProject]), 0)
    assert.equal(await count(connection, 'workspace_project_environments where "projectId"=$1', [doomedProject]), 0)
    assert.equal(await count(connection, 'workspace_task_identifier_counters where "workspaceId"=$1', [doomed.id]), 0)
    assert.equal(await count(connection, 'workspace_projects where id=$1 and "workspaceId"=$2', [keptProject, kept.id]), 1)
    assert.equal(await count(connection, 'project_decisions where id=$1', [keptDecision.decisionId]), 1)
    assert.equal(await count(connection, 'project_decision_sources where id=$1', [keptDecision.sourceId]), 1)
    assert.equal(await count(connection, 'workspace_resource_events where id=$1', [keptResources.eventId]), 1)
    assert.equal(await count(connection, 'workspace_environments where id=$1', [keptResources.environmentId]), 1)
    assert.equal(await count(connection, 'workspace_project_repositories where "projectId"=$1', [keptProject]), 1)
    assert.equal((await teamLifecycle.readTeamLifecycleAudit(admin, kept.id, keptTeam.id)).length, 1)
    assert.equal(await count(connection, 'workspace_task_identifier_counters where "workspaceId"=$1', [kept.id]), 1)
  })
})
