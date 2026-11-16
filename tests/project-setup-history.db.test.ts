import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { dbUrl, seedProject, seedTeam, seedUser, seedWorkspace } from './support/workspace-admin-db'

test('Project setup history restores only the recipe after fresh binding and authority checks', { skip: !dbUrl }, async t => {
  const database = new Pool({ connectionString: dbUrl })
  const store = await import('../lib/project-resources/store')
  const { pool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  t.after(async () => { await Promise.all([database.end(), pool.end(), workspacePool.end()]) })
  const owner = await seedUser(database, 'setup-owner'), member = await seedUser(database, 'setup-member')
  const workspace = await seedWorkspace(database, owner, [{ userId: owner, role: 'admin' }, { userId: member, role: 'member' }])
  const team = await seedTeam(database, workspace.id, owner)
  const projectId = await seedProject(database, owner, [{ teamId: team.id, workspaceId: workspace.id }])
  const other = await seedProject(database, member, [{ teamId: team.id, workspaceId: workspace.id }])
  const env = await store.saveEnvironment(owner, { workspaceId: workspace.id, name: 'Setup history', configuration: {
    variables: { CURRENT_VALUE: 'old' }, setup: { copyFiles: ['fixture.txt'], command: 'node --version', approved: true },
  } })
  const scope = { workspaceId: workspace.id, projectId, environmentId: env.id }
  await store.setProjectDefaultEnvironment(owner, { ...scope, revision: 1 })
  await store.saveEnvironment(owner, { workspaceId: workspace.id, id: env.id, revision: 1, name: 'Current name', configuration: {
    runtime: 'local', variables: { CURRENT_VALUE: 'now' }, setup: { copyFiles: [], command: 'node --help', approved: true },
  } })
  const history = await store.listProjectSetupVersions(owner, scope)
  assert.equal(history.totalProjects, 1)
  assert.deepEqual(history.versions.map(v => [v.revision, v.recipe]), [[2, { command: 'node --help', copyFiles: [] }],
    [1, { command: 'node --version', copyFiles: ['fixture.txt'] }]])
  assert.equal(history.before, null)
  assert.ok(!JSON.stringify(history).includes('approved'))
  assert.ok(!JSON.stringify(history).includes('CURRENT_VALUE'))
  const request = { ...scope, revision: 2, version: 1, bindingSnapshot: history.bindingSnapshot }
  await assert.rejects(store.rollbackProjectSetup(member, request))
  await assert.rejects(store.listProjectSetupVersions(owner, { ...scope, environmentId: randomUUID() }))
  await store.setProjectDefaultEnvironment(owner, { ...scope, projectId: other, revision: 1 })
  await assert.rejects(store.rollbackProjectSetup(owner, request), { code: 'projectResourceConflict' })
  const shared = await store.listProjectSetupVersions(owner, scope)
  assert.equal(shared.totalProjects, 2)
  assert.notEqual(shared.bindingSnapshot, request.bindingSnapshot)
  const applied = await store.rollbackProjectSetup(owner, { ...request, bindingSnapshot: shared.bindingSnapshot })
  assert.deepEqual(applied, { id: env.id, revision: 3 })
  const stored = (await database.query('select name,configuration from workspace_environments where id=$1', [env.id])).rows[0]
  assert.equal(stored.name, 'Current name')
  assert.equal(stored.configuration.runtime, 'local')
  assert.deepEqual(stored.configuration.variables, { CURRENT_VALUE: 'now' })
  assert.deepEqual(stored.configuration.setup, { command: 'node --version', copyFiles: ['fixture.txt'], approved: false })
  await assert.rejects(store.rollbackProjectSetup(owner, { ...request, bindingSnapshot: shared.bindingSnapshot }), { code: 'projectResourceConflict' })
  assert.equal((await database.query("select count(*)::integer count from workspace_resource_events where kind='environment.setup_restored' and \"resourceId\"=$1", [env.id])).rows[0].count, 1)
  await database.query("update resource_access_policies set visibility='private' where kind='project' and id=$1", [other])
  await assert.rejects(store.listProjectSetupVersions(owner, { ...scope, projectId: other }))
  await database.query("update mikka_workspace_members set status='suspended' where \"workspaceId\"=$1 and \"userId\"=$2", [workspace.id, member])
  await assert.rejects(store.listProjectSetupVersions(member, scope))
})
