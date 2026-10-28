import assert from 'node:assert/strict'
import { after, before, mock, test } from 'node:test'
import { createHash } from 'node:crypto'
import net from 'node:net'
import { EventEmitter } from 'node:events'
import { personalWorkerMailboxSupported } from './personal-mailbox-capability'
import { makeSnapshot, digest } from './agent-kit/definition'
import { DEFAULT_AGENT_DEFINITION } from './agent-kit/builtin'
import { freezeWorkerDefinition } from './agent-kit/worker'
import { mailboxInputs } from '@mikka/protocol/mailbox'

// Actual exported HTTP handler, runtime namespace resolver, strict action
// parser and store. Token verification and SQL are controlled fixtures, not
// genuine credentials/Postgres acceptance. No listener, network or SQL client.
const owner = 'synthetic-owner', runId = '28700000-0000-4000-8000-000000000001'
const namespace = '28700000-0000-4000-8000-000000000002'
const boxId = '28700000-0000-4000-8000-000000000003'
const bearer = 'mkw_' + 'x'.repeat(43)
let validToken = true, botOwned = true, enabled = true, stopped = false, expired = false
let memberStatus = 'active', currentHarness = 'codex'
let botId: string | null = '28700000-0000-4000-8000-000000000004'
let parentBotKey = '28700000-0000-4000-8000-000000000004'
const mailboxNamespace = () => botId ? namespace : '28700000-0000-4000-8000-000000000099'
let parent = makeSnapshot('28700000-0000-4000-8000-000000000081', 1, { ...DEFAULT_AGENT_DEFINITION, tools: Object.keys(mailboxInputs) }, 'HOST', { harness: 'ai_sdk', model: 'synthetic' })
const parentId = '28700000-0000-4000-8000-000000000082'
const grantedWorker = (kind: 'codex' | 'claude_code' = 'codex') => freezeWorkerDefinition({ harness: kind, instructions: 'Fixture', prompt: 'Task', parent, executionId: parentId, mailboxEnabled: true, mailboxScope: { botId, workspaceId: mailboxNamespace() } })
let agentDefinition: unknown = grantedWorker(), harness = 'codex'
let currentDefinition = parent.definition
function grantQuery(sql: string) {
  if (sql.startsWith('select bot_key from agent_kit_executions')) return { rows: [{ bot_key: parentBotKey }] }
  if (sql.startsWith('select active_version,workspace_id from agent_kit_heads')) return { rows: [{ active_version: parent.revisionId, workspace_id: parentBotKey === 'coordinator' ? null : namespace }] }
  if (sql.startsWith('select snapshot,status,version_id from agent_kit_executions')) return { rows: [{ snapshot: parent, status: 'completed', version_id: parent.revisionId }] }
  if (sql.startsWith('select definition,digest from agent_kit_versions')) return { rows: [{ definition: currentDefinition, digest: digest(currentDefinition) }] }
}
let afterHint = () => {}, afterData = () => {}
const queries: { sql: string; params: unknown[] }[] = []
let connections = 0
const client = { release() {}, async query(sql: string, params: unknown[] = []) {
  queries.push({ sql, params })
  const grant = grantQuery(sql); if (grant) return grant
  if (sql.startsWith('SELECT id FROM bots')) {
    assert.equal(params[2], namespace)
    return { rows: botOwned ? [{}] : [], rowCount: botOwned ? 1 : 0 }
  }
  if (sql.startsWith('SELECT id FROM devices')) return { rows: enabled ? [{}] : [], rowCount: enabled ? 1 : 0 }
  if (sql.startsWith('SELECT id FROM agents')) return { rows: [{}], rowCount: 1 }
  if (sql.startsWith('SELECT r.id FROM agent_runs r')) {
    const valid = params[2] === botId && params[3] === 'synthetic-device' && validToken && !stopped && !expired && params[6] === JSON.stringify(agentDefinition)
    return { rows: valid ? [{}] : [], rowCount: valid ? 1 : 0 }
  }
  if (sql.startsWith('select "mailboxId" from agent_runs')) return { rows: [{ mailboxId: boxId }] }
  if (sql.startsWith('select r.*,a.harness')) return { rows: [{ mailboxId: boxId, harness: 'codex', status: 'running', stopRequestedAt: stopped ? new Date() : null, leaseExpiresAt: new Date(expired ? 0 : Date.now() + 60000) }] }
  if (sql.startsWith('select id from run_tokens')) {
    assert.deepEqual(params, [runId, owner, createHash('sha256').update(bearer).digest('hex')])
    return { rows: validToken ? [{ id: 'synthetic-token' }] : [], rowCount: validToken ? 1 : 0 }
  }
  if (sql.startsWith('select 1 from session_mailboxes')) return { rows: enabled ? [{}] : [], rowCount: enabled ? 1 : 0 }
  if (sql.startsWith('select * from session_mailboxes')) return { rows: [{ id: boxId, userId: owner, workspaceId: mailboxNamespace(), kind: 'run', sessionKey: runId, disabled: !enabled }] }
  if (sql.startsWith('select r.status')) return { rows: [{ status: 'running', stopRequestedAt: stopped ? new Date() : null, leaseExpiresAt: new Date(expired ? 0 : Date.now() + 60000), enabled }] }
  if (sql.startsWith('update run_messages set "deliveredAt"')) { afterData(); return { rows: [] } }
  return { rows: [] }
} }
const pool = {
  async connect() { connections++; return client },
  async query(sql: string, params: unknown[]) {
    const grant = grantQuery(sql); if (grant) return grant
    assert.ok(sql.includes('b."ownerId"=r."userId"'))
    assert.deepEqual(params, [runId, owner])
    queries.push({ sql, params })
    assert.ok(sql.includes("coalesce(to_jsonb(r)->'agentDefinition'->>'harness',a.harness)"))
    const result = { rows: [{ botId, deviceId: 'synthetic-device', agentId: 'synthetic-agent', workspaceId: botId && botOwned ? namespace : null, harness, currentHarness, agentDefinition,
      status: 'running', stopRequestedAt: stopped ? new Date() : null, leaseExpiresAt: new Date(expired ? 0 : Date.now() + 60000) }] }
    afterHint()
    return result
  },
}
mock.module(new URL('./db/index.ts', import.meta.url).href, { exports: { pool } })
mock.module(new URL('./device-link.ts', import.meta.url).href, { exports: { WORKSPACE_ID: '28700000-0000-4000-8000-000000000099' } })
let memberConnections = 0
mock.module(new URL('./workspace-db.ts', import.meta.url).href, { exports: { workspacePool: {
  async connect() {
    memberConnections++
    const client = Object.assign(new EventEmitter(), { release() {}, async query(input: string | { text: string }) {
      const sql = typeof input === 'string' ? input : input.text
      return { rows: sql.includes('mikka_workspace_members') && memberStatus !== 'active' ? [] : [{ status: 'active' }], rowCount: sql.includes('mikka_workspace_members') && memberStatus !== 'active' ? 0 : 1 }
    } })
    return client
  },
} } })
mock.module(new URL('./agent-kit/service.ts', import.meta.url).href, { exports: { agentScope: async (userId: string, id: string | null) => {
  if (id && memberStatus !== 'active') throw Error('agentScopeNotFound')
  return { ownerId: userId, botId: id, workspaceId: id ? namespace : null }
} } })
mock.module(new URL('./mcp/worker.ts', import.meta.url).href, { exports: {
  RUN_TOKEN_PREFIX: 'mkw_',
  verifyRunToken: async (_request: Request, token?: string) => validToken && token === bearer ? { token, clientId: `run:${runId}`, scopes: [], expiresAt: Math.floor(Date.now() / 1000) + 60, extra: { userId: owner, runId } } : undefined,
  workerRun: (auth: { extra: { userId: string; runId: string } }) => ({ id: auth.extra.runId, userId: auth.extra.userId }),
  report: () => {}, ask: () => {}, blocked: () => {},
} })
mock.module(new URL('./mcp/auth.ts', import.meta.url).href, { exports: {
  verifyMcpToken: async () => undefined,
  mcpUserId: () => { throw Error('OAuth tool outside worker fixture') },
  mcpActor: () => { throw Error('OAuth tool outside worker fixture') },
} })
for (const path of ['./mcp/actions.ts', './mcp/tools.ts', './mcp/artifacts.ts']) mock.module(new URL(path, import.meta.url).href, { exports: {} })
mock.module(new URL('./composio.ts', import.meta.url).href, { exports: { runComposioAction: () => { throw Error('Provider forbidden') } } })
let POST: typeof import('../app/v1/mailbox/route').POST
let mcpPOST: typeof import('../app/api/mcp/route').POST
const previousFlag = process.env.MIKKA_PERSONAL_MAILBOX_ENABLED
const originalFetch = globalThis.fetch, originalConnect = net.Socket.prototype.connect
before(async () => {
  globalThis.fetch = (() => { throw Error('Network forbidden in pure worker entry test') }) as typeof fetch
  net.Socket.prototype.connect = (() => { throw Error('Socket forbidden in pure worker entry test') }) as typeof net.Socket.prototype.connect
  ;({ POST } = await import('../app/v1/mailbox/route'))
  ;({ POST: mcpPOST } = await import('../app/api/mcp/route'))
})
after(() => {
  globalThis.fetch = originalFetch; net.Socket.prototype.connect = originalConnect
  if (previousFlag === undefined) delete process.env.MIKKA_PERSONAL_MAILBOX_ENABLED
  else process.env.MIKKA_PERSONAL_MAILBOX_ENABLED = previousFlag
})
function call(body: unknown = { action: 'inbox' }, token: string | null = bearer) {
  return POST(new Request('http://127.0.0.1/mikka/v1/mailbox', { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) }))
}
test('actual worker HTTP path is default-off and performs no persistence', async () => {
  delete process.env.MIKKA_PERSONAL_MAILBOX_ENABLED
  const count = connections
  assert.equal((await call()).status, 503)
  assert.equal(connections, count)
})
test('enabled HTTP path uses verified owner/run and trusted private Bot namespace', async () => {
  process.env.MIKKA_PERSONAL_MAILBOX_ENABLED = '1'; botId = '28700000-0000-4000-8000-000000000004'
  const response = await call()
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert.equal((await response.json()).self, boxId)
  assert.ok(queries.some(q => q.sql.includes('"workspaceId"=$3') && q.params.includes(namespace)))
  assert.equal(queries.at(-1)?.sql, 'commit')
})
test('missing or revoked bearer is rejected before store resolution', async () => {
  const count = connections
  assert.equal((await call(undefined, null)).status, 401)
  validToken = false
  assert.equal((await call()).status, 401)
  validToken = true
  assert.equal(connections, count)
})
test('forged origin/owner/run/namespace never become transport authority', async () => {
  const count = connections
  for (const field of ['origin', 'userId', 'runId', 'workspaceId', 'enabled']) {
    assert.equal((await call({ action: 'inbox', [field]: field === 'enabled' ? true : 'victim' })).status, 400)
  }
  assert.equal(connections, count)
})
test('foreign Bot binding, stopped/expired run and disabled mailbox fail closed', async () => {
  botOwned = false; assert.equal((await call()).status, 403); botOwned = true
  for (const state of ['stopped', 'expired', 'disabled']) {
    stopped = state === 'stopped'; expired = state === 'expired'; enabled = state !== 'disabled'
    assert.equal((await call()).status, 403)
    assert.equal(queries.at(-1)?.sql, 'rollback')
  }
  stopped = false; expired = false; enabled = true
})
test('namespace/owner hints changing before admission or after data are rejected in the actual resolver/store path', async () => {
  const actualBot = botId
  afterHint = () => { botId = 'rebound-to-another-bot' }
  assert.equal((await call()).status, 403)
  assert.equal(queries.at(-1)?.sql, 'rollback')
  afterHint = () => {}; botId = actualBot
  afterData = () => { botOwned = false }
  assert.equal((await call()).status, 403)
  assert.equal(queries.at(-1)?.sql, 'rollback')
  afterData = () => {}; botOwned = true
  assert.equal((await call()).status, 200)
})
test('historical frozen workers and unsupported harnesses receive no implicit mailbox grant', async () => {
  const count = connections
  const memberCount = memberConnections
  for (const value of [{ schemaVersion: 1, kind: 'worker' }, { effectiveTools: ['mailbox_send'] }, false, 'owner approved']) {
    agentDefinition = value
    assert.equal((await call()).status, 409)
    assert.equal(personalWorkerMailboxSupported('codex', value), false)
  }
  agentDefinition = grantedWorker()
  for (const value of ['cursor', 'mock', 'unknown']) {
    harness = value; assert.equal((await call()).status, 409)
  }
  harness = 'codex'
  assert.equal(connections, count)
  assert.equal(memberConnections, memberCount, 'ungranted snapshots cannot acquire an effect lease')
  for (const value of ['codex', 'claude_code'] as const) assert.equal(personalWorkerMailboxSupported(value, grantedWorker(value)), true)
})

let rpcId = 0
function rpc(method: string, params: unknown, token = bearer) {
  return mcpPOST(new Request('http://127.0.0.1/mikka/api/mcp', { method: 'POST', headers: {
    'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer ' + token,
  }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) }))
}
async function packet(response: Response) {
  assert.equal(response.status, 200)
  const text = await response.text()
  return response.headers.get('content-type')?.includes('text/event-stream')
    ? JSON.parse(text.split('\n').find(line => line.startsWith('data: '))!.slice(6)) : JSON.parse(text)
}
test('actual MCP POST registers exact five strict personal tools and calls the same owner/run store path', async () => {
  const list = await packet(await rpc('tools/list', {}))
  assert.deepEqual(list.result.tools.filter((tool: { name: string }) => tool.name.startsWith('mailbox_')).map((tool: { name: string }) => tool.name).sort(), ['mailbox_ack', 'mailbox_inbox', 'mailbox_recipients', 'mailbox_send', 'mailbox_sent'])
  const response = await packet(await rpc('tools/call', { name: 'mailbox_inbox', arguments: {} }))
  assert.equal(response.error, undefined)
  assert.equal(response.result.isError, false)
  assert.equal(JSON.parse(response.result.content[0].text).self, boxId)
})
test('actual MCP schema rejects forged source arguments and revoked bearer before mailbox writes', async () => {
  const count = connections
  const response = await packet(await rpc('tools/call', { name: 'mailbox_inbox', arguments: { origin: 'owner', userId: 'victim' } }))
  assert.ok(response.error || response.result?.isError)
  validToken = false
  assert.equal((await rpc('tools/call', { name: 'mailbox_inbox', arguments: {} })).status, 401)
  validToken = true
  assert.equal(connections, count)
})
test('actual MCP catalogue never widens historical snapshots or unsupported workers and preserves normal worker tools', async () => {
  for (const value of [undefined, { schemaVersion: 1, kind: 'worker' }, { effectiveTools: ['mailbox_send'] }]) {
    agentDefinition = value; harness = value === undefined ? 'cursor' : 'codex'
    const list = await packet(await rpc('tools/list', {}))
    assert.equal(list.result.tools.some((tool: { name: string }) => tool.name.startsWith('mailbox_')), false)
    assert.equal(list.result.tools.some((tool: { name: string }) => tool.name === 'report'), true)
    const response = await packet(await rpc('tools/call', { name: 'mailbox_inbox', arguments: {} }))
    assert.ok(response.error || response.result?.isError)
  }
  agentDefinition = grantedWorker(); harness = 'codex'
  delete process.env.MIKKA_PERSONAL_MAILBOX_ENABLED
  const disabled = await packet(await rpc('tools/list', {}))
  assert.equal(disabled.result.tools.some((tool: { name: string }) => tool.name.startsWith('mailbox_')), false)
  process.env.MIKKA_PERSONAL_MAILBOX_ENABLED = '1'
})
test('actual same endpoint selects each run frozen subset and rejects grants revoked in the current user definition', async () => {
  const original = parent, originalCurrent = currentDefinition
  parent = makeSnapshot(original.revisionId, 2, { ...original.definition, tools: ['mailbox_inbox'] }, 'HOST', original.runtime)
  agentDefinition = grantedWorker()
  const list = await packet(await rpc('tools/list', {}))
  assert.deepEqual(list.result.tools.filter((tool: { name: string }) => tool.name.startsWith('mailbox_')).map((tool: { name: string }) => tool.name), ['mailbox_inbox'])
  currentDefinition = { ...currentDefinition, tools: [] }
  const revoked = await packet(await rpc('tools/list', {}))
  assert.equal(revoked.result.tools.some((tool: { name: string }) => tool.name.startsWith('mailbox_')), false)
  assert.equal((await call()).status, 403)
  parent = original; currentDefinition = originalCurrent; agentDefinition = grantedWorker()
  assert.equal((await call()).status, 200)
})
test('pinned worker harness survives Agent edits; removed/suspended membership fails both catalogue and effect', async () => {
  currentHarness = 'claude_code'
  assert.equal((await call()).status, 200)
  assert.equal((await packet(await rpc('tools/list', {}))).result.tools.some((tool: { name: string }) => tool.name === 'mailbox_inbox'), true)
  for (const status of ['removed', 'suspended']) {
    memberStatus = status
    assert.equal((await call()).status, 403)
    assert.equal((await packet(await rpc('tools/list', {}))).result.tools.some((tool: { name: string }) => tool.name.startsWith('mailbox_')), false)
  }
  memberStatus = 'active'; currentHarness = 'codex'
  afterData = () => { memberStatus = 'suspended' }
  assert.equal((await call()).status, 403)
  assert.equal(queries.at(-1)?.sql, 'rollback')
  afterData = () => {}; memberStatus = 'active'
})

test('personal Coordinator-owned worker pre-abort refuses APP checkout even without a workspace guard', async () => {
  const previousBot = botId, previousDefinition = agentDefinition, controller = new AbortController(), before = connections
  botId = null; agentDefinition = grantedWorker(); controller.abort()
  try {
    const response = await POST(new Request('http://127.0.0.1/mikka/v1/mailbox', { method: 'POST', signal: controller.signal,
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + bearer }, body: JSON.stringify({ action: 'inbox' }) }))
    assert.equal(response.status, 403)
    assert.equal(connections, before, 'APP cancellation is required independently of Bot membership')
  } finally { botId = previousBot; agentDefinition = previousDefinition }
})
test('personal Coordinator-owned worker keeps its real APP grant and cancels before COMMIT without WS', async () => {
  const previousBot = botId, previousParent = parentBotKey, previousDefinition = agentDefinition, controller = new AbortController()
  botId = null; parentBotKey = 'coordinator'; agentDefinition = grantedWorker()
  try {
    const wsBefore = memberConnections
    assert.equal((await call()).status, 200)
    assert.equal(memberConnections, wsBefore)
    let cancelAt = -1
    afterData = () => { cancelAt = queries.length; controller.abort() }
    const response = await POST(new Request('http://127.0.0.1/mikka/v1/mailbox', { method: 'POST', signal: controller.signal,
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + bearer }, body: JSON.stringify({ action: 'inbox' }) }))
    assert.equal(response.status, 403)
    assert.notEqual(cancelAt, -1)
    assert.equal(queries.slice(cancelAt).some(query => query.sql === 'commit'), false)
    assert.equal(memberConnections, wsBefore)
  } finally { afterData = () => {}; botId = previousBot; parentBotKey = previousParent; agentDefinition = previousDefinition }
})

test('Bot deletion before the first mailbox attachment cannot widen a Coordinator-delegated worker namespace', async () => {
  const previousBot = botId, previousDefinition = agentDefinition, previousParent = parentBotKey
  // The real schema's ON DELETE SET NULL leaves a run with no Bot. The parent
  // Coordinator remains valid, so the immutable target scope must deny first.
  parentBotKey = 'coordinator'; agentDefinition = grantedWorker(); botId = null
  const before = connections
  try {
    assert.equal((await call()).status, 403)
    const list = await packet(await rpc('tools/list', {}))
    assert.equal(list.result.tools.some((tool: { name: string }) => tool.name.startsWith('mailbox_')), false)
    assert.equal(list.result.tools.some((tool: { name: string }) => tool.name === 'report'), true)
    const result = await packet(await rpc('tools/call', { name: 'mailbox_inbox', arguments: {} }))
    assert.ok(result.error || result.result?.isError)
    assert.equal(connections, before, 'no mailbox attachment or effect transaction is admitted')
  } finally { botId = previousBot; agentDefinition = previousDefinition; parentBotKey = previousParent }
})
