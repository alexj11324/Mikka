import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFile, readdir } from 'node:fs/promises'
import { Pool } from 'pg'
import { orderMigrations } from '../../scripts/migration-order.mjs'
import { isE2eTarget, E2E_DB_RULE } from '../../tests/helpers/e2e-target.mjs'
import { dropTestDatabase } from '../../tests/support/drop-test-database'
import { PersonalPluginStore } from './store'
import { WorkspaceMcpStore } from './workspace-mcp'
import { createMcpSchema } from './contracts'
import { createPersonalMcpRuntime, type McpDependencies } from './mcp'
import { AgentKitStore } from '@/lib/agent-kit/store'
import { DEFAULT_AGENT_DEFINITION } from '@/lib/agent-kit/builtin'
import { freezeWorkerDefinition, retryWorkerDefinition } from '@/lib/agent-kit/worker'
import { freezeExecutionIdentity, ExecutionIdentityError } from '@/lib/execution-identity'
import { createExecutionClaim } from '@/lib/factory/execution-claim'

const url = process.env.E2E_DATABASE_URL
if (url) assert.ok(isE2eTarget(url), E2E_DB_RULE)
else if (process.env.REQUIRE_DB === '1') assert.fail('Shared MCP tests require an isolated E2E_DATABASE_URL')

test('explicit workspace MCP sharing keeps requester, resource grants, tokens and history distinct', { skip: !url, timeout: 180_000 }, async t => {
  const admin = new Pool({ connectionString: url, max: 1 })
  const database = `workspace_mcp_${randomUUID().replaceAll('-', '')}_e2e`
  await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`)
  const target = new URL(url!); target.pathname = `/${database}`
  const pool = new Pool({ connectionString: target.toString(), max: 5 })
  let appPool: Pool | undefined, workspacePool: Pool | undefined
  const saved = { MIKKA_DATABASE_URL: process.env.MIKKA_DATABASE_URL, DATABASE_URL: process.env.DATABASE_URL, WORKSPACE_SECRETS_KEY: process.env.WORKSPACE_SECRETS_KEY }
  Object.assign(process.env, { MIKKA_DATABASE_URL: target.toString(), DATABASE_URL: target.toString(), WORKSPACE_SECRETS_KEY: randomBytes(32).toString('hex') })
  const secret = `synthetic-mcp-${randomUUID()}`, privateUrl = 'https://mcp.acme.dev/private-endpoint'
  let calls = 0, handshakes = 0, afterInitialize: (() => Promise<void>) | undefined
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${secret}`)
    if (request.method === 'DELETE') { response.writeHead(200); response.end(); return }
    if (request.method === 'GET') { response.writeHead(405); response.end(); return }
    let body = ''; for await (const chunk of request) body += chunk
    const input = JSON.parse(body)
    if (!('id' in input)) { response.writeHead(202); response.end(); return }
    if (input.method === 'initialize') { handshakes++; await afterInitialize?.() }
    if (input.method === 'tools/call') calls++
    const result = input.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'shared-fixture', version: '1' } }
      : input.method === 'tools/list' ? { tools: [{ name: 'echo', description: `${privateUrl} ${secret}`, inputSchema: { type: 'object', properties: {} } }] }
        : { content: [{ type: 'text', text: JSON.stringify({ done: true, secret, authorization: `Bearer ${secret}`, encoded: Buffer.from(secret).toString('base64'), endpoint: privateUrl }) }] }
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ jsonrpc: '2.0', id: input.id, result }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  // A real MCP SDK handshake against a local fixture; no third-party service or model I/O.
  const transport: McpDependencies = { transport: (_origin, signal) => ({ fetch: (input, init) => fetch(address + new URL(String(input)).pathname, { ...init, signal }), close: async () => {} }) }
  try {
    const directory = new URL('../../drizzle/', import.meta.url)
    for (const migration of orderMigrations((await readdir(directory)).filter(name => name.endsWith('.sql')))) await pool.query(await readFile(new URL(migration, directory), 'utf8'))
    await pool.query(await readFile(new URL('20261104003000_mcp_workspace_shares.sql', directory), 'utf8'))
    mock.module('next/server', { namedExports: { after() {} } })
    const { issueRunToken, verifyRunToken } = await import('@/lib/mcp/worker')
    const { runMcpAuthority, runCustomMcp } = await import('./run-mcp')
    const { submitArtifact, readArtifact } = await import('@/lib/artifacts/store')
    const { releaseDepartingMember } = await import('@/lib/workspace-admin/members')
    appPool = (await import('@/lib/db')).pool; workspacePool = (await import('@/lib/workspace-db')).workspacePool
    const owner = 'mcp-owner', requester = 'mcp-requester', outsider = 'mcp-outsider'
    for (const user of [owner, requester, outsider]) await pool.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$1,$2,true,now(),now())', [user, `${user}@example.invalid`])
    const workspace = randomUUID(), foreignWorkspace = randomUUID(), personalWorkspace = randomUUID(), bot = randomUUID(), device = randomUUID(), agent = randomUUID(), issue = randomUUID()
    for (const [id, kind] of [[workspace, 'team'], [foreignWorkspace, 'team'], [personalWorkspace, 'personal']]) {
      await pool.query('INSERT INTO mikka_workspaces(id,"userId",name,kind) VALUES($1,$2,\'MCP fixture\',$3)', [id, owner, kind])
      for (const user of kind === 'personal' ? [owner] : [owner, requester]) await pool.query('INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) VALUES($1,$2,$2,$3,\'member\',\'active\')', [id, user, `${user}@example.invalid`])
    }
    await pool.query('INSERT INTO bots(id,"ownerId","workspaceId",name) VALUES($1,$2,$3,\'Requester Bot\')', [bot, requester, workspace])
    await pool.query('INSERT INTO devices(id,"ownerId",name) VALUES($1,$2,\'Requester device\')', [device, requester])
    await pool.query('INSERT INTO agents(id,"userId",name,harness,"deviceId") VALUES($1,$2,\'Requester Agent\',\'codex\',$3)', [agent, requester, device])
    await pool.query('INSERT INTO issues(id,"userId","workspaceId",title,content,status,priority) VALUES($1,$2,$3,\'MCP fixture\',\'{"type":"doc","content":[]}\',\'doing\',\'normal\')', [issue, requester, workspace])
    const personal = new PersonalPluginStore(pool, process.env, pool), shares = new WorkspaceMcpStore(pool, pool)
    const connection = await personal.createMcp(owner, createMcpSchema.parse({ name: 'Team finance', url: privateUrl, auth: { name: 'Authorization', value: `Bearer ${secret}` } }))
    const runtime = createPersonalMcpRuntime(personal, transport)
    const command = { serverId: connection.id, name: 'echo', arguments: {} }

    await t.test('membership alone lends nothing; only the resource owner may explicitly share into an existing team', async () => {
      assert.deepEqual((await shares.list(requester, workspace)).servers, [])
      assert.equal((await personal.snapshot(requester, pool, workspace)).servers.length, 0)
      await assert.rejects(personal.mcpConnection(requester, connection.id), /mcpUnavailable/)
      await assert.rejects(shares.share(requester, { serverId: connection.id, workspaceId: workspace, shared: true }), /mcpNotFound/)
      await assert.rejects(shares.share(outsider, { serverId: connection.id, workspaceId: workspace, shared: true }), /workspaceAccessDenied/)
      await assert.rejects(shares.share(owner, { serverId: connection.id, workspaceId: personalWorkspace, shared: true }), /workspaceAccessDenied/)
      assert.equal(handshakes, 0)
    })
    await shares.share(owner, { serverId: connection.id, workspaceId: workspace, shared: true })
    let snapshot = await personal.snapshot(requester, pool, workspace)
    await t.test('shared discovery and a real MCP handshake use the owner credential without returning it or changing the requester', async () => {
      assert.equal(snapshot.mcpAuthority?.requester, requester)
      assert.equal(snapshot.mcpAuthority?.servers[0].ownerId, owner)
      assert.ok(snapshot.mcpAuthority?.servers[0].grantId)
      const view = (await shares.list(requester, workspace)).servers[0]
      assert.equal(view.url, null); assert.equal(view.mine, false); assert.equal(view.ownerId, owner)
      assert.ok(!JSON.stringify(view).includes(secret)); assert.ok(!JSON.stringify(snapshot).includes(privateUrl))
      const catalog = await runtime(requester, snapshot, { serverId: connection.id })
      const result = await runtime(requester, snapshot, command)
      assert.equal(calls, 1); assert.ok('tools' in catalog)
      for (const value of [catalog, result]) for (const needle of [secret, Buffer.from(secret).toString('base64'), privateUrl]) assert.ok(!JSON.stringify(value).includes(needle))
      const stored = (await pool.query('SELECT ciphertext FROM personal_mcp_servers WHERE id=$1', [connection.id])).rows[0]
      assert.ok(stored.ciphertext && !stored.ciphertext.includes(secret))
      assert.equal((await runtime(owner, await personal.snapshot(owner), command) as { error?: string }).error, undefined, 'legacy personal runtime stays usable')
    })
    await t.test('workspace, requester, connection revision and grant ID are bound independently', async () => {
      const before = calls
      assert.equal((await personal.snapshot(requester, pool, foreignWorkspace)).servers.length, 0)
      for (const authority of [{ ...snapshot.mcpAuthority!, requester: owner }, { ...snapshot.mcpAuthority!, workspaceId: foreignWorkspace },
        { ...snapshot.mcpAuthority!, servers: snapshot.mcpAuthority!.servers.map(item => ({ ...item, grantId: randomUUID() })) }])
        assert.ok('error' in await runtime(requester, { ...snapshot, mcpAuthority: authority }, command))
      assert.equal(calls, before)
      const grant = snapshot.mcpAuthority!.servers[0].grantId
      await shares.share(owner, { serverId: connection.id, workspaceId: workspace, shared: true })
      assert.equal((await personal.snapshot(requester, pool, workspace)).mcpAuthority!.servers[0].grantId, grant, 'exact sharing replay preserves the grant')
    })
    const kit = new AgentKitStore(pool), scope = { ownerId: requester, botId: bot, workspaceId: workspace }
    const execution = await kit.beginExecution(scope, 'shared-mcp-execution', 'Requester instructions only', { harness: 'ai_sdk', model: 'fixture-no-model-call' }, DEFAULT_AGENT_DEFINITION, client => personal.snapshot(requester, client, workspace))
    const definition = freezeWorkerDefinition({ harness: 'codex', instructions: 'Requester task', prompt: 'Read the authorized team resource', parent: execution.snapshot, executionId: execution.id, allowLocalRecovery: true })
    definition.executionIdentity = await freezeExecutionIdentity(pool, { userId: requester, botId: bot, deviceId: device, agentDefinition: definition }, pool)
    const runId = randomUUID(), legacyId = randomUUID(), request = new Request('http://127.0.0.1/mikka/api/runs/mcp/custom_mcp')
    for (const [id, value] of [[runId, definition], [legacyId, null]]) await pool.query('INSERT INTO agent_runs(id,"userId","botId","deviceId","agentId","issueId",status,"agentDefinition") VALUES($1,$2,$3,$4,$5,$6,\'queued\',$7)', [id, requester, bot, device, agent, issue, value ? JSON.stringify(value) : null])
    const { token } = await issueRunToken({ id: runId, userId: requester }), legacy = await issueRunToken({ id: legacyId, userId: requester })
    const verified = await verifyRunToken(request, token); assert.ok(verified)
    const claim = createExecutionClaim(pool, async () => true)
    await claim(requester, device, runId, new Date(Date.now() + 300_000).toISOString())
    let artifactId = ''
    await t.test('actual run token, claim and artifact provenance retain requester and immutable resource owner; legacy tokens gain no shared catalogue', async () => {
      assert.equal((await runMcpAuthority(requester, runId))?.servers[0].ownerId, owner)
      assert.equal(await runMcpAuthority(owner, runId), null)
      assert.ok(await verifyRunToken(request, legacy.token)); assert.equal(await runMcpAuthority(requester, legacyId), null)
      assert.ok(!('error' in await runCustomMcp(request, verified, command, transport)))
      assert.equal(definition.executionIdentity?.requester, requester); assert.equal(definition.executionIdentity?.outputOwner, requester)
      const resource = definition.executionIdentity?.resourceBindings.find(item => item.kind === 'mcp')
      assert.deepEqual(resource, { kind: 'mcp', id: connection.id, ownerId: owner, access: 'workspace_share', revision: String(connection.revision), grantId: snapshot.mcpAuthority!.servers[0].grantId, workspaceId: workspace })
      const artifact = await submitArtifact({ userId: requester, runId, botId: bot, issueId: issue, authorName: 'Fixture' }, { title: 'Requester output', kind: 'markdown', content: 'Synthetic result without private connection data' })
      assert.ok(!('error' in artifact)); if ('error' in artifact) return
      artifactId = artifact.artifactId
      assert.ok(await readArtifact(requester, artifactId)); assert.equal(await readArtifact(owner, artifactId), null)
      assert.deepEqual(retryWorkerDefinition(definition, 'Retry current target')?.customMcp, definition.customMcp)
      assert.equal(retryWorkerDefinition(definition, 'Retry current target')?.allowLocalRecovery, true)
    })
    await t.test('token withdrawal during the MCP handshake refuses the side effect', async () => {
      const before = calls
      afterInitialize = async () => { await pool.query('UPDATE run_tokens SET "revokedAt"=now() WHERE "runId"=$1', [runId]) }
      assert.deepEqual(await runCustomMcp(request, verified, command, transport), { error: 'mcpUnavailable' })
      afterInitialize = undefined
      assert.equal(calls, before)
      await pool.query('UPDATE run_tokens SET "revokedAt"=NULL WHERE "runId"=$1', [runId])
    })
    await t.test('sharing withdrawal during initialization refuses the next call and re-sharing never revives old execution snapshots', async () => {
      const before = calls, oldGrant = snapshot.mcpAuthority!.servers[0].grantId
      afterInitialize = async () => { await shares.share(owner, { serverId: connection.id, workspaceId: workspace, shared: false }) }
      assert.deepEqual(await runtime(requester, snapshot, command), { error: 'mcpUnavailable' })
      afterInitialize = undefined
      assert.equal(calls, before); assert.equal(await verifyRunToken(request, token), undefined)
      await pool.query('UPDATE agent_runs SET status=\'queued\' WHERE id=$1', [runId])
      await assert.rejects(claim(requester, device, runId, new Date(Date.now() + 300_000).toISOString()), ExecutionIdentityError)
      await shares.share(owner, { serverId: connection.id, workspaceId: workspace, shared: true })
      assert.ok('error' in await runtime(requester, snapshot, command))
      snapshot = await personal.snapshot(requester, pool, workspace)
      assert.notEqual(snapshot.mcpAuthority!.servers[0].grantId, oldGrant)
      assert.ok(!('error' in await runtime(requester, snapshot, command)))
      assert.equal(await verifyRunToken(request, token), undefined, 'new grants do not repair or widen a historical token')
      const history = (await pool.query('SELECT "executionIdentity" FROM artifact_versions WHERE "artifactId"=$1', [artifactId])).rows[0]
      assert.deepEqual(history.executionIdentity, definition.executionIdentity)
      assert.deepEqual((await kit.readExecution(scope, execution.id)).snapshot.personalPlugins, execution.snapshot.personalPlugins)
    })
    for (const user of [owner, requester]) await t.test(`the next MCP call refuses an inactive ${user}`, async () => {
      const before = calls
      await pool.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2', [workspace, user])
      assert.ok('error' in await runtime(requester, snapshot, command)); assert.equal(calls, before)
      await pool.query('UPDATE mikka_workspace_members SET status=\'active\' WHERE "workspaceId"=$1 AND "userId"=$2', [workspace, user])
    })
    await t.test('disconnect/revision changes and normal member departure revoke references without rewriting history', async () => {
      const before = calls
      await personal.updateMcp(owner, { id: connection.id, enabled: false })
      assert.ok('error' in await runtime(requester, snapshot, command)); assert.equal(calls, before)
      await personal.updateMcp(owner, { id: connection.id, enabled: true })
      assert.ok('error' in await runtime(requester, snapshot, command))
      snapshot = await personal.snapshot(requester, pool, workspace)
      await releaseDepartingMember(workspace, owner)
      assert.ok('error' in await runtime(requester, snapshot, command))
      assert.equal((await shares.list(requester, workspace)).servers.length, 0)
      assert.ok(await readArtifact(requester, artifactId), 'resource withdrawal does not erase requester-owned output')
    })
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
    for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value }
    await dropTestDatabase(admin, database, pool, appPool, workspacePool)
  }
})
