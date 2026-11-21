import assert from 'node:assert/strict'
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { mock, test } from 'node:test'
import { Pool } from 'pg'
import { orderMigrations } from '../../scripts/migration-order.mjs'
import { isE2eTarget, E2E_DB_RULE } from '../../tests/helpers/e2e-target.mjs'
import { createTestDatabase, dropTestDatabase } from '../../tests/support/drop-test-database'
import { PersonalPluginStore } from './store'
import { WorkspaceMcpStore } from './workspace-mcp'
import { McpConnectionStore } from './connection-store'
import { McpOAuthStore } from './mcp-oauth'
import { createMcpSchema } from './contracts'
import { createPersonalMcpRuntime } from './mcp'
import { McpDeviceChecks } from './device-checks'
import { checkStdioMcp } from '../../packages/daemon/src/mcp-check'
import { ownerIntegrationSettingsTargets } from '../live/lists'

const database = process.env.E2E_DATABASE_URL
if (database) assert.ok(isE2eTarget(database), E2E_DB_RULE)
else if (process.env.REQUIRE_DB === '1') throw Error('MCP connection settings require an isolated E2E_DATABASE_URL')

test('MCP settings persist real discovery, owner-only tools and environment scope, and SDK OAuth without model calls', { skip: !database }, async t => {
  const isolatedDatabase = `mcp_settings_${randomUUID().replaceAll('-', '')}_e2e`
  const admin = new Pool({ connectionString: database })
  await createTestDatabase(admin, isolatedDatabase, 'template0')
  const target = new URL(database!); target.pathname = `/${isolatedDatabase}`
  const pool = new Pool({ connectionString: target.toString(), max: 8 })
  const owner = 'settings-owner', member = 'settings-member', outsider = 'settings-outsider'
  const workspace = randomUUID(), elsewhere = randomUUID(), environment = randomUUID(), wrongEnvironment = randomUUID()
  const fixtureToken = `synthetic-mcp-${randomUUID()}`
  let requireAuth = false, failCheck = false, toolCalls = 0, exchanges = 0, refreshes = 0, challenge = ''
  let mismatchedCatalogue = false
  const server = createServer(async (request, response) => {
    const path = new URL(request.url!, 'http://localhost').pathname
    const send = (body: unknown, status = 200) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)) }
    if (path.startsWith('/v0.1/servers')) {
      const entry = { server: { name: mismatchedCatalogue ? 'io.example/other' : 'io.example/docs', description: 'Directory fixture', version: '1.2.3', remotes: [
        { type: 'streamable-http', url: 'https://catalogue.example.com/mcp' }, { type: 'sse', url: 'https://127.0.0.1/private' },
      ] } }
      return send(path === '/v0.1/servers' ? { servers: [entry], metadata: { nextCursor: 'page-two' } } : entry)
    }
    if (path.startsWith('/.well-known/oauth-protected-resource')) return send({ resource: 'https://mcp.example.com/mcp', authorization_servers: ['https://oauth.example.com'] })
    if (path.startsWith('/.well-known/oauth-authorization-server') || path.startsWith('/.well-known/openid-configuration')) return send({
      issuer: 'https://oauth.example.com', authorization_endpoint: 'https://oauth.example.com/authorize', token_endpoint: 'https://oauth.example.com/token', registration_endpoint: 'https://oauth.example.com/register',
      response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'],
    })
    let body = ''; for await (const chunk of request) body += chunk
    if (path === '/register') return send({ client_id: 'fixture-client', ...JSON.parse(body) })
    if (path === '/token') {
      const params = new URLSearchParams(body)
      if (params.get('grant_type') === 'authorization_code') {
        exchanges++
        assert.equal(params.get('code'), 'fixture-code')
        assert.equal(createHash('sha256').update(params.get('code_verifier')!).digest('base64url'), challenge)
      } else { refreshes++; assert.equal(params.get('refresh_token'), 'fixture-refresh') }
      return send({ access_token: fixtureToken, token_type: 'Bearer', refresh_token: 'fixture-refresh', expires_in: refreshes ? 3600 : 1 })
    }
    if (request.method === 'GET') return send({}, 405)
    if (request.method === 'DELETE') return send({})
    if (failCheck) return send({ error: `private remote detail ${fixtureToken}` }, 503)
    if (requireAuth && request.headers.authorization !== `Bearer ${fixtureToken}`) return send({ error: fixtureToken }, 401)
    const input = JSON.parse(body)
    if (!('id' in input)) { response.writeHead(202); response.end(); return }
    if (input.method === 'tools/call') toolCalls++
    send({ jsonrpc: '2.0', id: input.id, result: input.method === 'initialize'
      ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'settings-fixture', version: '1' } }
      : input.method === 'tools/list'
        ? { tools: [{ name: 'read_docs', description: 'Read docs', inputSchema: { type: 'object' } }, { name: 'write_docs', description: 'd'.repeat(4001), inputSchema: { type: 'object' } }] }
        : { content: [{ type: 'text', text: 'done' }] } })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const localFetch: typeof fetch = (input, init) => { const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url); return fetch(address + url.pathname + url.search, init) }
  const transport = () => ({ fetch: localFetch, close: async () => {} })
  const env = { WORKSPACE_SECRETS_KEY: randomBytes(32).toString('hex'), BETTER_AUTH_URL: 'https://app.example.com' }
  try {
    const directory = new URL('../../drizzle/', import.meta.url)
    for (const migration of orderMigrations((await readdir(directory)).filter(name => name.endsWith('.sql')))) await pool.query(await readFile(new URL(migration, directory), 'utf8'))
    await pool.query(await readFile(new URL('20261120185217_mcp_connection_details.sql', directory), 'utf8'))
    await pool.query(await readFile(new URL('20261120191012_mcp_device_checks.sql', directory), 'utf8'))
    assert.match((await pool.query('SHOW server_version')).rows[0].server_version, /^17\./)
    for (const user of [owner, member, outsider]) await pool.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$1,$2,true,now(),now())', [user, `${user}@example.invalid`])
    for (const [id, users] of [[workspace, [owner, member]], [elsewhere, [outsider]]] as const) {
      await pool.query('INSERT INTO mikka_workspaces(id,"userId",name,kind) VALUES($1,$2,\'MCP settings fixture\',\'team\')', [id, users[0]])
      for (const user of users) await pool.query('INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) VALUES($1,$2,$2,$3,$4,\'active\')', [id, user, `${user}@example.invalid`, user === users[0] ? 'admin' : 'member'])
    }
    for (const [id, ws, user] of [[environment, workspace, owner], [wrongEnvironment, elsewhere, outsider]]) await pool.query('INSERT INTO workspace_environments(id,"workspaceId",name,configuration,"createdBy","updatedBy") VALUES($1,$2,\'Fixture\',\'{}\',$3,$3)', [id, ws, user])
    const personal = new PersonalPluginStore(pool, env, pool), shares = new WorkspaceMcpStore(pool, pool)
    const oauth = new McpOAuthStore(pool, env, transport)
    const connections = new McpConnectionStore(personal, { transport }, oauth)
    const deviceChecks = new McpDeviceChecks(personal)
    const installed = await personal.createMcp(owner, createMcpSchema.parse({ name: 'Docs', url: 'https://mcp.example.com/mcp', headers: { 'X-Account': 'fixture-account' } }))

    await t.test('real check persists status and tools, and repeat check preserves switches', async () => {
      assert.equal((await connections.detail(owner, installed.id)).status, 'needs_connect')
      const checked = await connections.check(owner, installed.id)
      assert.equal(checked.status, 'connected'); assert.ok(checked.lastCheckedAt)
      assert.deepEqual(checked.tools.map(tool => tool.name), ['read_docs', 'write_docs'])
      assert.equal(checked.tools.find(tool => tool.name === 'write_docs')?.description, 'd'.repeat(4000))
      await connections.setTool(owner, installed.id, 'write_docs', false)
      assert.equal((await connections.check(owner, installed.id)).tools.find(tool => tool.name === 'write_docs')?.enabled, false)
      failCheck = true
      const failed = await connections.check(owner, installed.id)
      assert.equal(failed.status, 'check_failed'); assert.ok(failed.failureReason)
      assert.equal(failed.tools.length, 2); assert.ok(!JSON.stringify(failed).includes(fixtureToken))
      failCheck = false
      assert.equal((await connections.check(owner, installed.id)).status, 'connected')
    })
    await t.test('shared members see only enabled tools and cannot change owner settings; other workspaces see nothing', async () => {
      await shares.share(owner, { serverId: installed.id, workspaceId: workspace, shared: true })
      const shared = await connections.detail(member, installed.id, workspace)
      assert.deepEqual(shared.tools.map(tool => tool.name), ['read_docs']); assert.equal(shared.authorizationUrl, null)
      assert.equal((await connections.search(member, { workspaceId: workspace, query: 'write_docs' })).count, 0)
      await assert.rejects(connections.detail(outsider, installed.id, elsewhere), /mcpNotFound/)
      await assert.rejects(connections.search(outsider, { workspaceId: workspace }), /workspaceAccessDenied/)
      await assert.rejects(connections.check(member, installed.id), /mcpNotFound/)
      await assert.rejects(connections.setTool(member, installed.id, 'read_docs', false), /mcpNotFound/)
      await assert.rejects(connections.setEnvironments(member, installed.id, { workspaceId: workspace, environmentIds: [environment] }), /mcpNotFound/)
      await assert.rejects(oauth.start(member, installed.id), /mcpNotFound/)
    })
    await t.test('disabled tools cannot be discovered or executed, and native grants carry the same filter', async () => {
      const snapshot = await personal.snapshot(member, pool, workspace)
      const runtime = createPersonalMcpRuntime(personal, { transport })
      const listed = await runtime(member, snapshot, { serverId: installed.id }) as { tools: { name: string }[] }
      assert.deepEqual(listed.tools.map(tool => tool.name), ['read_docs'])
      assert.deepEqual(await runtime(member, snapshot, { serverId: installed.id, name: 'write_docs', arguments: {} }), { error: 'mcpToolDisabled' })
      assert.equal(toolCalls, 0)
      assert.ok(!('error' in await runtime(member, snapshot, { serverId: installed.id, name: 'read_docs', arguments: {} })))
      assert.equal(toolCalls, 1)
      assert.deepEqual((await personal.nativeMcpConnections(member, snapshot.mcpAuthority!))[0].disabledTools, ['write_docs'])
    })
    await t.test('environment bindings narrow both personal and shared grants and cannot reference another tenant', async () => {
      await assert.rejects(connections.setEnvironments(owner, installed.id, { workspaceId: workspace, environmentIds: [wrongEnvironment] }), /environmentAccessDenied/)
      await assert.rejects(connections.setEnvironments(owner, installed.id, { workspaceId: elsewhere, environmentIds: [wrongEnvironment] }), /workspaceAccessDenied/)
      await connections.setEnvironments(owner, installed.id, { workspaceId: workspace, environmentIds: [environment] })
      assert.equal((await personal.snapshot(owner)).servers.length, 0)
      assert.equal((await personal.snapshot(member, pool, workspace)).servers.length, 0)
      const scoped = await personal.snapshot(member, pool, workspace, environment)
      assert.equal(scoped.servers.length, 1)
      const scopedBot = randomUUID()
      await pool.query('INSERT INTO bots(id,"ownerId","workspaceId","environmentId",name) VALUES($1,$2,$3,$4,\'Scoped MCP fixture\')', [scopedBot, member, workspace, environment])
      const botSnapshot = await personal.snapshotForBot(member, scopedBot, workspace, pool)
      assert.deepEqual(botSnapshot.servers.map(server => server.id), [installed.id])
      assert.equal(botSnapshot.mcpAuthority?.environmentId, environment)
      assert.equal((await personal.snapshotForBot(owner, scopedBot, workspace, pool)).servers.length, 0)
      await pool.query('UPDATE bots SET "environmentId"=NULL WHERE id=$1', [scopedBot])
      assert.equal((await personal.snapshotForBot(member, scopedBot, workspace, pool)).servers.length, 0)
      await assert.rejects(shares.validate(member, { ...scoped.mcpAuthority!, environmentId: wrongEnvironment }), /mcpUnavailable/)
      assert.equal((await personal.nativeMcpConnections(member, scoped.mcpAuthority!, environment)).length, 1)
      await assert.rejects(personal.nativeMcpConnections(member, scoped.mcpAuthority!, wrongEnvironment), /mcpUnavailable/)
      await assert.rejects(personal.nativeMcpConnections(member, scoped.mcpAuthority!, null), /mcpUnavailable/)
      await connections.setEnvironments(owner, installed.id, { workspaceId: workspace, environmentIds: [] })
      assert.equal((await personal.snapshot(member, pool, workspace)).servers.length, 1)
    })
    await t.test('SDK authorization code uses PKCE/state, tokens are encrypted, callbacks are single-use and refresh rotates under a row lock', async () => {
      requireAuth = true
      const needsConnect = await connections.check(owner, installed.id)
      assert.equal(needsConnect.status, 'needs_connect'); assert.ok(needsConnect.authorizationUrl)
      const start = await oauth.start(owner, installed.id)
      assert.equal(start.status, 'needs_connect'); assert.ok(start.authorizationUrl)
      const authorization = new URL(start.authorizationUrl)
      assert.equal(authorization.origin, 'https://oauth.example.com')
      assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256')
      challenge = authorization.searchParams.get('code_challenge')!
      const state = authorization.searchParams.get('state')!
      const input = { code: 'fixture-code', state, issuer: 'https://oauth.example.com' }
      await assert.rejects(oauth.callback(member, installed.id, input), /mcpNotFound/)
      await assert.rejects(oauth.callback(owner, installed.id, { ...input, state: 'wrong' }), /mcpOAuthStateInvalid/)
      assert.equal(exchanges, 0)
      assert.equal((await oauth.callback(owner, installed.id, input)).status, 'connected')
      await assert.rejects(oauth.callback(owner, installed.id, input), /mcpOAuthStateInvalid/)
      assert.equal(exchanges, 1)
      const stored = JSON.stringify((await pool.query('SELECT * FROM personal_mcp_oauth WHERE server_id=$1', [installed.id])).rows)
      assert.ok(!stored.includes(fixtureToken) && !stored.includes('fixture-refresh') && !stored.includes(state))
      assert.deepEqual(await Promise.all([oauth.accessToken(owner, installed.id), oauth.accessToken(owner, installed.id)]), [fixtureToken, fixtureToken])
      assert.equal(refreshes, 1)
      assert.deepEqual((await personal.mcpConnection(owner, installed.id)).headers, { 'X-Account': 'fixture-account', Authorization: `Bearer ${fixtureToken}` })
      assert.equal((await connections.detail(member, installed.id, workspace)).authorizationUrl, null)
      assert.ok(!JSON.stringify(await personal.listMcp(owner)).includes(fixtureToken))
    })
    await t.test('lost OAuth credentials change persisted state and explicit disconnect removes tokens', async () => {
      const oauthConnection = await personal.createMcp(owner, createMcpSchema.parse({ name: 'Missing token', url: 'https://mcp.example.com/mcp' }))
      await pool.query(`UPDATE personal_mcp_servers SET oauth_enabled=true,connection_status='connected' WHERE id=$1`, [oauthConnection.id])
      await assert.rejects(oauth.accessToken(owner, oauthConnection.id), /mcpNeedsConnect/)
      assert.equal((await connections.detail(owner, oauthConnection.id)).status, 'needs_connect')
      await personal.updateMcp(owner, { id: installed.id, auth: null })
      assert.equal((await pool.query('SELECT 1 FROM personal_mcp_oauth WHERE server_id=$1', [installed.id])).rowCount, 0)
      assert.equal((await connections.detail(owner, installed.id)).status, 'needs_connect')
      assert.equal((await personal.mcpConnection(owner, installed.id)).headers.Authorization, undefined)
      requireAuth = false
    })
    await t.test('STDIO check uses the selected owner device and accepts only a current one-use SDK receipt', async () => {
      const device = randomUUID(), otherDevice = randomUUID(), memberDevice = randomUUID()
      for (const [id, userId] of [[device, owner], [otherDevice, owner], [memberDevice, member]]) await pool.query('INSERT INTO devices(id,"ownerId",name) VALUES($1,$2,\'MCP fixture\')', [id, userId])
      const local = await personal.createMcp(owner, createMcpSchema.parse({ name: 'Local docs', transport: 'stdio', command: process.execPath,
        args: [fileURLToPath(new URL('../../packages/daemon/test/fakes/mcp-settings.mjs', import.meta.url))], env: { SERVICE_TOKEN: fixtureToken } }))
      await assert.rejects(deviceChecks.request(member, local.id, memberDevice), /mcpNotFound/)
      await assert.rejects(deviceChecks.request(owner, local.id, memberDevice), /mcpCheckDeviceNotFound/)
      await assert.rejects(deviceChecks.request(owner, installed.id, device), /mcpCheckNotAvailable/)
      const queued = await deviceChecks.request(owner, local.id, device)
      assert.equal((await connections.detail(owner, local.id)).deviceCheck?.status, 'pending')
      assert.deepEqual(await deviceChecks.pending(member, device), [])
      assert.deepEqual(await deviceChecks.pending(owner, otherDevice), [])
      const [command] = await deviceChecks.pending(owner, device)
      assert.equal(command.id, queued.id)
      const receipt = await checkStdioMcp(command)
      assert.deepEqual(receipt, { id: queued.id, status: 'connected', tools: [{ name: 'read_docs', description: 'Read [redacted]' }] })
      await assert.rejects(deviceChecks.complete(member, device, receipt), /mcpCheckReceiptExpired/)
      await assert.rejects(deviceChecks.complete(owner, otherDevice, receipt), /mcpCheckReceiptExpired/)
      await deviceChecks.complete(owner, device, receipt)
      await assert.rejects(deviceChecks.complete(owner, device, receipt), /mcpCheckReceiptExpired/)
      const checked = await connections.detail(owner, local.id)
      assert.equal(checked.status, 'connected'); assert.ok(checked.lastCheckedAt); assert.equal(checked.deviceCheck, null)
      assert.ok(!JSON.stringify(checked).includes(fixtureToken))
      await connections.setTool(owner, local.id, 'read_docs', false)
      const next = await deviceChecks.request(owner, local.id, device)
      await deviceChecks.complete(owner, device, { ...receipt, id: next.id })
      assert.equal((await connections.detail(owner, local.id)).tools[0].enabled, false)
      const stale = await deviceChecks.request(owner, local.id, device)
      await personal.updateMcp(owner, { id: local.id, name: 'Renamed local' })
      await assert.rejects(deviceChecks.complete(owner, device, { ...receipt, id: stale.id }), /mcpCheckReceiptExpired/)
      const expired = await deviceChecks.request(owner, local.id, device)
      await pool.query(`UPDATE mcp_device_checks SET expires_at=now()-interval '1 second' WHERE id=$1`, [expired.id])
      await assert.rejects(deviceChecks.complete(owner, device, { ...receipt, id: expired.id }), /mcpCheckReceiptExpired/)
      assert.deepEqual(await deviceChecks.pending(owner, device), [])
      assert.equal((await connections.detail(owner, local.id)).status, 'check_failed')
      assert.equal((await connections.detail(owner, local.id)).failureReason, 'deviceCheckExpired')
      assert.deepEqual(await ownerIntegrationSettingsTargets(pool, pool, owner), [{ scope: { ownerId: owner, workspaceId: workspace }, events: [{ kind: 'integration_settings', id: workspace }] }])
      await pool.query(`UPDATE devices SET "removedAt"=now() WHERE id=$1`, [device])
      await assert.rejects(deviceChecks.request(owner, local.id, device), /mcpCheckDeviceNotFound/)
    })
    await t.test('STDIO discovery and receipt commit finish through a one-connection Postgres pool', async () => {
      const single = new Pool({ connectionString: target.toString(), max: 1, connectionTimeoutMillis: 5_000 })
      try {
        const own = new PersonalPluginStore(single, env, single), checks = new McpDeviceChecks(own)
        const device = randomUUID()
        await single.query('INSERT INTO devices(id,"ownerId",name) VALUES($1,$2,\'Single connection fixture\')', [device, owner])
        const local = await own.createMcp(owner, createMcpSchema.parse({ name: 'Single connection docs', transport: 'stdio', command: process.execPath,
          args: [fileURLToPath(new URL('../../packages/daemon/test/fakes/mcp-settings.mjs', import.meta.url))], env: { SERVICE_TOKEN: fixtureToken } }))
        const queued = await checks.request(owner, local.id, device)
        const [command] = await checks.pending(owner, device)
        assert.equal(command.id, queued.id)
        const receipt = await checkStdioMcp(command)
        assert.equal(receipt.status, 'connected')
        await checks.complete(owner, device, receipt)
        const detail = await new McpConnectionStore(own).detail(owner, local.id)
        assert.equal(detail.status, 'connected'); assert.equal(detail.deviceCheck, null)
        assert.deepEqual(detail.tools, [{ name: 'read_docs', description: 'Read [redacted]', enabled: true, available: true }])
        await assert.rejects(checks.complete(owner, device, receipt), /mcpCheckReceiptExpired/)
      } finally { await single.end() }
    })
    await t.test('real API handlers reject unauthenticated, delegated, nonowner and cross-workspace calls before mutations', async () => {
      let actor: string | null = owner
      mock.module('../api-auth.ts', { namedExports: { auth: { api: { getSession: async () => actor ? { user: { id: actor } } : null } } } })
      mock.module('../request-log.ts', { namedExports: { noteLogUser() {}, noteLogRpcAction() {} } })
      mock.module('./runtime.ts', { namedExports: { personalPlugins: personal, workspaceMcp: shares, mcpConnections: connections, mcpDeviceChecks: deviceChecks } })
      // The directory uses real HTTP payloads; public DNS protection is owned by plugins.test.ts.
      mock.module('./public-fetch.ts', { namedExports: { publicMcpFetch: () => transport() } })
      const detail = await import('../../app/api/integrations/mcp/[id]/route')
      const check = await import('../../app/api/integrations/mcp/[id]/check/route')
      const tool = await import('../../app/api/integrations/mcp/[id]/tools/[name]/route')
      const environments = await import('../../app/api/integrations/mcp/[id]/environments/route')
      const start = await import('../../app/api/integrations/mcp/[id]/oauth/start/route')
      const callback = await import('../../app/api/integrations/mcp/[id]/oauth/callback/route')
      const search = await import('../../app/api/integrations/mcp/search/route')
      const catalog = await import('../../app/api/integrations/mcp/catalog/route')
      const context = { params: Promise.resolve({ id: installed.id, name: 'read_docs' }) }
      const request = (path: string, method = 'GET', body?: object) => new Request(`https://app.example.com${path}`, { method, headers: { origin: 'https://app.example.com', cookie: 'fixture', 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
      actor = null
      for (const result of await Promise.all([
        detail.GET(request('/api/integrations/mcp/id'), context), check.POST(request('/api/integrations/mcp/id/check', 'POST'), context),
        tool.PATCH(request('/api/integrations/mcp/id/tools/read_docs', 'PATCH', { enabled: false }), context), environments.PATCH(request('/api/integrations/mcp/id/environments', 'PATCH', { workspaceId: workspace, environmentIds: [] }), context),
        start.POST(request('/api/integrations/mcp/id/oauth/start', 'POST', {}), context), callback.GET(request('/api/integrations/mcp/id/oauth/callback'), context),
        search.GET(request('/api/integrations/mcp/search')), catalog.GET(request('/api/integrations/mcp/catalog')), catalog.POST(request('/api/integrations/mcp/catalog', 'POST', { name: 'fixture' })),
      ])) assert.equal(result.status, 401)
      actor = member
      for (const result of await Promise.all([
        check.POST(request('/api/integrations/mcp/id/check', 'POST'), context), tool.PATCH(request('/api/integrations/mcp/id/tools/read_docs', 'PATCH', { enabled: false }), context),
        environments.PATCH(request('/api/integrations/mcp/id/environments', 'PATCH', { workspaceId: workspace, environmentIds: [] }), context),
        start.POST(request('/api/integrations/mcp/id/oauth/start', 'POST', {}), context), callback.GET(request('/api/integrations/mcp/id/oauth/callback?code=fixture-code&state=wrong'), context),
      ])) assert.equal(result.status, 404)
      assert.equal((await detail.GET(request(`/api/integrations/mcp/id?workspaceId=${workspace}`), context)).status, 200)
      actor = outsider
      assert.equal((await detail.GET(request(`/api/integrations/mcp/id?workspaceId=${elsewhere}`), context)).status, 404)
      assert.equal((await search.GET(request(`/api/integrations/mcp/search?workspaceId=${workspace}`))).status, 403)
      actor = owner
      assert.equal((await check.POST(new Request('https://app.example.com/api/integrations/mcp/id/check', { method: 'POST', headers: { origin: 'https://other.example.com', cookie: 'fixture' } }), context)).status, 403)
      assert.equal((await start.POST(new Request('https://app.example.com/api/integrations/mcp/id/oauth/start', { method: 'POST', headers: { origin: 'https://app.example.com', authorization: 'Bearer mkpat_fixture', 'content-type': 'application/json' }, body: '{}' }), context)).status, 401)
      const local = (await personal.listMcp(owner)).find(server => server.transport === 'stdio')!
      const device = (await pool.query('SELECT id FROM devices WHERE "ownerId"=$1 AND "removedAt" IS NULL LIMIT 1', [owner])).rows[0].id
      const localContext = { params: Promise.resolve({ id: local.id }) }
      const requested = await check.POST(request('/api/integrations/mcp/id/check', 'POST', { deviceId: device }), localContext)
      assert.equal(requested.status, 200); assert.equal((await requested.json()).deviceCheck.status, 'pending')
      assert.equal((await check.POST(request('/api/integrations/mcp/id/check', 'POST', { deviceId: device, userId: outsider }), localContext)).status, 400)
      assert.equal((await connections.detail(owner, installed.id)).tools.find(tool => tool.name === 'read_docs')?.enabled, true)
      const directory = await catalog.GET(request('/api/integrations/mcp/catalog?q=docs'))
      assert.equal(directory.status, 200)
      assert.deepEqual(await directory.json(), { entries: [{ name: 'io.example/docs', description: 'Directory fixture', version: '1.2.3', remotes: [{ index: 0, url: 'https://catalogue.example.com/mcp', transport: 'http' }] }], nextCursor: 'page-two' })
      const added = await catalog.POST(request('/api/integrations/mcp/catalog', 'POST', { name: 'io.example/docs', remoteIndex: 0 }))
      assert.equal(added.status, 201)
      const addedId = (await added.json()).server.id
      assert.ok((await personal.listMcp(owner)).some(server => server.id === addedId))
      assert.ok(!(await personal.listMcp(member)).some(server => server.id === addedId))
      mismatchedCatalogue = true
      assert.equal((await catalog.POST(request('/api/integrations/mcp/catalog', 'POST', { name: 'io.example/docs', remoteIndex: 0 }))).status, 502)
    })
  } finally {
    mock.restoreAll()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await (await import('../builtin-gateway/runtime')).builtinGateway()?.stop()
    const [{ pool: applicationPool }, { workspacePool }] = await Promise.all([import('../db'), import('../workspace-db')])
    await Promise.all([applicationPool.end(), workspacePool.end()])
    await pool.end(); await dropTestDatabase(admin, isolatedDatabase); await admin.end()
  }
})
