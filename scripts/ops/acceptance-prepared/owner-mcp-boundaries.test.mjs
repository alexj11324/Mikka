import assert from 'node:assert/strict'
import test from 'node:test'
import { runOwnerMcpBoundaries } from './owner-mcp-boundaries.mjs'

const id = value => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`
function fixture({ team = false, foreignBot = false, unknownCreate = false, existingReceipt = false, wrongShare = false, unknownDelete = false } = {}) {
  const ownerId = 'owner-user', workspaceId = id(1), priorId = id(2), newId = id(3)
  const prior = { id: priorId, ownerId, mine: true, shared: false, name: 'Existing private connection', url: 'https://private.example.test', enabled: true, transport: 'http', revision: 4, authKind: 'header' }
  const state = { calls: [], server: null, versions: 0, prior }
  const catalog = () => ({ workspaceId, workspaceKind: 'personal', canShare: false, count: state.server ? 2 : 1, servers: [prior, ...(state.server ? [state.server] : [])] })
  const owner = { request: async (path, init) => {
    const body = init.body === undefined ? undefined : JSON.parse(init.body)
    state.calls.push({ path, method: init.method, body })
    if (path === '/api/auth/get-session') return Response.json({ user: { id: ownerId, email: 'owner+mikka-smoke@example.test' }, session: { userId: ownerId, token: 'not-for-output' } })
    if (path === '/api/workspace') return Response.json({ currentUserId: ownerId, workspace: { id: workspaceId, kind: team ? 'team' : 'personal' }, role: 'admin', members: [{ userId: ownerId, status: 'active' }] })
    if (path === '/api/bots') return Response.json([{ id: id(4), ownerId: foreignBot ? 'someone-else' : ownerId, workspaceId, name: 'private bot' }])
    if (path === '/api/integrations/mcp?workspaceId=' + workspaceId) { assert.equal(init.method, 'GET'); return Response.json(catalog()) }
    if (path === '/api/integrations/mcp/shares') {
      assert.equal(init.method, 'PATCH'); assert.deepEqual(body, { serverId: newId, workspaceId, shared: true })
      return Response.json({ error: wrongShare ? 'invalidPluginInput' : 'workspaceAccessDenied' }, { status: wrongShare ? 400 : 403 })
    }
    if (path === '/api/integrations/mcp' && init.method === 'POST') {
      assert.equal(Object.hasOwn(body, 'auth'), false); assert.equal(body.enabled, false)
      assert.deepEqual(Object.keys(body).sort(), ['enabled', 'name', 'transport', 'url'])
      if (unknownCreate) throw Error('unconfirmed creation with private response')
      if (existingReceipt) return Response.json({ server: prior }, { status: 201 })
      state.server = { ...body, id: newId, ownerId, mine: true, shared: false, authKind: 'none', revision: 1 }
      return Response.json({ server: state.server }, { status: 201 })
    }
    if (path === '/api/integrations/mcp' && init.method === 'DELETE') {
      assert.deepEqual(body, { id: newId }); state.server = null
      if (unknownDelete) throw Error('unconfirmed deletion with private response')
      return Response.json({ deleted: true })
    }
    throw Error('unexpected endpoint')
  } }
  return { owner, verifyTarget: async () => { state.versions++ }, state }
}

test('single owner creates no-secret disabled metadata, rejects personal sharing, and deletes only its new receipt', async () => {
  const input = fixture(), result = await runOwnerMcpBoundaries(input)
  assert.equal(result.status, 'passed'); assert.ok(Object.values(result.checks).every(Boolean))
  assert.deepEqual(result.http, { create: 201, share: 403, delete: 200 })
  assert.deepEqual(result.cleanup, { deleteAttempted: true, deleteAcknowledged: true, absentReadback: true })
  assert.deepEqual(result.counts, { ownedBots: 1, before: 1, withFixture: 2, after: 1 })
  assert.equal(input.state.server, null); assert.equal(input.state.prior.id, id(2)); assert.equal(input.state.versions, 2)
  assert.deepEqual(input.state.calls.filter(call => call.method !== 'GET').map(call => [call.method, call.path]), [
    ['POST', '/api/integrations/mcp'], ['PATCH', '/api/integrations/mcp/shares'], ['DELETE', '/api/integrations/mcp'],
  ])
  for (const forbidden of ['https://', 'url', 'credential', 'private bot', 'Existing private', '@example.test', 'not-for-output']) assert.equal(JSON.stringify(result).includes(forbidden), false)
  assert.equal(result.coverage.twoMemberSharing, false); assert.equal(result.coverage.providerCalls, 0); assert.equal(result.coverage.gmail, false)
})

test('team scope or foreign Bot stops before any creation or mutation', async () => {
  for (const config of [{ team: true }, { foreignBot: true }]) {
    const input = fixture(config), result = await runOwnerMcpBoundaries(input)
    assert.equal(result.status, 'failed'); assert.equal(result.connectionId, null)
    assert.ok(input.state.calls.every(call => call.method === 'GET'))
  }
})

test('unknown creation or a pre-existing ID cannot trigger a retry or deletion', async () => {
  for (const config of [{ unknownCreate: true }, { existingReceipt: true }]) {
    const input = fixture(config), result = await runOwnerMcpBoundaries(input)
    assert.equal(result.status, 'failed'); assert.equal(result.connectionId, null)
    assert.equal(input.state.calls.filter(call => call.method === 'POST').length, 1)
    assert.equal(input.state.calls.filter(call => call.method === 'DELETE').length, 0)
  }
})

test('a schema-error rejection or unknown DELETE cannot pass; cleanup observes rather than repeats writes', async () => {
  const wrong = fixture({ wrongShare: true }), rejected = await runOwnerMcpBoundaries(wrong)
  assert.equal(rejected.status, 'failed'); assert.equal(rejected.checks.personalShareRejected, false)
  assert.equal(rejected.cleanup.absentReadback, true)
  const unknown = fixture({ unknownDelete: true }), uncertain = await runOwnerMcpBoundaries(unknown)
  assert.equal(uncertain.status, 'failed'); assert.equal(uncertain.cleanup.deleteAcknowledged, false)
  assert.equal(uncertain.cleanup.absentReadback, true)
  assert.equal(unknown.state.calls.filter(call => call.method === 'DELETE').length, 1)
})
