import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mock, test } from 'node:test'
import { RUN_DECISION_CATALOGUE } from './mcp-tool'
import { dbUrl, seedAgent, seedBot, seedIssue, seedProject, seedProjectTasks, seedRun, seedUser, seedWorkspace } from '../../tests/support/workspace-admin-db'
import { dbUrl, seedAgent, seedBot, seedIssue, seedProject, seedRun, seedUser, seedPersonalWorkspace, seedWorkspace } from '../../tests/support/workspace-admin-db'
import { createApiHandler } from '../../apps/api/src/application'
import * as apiServer from '../../apps/api/compat/server'
import { ownLiveRuntime } from '../../tests/support/live-runtime'

test('decision HTTP routes and worker MCP persist through real token authorization', { skip: !dbUrl }, async t => {
  mock.module('next/server', { namedExports: apiServer })
  const live = await ownLiveRuntime(t)
  mock.module('@/lib/auth', { namedExports: {
    MOBILE_APP_ORIGIN: 'mikka://', auth: { api: { getSession: async () => null } },
  } })
  const { Pool } = await import('pg')
  const connection = new Pool({ connectionString: dbUrl, max: 2 })
  const { pool } = await import('@/lib/db')
  const { workspacePool } = await import('@/lib/workspace-db')
  const { createPersonalAccessToken } = await import('@/lib/tokens/store')
  const { issueRunToken } = await import('@/lib/mcp/worker')
  const route = await import('../../app/api/projects/[projectId]/decisions/route')
  const marking = await import('../../app/api/projects/[projectId]/decisions/from-message/route')
  const mcp = await import('../../app/api/mcp/route')
  // Exercise the real API request scope used by MCP's retained tool callbacks.
  const mcpApi = createApiHandler([{ path: '/mikka/api/mcp', template: '/api/mcp', source: 'app/api/mcp/route.ts',
    methods: ['POST'], load: async () => mcp }])
  const owner = await seedUser(connection, 'decision-http-owner'), other = await seedUser(connection, 'decision-http-other')
  const workspace = { id: await seedPersonalWorkspace(connection, owner) }
  const foreign = await seedWorkspace(connection, other, [{ userId: other, role: 'admin' }])
  const projectId = await seedProject(connection, owner, [])
  const issueId = await seedIssue(connection, owner)
  await seedProjectTasks(connection, projectId, [issueId])
  const botId = await seedBot(connection, workspace.id, owner)
  const messageId = randomUUID()
  await connection.query('insert into coordinator_messages (id,"userId","botId",position,message) values ($1,$2,$3,0,$4)', [
    messageId, owner, botId, JSON.stringify({ role: 'user', content: 'Keep the immutable decision history.' }),
  ])
  const originalMessageAt = new Date('2026-01-01T00:00:00Z')
  await connection.query('update coordinator_messages set "createdAt"=$2 where id=$1', [messageId, originalMessageAt])
  const token = await createPersonalAccessToken(owner, workspace.id, { name: 'Project decisions HTTP test' })
  const otherToken = await createPersonalAccessToken(other, foreign.id, { name: 'Foreign project decisions HTTP test' })
  const agentId = await seedAgent(connection, owner)
  const runId = await seedRun(connection, { userId: owner, agentId, issueId, status: 'running' })
  const runToken = await issueRunToken({ id: runId, userId: owner })
  const server = createServer(async (incoming, outgoing) => {
    try {
      const chunks: Buffer[] = []
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
      const request = new Request('http://127.0.0.1' + incoming.url, {
        method: incoming.method, headers: Object.fromEntries(Object.entries(incoming.headers).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
        ...(incoming.method !== 'GET' ? { body: Buffer.concat(chunks).toString('utf8') } : {}),
      })
      const context = { params: Promise.resolve({ projectId }) }
      const response = incoming.url?.includes('/api/mcp') ? await mcpApi.fetch(request)
        : incoming.url?.includes('/from-message') ? await marking.POST(request, context)
          : incoming.method === 'GET' ? await route.GET(request, context) : await route.POST(request, context)
      outgoing.writeHead(response.status, Object.fromEntries(response.headers))
      outgoing.end(await response.text())
    } catch { outgoing.writeHead(500); outgoing.end('handlerFailed') }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const origin = 'http://127.0.0.1:' + address.port
  t.after(async () => { server.close(); server.closeAllConnections(); try { await live.close() } finally { await Promise.all([connection.end(), pool.end(), workspacePool.end()]) } })
  const path = '/mikka/api/projects/' + projectId + '/decisions'
  const input = { workspaceId: workspace.id, kind: 'confirm', title: 'Retain the history', summary: 'Keep earlier reasons', reason: 'A later correction must remain auditable', idempotencyKey: 'http-marking-1' }
  const send = (pathname: string, bearer: string | null, body?: unknown) => fetch(origin + pathname, {
    method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(10_000),
    headers: { ...(bearer ? { authorization: 'Bearer ' + bearer } : {}), 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  await t.test('from-message returns 201 then 200, reads the real row and never echoes the transcript', async () => {
    const body = { ...input, source: { type: 'bot_message', id: messageId, botId, position: 0 } }
    const first = await send(path + '/from-message', token.token, body)
    assert.equal(first.status, 201)
    assert.equal(first.headers.get('cache-control'), 'private, no-store')
    const created = await first.json()
    assert.equal(created.duplicate, false)
    const duplicate = await send(path + '/from-message', token.token, body)
    assert.equal(duplicate.status, 200)
    assert.equal((await duplicate.json()).decisionId, created.decisionId)
    const { rows } = await connection.query('select "captureMode","recordedBy","occurredAt" from project_decisions where id=$1', [created.decisionId])
    assert.equal(rows[0].captureMode, 'human_marked')
    assert.equal(rows[0].occurredAt.toISOString(), originalMessageAt.toISOString())
    assert.equal(rows[0].recordedBy.userId, owner)
    const read = await send(path + '?workspaceId=' + workspace.id, token.token)
    assert.equal(read.status, 200)
    const text = await read.text()
    assert.ok(!text.includes('Keep the immutable decision history.'))
    assert.equal(JSON.parse(text).decisions[0].sources[0].locator.id, messageId)
  })
  await t.test('unauthenticated, foreign-workspace, conflicting and forged writes fail with no row', async () => {
    assert.equal((await send(path + '?workspaceId=' + workspace.id, null)).status, 401)
    assert.equal((await send(path, otherToken.token, input)).status, 404)
    assert.equal((await send(path, token.token, { ...input, ownerId: other })).status, 400)
    assert.equal((await send(path + '/from-message', token.token, { ...input, idempotencyKey: 'missing-message', source: { type: 'bot_message', id: randomUUID() } })).status, 404)
    assert.equal((await send(path + '/from-message', token.token, { ...input, reason: 'conflicting reason', source: { type: 'bot_message', id: messageId, botId, position: 0 } })).status, 409)
  })
  const rpc = async (bearer: string, method: string, params: unknown) => {
    const response = await send('/mikka/api/mcp', bearer, { jsonrpc: '2.0', id: 1, method, params })
    const text = await response.text()
    const payload = text.trim().startsWith('{') ? JSON.parse(text) : JSON.parse(text.split('\n').find(line => line.startsWith('data: '))!.slice(6))
    return { response, payload }
  }
  await t.test('exported worker MCP lists and actually calls record_decision; revoked token fails', async () => {
    const listed = await rpc(runToken.token, 'tools/list', {})
    assert.equal(listed.response.status, 200)
    assert.deepEqual(listed.payload.result.tools.find((tool: { name: string }) => tool.name === 'record_decision'), RUN_DECISION_CATALOGUE.tool)
    const args = { ...input, projectId, issueId, idempotencyKey: 'mcp-real-write' }
    const called = await rpc(runToken.token, 'tools/call', { name: 'record_decision', arguments: args })
    assert.equal(called.response.status, 200)
    assert.notEqual(called.payload.result.isError, true)
    const { rows } = await connection.query('select id,"captureMode","recordedBy" from project_decisions where "runId"=$1', [runId])
    assert.equal(rows.length, 1)
    assert.equal(rows[0].captureMode, 'live')
    assert.equal(rows[0].recordedBy.id, runId)
    const second = await rpc(runToken.token, 'tools/call', { name: 'record_decision', arguments: args })
    assert.equal(second.response.status, 200)
    assert.equal((await connection.query('select count(*)::int as count from project_decisions where "runId"=$1', [runId])).rows[0].count, 1)
    await connection.query('update run_tokens set "revokedAt"=now() where "runId"=$1', [runId])
    const denied = await send('/mikka/api/mcp', runToken.token, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'record_decision', arguments: { ...args, idempotencyKey: 'revoked' } } })
    assert.equal(denied.status, 401)
  })
})
