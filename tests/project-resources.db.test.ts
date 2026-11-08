import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { dbUrl, seedIssue, seedPersonalWorkspace, seedProject, seedProjectTasks, seedUser, seedWorkspace } from './support/workspace-admin-db'

test('Project repository/environment policy on real PostgreSQL', { skip: !dbUrl }, async t => {
  const { Pool } = await import('pg')
  const connection = new Pool({ connectionString: dbUrl, max: 3 })
  const resources = await import('../lib/project-resources/store')
  const { withRunProjectExecution } = await import('../lib/project-resources/run-lease')
  const { environmentConfiguration } = await import('../lib/project-resources/contracts')
  const { ActionFailureError } = await import('../lib/action-error')
  const { pool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  const { tokenWorkspace } = await import('../lib/tokens/principal')
  t.after(async () => { await Promise.all([connection.end(), pool.end(), workspacePool.end()]) })
  const rejects = (work: Promise<unknown>, code: string) => assert.rejects(work, (error: unknown) => error instanceof ActionFailureError && error.code === code)
  const owner = await seedUser(connection, 'resource-owner'), member = await seedUser(connection, 'resource-member')
  const workspace = await seedWorkspace(connection, owner, [{ userId: owner, role: 'admin' }, { userId: member, role: 'member' }])
  const other = await seedWorkspace(connection, owner, [{ userId: owner, role: 'admin' }])
  const issueId = await seedIssue(connection, owner, workspace.id)
  const projectId = randomUUID()
  await connection.query(`insert into workspace_projects(id,"userId","workspaceId",name,summary,description,status,priority,lead,team,"startDate","targetDate","issueIds",revision)
    values($1,$2,$3,'Shared project','','','planned','none','','','','','[]',1)`, [projectId, owner, workspace.id])
  await seedProjectTasks(connection, projectId, [issueId])
  const repoA = 'v2/github.com/acme/application', repoB = 'v2/github.com/acme/service', repoC = 'v2/github.com/elsewhere/private'
  const request = { userId: owner, workspaceId: workspace.id, issueId, repositoryKey: repoA, baseBranch: 'main', runtime: 'local' as const, harness: 'codex' }
  const admission = (repositoryKey = repoA) => resources.withProjectExecution({ ...request, repositoryKey }, async snapshot => snapshot)

  await t.test('zero repository bindings inherit existing authorization without becoming a grant', async () => {
    const value = await admission(repoC)
    assert.equal(value.projectId, projectId)
    assert.equal(value.repositoryKey, repoC)
    assert.equal(value.policyRevision, 0)
    assert.equal(value.environment, null)
  })
  let environmentId: string
  await t.test('environment stores reusable configuration and validates existing references', async () => {
    assert.equal(environmentConfiguration.safeParse({ variables: { PATH: '/untrusted' } }).success, false)
    await rejects(resources.saveEnvironment(owner, { workspaceId: workspace.id, name: 'Bad reference', configuration: { secretIds: [randomUUID()] } }), 'projectEnvironmentUnavailable')
    await rejects(resources.saveEnvironment(member, { workspaceId: workspace.id, name: 'No permission', configuration: {} }), 'workspaceAccessDenied')
    const environment = await resources.saveEnvironment(owner, { workspaceId: workspace.id, name: 'Tests', configuration: { variables: { FEATURE_MODE: 'test' }, runtime: 'local', harness: 'codex', repositoryKeys: [repoA, repoB], setup: { copyFiles: [], command: 'node --version', approved: true } } })
    environmentId = environment.id
    assert.equal(environment.revision, 1)
    await rejects(resources.listProjectResources({ id: owner, [tokenWorkspace]: other.id }, workspace.id, projectId), 'workspaceAccessDenied')
    await rejects(resources.saveProjectResources(owner, { workspaceId: other.id, projectId, revision: 1, repositories: [], environmentIds: [environment.id], defaultEnvironmentId: environment.id }), 'projectNotFound')
  })
  await t.test('multiple bindings and Workspace policy form an intersection', async () => {
    await resources.saveProjectResources(owner, { workspaceId: workspace.id, projectId, revision: 1,
      repositories: [{ repositoryKey: repoA, isPrimary: true, baseBranch: 'develop' }, { repositoryKey: repoB }], environmentIds: [environmentId], defaultEnvironmentId: environmentId })
    const value = await admission()
    assert.equal(value.baseBranch, 'develop', 'the project target branch is frozen instead of the device default')
    assert.equal(value.environment?.id, environmentId)
    assert.equal(value.environment?.variables.FEATURE_MODE, 'test')
    assert.equal((await admission(repoB)).repositoryKey, repoB)
    await rejects(admission(repoC), 'projectRepositoryDenied')
    await resources.saveWorkspaceRepositoryPolicy(owner, { workspaceId: workspace.id, revision: 0, mode: 'restricted', repositoryKeys: [repoA, repoC] })
    await rejects(admission(repoB), 'projectRepositoryDenied')
    assert.equal((await admission()).policyRevision, 1)
    await rejects(resources.withProjectExecution({ ...request, runtime: 'cloud' }, async value => value), 'projectEnvironmentUnavailable')
    await rejects(resources.withProjectExecution({ ...request, harness: 'claude_code' }, async value => value), 'projectEnvironmentUnavailable')
  })
  await t.test('snapshot remains immutable across edits; revocation blocks new admissions', async () => {
    const original = await admission()
    const serialized = JSON.stringify(original)
    let claimed = 0
    await withRunProjectExecution({ ...request, baseBranch: original.baseBranch }, original, async () => { claimed++ })
    assert.equal(claimed, 1)
    await resources.saveWorkspaceRepositoryPolicy(owner, { workspaceId: workspace.id, revision: 1, mode: 'restricted', repositoryKeys: [repoB] })
    await rejects(withRunProjectExecution(request, original, async () => { claimed++ }), 'projectRepositoryDenied')
    assert.equal(claimed, 1, 'a queued Run is not a grant after repository revocation')
    await resources.saveWorkspaceRepositoryPolicy(owner, { workspaceId: workspace.id, revision: 2, mode: 'restricted', repositoryKeys: [repoA, repoC] })
    const alternate = await resources.saveEnvironment(owner, { workspaceId: workspace.id, name: 'Replacement', configuration: {} })
    await resources.saveProjectResources(owner, { workspaceId: workspace.id, projectId, revision: 2,
      repositories: [{ repositoryKey: repoA, isPrimary: true, baseBranch: 'develop' }, { repositoryKey: repoB }], environmentIds: [environmentId, alternate.id], defaultEnvironmentId: alternate.id })
    await rejects(withRunProjectExecution(request, original, async () => { claimed++ }), 'projectEnvironmentUnavailable')
    assert.equal(claimed, 1, 'binding replacement never mutates or reinterprets the frozen Environment')
    await resources.saveProjectResources(owner, { workspaceId: workspace.id, projectId, revision: 3,
      repositories: [{ repositoryKey: repoA, isPrimary: true, baseBranch: 'different' }, { repositoryKey: repoB }], environmentIds: [environmentId], defaultEnvironmentId: environmentId })
    await rejects(withRunProjectExecution(request, original, async () => { claimed++ }), 'projectRepositoryDenied')
    await resources.saveProjectResources(owner, { workspaceId: workspace.id, projectId, revision: 4,
      repositories: [{ repositoryKey: repoA, isPrimary: true, baseBranch: 'develop' }, { repositoryKey: repoB }], environmentIds: [environmentId], defaultEnvironmentId: environmentId })
    await withRunProjectExecution({ ...request, baseBranch: original.baseBranch }, original, async () => { claimed++ })
    assert.equal(claimed, 2)
    await rejects(withRunProjectExecution({ ...request, baseBranch: original.baseBranch }, undefined, async () => { claimed++ }), 'projectEnvironmentUnavailable')
    assert.equal(claimed, 2, 'a legacy Run cannot silently acquire a new Environment')
    await resources.saveEnvironment(owner, { workspaceId: workspace.id, id: environmentId, revision: 1, name: 'Renamed', configuration: { variables: { FEATURE_MODE: 'updated' } } })
    assert.equal(JSON.stringify(original), serialized)
    assert.equal((await admission()).environment?.revision, 2)
    await rejects(withRunProjectExecution(request, original, async () => { claimed++ }), 'projectEnvironmentUnavailable')
    await rejects(resources.saveEnvironment(owner, { workspaceId: workspace.id, id: environmentId, revision: 1, name: 'Stale', configuration: {} }), 'projectResourceConflict')
    await resources.saveEnvironment(owner, { workspaceId: workspace.id, id: environmentId, revision: 2, name: 'Renamed', archived: true, configuration: {} })
    await rejects(admission(), 'projectEnvironmentUnavailable')
    await rejects(withRunProjectExecution(request, original, async () => { claimed++ }), 'projectEnvironmentUnavailable')
    assert.equal(claimed, 2)
    assert.equal(JSON.stringify(original), serialized)
  })
  await t.test('same Git repository in another tenant needs its own policy; unprojected work still works', async () => {
    const otherIssue = await seedIssue(connection, owner, other.id)
    const value = await resources.withProjectExecution({ ...request, workspaceId: other.id, issueId: otherIssue, repositoryKey: repoB }, async snapshot => snapshot)
    assert.equal(value.projectId, null)
    assert.equal(value.policyRevision, 0)
    assert.equal(await withRunProjectExecution({ ...request, workspaceId: other.id, issueId: otherIssue, repositoryKey: repoB }, undefined, async () => 'legacy checkout'), 'legacy checkout')
    await resources.saveWorkspaceRepositoryPolicy(owner, { workspaceId: other.id, revision: 0, mode: 'restricted', repositoryKeys: [] })
    await rejects(resources.withProjectExecution({ ...request, workspaceId: other.id, issueId: otherIssue, repositoryKey: repoB }, async snapshot => snapshot), 'projectRepositoryDenied')
    await resources.withProjectExecution({ ...request, workspaceId: other.id, issueId: otherIssue, repositoryKey: null }, async snapshot => assert.equal(snapshot.repositoryKey, null))
  })
  await t.test('database foreign keys reject cross-tenant environment attachment', async () => {
    const personal = await seedPersonalWorkspace(connection, owner)
    const personalProject = await seedProject(connection, owner, [])
    assert.ok(personal)
    await assert.rejects(connection.query(`insert into workspace_project_environments("projectId","workspaceId","environmentId") values($1,$2,$3)`, [personalProject, personal, environmentId]), { code: '23503' })
  })
  await t.test('completed membership revocation cannot reuse a previously read configuration', async () => {
    await connection.query('update mikka_workspace_members set status=\'suspended\' where "workspaceId"=$1 and "userId"=$2', [other.id, owner])
    await rejects(resources.listProjectResources(owner, other.id), 'workspaceAccessDenied')
    await rejects(resources.withProjectExecution({ ...request, workspaceId: other.id }, async snapshot => snapshot), 'workspaceAccessDenied')
  })
})
