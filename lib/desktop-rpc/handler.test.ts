import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { createDesktopRpc, desktopBearerHeaders, humanSessionHeaders } from './handler'
import { desktopActionSchemas } from './schemas'
import { currentDesktopSession, withDesktopSession, safeDesktopSession } from './session'
import { decode, encode, UPDATE_REQUIRED } from './wire'
import { withRequestLog } from '../request-log'

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
      'model-order.getModelOrder': { args: z.tuple([]), invoke: async () => { calls++; return [] } },
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

test('request attribution records only registry-owned RPC actions without arguments or credentials', async () => {
  const lines: string[] = []
  const handler = withRequestLog('/api/desktop/rpc', fixture().handle, line => { lines.push(line) })
  const cases = [
    { request: request(), status: 200, action: 'fixture.read' },
    { request: request('model-order.getModelOrder'), status: 200, action: 'model-order.getModelOrder' },
    { request: request('fixture.read', ['PRIVATE_ARGUMENT']), status: 400, action: 'fixture.read' },
    { request: request('fixture.owned', [peer]), status: 500, action: 'fixture.owned' },
    { request: request('private.actionCanary'), status: 404 },
    { request: request('constructor'), status: 404 },
    { request: request('fixture.read', [], { authorization: '' }), status: 401 },
    { request: request('fixture.read', [], {}, 99), status: 426 },
  ]
  for (const value of cases) {
    assert.equal((await handler(value.request)).status, value.status)
    const entry = JSON.parse(lines.at(-1)!)
    assert.equal(entry.rpcAction, value.action)
    assert.equal(Object.hasOwn(entry, 'rpcAction'), value.action !== undefined)
  }
  assert.doesNotMatch(lines.join('\n'), /PRIVATE_ARGUMENT|private\.actionCanary|private-other-tenant-diagnostic/)
  assert.equal(lines.some(line => line.includes(tokenA)), false)
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

test('signed bearer padding stays trailing and inside the existing total length limit', () => {
  for (const token of ['a'.repeat(512), 'a'.repeat(511) + '=', 'a'.repeat(510) + '==']) {
    assert.ok(desktopBearerHeaders(request('fixture.read', [], { authorization: `Bearer ${token}` })))
  }
  for (const token of ['a'.repeat(512) + '=', 'a'.repeat(31), 'a'.repeat(32) + '===', 'a'.repeat(32) + '=b']) {
    assert.equal(desktopBearerHeaders(request('fixture.read', [], { authorization: `Bearer ${token}` })), null)
  }
})

test('native bearer requests cannot import another origin or cross-site fetch metadata', async () => {
  const f = fixture()
  for (const headers of [{ origin: 'https://attacker.example' }, { origin: 'null' }, { 'sec-fetch-site': 'cross-site' }] as Record<string, string>[]) {
    assert.equal((await f.handle(request('fixture.read', [], headers))).status, 403)
  }
  assert.equal(f.calls(), 0)
  const ownOrigin = new URL(request().url).origin
  assert.equal((await f.handle(request('fixture.read', [], { origin: ownOrigin }))).status, 200)
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
    ['teams.deleteTeam', ['not-a-team', 'Design']],
    ['teams.deleteTeam', [owner]],
    ['teams.getTeamDeletionImpact', [owner, { workspaceId: peer }]],
  ]
  for (const [name, args] of cases) assert.equal(desktopActionSchemas[name].safeParse(args).success, false, name)
  assert.equal(desktopActionSchemas['coordinator.pollCoordinatorChat'].safeParse([null, undefined, { after: 2, cursor: 1, prefix: 'a'.repeat(32) }]).success, true)
})

test('Board status moves accept an optional checked block change across the shared RPC boundary', () => {
  const schema = desktopActionSchemas['issues.moveIssue']
  const move = { id: owner, revision: 3, status: 'doing' }
  for (const input of [move, { ...move, block: { blocked: false, runId: null } }, { ...move, block: { blocked: false, runId: 'last-run' } }]) {
    assert.deepEqual(schema.parse([input]), [input])
  }
  for (const block of [null, { blocked: false }, { blocked: 'false', runId: null }, { blocked: false, runId: null, issueId: peer }]) {
    assert.equal(schema.safeParse([{ ...move, block }]).success, false)
  }
})

test('explicit schemas and function map have exactly matching action names', () => {
  const registry = readFileSync(new URL('./registry.ts', import.meta.url), 'utf8')
  const registered = [...registry.matchAll(/^  '([^']+)':/gm)].map(match => match[1]).sort()
  assert.deepEqual(registered, Object.keys(desktopActionSchemas).sort())
  for (const name of registered) {
    assert.ok(name.length <= 120, name)
    assert.match(name, /^[a-z][\w-]*\.[a-z]\w*$/i)
  }
})

test('memory RPC exposes manual, review, scope and undo actions with closed owner-free inputs', () => {
  const schemas = desktopActionSchemas as Record<string, z.ZodType | undefined>
  const manual = { requestId: owner, kind: 'preference', subject: 'Synthetic fact', scope: { kind: 'global', ids: [] } }
  const valid: [string, unknown[]][] = [
    ['memory.addFact', [manual]], ['memory.clearMemory', []],
    ['memory.reviewFact', [owner, 'approve']], ['memory.reviewFact', [owner, 'reject']],
    ['memory.setFactScope', [owner, { kind: 'workspaces', ids: [peer] }]],
    ['memory.setFactScope', [owner, { kind: 'projects', ids: [peer] }]], ['memory.undoRemoveFact', [owner]],
  ]
  for (const [name, args] of valid) assert.equal(schemas[name]?.safeParse(args).success, true, name)
  const invalid: [string, unknown[]][] = [
    ['memory.addFact', [{ ...manual, userId: peer }]],
    ['memory.addFact', [{ ...manual, subject: '' }]],
    ['memory.addFact', [{ ...manual, kind: 'administrator' }]],
    ['memory.addFact', [{ ...manual, scope: { kind: 'global', ids: [peer] } }]],
    ['memory.reviewFact', [owner, 'approve', peer]], ['memory.reviewFact', [owner, 'force']],
    ['memory.setFactScope', [owner, { kind: 'projects', ids: [] }]],
    ['memory.setFactScope', [owner, { kind: 'workspaces', ids: [peer], admin: true }]],
    ['memory.undoRemoveFact', [owner, peer]], ['memory.clearMemory', [peer]],
  ]
  for (const [name, args] of invalid) assert.equal(schemas[name]?.safeParse(args).success, false, name)
})

test('Task presentation batch rejects forged authority and oversized input before invoking its reader', async () => {
  const action = 'task-domain.getTaskPresentations'
  let calls = 0
  const handle = createDesktopRpc({
    authenticate: async () => sessions.get(tokenA)!,
    scope: withDesktopSession,
    actions: { [action]: { args: desktopActionSchemas[action], invoke: async () => { calls++; return { version: 1, workspaceId: owner, items: {} } } } },
  })
  for (const args of [
    [{ workspaceId: owner, issueIds: [peer], userId: peer }],
    [{ workspaceId: owner, issueIds: [peer], includeDeleted: true }],
    [{ workspaceId: owner, issueIds: [peer] }, { role: 'admin' }],
    [{ workspaceId: 'invalid', issueIds: [] }],
    [{ workspaceId: owner, issueIds: ['invalid'] }],
    [{ workspaceId: owner, issueIds: Array.from({ length: 201 }, () => peer) }],
  ]) assert.equal((await handle(request(action, args))).status, 400)
  assert.equal(calls, 0)
  for (const issueIds of [[], Array.from({ length: 200 }, () => peer)]) {
    assert.equal((await handle(request(action, [{ workspaceId: owner, issueIds }]))).status, 200)
  }
  assert.equal(calls, 2, 'empty and bounded inputs still enter the reader and its membership checks')
})

test('Coordinator submission accepts an optional captured workspace without widening its authority tuple', () => {
  const schema = desktopActionSchemas['coordinator.sendCoordinatorMessage']
  const legacy = ['hello', null, null, owner, undefined, undefined, undefined, undefined, undefined]
  for (const args of [['hello'], legacy, [...legacy, undefined], [...legacy, peer], [...legacy, peer.toUpperCase()]]) {
    assert.equal(schema.safeParse(args).success, true)
  }
  for (const expected of [null, '', 'invalid', { workspaceId: peer }, { userId: owner }]) {
    assert.equal(schema.safeParse([...legacy, expected]).success, false)
  }
  assert.equal(schema.safeParse([...legacy, peer, { admin: true }]).success, false)
})

test('Coordinator task titles cross the shared Web and desktop RPC boundary', () => {
  const schema = desktopActionSchemas['coordinator.sendCoordinatorMessage']
  const args = ['Task description', null, null, owner, undefined, undefined, undefined, undefined, undefined]
  for (const workspaceId of [undefined, peer]) {
    const parsed = schema.safeParse([...args, workspaceId, '  修复登录后回跳  '])
    assert.equal(parsed.success, true)
    if (parsed.success) {
      assert.ok(Array.isArray(parsed.data))
      assert.equal(parsed.data[10], '修复登录后回跳')
    }
    for (const title of ['', ' ', 'x'.repeat(61), 'two\nlines', null, { admin: true }]) {
      assert.equal(schema.safeParse([...args, workspaceId, title]).success, false)
    }
  }
  assert.equal(schema.safeParse([...args, peer, 'Title', { admin: true }]).success, false)
})

test('billing re-export consumers accept only the existing workspace selector and purchase amounts', () => {
  const verification = desktopActionSchemas['billing.startCardVerification']
  for (const args of [[], [undefined], [owner]]) assert.equal(verification.safeParse(args).success, true)
  for (const args of [[null], ['invalid'], [{ userId: owner }], [owner, peer], [owner, 'https://foreign.test']]) assert.equal(verification.safeParse(args).success, false)
  const purchase = desktopActionSchemas['billing.startPointsPurchase']
  for (const amount of [10, 25, 50]) assert.equal(purchase.safeParse([owner, amount]).success, true)
  for (const args of [[], [owner], [undefined, 10], ['invalid', 10], [owner, '10'], [owner, 0], [owner, -10], [owner, 10.5], [owner, 100], [owner, NaN], [owner, Infinity], [owner, 25, { userId: peer }]]) assert.equal(purchase.safeParse(args).success, false)
})

test('Coordinator history keeps the current bounded page size and previous two-argument calls', () => {
  const schema = desktopActionSchemas['coordinator.coordinatorHistory']
  for (const args of [[null, 0], [owner, 20, undefined], [null, 50, 1], [owner, 500, 200]]) assert.equal(schema.safeParse(args).success, true)
  for (const args of [[null, 20, 0], [null, 20, 201], [null, 20, 1.5], [null, 20, '20'], [null, -1, 20], [null, 20, 20, peer]]) assert.equal(schema.safeParse(args).success, false)
})

test('cached list cursors retain each reader limit, old calls and unique bounded row proofs', () => {
  const held = (length: number) => Array.from({ length }, (_, index) => ({ id: `aaaaaaaa-aaaa-4aaa-8aaa-${index.toString(16).padStart(12, '0')}`, version: 'a'.repeat(32) }))
  const readers = [
    ['issues.pollIssues', 100, []], ['issues.syncIssueList', 100, []],
    ['task-runs.pollThreads', 200, []], ['task-runs.syncThreadList', 200, []],
    ['issues.pollIssueVersionSummaries', 51, [owner]],
  ] as const
  for (const [name, limit, prefix] of readers) {
    const schema = desktopActionSchemas[name]
    for (const args of [[...prefix], [...prefix, 'a'.repeat(32)], [...prefix, undefined, []], [...prefix, 'a'.repeat(32), held(limit)]]) {
      assert.equal(schema.safeParse(args).success, true, name)
    }
    for (const positions of [held(limit + 1), [held(1)[0], held(1)[0]], [{ id: owner, version: 'invalid' }], [{ id: 'invalid', version: 'a'.repeat(32) }], [{ ...held(1)[0], userId: peer }]]) {
      assert.equal(schema.safeParse([...prefix, 'a'.repeat(32), positions]).success, false, name)
    }
    assert.equal(schema.safeParse([...prefix, 'a'.repeat(32), [], { role: 'admin' }]).success, false, name)
  }
})

test('cached chat metadata repair is literal, bounded and cannot authorize another reader', () => {
  for (const name of ['coordinator.pollCoordinatorChat', 'coordinator.syncCoordinatorChat'] as const) {
    const schema = desktopActionSchemas[name]
    const continuation = { after: 2, cursor: 1, prefix: 'a'.repeat(32), restoreToolMetadata: true, sourceIds: [owner], artifactIds: [peer] }
    assert.equal(schema.safeParse([]).success, true)
    assert.equal(schema.safeParse([null, undefined, continuation]).success, true)
    for (const change of [{ restoreToolMetadata: false }, { restoreToolMetadata: 'true' }, { sourceIds: Array(401).fill(owner) }, { artifactIds: Array(401).fill(peer) }, { ownerId: peer }]) {
      assert.equal(schema.safeParse([null, undefined, { ...continuation, ...change }]).success, false)
    }
  }
  assert.equal(Object.hasOwn(desktopActionSchemas, 'coordinator.getCoordinatorChat'), false)
})

test('cached detail and bootstrap accept identity-free selectors while preserving legacy bootstrap', () => {
  assert.equal(desktopActionSchemas['issues.pollIssue'].safeParse([owner]).success, true)
  assert.equal(desktopActionSchemas['issues.pollIssue'].safeParse([owner, 'a'.repeat(32)]).success, true)
  for (const args of [[], ['invalid'], [owner, 'invalid'], [owner, 'a'.repeat(32), { viewerId: peer }]]) {
    assert.equal(desktopActionSchemas['issues.pollIssue'].safeParse(args).success, false)
  }
  for (const args of [[], [undefined], [owner]]) assert.equal(desktopActionSchemas['desktop.bootstrap'].safeParse(args).success, true)
  for (const args of [[null], ['invalid'], [{ workspaceId: owner, role: 'admin' }], [owner, peer]]) assert.equal(desktopActionSchemas['desktop.bootstrap'].safeParse(args).success, false)
})
