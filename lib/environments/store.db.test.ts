import assert from 'node:assert/strict'
import test from 'node:test'
import { Pool } from 'pg'
import { dbUrl, seedPersonalWorkspace, seedProject, seedUser } from '../../tests/support/workspace-admin-db'
import type { EnvironmentSaveInput } from './contract'
import {
  archiveEnvironment, defaultEnvironmentForRun, listEnvironmentRows, readEnvironmentRow, saveEnvironment,
} from './store'

const environment = (overrides: { id?: string; revision?: number; projectId?: string | null; isDefault?: boolean; config?: Record<string, unknown> } = {}): EnvironmentSaveInput => ({
  ...(overrides.id ? { id: overrides.id } : {}),
  ...(overrides.revision ? { revision: overrides.revision } : {}),
  projectId: overrides.projectId ?? null,
  isDefault: overrides.isDefault ?? true,
  config: {
    name: 'Node', description: '', runtime: 'cloud' as const, workdir: 'apps/web',
    setupScript: 'pnpm install', installScript: '', repositories: [] as string[], actions: [],
    ...overrides.config,
  },
} as unknown as EnvironmentSaveInput)

test('run environments are versioned by revision and one default per scope', { skip: !dbUrl, timeout: 60_000 }, async t => {
  const pool = new Pool({ connectionString: dbUrl, max: 2 })
  t.after(() => pool.end())
  const owner = await seedUser(pool, 'env-store-owner')
  const workspaceId = await seedPersonalWorkspace(pool, owner)
  const projectId = await seedProject(pool, owner, [])
  const actor = { userId: owner, workspaceId }

  const first = await saveEnvironment(pool, actor, environment({ projectId }))
  assert.equal(first.revision, 1)
  assert.equal(first.isDefault, true)
  assert.equal((await pool.query('SELECT revision FROM project_environment_revisions WHERE "environmentId"=$1', [first.id])).rows.length, 1)

  const second = await saveEnvironment(pool, actor, environment({ projectId, config: { name: 'Python', workdir: '', setupScript: '', repositories: ['v2/github.com/acme/only'] } }))
  assert.equal((await readEnvironmentRow(pool, workspaceId, first.id))?.isDefault, false, 'a new project default replaces the previous one')
  assert.equal((await readEnvironmentRow(pool, workspaceId, second.id))?.isDefault, true)
  const workspaceDefault = await saveEnvironment(pool, actor, environment({ projectId: null, config: { name: 'Any', workdir: '', setupScript: '' } }))
  assert.equal(workspaceDefault.isDefault, true)

  await assert.rejects(saveEnvironment(pool, actor, environment({ id: second.id, revision: 1, projectId, config: { name: 'Stale', workdir: '', setupScript: '' } })), { code: 'environmentConflict' })
  const updated = await saveEnvironment(pool, actor, environment({ id: second.id, revision: 2, projectId, config: { name: 'Python 3', workdir: 'py', setupScript: 'pip install -r requirements.txt' } }))
  assert.equal(updated.revision, 3)
  assert.equal((await pool.query('SELECT revision FROM project_environment_revisions WHERE "environmentId"=$1 ORDER BY revision', [second.id])).rows.map(row => row.revision).join(','), '1,3')

  await assert.rejects(saveEnvironment(pool, actor, environment({ projectId, config: { name: 'python 3', workdir: '', setupScript: '' } })), { code: 'environmentNameTaken' })

  const chosen = await defaultEnvironmentForRun(pool, { workspaceId, issueId: null, repositoryKey: 'v2/github.com/acme/other' })
  assert.equal(chosen?.id, workspaceDefault.id, 'a project default that forbids this repository is skipped')
  const allowed = await defaultEnvironmentForRun(pool, { workspaceId, issueId: null, repositoryKey: 'v2/github.com/acme/only' })
  assert.equal(allowed?.id, second.id, 'the project default wins when its allow-list admits the repository')

  await assert.rejects(archiveEnvironment(pool, actor, { id: second.id, revision: 2 }), { code: 'environmentConflict' })
  const archived = await archiveEnvironment(pool, actor, { id: second.id, revision: 3 })
  assert.ok(archived.archivedAt)
  assert.deepEqual((await listEnvironmentRows(pool, workspaceId)).map(row => row.id).sort(), [first.id, workspaceDefault.id].sort())
})

test('a member cannot change an environment even when the client calls storage directly', { skip: !dbUrl, timeout: 60_000 }, async t => {
  const pool = new Pool({ connectionString: dbUrl, max: 2 })
  t.after(() => pool.end())
  const owner = await seedUser(pool, 'env-store-admin'), member = await seedUser(pool, 'env-store-member')
  const workspaceId = await seedPersonalWorkspace(pool, owner)
  await pool.query(`INSERT INTO mikka_workspace_members ("workspaceId","userId",name,email,role,status) VALUES ($1,$2,$2,$3,'member','active')`,
    [workspaceId, member, `${member}@example.invalid`])
  await assert.rejects(saveEnvironment(pool, { userId: member, workspaceId }, environment()), { code: 'environmentPermissionDenied' })
})
