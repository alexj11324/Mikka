import '../../tests/support/server-only.mjs'
import assert from 'node:assert/strict'
import { before, beforeEach, mock, test } from 'node:test'

let ownApp = false, cloudEdition = false, binding: { revoked: boolean; scopes: string[] } | null = null, legacyCalls = 0
let cache = [{ installation_id: '99', account_id: '42', account_login: 'owner', account_type: 'User', github_account_id: '42' }]
const calls: { userId: string; scope: string; path: string; input?: Record<string, unknown> }[] = []
const native = `ghs_${'x'.repeat(36)}`
mock.module(new URL('../db/index.ts', import.meta.url).href, { namedExports: { pool: {
  async query(sql: string) { return { rows: sql.includes('cloud_service_bindings') ? binding ? [binding] : [] : cache, rowCount: 1 } },
  async connect() { return { async query() { return { rows: [], rowCount: 1 } }, release() {} } },
} } })
mock.module(new URL('./app-config.ts', import.meta.url).href, { namedExports: { readGitHubAppConfig: async () => ({ source: ownApp ? 'database' : 'environment' }) } })
mock.module(new URL('../edition.ts', import.meta.url).href, { namedExports: { isCloudEdition: () => cloudEdition } })
mock.module(new URL('./user-access.ts', import.meta.url).href, { namedExports: { githubTokenForUser: async () => { legacyCalls++; return { token: 'fixture-own-user-token', githubAccountId: '42', expiresAt: null } } } })
mock.module(new URL('./repository-installation.ts', import.meta.url).href, { namedExports: { linkedGitHubAccountId: async () => '42' } })
mock.module(new URL('../cloud-services/runtime.ts', import.meta.url).href, { namedExports: { cloudRequest: async (userId: string, scope: string, path: string, init?: RequestInit) => {
  calls.push({ userId, scope, path, ...(init?.body ? { input: JSON.parse(String(init.body)) } : {}) })
  if (path === '/v1/github/installation-token') return Response.json({ token: native, expiresAt: new Date(Date.now() + 3600_000).toISOString() })
  if (path === '/v1/github/installations') return Response.json({ installations: [], githubAccountId: null, subject: 'user:cloud-user', workspaceId: '00000000-0000-4000-8000-000000000001' })
  if (path === '/v1/github/install') return Response.json({ url: `https://github.com/apps/fixture-app/installations/new?state=mikka-gh.00000000-0000-4000-8000-000000000001.${'x'.repeat(43)}` })
  assert.fail('Unexpected cloud capability path')
} } })
let runtime: typeof import('./machine-credential'), cloud: typeof import('./cloud')
before(async () => { runtime = await import('./machine-credential'); cloud = await import('./cloud') })
beforeEach(() => { ownApp = false; cloudEdition = false; binding = { revoked: false, scopes: ['github'] }; legacyCalls = 0; calls.length = 0; cache = [{ installation_id: '99', account_id: '42', account_login: 'owner', account_type: 'User', github_account_id: '42' }] })

test('self-owned App wins over a cloud connection; no cloud provider call occurs', async () => {
  ownApp = true
  assert.equal((await runtime.githubMachineCredential('local-user', { remoteKey: 'v2/github.com/owner/repo' })).token, 'fixture-own-user-token')
  assert.equal(legacyCalls, 1); assert.deepEqual(calls, [])
})

test('cloud task preparation returns the native token and repository installation; no legacy identity substitution', async () => {
  const result = await runtime.githubMachineCredential('local-user', { remoteKey: 'v2/github.com/owner/repo' })
  assert.equal(result.token, native); assert.equal(result.installationId, '99'); assert.equal(result.githubAccountId, '42')
  assert.equal(legacyCalls, 0)
  assert.deepEqual(calls, [{ userId: 'local-user', scope: 'github', path: '/v1/github/installation-token', input: { installationId: '99', repositories: ['repo'] } }])
})

test('unconnected installation and Mikka Cloud itself retain environment-backed user credentials', async () => {
  binding = null
  assert.equal((await runtime.githubMachineCredential('local-user')).token, 'fixture-own-user-token')
  binding = { revoked: false, scopes: ['github'] }; cloudEdition = true
  assert.equal((await runtime.githubMachineCredential('local-user')).token, 'fixture-own-user-token')
  assert.equal(legacyCalls, 2); assert.deepEqual(calls, [])
})

test('revoked or insufficient cloud authority fails closed instead of selecting an environment credential', async () => {
  binding = { revoked: true, scopes: ['github'] }
  await assert.rejects(runtime.githubMachineCredential('local-user', { remoteKey: 'v2/github.com/owner/repo' }), { code: 'cloud_server_revoked' })
  binding = { revoked: false, scopes: ['push'] }
  await assert.rejects(runtime.githubMachineCredential('local-user', { remoteKey: 'v2/github.com/owner/repo' }), { code: 'cloud_scope_missing' })
  assert.equal(legacyCalls, 0); assert.deepEqual(calls, [])
})

test('cloud credentials require the host-selected canonical repository and never accept an arbitrary URL', async () => {
  for (const remoteKey of [undefined, 'https://evil.example/repo', 'v2/github.com/owner/../repo']) await assert.rejects(runtime.githubMachineCredential('local-user', { remoteKey }))
  assert.deepEqual(calls, [])
})

test('cloud installation redirect stays on GitHub and its state is issued through the linked user capability', async () => {
  const url = await cloud.beginCloudGitHubInstallation('local-user')
  assert.ok(url?.startsWith('https://github.com/apps/fixture-app/installations/new?state='))
  assert.deepEqual(calls, [{ userId: 'local-user', scope: 'github', path: '/v1/github/install', input: {} }])
})
