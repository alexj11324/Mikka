import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mock, test } from 'node:test'
import { Pool } from 'pg'
import { remoteKey } from '@mikka/protocol/repository'
import { dbUrl, seedIssue, seedPersonalWorkspace, seedProject, seedProjectTasks, seedUser } from './support/workspace-admin-db'
import { ALLOWED_MODEL, codexWithModel, seedAllowedModel } from './support/allowed-model'

test('one person saves an environment, selects it for a Project and queues a Run with its frozen configuration', { skip: !dbUrl, timeout: 30_000 }, async t => {
  const previousByos = process.env.MIKKA_BYOS_ENABLED
  process.env.MIKKA_BYOS_ENABLED = '1'
  t.after(() => { if (previousByos === undefined) delete process.env.MIKKA_BYOS_ENABLED; else process.env.MIKKA_BYOS_ENABLED = previousByos })
  const headers = mock.module('next/headers', { namedExports: { cookies: async () => ({ get: () => undefined }), headers: async () => new Headers() } })
  const locale = mock.module('next-intl/server', { namedExports: { getLocale: async () => 'en', getTranslations: async () => (key: string) => key } })
  t.after(() => { headers.restore(); locale.restore() })
  const fixture = new Pool({ connectionString: dbUrl })
  const { pool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  t.after(async () => { await Promise.all([fixture.end(), pool.end(), workspacePool.end()]) })
  const owner = await seedUser(fixture, 'environment-solo')
  const workspaceId = await seedPersonalWorkspace(fixture, owner)
  const projectId = await seedProject(fixture, owner, [])
  const issueId = await seedIssue(fixture, owner, workspaceId)
  await seedProjectTasks(fixture, projectId, [issueId])
  const deviceId = randomUUID(), agentId = randomUUID(), repoId = randomUUID()
  const repository = `https://github.com/mikka-ci/environment-${randomUUID()}.git`
  const repositoryKey = remoteKey(repository)
  await fixture.query(`INSERT INTO devices(id,"ownerId",name,kind,harnesses,"protocolVersion","lastSeenAt")
    VALUES($1,$2,'Single workflow fixture','local',$3,3,now())`, [deviceId, owner, JSON.stringify(codexWithModel)])
  await fixture.query(`INSERT INTO agents(id,"userId","deviceId",harness,name) VALUES($1,$2,$3,'codex','Single workflow Agent')`, [agentId, owner, deviceId])
  await fixture.query(`INSERT INTO device_repos(id,"deviceId","userId","repoPath","remoteUrl","baseBranch") VALUES($1,$2,$3,$4,$5,'main')`, [repoId, deviceId, owner, repositoryKey, repository])
  await seedAllowedModel(fixture, owner, { workspaceId, deviceIds: [deviceId] })
  await (await import('./support/github-app-stub')).recordPushGrant(fixture, owner, repositoryKey)
  const { actAs } = await import('../lib/acting-user')
  const actions = await import('../app/actions/project-resources')
  const { listEnvironments } = await import('../app/actions/environments')
  const { queueRun } = await import('../lib/agent-runs')
  const configuration = { runtime: 'local' as const, setup: { copyFiles: [], command: 'node --version', approved: true }, variables: { SINGLE_WORKFLOW: 'ready' } }
  const saved = await actAs(owner, () => actions.saveEnvironment({ workspaceId, name: 'Solo execution', configuration }))
  assert.ok(!saved.error)
  assert.equal(saved.revision, 1)
  const selected = await actAs(owner, () => actions.setProjectDefaultEnvironment({ workspaceId, projectId, revision: 1, environmentId: saved.id }))
  assert.ok(!selected.error)
  const settings = await actAs(owner, () => listEnvironments(workspaceId))
  assert.equal(settings.canManage, true)
  assert.deepEqual(settings.projects.map(project => [project.id, project.environmentId]), [[projectId, saved.id]])
  const admitted = await queueRun(owner, { issueId, agentId, repo: repository, requestKey: `solo-environment:${randomUUID()}`, model: ALLOWED_MODEL })
  const { rows: [run] } = await fixture.query('SELECT "workspaceId","agentDefinition" FROM agent_runs WHERE id=$1', [admitted.runId])
  assert.equal(run.workspaceId, workspaceId)
  const frozen = run.agentDefinition.projectExecution
  assert.equal(frozen.projectId, projectId)
  assert.equal(frozen.repositoryKey, repositoryKey)
  assert.equal(frozen.environment.id, saved.id)
  assert.equal(frozen.environment.revision, 1)
  assert.equal(frozen.environment.setup.command, configuration.setup.command)
  assert.equal(frozen.environment.variables.SINGLE_WORKFLOW, 'ready')
  const edited = await actAs(owner, () => actions.saveEnvironment({ workspaceId, id: saved.id, revision: 1, name: 'Solo execution', configuration: { ...configuration, variables: { SINGLE_WORKFLOW: 'next-run' } } }))
  assert.ok(!edited.error)
  assert.equal(edited.revision, 2)
  const persisted = (await fixture.query('SELECT "agentDefinition" FROM agent_runs WHERE id=$1', [admitted.runId])).rows[0].agentDefinition.projectExecution
  assert.deepEqual(persisted, frozen, 'an environment edit never rewrites an already admitted Run')

  const stranger = await seedUser(fixture, 'environment-solo-stranger')
  await assert.rejects(fixture.query(`INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status)
    VALUES($1,$2,'Unexpected personal member',$3,'admin','active')`, [workspaceId, stranger, `${stranger}@example.invalid`]), { code: '23514' }, 'the database itself rejects adding another account to a personal tenant')
  await assert.rejects(actAs(stranger, () => listEnvironments(workspaceId)), { code: 'workspaceAccessDenied' })
  const denied = await actAs(stranger, () => actions.setProjectDefaultEnvironment({ workspaceId, projectId, revision: 2, environmentId: null }))
  assert.equal(denied.error, 'workspaceAccessDenied', 'another account cannot edit personal Project defaults')
})
