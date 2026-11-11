import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { Pool } from 'pg'
import { dbUrl, seedIssue, seedProject, seedProjectTasks, seedTeam, seedUser, seedWorkspace } from './support/workspace-admin-db'

test('project default editor preserves repository overrides and canonical task selection', { skip: !dbUrl }, async t => {
  const fixture = new Pool({ connectionString: dbUrl })
  const { pool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  const store = await import('../lib/project-resources/store')
  t.after(async () => { await Promise.all([fixture.end(), pool.end(), workspacePool.end()]) })
  const owner = await seedUser(fixture, 'environment-settings-owner'), member = await seedUser(fixture, 'environment-settings-member')
  const workspace = await seedWorkspace(fixture, owner, [{ userId: owner, role: 'admin' }, { userId: member, role: 'member' }])
  const other = await seedWorkspace(fixture, owner, [{ userId: owner, role: 'admin' }])
  const team = await seedTeam(fixture, workspace.id, owner)
  const projectId = await seedProject(fixture, owner, [{ teamId: team.id, workspaceId: workspace.id }])
  const issueId = await seedIssue(fixture, owner, workspace.id)
  await seedProjectTasks(fixture, projectId, [issueId])
  const first = await store.saveEnvironment(owner, { workspaceId: workspace.id, name: 'Repository', configuration: { setup: { copyFiles: [], command: 'echo repository', approved: true } } })
  const second = await store.saveEnvironment(owner, { workspaceId: workspace.id, name: 'Project', configuration: { setup: { copyFiles: [], command: 'echo project', approved: true } } })
  const repositoryKey = 'v2/github.com/mikka-ci/environment-settings'
  await store.saveProjectResources(owner, { workspaceId: workspace.id, projectId, revision: 1,
    repositories: [{ repositoryKey, environmentId: first.id }, { repositoryKey: `${repositoryKey}-other` }],
    environmentIds: [first.id], defaultEnvironmentId: first.id })
  const choose = (environmentId: string | null, revision: number, user = owner, tenant = workspace.id) =>
    store.setProjectDefaultEnvironment(user, { workspaceId: tenant, projectId, revision, environmentId })
  await assert.rejects(choose(second.id, 2, member), { code: 'workspaceAccessDenied' })
  await assert.rejects(choose(second.id, 2, owner, other.id), { code: 'projectNotFound' })
  await assert.rejects(choose(randomUUID(), 2), { code: 'projectEnvironmentUnavailable' })
  assert.deepEqual(await choose(second.id, 2), { revision: 3 })
  const configuration = await store.listProjectResources(owner, workspace.id, projectId)
  assert.equal(configuration.repositories.length, 2)
  assert.equal(configuration.repositories.find(row => row.repositoryKey === repositoryKey)?.environmentId, first.id)
  assert.deepEqual(configuration.environmentBindings.map(row => [row.environmentId, row.isDefault]).sort(), [[first.id, false], [second.id, true]].sort())
  const admission = (key: string) => store.withProjectExecution({ userId: owner, workspaceId: workspace.id, issueId,
    repositoryKey: key, baseBranch: 'main', runtime: 'local', harness: 'codex' }, async snapshot => snapshot)
  assert.equal((await admission(repositoryKey)).environment?.id, first.id, 'an explicit repository override wins')
  const frozen = await admission(`${repositoryKey}-other`)
  assert.equal(frozen.projectId, projectId, 'the retired issueIds JSON stays empty; the canonical relation selects the Project')
  assert.equal(frozen.environment?.id, second.id)
  assert.equal(frozen.environment?.setup?.command, 'echo project')
  await assert.rejects(choose(first.id, 2), { code: 'projectResourceConflict' })
  assert.deepEqual(await choose(null, 3), { revision: 4 })
  assert.equal((await admission(`${repositoryKey}-other`)).environment, null)
  assert.equal((await admission(repositoryKey)).environment?.id, first.id)
  assert.equal(frozen.environment?.id, second.id, 'changing the default never mutates a frozen snapshot')
  assert.equal((await fixture.query('SELECT "issueIds" FROM workspace_projects WHERE id=$1', [projectId])).rows[0].issueIds.length, 0)

  const foreign = await store.saveEnvironment(owner, { workspaceId: other.id, name: 'Other tenant', configuration: {} })
  await assert.rejects(choose(foreign.id, 4), { code: 'projectEnvironmentUnavailable' })
  assert.equal((await fixture.query('SELECT revision FROM workspace_projects WHERE id=$1', [projectId])).rows[0].revision, 4, 'a rejected foreign default rolls back without consuming the Project revision')
  const simultaneous = await Promise.allSettled([choose(first.id, 4), choose(second.id, 4)])
  assert.equal(simultaneous.filter(result => result.status === 'fulfilled').length, 1)
  const refused = simultaneous.find(result => result.status === 'rejected') as PromiseRejectedResult
  assert.equal(refused.reason.code, 'projectResourceConflict')
  assert.equal((await fixture.query('SELECT count(*)::int AS n FROM workspace_project_environments WHERE "projectId"=$1 AND "isDefault"', [projectId])).rows[0].n, 1, 'concurrent editors never create two defaults')

  await store.saveEnvironment(owner, { workspaceId: workspace.id, id: second.id, revision: 1, name: 'Project', configuration: {}, archived: true })
  await assert.rejects(choose(second.id, 5), { code: 'projectEnvironmentUnavailable' })
  const restored = await store.saveEnvironment(owner, { workspaceId: workspace.id, id: second.id, revision: 2, name: 'Project', configuration: {}, archived: false })
  assert.equal(restored.revision, 3)
  assert.deepEqual(await choose(second.id, 5), { revision: 6 })
  assert.equal((await admission(`${repositoryKey}-other`)).environment?.revision, 3, 'restoring an environment permits a fresh admission with its new revision')
  assert.equal((await admission(repositoryKey)).environment?.id, first.id, 'restoring the default still preserves repository overrides')
  await fixture.query('UPDATE workspace_projects SET "archivedAt"=now(),"archivedBy"=$2 WHERE id=$1', [projectId, owner])
  await assert.rejects(choose(first.id, 6), { code: 'projectArchived' })
  await fixture.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2', [workspace.id, owner])
  await assert.rejects(choose(first.id, 6), { code: 'workspaceAccessDenied' })
})
