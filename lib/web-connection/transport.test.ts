import assert from 'node:assert/strict'
import test from 'node:test'
import { createWebTransport } from './transport'
import { WORKSPACE_SELECTION_HEADER } from '../workspace-selection'

const origin = 'https://app.aspectlylabs.com'
const bearer = `Bearer ${'s'.repeat(40)}`
const request = (path: string, options: RequestInit = {}) => new Request(`https://self.test/mikka${path}`, { ...options, headers: { origin, ...options.headers } })
test('CORS preflight has exact origin/header allowlists and never enables cookie credentials', async () => {
  const prepare = createWebTransport({ env: {}, authenticate: async () => { throw new Error('preflight cannot authenticate') }, scope: (_, work) => work() })
  const result = await prepare(request('/api/desktop/rpc', { method: 'OPTIONS', headers: { 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type,x-mikka-desktop-protocol' } }), '/api/desktop/rpc')
  assert.ok(result instanceof Response)
  assert.equal(result.status, 204)
  assert.equal(result.headers.get('access-control-allow-origin'), origin)
  assert.equal(result.headers.has('access-control-allow-credentials'), false)
  const refused = await prepare(request('/api/desktop/rpc', { method: 'OPTIONS', headers: { 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-mikka-session-cache' } }), '/api/desktop/rpc')
  assert.ok(refused instanceof Response); assert.equal(refused.status, 403)
  assert.equal(await prepare(request('/api/desktop/rpc', { headers: { origin: 'https://evil.test' } }), '/api/desktop/rpc'), null)
})

test('fresh bearer validation precedes adaptation; cookie/cache authority and response cookies are removed', async () => {
  let revoked = false, reads = 0
  const prepare = createWebTransport({ env: {}, authenticate: async headers => {
    reads++; assert.deepEqual([...headers], [['authorization', bearer]])
    return revoked ? null : { session: { id: 'session' }, user: { id: 'owner' } }
  }, scope: (identity, work) => { assert.equal(identity.user.id, 'owner'); return work() } })
  const input = request('/api/coordinator/messages', { method: 'POST', body: 'body', headers: { authorization: bearer, cookie: 'cloud=do-not-read', 'x-mikka-session-cache': 'stale-proof', 'sec-fetch-site': 'cross-site' } })
  const prepared = await prepare(input, '/api/coordinator/messages')
  assert.ok(prepared && !(prepared instanceof Response))
  assert.equal(input.headers.get('origin'), origin)
  assert.equal(prepared.request.headers.get('origin'), 'https://self.test')
  assert.equal(prepared.request.headers.get('cookie'), null)
  assert.equal(prepared.request.headers.get('x-mikka-session-cache'), null)
  assert.equal(await prepared.request.text(), 'body')
  const response = prepared.response(new Response('data', { headers: { 'set-cookie': 'session=secret', 'x-mikka-session-cache': 'proof', 'x-mikka-session-token': 'rotated', vary: 'Accept' } }))
  assert.equal(response.headers.get('set-cookie'), null); assert.equal(response.headers.get('x-mikka-session-cache'), null)
  assert.match(response.headers.get('vary')!, /Origin/)
  revoked = true
  const rejected = await prepare(request('/api/desktop/rpc', { method: 'POST', headers: { authorization: bearer } }), '/api/desktop/rpc')
  assert.ok(rejected instanceof Response); assert.equal(rejected.status, 401); assert.equal(reads, 2)
})

test('public discovery never receives ambient authority, and disabling blocks an existing bearer', async () => {
  const create = (env = {}) => createWebTransport({ env, authenticate: async () => { throw new Error('must not authenticate') }, scope: (_, work) => work() })
  const prepared = await create()(request('/api/desktop/discovery', { headers: { authorization: bearer, cookie: 'cloud=secret' } }), '/api/desktop/discovery')
  assert.ok(prepared && !(prepared instanceof Response)); assert.equal(prepared.request.headers.has('authorization'), false); assert.equal(prepared.request.headers.has('cookie'), false)
  const disabled = await create({ MIKKA_OFFICIAL_WEB_ENABLED: '0' })(request('/api/desktop/rpc', { headers: { authorization: bearer } }), '/api/desktop/rpc')
  assert.ok(disabled instanceof Response); assert.equal(disabled.status, 403)
  for (const path of ['/api/auth/sign-out', '/api/cron/reconcile', '/api/web/return', '/api/desktop/exchange', '/api/rpc']) {
    const result = await create()(request(path, { method: 'POST', headers: { authorization: bearer } }), path)
    assert.ok(result instanceof Response); assert.equal(result.status, 403, path)
  }
})

test('Workspace preference has an explicit header contract without transporting any Cookie authority', async () => {
  const workspaceId = '07a38989-1ca9-42ba-9788-742bef75916c'
  const prepare = createWebTransport({ env: {}, authenticate: async headers => {
    assert.deepEqual([...headers], [['authorization', bearer]])
    return { user: { id: 'owner' }, session: { id: 'real-session' } }
  }, scope: (_, work) => work() })
  const preflight = await prepare(request('/api/desktop/rpc', { method: 'OPTIONS', headers: {
    'access-control-request-method': 'POST', 'access-control-request-headers': `authorization,${WORKSPACE_SELECTION_HEADER}`,
  } }), '/api/desktop/rpc')
  assert.ok(preflight instanceof Response); assert.equal(preflight.status, 204)
  const prepared = await prepare(request('/api/desktop/rpc', { method: 'POST', headers: { authorization: bearer, [WORKSPACE_SELECTION_HEADER]: workspaceId } }), '/api/desktop/rpc')
  assert.ok(prepared && !(prepared instanceof Response))
  assert.equal(prepared.request.headers.get(WORKSPACE_SELECTION_HEADER), workspaceId)
  const headers = new Headers({ [WORKSPACE_SELECTION_HEADER]: 'untrusted-existing-response-header', 'x-mikka-session-cache': 'private-cache' })
  headers.append('set-cookie', 'auth.session=private; HttpOnly; Secure')
  headers.append('set-cookie', `mikka-workspace=${workspaceId}; Path=/; HttpOnly; Secure`)
  const confirmed = prepared.response(Response.json({ ok: true }, { headers }))
  assert.equal(confirmed.headers.get(WORKSPACE_SELECTION_HEADER), workspaceId)
  assert.match(confirmed.headers.get('access-control-expose-headers')!, /x-mikka-workspace-id/)
  for (const name of ['set-cookie', 'x-mikka-session-cache', 'access-control-allow-credentials']) assert.equal(confirmed.headers.has(name), false)
  assert.equal(prepared.response(new Response(null, { status: 403, headers })).headers.has(WORKSPACE_SELECTION_HEADER), false)
  const cleared = prepared.response(new Response(null, { status: 204, headers: { 'set-cookie': 'mikka-workspace=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/' } }))
  assert.equal(cleared.headers.get(WORKSPACE_SELECTION_HEADER), '')
  for (const value of ['', 'not-a-workspace', `${workspaceId}, ${workspaceId}`]) {
    const refused = await prepare(request('/api/desktop/rpc', { headers: { authorization: bearer, [WORKSPACE_SELECTION_HEADER]: value } }), '/api/desktop/rpc')
    assert.ok(refused instanceof Response); assert.equal(refused.status, 403)
    assert.equal((await refused.json()).error.code, 'workspaceAccessDenied')
  }
})
