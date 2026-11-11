import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mock, test } from 'node:test'
import { Pool } from 'pg'
import { ActionFailureError } from '../lib/action-error'
import { WorkspaceError } from '../lib/workspace-error'
import { tokenWorkspace } from '../lib/tokens/principal'
import { dbUrl, seedProject, seedTeam, seedUser, seedWorkspace } from './support/workspace-admin-db'

test('environment settings GET keeps canonical storage, fresh membership and private Project filtering', { skip: !dbUrl }, async t => {
  const fixture = new Pool({ connectionString: dbUrl })
  const { pool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  t.after(async () => { await Promise.all([fixture.end(), pool.end(), workspacePool.end()]) })
  const owner = await seedUser(fixture, 'env-http-owner'), member = await seedUser(fixture, 'env-http-member'), peer = await seedUser(fixture, 'env-http-peer')
  const workspace = await seedWorkspace(fixture, owner, [{ userId: owner, role: 'admin' }, { userId: member, role: 'member' }, { userId: peer, role: 'member' }])
  const foreign = await seedWorkspace(fixture, peer, [{ userId: peer, role: 'admin' }])
  const team = await seedTeam(fixture, workspace.id, owner)
  const project = await seedProject(fixture, owner, [{ teamId: team.id, workspaceId: workspace.id }])
  const privateProject = await seedProject(fixture, peer, [{ teamId: team.id, workspaceId: workspace.id }])
  await fixture.query('UPDATE workspace_projects SET name=$2 WHERE id=$1', [privateProject, 'private Project title'])
  await fixture.query('UPDATE resource_access_policies SET visibility=\'private\' WHERE kind=\'project\' AND id=$1', [privateProject])
  let current: { id: string; name: string; email: string; [tokenWorkspace]?: string } | null = { id: owner, name: 'Owner', email: `${owner}@example.invalid` }
  const mocks = [
    mock.module('@/lib/issue-access', { namedExports: { requireUser: async () => { if (!current) throw new ActionFailureError('authRequired'); return current } } }),
    // Deliberately stale context: the store must recheck the membership row,
    // and canManage must not trust this old admin projection.
    mock.module('@/lib/workspace-access', { namedExports: { WorkspaceError,
      loadWorkspaceContext: async (requested?: string) => ({ workspace: { id: requested ?? workspace.id }, role: 'admin' }) } }),
  ]
  t.after(() => { for (const replacement of mocks.reverse()) replacement.restore() })
  const unexpected = () => { throw new Error('unrelated settings action called') }
  for (const [module, names] of Object.entries({
    '@/app/actions/account': ['getPasswordStatus', 'listSessions'],
    '@/app/actions/preferences': ['getPreferences'], '@/app/actions/issue-prefix': ['getIssuePrefixState'],
    '@/app/actions/settings-activity': ['listSavedLogins'],
    '@/app/actions/workspace-settings': ['getWorkspaceDeletionImpact', 'getWorkspaceGeneral', 'getWorkspaceTransferTargets'],
    '@/app/actions/app-policy': ['getAppPolicy'], '@/app/actions/personal-policy': ['getSharePolicy'],
    '@/app/actions/workspace-secrets': ['getE2BKeyCapability', 'listSecrets'], '@/app/actions/usage': ['getUsage'],
    '@/app/actions/billing': ['cardVerificationStatus', 'getBilling', 'getCreditBilling'],
    '@/app/actions/audit-log': ['listAuditLog'], '@/app/actions/model-order': ['getModelOrder'],
    '@/app/actions/bots': ['listBots', 'listWorkspaceBots'], '@/app/actions/model-api-keys': ['getApiKeys'],
  })) mocks.push(mock.module(module, { namedExports: Object.fromEntries(names.map(name => [name, unexpected])) }))
  const store = await import('../lib/project-resources/store')
  const environment = await store.saveEnvironment(owner, { workspaceId: workspace.id, name: 'Canonical environment', configuration: { setup: { copyFiles: [], command: 'node --version', approved: true } } })
  const recoverable = await store.saveEnvironment(owner, { workspaceId: workspace.id, name: 'Recoverable environment', configuration: { variables: { RESTORED_ENVIRONMENT: 'kept' } } })
  await store.saveEnvironment(owner, { workspaceId: workspace.id, id: recoverable.id, revision: 1, name: 'Recoverable environment', configuration: { variables: { RESTORED_ENVIRONMENT: 'kept' } }, archived: true })
  await store.setProjectDefaultEnvironment(owner, { workspaceId: workspace.id, projectId: project, revision: 1, environmentId: environment.id })
  const { GET } = await import('../app/api/settings/[read]/route')
  const server = createServer(async (request, response) => {
    try {
      const result = await GET(new Request(`http://127.0.0.1${request.url}`), { params: Promise.resolve({ read: 'environments' }) })
      response.writeHead(result.status, Object.fromEntries(result.headers))
      response.end(await result.text())
    } catch (error) { response.statusCode = 500; response.end(error instanceof Error ? error.name : 'error') }
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections() }))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const read = (id = workspace.id) => fetch(`http://127.0.0.1:${address.port}/api/settings/environments?workspace=${id}`)
  let response = await read()
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  let body = await response.json()
  assert.equal(body.canManage, true)
  assert.deepEqual(body.environments.map((row: { id: string; archived: boolean }) => [row.id, row.archived]), [[environment.id, false], [recoverable.id, true]])
  assert.deepEqual(body.projects.map((row: { id: string; environmentId: string | null }) => [row.id, row.environmentId]), [[project, environment.id]])
  assert.equal(JSON.stringify(body).includes('private Project title'), false)

  const archived = body.environments.find((row: { id: string }) => row.id === recoverable.id)
  const restored = await store.saveEnvironment(owner, { workspaceId: workspace.id, id: archived.id, revision: archived.revision,
    name: archived.name, configuration: archived.configuration, archived: false })
  assert.equal(restored.revision, 3)
  response = await read(); body = await response.json()
  const recovered = body.environments.find((row: { id: string }) => row.id === recoverable.id)
  assert.equal(recovered.archived, false)
  assert.equal(recovered.configuration.variables.RESTORED_ENVIRONMENT, 'kept', 'restore uses the same versioned configuration and keeps its data')

  current = { id: member, name: 'Member', email: `${member}@example.invalid` }
  response = await read(); body = await response.json()
  assert.equal(response.status, 200)
  assert.equal(body.canManage, false, 'an old admin context cannot revive a downgraded role')
  assert.equal(body.environments[0].id, environment.id)
  assert.equal((await read(foreign.id)).status, 403)
  current[tokenWorkspace] = foreign.id
  assert.equal((await read()).status, 403, 'a pinned token tenant remains enforced after context resolution')
  delete current[tokenWorkspace]
  await fixture.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2', [workspace.id, member])
  response = await read()
  assert.equal(response.status, 403)
  assert.deepEqual(await response.json(), { error: 'workspaceAccessDenied' })
  current = null
  response = await read()
  assert.equal(response.status, 401)
  assert.deepEqual(await response.json(), { error: 'authRequired' })
})
