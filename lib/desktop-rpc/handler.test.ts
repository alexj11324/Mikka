import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { createDesktopRpc, desktopBearerHeaders, humanSessionHeaders } from './handler'
import { desktopActionSchemas } from './schemas'
import { currentDesktopSession, withDesktopSession, safeDesktopSession } from './session'
import { decode, encode, UPDATE_REQUIRED } from './wire'

const tokenA = 'A'.repeat(32)
const tokenB = 'B'.repeat(32)
const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const peer = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const sessions = new Map([[tokenA, { user: { id: owner }, session: { id: 'sessionA' } }], [tokenB, { user: { id: peer }, session: { id: 'sessionB' } }]])
const request = (action = 'fixture.read', args: unknown[] = [], headers: Record<string, string> = {}, version = 1) => new Request('https://app.example/mikka/api/desktop/rpc', {
  method: 'POST', headers: { authorization: `Bearer ${tokenA}`, 'content-type': 'application/json', 'x-mikka-desktop-protocol': String(version), ...headers },
  body: JSON.stringify({ version, action, args: encode(args) }),
})
function fixture() {
  let calls = 0
  const handle = createDesktopRpc({
    authenticate: async headers => { assert.equal(headers.has('cookie'), false); return sessions.get(headers.get('authorization')!.slice(7)) ?? null },
    scope: withDesktopSession,
    actions: {
      'fixture.read': { args: z.tuple([]), invoke: async () => { calls++; return { session: currentDesktopSession(), at: new Date(0), optional: undefined } } },
      'fixture.owned': { args: z.tuple([z.uuid()]), invoke: async ([id]) => {
        calls++
        const session = currentDesktopSession() as { user: { id: string } }
        if (session.user.id !== id) throw new Error('private-other-tenant-diagnostic')
        return { owner: id }
      } },
    },
  })
  return { handle, calls: () => calls }
}

test('RPC never authenticates a cookie-only, revoked, invalid or delegated token', async () => {
  const f = fixture()
  for (const authorization of ['', 'Basic invalid', 'Bearer missing_12345678901234567890', `Bearer mkp_${'a'.repeat(43)}`, `Bearer mka_${'a'.repeat(43)}`, `Bearer mkr_${'a'.repeat(43)}`]) {
    const response = await f.handle(request('fixture.read', [], { authorization, cookie: 'better-auth.session_token=valid-other-account' }))
    assert.equal(response.status, 401)
  }
  const cookieOnly = request(); cookieOnly.headers.delete('authorization'); cookieOnly.headers.set('cookie', 'valid=browser')
  assert.equal((await f.handle(cookieOnly)).status, 401)
  assert.equal(f.calls(), 0)
})

test('authenticated bearer wins over foreign cookies and the original action sees its real session', async () => {
  const response = await fixture().handle(request('fixture.read', [], { cookie: 'better-auth.session_token=account-B' }))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('vary'), 'Authorization')
  const value = decode((await response.json()).result) as { session: unknown; at: Date }
  assert.deepEqual(value.session, sessions.get(tokenA)); assert.deepEqual(value.at, new Date(0))
  assert.equal(currentDesktopSession(), undefined)
})

test('parallel users retain separate request scopes and original tenant checks', async () => {
  const f = fixture()
  const [a, b, cross] = await Promise.all([
    f.handle(request('fixture.owned', [owner])), f.handle(request('fixture.owned', [peer], { authorization: `Bearer ${tokenB}` })),
    f.handle(request('fixture.owned', [peer])),
  ])
  assert.equal(a.status, 200); assert.equal(b.status, 200); assert.equal(cross.status, 500)
  assert.deepEqual(await cross.json(), { version: 1, ok: false, error: { code: 'desktop_rpc_failed' } })
  assert.equal(currentDesktopSession(), undefined)
})

test('current and previous versions work and unsupported versions return the fixed update code', async () => {
  const f = fixture()
  for (const version of [0, 1]) {
    const response = await f.handle(request('fixture.read', [], {}, version))
    assert.equal(response.status, 200)
    assert.equal((await response.json()).version, version)
  }
  for (const version of [-1, 2, 99]) {
    const response = await f.handle(request('fixture.read', [], {}, version))
    assert.equal(response.status, 426); assert.equal((await response.json()).error.code, UPDATE_REQUIRED)
  }
  assert.equal((await f.handle(request('fixture.read', [], { 'x-mikka-desktop-protocol': '99' }))).status, 426)
})

test('closed whitelist rejects arbitrary exports and prototype names before dispatch', async () => {
  const f = fixture()
  for (const name of ['constructor', 'toString', '__proto__', 'auth.getSession', '../auth', 'fixture.hidden']) assert.equal((await f.handle(request(name))).status, 404)
  assert.equal(f.calls(), 0)
})

test('all parameters are validated, including extras and malformed nested wire tags', async () => {
  const f = fixture()
  for (const args of [[], [null], ['invalid'], [owner, 'extra']]) assert.equal((await f.handle(request('fixture.owned', args))).status, 400)
  const malformed = new Request(request().url, { method: 'POST', headers: request().headers, body: JSON.stringify({ version: 1, action: 'fixture.read', args: { $mikka: 'date', value: 'invalid' } }) })
  assert.equal((await f.handle(malformed)).status, 400)
  assert.equal((await f.handle(request('fixture.read', [], { 'content-type': 'text/plain' }))).status, 415)
  assert.equal(f.calls(), 0)
})

test('safe session summary omits token, timestamps, network and provider credentials', () => {
  const input = { user: { id: owner, name: 'Fixture', email: 'fixture@example.test', image: null, emailVerified: true, secret: 'do not include' }, session: { id: 'session', token: 'do not include', ipAddress: 'private', expiresAt: new Date() } }
  assert.deepEqual(safeDesktopSession(input), { user: { id: owner, name: 'Fixture', email: 'fixture@example.test', image: null, emailVerified: true }, session: { id: 'session' } })
})

test('native header adapter preserves browser authority but strips all bearer cookies', () => {
  const cookie = new Request('https://app.example', { headers: { cookie: 'browser=1' } })
  assert.equal(humanSessionHeaders(cookie), cookie.headers)
  assert.equal(humanSessionHeaders(new Request('https://app.example')), null)
  assert.equal(desktopBearerHeaders(request('fixture.read', [], { cookie: 'browser=1' }))?.has('cookie'), false)
})

test('registry schemas reject forged authority, malformed nested input and extra arguments', () => {
  const cases: [keyof typeof desktopActionSchemas, unknown[]][] = [
    ['desktop.workspaceLink', ['valid-slug', { userId: peer }]],
    ['desktop.workspaceLink', ['../private']],
    ['workspace.switchWorkspace', [{ workspaceId: owner, ownerId: peer }]],
    ['coordinator.sendCoordinatorMessage', ['hello', null, null, owner, { kind: 'device', deviceId: 'invalid' }]],
    ['issue-metadata.updateIssueMetadata', [{ id: owner, revision: 1, patch: { userId: peer } }]],
    ['account.changePassword', [{ currentPassword: 'password', newPassword: 'password', userId: peer }]],
    ['workspace-secrets.createSecret', [{ name: 'KEY', kind: 'secret', value: 'fixture', scope: { type: 'repository', repository: {} } }]],
    ['preferences.updatePreferences', [{ administrator: true }]],
    ['artifacts.listArtifacts', ['unwanted']],
  ]
  for (const [name, args] of cases) assert.equal(desktopActionSchemas[name].safeParse(args).success, false, name)
  assert.equal(desktopActionSchemas['coordinator.pollCoordinatorChat'].safeParse([null, undefined, { after: 2, cursor: 1, prefix: 'a'.repeat(32) }]).success, true)
})

test('explicit schemas and function map have exactly matching action names', () => {
  const registry = readFileSync(new URL('./registry.ts', import.meta.url), 'utf8')
  const registered = [...registry.matchAll(/^  '([^']+)':/gm)].map(match => match[1]).sort()
  assert.deepEqual(registered, Object.keys(desktopActionSchemas).sort())
})

test('Coordinator history keeps the current bounded page size and previous two-argument calls', () => {
  const schema = desktopActionSchemas['coordinator.coordinatorHistory']
  for (const args of [[null, 0], [owner, 20, undefined], [null, 50, 1], [owner, 500, 200]]) assert.equal(schema.safeParse(args).success, true)
  for (const args of [[null, 20, 0], [null, 20, 201], [null, 20, 1.5], [null, 20, '20'], [null, -1, 20], [null, 20, 20, peer]]) assert.equal(schema.safeParse(args).success, false)
})
