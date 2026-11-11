import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mock, test } from 'node:test'
import { Pool } from 'pg'
import { dbUrl, seedUser, seedWorkspace } from '../../tests/support/workspace-admin-db'

// Uses real PAT authentication, membership, plugin storage and share transactions.
// Only browser/native session verification and Next's request context are fixtures.
test('MCP permission grants require the existing human session boundary', { skip: !dbUrl, timeout: 60_000 }, async t => {
  const pool = new Pool({ connectionString: dbUrl, max: 4 })
  const owner = await seedUser(pool, 'mcp-human-owner'), peer = await seedUser(pool, 'mcp-human-peer')
  const home = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }])
  const team = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }, { userId: peer, role: 'member' }])
  const nativeToken = randomBytes(32).toString('base64url')
  mock.module('next/headers', { namedExports: { headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) } })
  mock.module('@/lib/auth', { namedExports: {
    MOBILE_APP_ORIGIN: 'mikka://',
    auth: { api: { getSession: async ({ headers }: { headers: Headers }) => headers.get('cookie') === 'human-fixture' || headers.get('authorization') === `Bearer ${nativeToken}` ? {
      user: { id: owner, name: 'Fixture', email: `${owner}@example.invalid`, image: null }, session: { id: 'synthetic-human-session' },
    } : null } },
  } })
  const { createLegacyPersonalAccessToken } = await import('../tokens/store')
  const token = await createLegacyPersonalAccessToken(owner, home.id, { name: 'Confined fixture token' })
  const { personalPlugins, workspaceMcp } = await import('./runtime')
  const server = await personalPlugins.createMcp(owner, { name: 'Private fixture', url: 'https://mcp.example.invalid/', transport: 'http', enabled: true })
  const route = await import('../../app/api/integrations/mcp/shares/route')
  const url = 'http://127.0.0.1/api/integrations/mcp/shares'
  const call = (headers: Record<string, string>, shared: boolean, workspaceId = team.id) => route.PATCH(new Request(url, { method: 'PATCH', headers: { origin: 'http://127.0.0.1', 'content-type': 'application/json', ...headers }, body: JSON.stringify({ serverId: server.id, workspaceId, shared }) }))
  const count = async () => (await pool.query('SELECT 1 FROM personal_mcp_workspace_shares WHERE server_id=$1 AND workspace_id=$2', [server.id, team.id])).rowCount
  t.after(async () => {
    mock.restoreAll()
    await pool.query('DELETE FROM personal_mcp_servers WHERE id=$1', [server.id])
    const [{ pool: appPool }, { workspacePool }] = await Promise.all([import('../db'), import('../workspace-db')])
    await Promise.all([pool.end(), appPool.end(), workspacePool.end()])
  })
  await t.test('a workspace PAT cannot grant another workspace access to a private MCP', async () => {
    const response = await call({ authorization: `Bearer ${token.token}` }, true)
    const observed = { status: response.status, grants: await count(), peerServers: (await workspaceMcp.freeze(peer, team.id)).servers.length }
    // Reset only this synthetic grant, even on RED, so later cases stay independent.
    await pool.query('DELETE FROM personal_mcp_workspace_shares WHERE server_id=$1', [server.id])
    assert.deepEqual(observed, { status: 401, grants: 0, peerServers: 0 })
  })
  await t.test('a PAT cannot withdraw a human-created grant', async () => {
    await workspaceMcp.share(owner, { serverId: server.id, workspaceId: team.id, shared: true })
    const before = (await workspaceMcp.freeze(peer, team.id)).servers[0].grantId
    const response = await call({ authorization: `Bearer ${token.token}` }, false)
    assert.deepEqual({ status: response.status, grants: await count(), grant: (await workspaceMcp.freeze(peer, team.id)).servers[0]?.grantId }, { status: 401, grants: 1, grant: before })
  })
  await t.test('an invalid delegated token is not rescued by a browser cookie', async () => {
    const response = await call({ authorization: `Bearer mkp_${'x'.repeat(43)}`, cookie: 'human-fixture' }, true)
    assert.equal(response.status, 401)
  })
  await t.test('a verified browser owner can share and unshare normally', async () => {
    assert.equal((await call({ cookie: 'human-fixture' }, true)).status, 200)
    assert.equal(await count(), 1)
    assert.equal((await call({ cookie: 'human-fixture' }, false)).status, 200)
    assert.equal(await count(), 0)
  })
  await t.test('a verified native human session retains the same sharing path', async () => {
    assert.equal((await call({ authorization: `Bearer ${nativeToken}` }, true)).status, 200)
    assert.equal(await count(), 1)
    assert.equal((await call({ authorization: `Bearer ${nativeToken}` }, false)).status, 200)
    assert.equal(await count(), 0)
  })
  await t.test('a human request with a foreign Origin remains refused', async () => {
    assert.equal((await call({ cookie: 'human-fixture', origin: 'https://elsewhere.example.invalid' }, true)).status, 403)
    assert.equal(await count(), 0)
  })
})
