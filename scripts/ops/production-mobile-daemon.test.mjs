import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { attestDeployedTarget } from '../acceptance/deployed-target.mjs'
import { PROJECT, TEAM, PRODUCTION_ALIAS } from '../ops/deployment-regression.mjs'
import { encode, decode } from '../../lib/desktop-rpc/wire.ts'
import { runMobileDaemonProof, newEnrollmentCredential } from './production-mobile-daemon.mjs'
import { CORE_MODE, CORE_WORKFLOW, CORE_ISSUES, attestCoreProduction } from '../acceptance/self-hosted-production-target.mjs'
import { liveReady } from '../../lib/live/events.ts'

const id = n => '30000000-0000-4000-8000-' + String(n).padStart(12, '0')
const OWNER = id(1), WORKSPACE = id(2), OLD_DEVICE = id(3), NEW_DEVICE = id(4), OLD_TOKEN = id(5), NEW_TOKEN = id(6)
const TEAM_WORKSPACE = id(8), SECOND_TEAM = id(9)
// Public Owner identity from comment #1504/6691409495; fixture data, never a login.
const POLICY_ADMIN_EMAIL = 'alex@acme.aspectlylabs.com', POLICY_ADMIN_ID = 'policy-admin'
const CREDENTIAL = 'orv_' + 'c'.repeat(43), GRANT = 'orv_' + 'g'.repeat(43)
const COOKIE = 'opaque-session-must-not-appear'
const ENV = { GITHUB_REPOSITORY: 'alexj11324/Mikka', GITHUB_REF: 'refs/heads/ops/issue1415-production-functional',
  GITHUB_EVENT_NAME: 'push', GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '17', APPLICATION_SHA: 'b'.repeat(40),
  GH_TOKEN: 'github-secret-must-not-appear', SMOKE_OWNER_EMAIL: 'owner+mikka-smoke@example.invalid',
  SMOKE_OWNER_PASSWORD: 'password-must-not-appear' }
const response = (body, status = 200, headers) => Response.json(body, { status, headers })
const storedToken = (tokenId, name = 'Existing token') => ({ id: tokenId, name,
  createdAt: '2026-11-06T12:00:00.000Z', lastUsedAt: null, expiresAt: null, revokedAt: null,
  revokedBy: null, boundDeviceId: null })

function fixture(options = {}) {
  let clock = Date.parse('2026-11-06T13:00:00.000Z'), activeSession = false, newDevice = null, removed = false
  const tokenRows = Array.from({ length: options.tokenCount ?? 1 }, (_, i) => storedToken(i === 0 ? OLD_TOKEN : id(100 + i)))
  const oldDevice = { id: OLD_DEVICE, name: 'Existing protected device', enabled: true, online: false,
    hostname: 'existing', platform: 'other', arch: 'other', harnesses: [], lastSeenAt: null, repos: [] }
  const requests = []
  const sockets = []
  const ticketProtocol = () => 'mikka-ticket-' + Math.floor((clock + 299_000) / 1000) + '-' + 'a'.repeat(64)
  const socketFactory = (url, protocol) => {
    assert.equal(protocol, ticketProtocol())
    const socket = new EventTarget()
    Object.assign(socket, { url, readyState: 0,
      send(value) { assert.equal(value, 'ping'); queueMicrotask(() => socket.dispatchEvent(new MessageEvent('message', { data: 'pong' }))) },
      close() { socket.readyState = 3; socket.dispatchEvent(new Event('close')) },
    })
    sockets.push(socket)
    queueMicrotask(() => {
      socket.readyState = 1; socket.dispatchEvent(new Event('open'))
      if (url.includes('/v1/live/')) socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(liveReady()) }))
      else if (options.gatewayCloses) socket.close()
    })
    return socket
  }
  const choices = [{ id: WORKSPACE, name: 'Personal', kind: 'personal' },
    ...(options.teamCount === 0 ? [] : [
      { id: SECOND_TEAM, name: 'Other team', kind: 'team' },
      { id: TEAM_WORKSPACE, name: 'Team', kind: 'team' },
    ])]
  const members = workspaceId => [
    { userId: OWNER, email: ENV.SMOKE_OWNER_EMAIL, role: 'member', status: 'active' },
    { userId: POLICY_ADMIN_ID,
      email: options.adminMatches !== 0 && (workspaceId === TEAM_WORKSPACE || options.adminMatches === 2)
        ? POLICY_ADMIN_EMAIL : 'unrelated-admin@example.invalid',
      role: 'admin', status: 'active' },
  ]
  const selectedTeam = headers => headers.get('cookie')?.split('; ').includes('mikka-workspace=' + TEAM_WORKSPACE)
  const devices = () => {
    if (newDevice && clock - newDevice.seen >= 60_000) newDevice.online = false
    const own = newDevice && !removed ? [{ ...newDevice, seen: undefined }] : []
    return [oldDevice, ...own]
  }
  async function fetchImpl(input, init = {}) {
    const url = new URL(input instanceof Request ? input.url : input)
    const method = init.method ?? 'GET', headers = new Headers(init.headers)
    assert.equal(url.origin, 'https://app.aspectlylabs.com')
    const path = url.pathname
    let body
    if (init.body) body = JSON.parse(init.body)
    requests.push({ path, search: url.search, method, action: body?.action })
    if (path.includes('/api/auth/')) {
      assert.equal(headers.get('origin'), url.origin)
      if (path.endsWith('/sign-in/email')) {
        assert.equal(body.email, ENV.SMOKE_OWNER_EMAIL)
        assert.equal(body.password, ENV.SMOKE_OWNER_PASSWORD)
        activeSession = true
        if (options.malformedLogin) return new Response('{', { status: 200,
          headers: { 'set-cookie': '__Secure-better-auth.session_token=' + COOKIE + '; Path=/mikka; Secure; HttpOnly' } })
        return response({ success: true }, 200, { 'set-cookie': '__Secure-better-auth.session_token=' + COOKIE + '; Path=/mikka; Secure; HttpOnly' })
      }
      if (path.endsWith('/sign-out')) {
        assert.equal(headers.get('cookie')?.includes(COOKIE), true)
        activeSession = false
        return response({ success: true }, 200, { 'set-cookie': '__Secure-better-auth.session_token=; Path=/mikka; Max-Age=0; Secure; HttpOnly' })
      }
      if (path.endsWith('/get-session')) {
        assert.ok(['', '?disableCookieCache=true'].includes(url.search))
        if (!url.search) assert.equal(selectedTeam(headers), true)
        return response(activeSession ? { user: { id: OWNER, email: ENV.SMOKE_OWNER_EMAIL } } : null)
      }
    }
    if (path.startsWith('/mikka/api/') || path.endsWith('/renderer-manifest.json')) {
      assert.equal(headers.get('cookie')?.includes(COOKIE), true)
      assert.equal(headers.has('authorization'), false)
      assert.equal(headers.get('origin'), url.origin)
      assert.equal(activeSession, true)
      if (path.endsWith('/api/workspace')) {
        assert.equal(method, 'GET')
        if (url.search) {
          const candidate = url.searchParams.get('workspace')
          assert.ok([SECOND_TEAM, TEAM_WORKSPACE].includes(candidate))
          assert.equal(url.search, '?workspace=' + candidate)
          assert.equal(selectedTeam(headers), false)
          return response({ currentUserId: OWNER, role: 'member', choices,
            workspace: { id: candidate, kind: 'team' }, members: members(candidate) })
        }
        const selected = selectedTeam(headers)
        return response({ currentUserId: OWNER, role: 'member', choices,
          workspace: selected ? { id: TEAM_WORKSPACE, kind: 'team' } : { id: WORKSPACE, kind: 'personal' },
          members: selected ? members(TEAM_WORKSPACE) : [] })
      }
      if (path.endsWith('/api/mobile/home')) return response({
        user: { id: options.foreignMobile ? id(90) : OWNER, email: ENV.SMOKE_OWNER_EMAIL },
        workspace: selectedTeam(headers) && !options.wrongMobileWorkspace
          ? { id: TEAM_WORKSPACE, kind: 'team' } : { id: WORKSPACE, kind: 'personal' },
        workspaces: choices, bots: [], threads: { running: 0, waiting: 0 },
        live: { ownerId: OWNER, workspaceId: null },
      })
      if (path.endsWith('/api/desktop/discovery')) {
        assert.equal(options.core, true); assert.equal(method, 'GET')
        return response({ version: ENV.GITHUB_SHA, edition: 'cloud', basePath: '/mikka', desktopProtocol: { min: 0, max: 1 },
          cloud: { connected: false }, mobileReady: true, signIn: { email: true, google: true, github: true } })
      }
      if (path.endsWith('/api/live/ticket')) {
        assert.equal(options.core, true); assert.equal(method, 'GET')
        // Owner device lists use the personal channel, even after the normal
        // cookie has selected the authorized shared team for business reads.
        assert.equal(selectedTeam(headers), true); assert.equal(url.search, '?workspace=' + WORKSPACE)
        const channel = createHash('sha256').update(JSON.stringify([OWNER, WORKSPACE])).digest('hex')
        return response({ url: 'wss://mikka-gateway.aspectlylabs.com/v1/live/' + channel + '/socket',
          protocol: ticketProtocol(), expiresAt: clock + 299_000 })
      }
      if (path.endsWith('/renderer-manifest.json')) return response({ version: 1, target: 'web',
        usedActions: options.missingAction ? ['agents.pollDevices', 'agents.setDeviceEnabled']
          : ['agents.pollDevices', 'agents.setDeviceEnabled', 'agents.removeDevice'] })
      if (path.endsWith('/api/device-tokens') && method === 'GET') {
        if (options.legacyTokenPage) return response({ tokens: tokenRows.slice(0, 100).map(row => ({ ...row })) })
        if (!options.paginateTokens) return response({ tokens: tokenRows.map(row => ({ ...row })) })
        const cursor = url.searchParams.get('cursor')
        const start = cursor ? tokenRows.findIndex(row => row.id === cursor) + 1 : 0
        const page = tokenRows.slice(start, start + 100)
        const nextCursor = options.repeatTokenCursor ? page[0]?.id
          : tokenRows.length > start + 100 ? page.at(-1).id : null
        return response({ tokens: page.map(row => ({ ...row })), nextCursor })
      }
      if (path.endsWith('/api/devices/enrollment')) return response({ token: GRANT })
      if (path.endsWith('/api/device-tokens/' + NEW_TOKEN + '/revoke')) {
        if (options.revokeReply) {
          const { body: failure, status } = options.revokeReply
          return typeof failure === 'string' ? new Response(failure, { status }) : response(failure, status)
        }
        const token = tokenRows.find(row => row.id === NEW_TOKEN)
        token.revokedAt = new Date(clock).toISOString(); token.revokedBy = OWNER
        if (options.wrongRevokeReceipt) return response({ tokenId: OLD_TOKEN, revokedAt: token.revokedAt, revokedBy: OWNER })
        return response({ tokenId: token.id, revokedAt: token.revokedAt, revokedBy: token.revokedBy, unattributedActiveRuns: 0 })
      }
      if (path.endsWith('/api/rpc')) {
        assert.equal(headers.get('x-mikka-rpc'), '1')
        assert.equal(body.version, 1)
        const args = decode(body.args)
        let result
        if (body.action === 'workspace.switchWorkspace') {
          assert.equal(method, 'POST'); assert.deepEqual(Object.keys(body).sort(), ['action', 'args', 'version'])
          assert.deepEqual(args, [TEAM_WORKSPACE])
          return response({ version: 1, ok: true, result: encode({ ok: true, data: { workspaceId: TEAM_WORKSPACE } }) },
            200, options.dropSwitchCookie ? undefined : { 'set-cookie': 'mikka-workspace=' + TEAM_WORKSPACE + '; Path=/; Secure; HttpOnly; SameSite=Lax' })
        }
        if (body.action === 'desktop.bootstrap') {
          assert.equal(options.core, true); assert.deepEqual(args, [TEAM_WORKSPACE])
          result = { user: { id: OWNER }, cacheWorkspace: { workspaceId: TEAM_WORKSPACE, role: 'member' }, edition: 'cloud',
            emailEnabled: true, features: { cloudComputer: options.cloudComputer ?? true, flags: { 'mikka-computer-billing': false, 'mikka-computer-tab-off': false } } }
        } else if (body.action === 'agents.pollDevices') result = { devices: devices(), live: { ownerId: OWNER, workspaceId: WORKSPACE } }
        else if (body.action === 'agents.setDeviceEnabled') {
          assert.deepEqual(args, [{ deviceId: NEW_DEVICE, enabled: false }])
          assert.equal(newDevice.id, NEW_DEVICE)
          newDevice.enabled = false
          result = { success: true }
        } else if (body.action === 'agents.removeDevice') {
          assert.deepEqual(args, [NEW_DEVICE])
          assert.equal(tokenRows.find(row => row.id === NEW_TOKEN)?.revokedBy, OWNER)
          assert.equal(newDevice.online, false)
          assert.equal(newDevice.enabled, false)
          if (options.removeReply) return response(options.removeReply.body, options.removeReply.status)
          removed = true
          result = { id: NEW_DEVICE, revokedTokens: 0, uninstall: 'not_possible' }
        } else assert.fail('Unexpected RPC action')
        return response({ version: 1, ok: true, result: encode(result) })
      }
    }
    if (path === '/mikka/v1/devices/enroll') {
      assert.equal(headers.get('authorization'), 'Bearer ' + GRANT)
      assert.equal(headers.has('cookie'), false)
      tokenRows.push(storedToken(NEW_TOKEN, 'SSH'))
      if (options.concurrentCredential) tokenRows.push(storedToken(id(7), 'SSH'))
      if (options.lostExchangeReply) throw new Error('exchange-error-' + CREDENTIAL)
      return response({ credential: CREDENTIAL })
    }
    assert.equal(headers.has('cookie'), false)
    assert.equal(headers.get('authorization'), 'Bearer ' + CREDENTIAL)
    // The actual repository HttpServerLink supplies these; no fake client implementation.
    assert.equal(headers.get('x-mikka-client-version'), '0.0.1')
    if (tokenRows.find(row => row.id === NEW_TOKEN)?.revokedAt) {
      if (options.rejectedCredentialTransportFailure) throw new Error('transport-error-' + CREDENTIAL)
      if (options.rejectedCredentialReply) {
        const { body: failure, status } = options.rejectedCredentialReply
        return typeof failure === 'string' ? new Response(failure, { status }) : response(failure, status)
      }
      return response({ error: 'Unauthorized' }, 401)
    }
    if (path === '/mikka/v1/devices/register') {
      assert.equal(body.daemonVersion, '0.0.1')
      assert.equal(body.protocolVersion, 3)
      assert.deepEqual(body.harnesses, [])
      assert.equal(body.computerUse.installed, false)
      newDevice = { id: NEW_DEVICE, name: options.wrongDeviceMarker ? 'Unconfirmed other device' : body.name,
        hostname: body.hostname, platform: body.platform,
        arch: body.arch, harnesses: [], online: true, enabled: true, seen: clock, repos: [] }
      sockets.find(socket => socket.url.includes('/v1/live/'))?.dispatchEvent(new MessageEvent('message', {
        data: JSON.stringify({ kind: 'device_list', id: WORKSPACE }),
      }))
      if (options.lostRegisterReply) throw new Error('transport-error-' + CREDENTIAL + '-' + COOKIE)
      return response({ deviceId: NEW_DEVICE, workspaceId: WORKSPACE })
    }
    if (path === '/mikka/v1/devices/' + NEW_DEVICE + '/gateway') {
      assert.equal(options.core, true); assert.equal(method, 'GET'); assert.equal(newDevice.enabled, false)
      return response({ url: 'wss://mikka-gateway.aspectlylabs.com/v1/devices/' + NEW_DEVICE + '/socket', protocol: ticketProtocol(),
        runControl: 'push', computerReviews: 'push', coordinatorResults: 'push' })
    }
    if (path === '/mikka/v1/devices/' + NEW_DEVICE + '/heartbeat') {
      assert.equal(newDevice.enabled, false)
      assert.deepEqual(body.runs, [])
      assert.deepEqual(body.harnesses, [])
      newDevice.seen = clock; newDevice.online = true
      return response({ leases: {}, revoked: [], deviceCommands: [], daemonVersions: { min: '0.0.456' } })
    }
    assert.fail('Unexpected path: ' + path)
  }
  return { requests, tokenRows, oldDevice, fetchImpl, socketFactory, sockets, now: () => clock,
    get removed() { return removed }, get deviceName() { return newDevice?.name },
    run: overrides => runMobileDaemonProof({ env: ENV, fetchImpl, now: () => clock,
      wait: async ms => { clock += ms }, deploymentGate: async () => {}, ...overrides }) }
}

function noSensitiveReport(report) {
  const value = JSON.stringify(report)
  for (const secret of [CREDENTIAL, GRANT, COOKIE, OWNER, WORKSPACE, TEAM_WORKSPACE, SECOND_TEAM, OLD_TOKEN, NEW_TOKEN, OLD_DEVICE, NEW_DEVICE,
    ENV.SMOKE_OWNER_EMAIL, ENV.SMOKE_OWNER_PASSWORD, ENV.GH_TOKEN, POLICY_ADMIN_EMAIL, POLICY_ADMIN_ID,
    'unrelated-admin@example.invalid', 'transport-error-'])
    assert.equal(value.includes(secret), false, 'closed report must omit identities, credentials and raw error')
}

test('real source HTTP client proves mobile owner, enroll, disabled heartbeat, revoke and normal offline removal', async () => {
  const f = fixture()
  const report = await f.run()
  assert.equal(report.status, 'pass', JSON.stringify(report))
  assert.equal(report.checks.mobileHomeOwner, true)
  assert.equal(report.teamWorkspaceConfirmed, true)
  assert.equal(report.teamWorkspaceHash, createHash('sha256').update('team-workspace\0' + TEAM_WORKSPACE).digest('hex'))
  assert.equal(report.teamAdminMembershipVerified, true)
  assert.equal(report.teamSelectionBasis, 'unique-active-admin-identity-match')
  assert.equal(report.teamOwnerAttribution, 'AGENTS.md-and-owner-comment-1504-6691409495')
  assert.deepEqual(f.requests.filter(row => row.path.endsWith('/api/workspace')).map(row => [row.method, row.search]),
    [['GET', ''], ['GET', '?workspace=' + SECOND_TEAM], ['GET', '?workspace=' + TEAM_WORKSPACE], ['GET', '']])
  const switchedAt = f.requests.findIndex(row => row.action === 'workspace.switchWorkspace')
  assert.ok(switchedAt > 0 && switchedAt < f.requests.findIndex(row => row.path.endsWith('/api/mobile/home')))
  assert.equal(f.requests.filter(row => row.action === 'workspace.switchWorkspace').length, 1)
  assert.equal(report.checks.heartbeat, true)
  assert.equal(report.client.version, '0.0.1')
  assert.equal(report.client.protocolVersion, 3)
  assert.equal(report.client.osInstallationExercised, false)
  assert.ok(Object.values(report.cleanup).every(Boolean))
  assert.equal(f.removed, true)
  assert.equal(f.tokenRows.find(row => row.id === OLD_TOKEN).revokedAt, null)
  assert.equal(f.oldDevice.enabled, true)
  assert.deepEqual(report.resourceBindings, { algorithm: 'sha256',
    credentialId: createHash('sha256').update('device-token-id\0' + NEW_TOKEN).digest('hex'),
    deviceId: createHash('sha256').update('device-id\0' + NEW_DEVICE).digest('hex'),
    deviceNonce: createHash('sha256').update('device-nonce\0' + f.deviceName).digest('hex') })
  assert.equal(JSON.stringify(report).includes(f.deviceName), false)
  noSensitiveReport(report)
})

test('complete paginated token history preserves all 263 originals through enrollment and cleanup', async () => {
  const f = fixture({ tokenCount: 263, paginateTokens: true })
  const report = await f.run()
  assert.equal(report.status, 'pass', JSON.stringify(report))
  assert.ok(Object.values(report.cleanup).every(Boolean))
  assert.equal(f.tokenRows.length, 264)
  assert.equal(f.tokenRows.filter(row => row.revokedAt !== null).length, 1)
  assert.equal(f.tokenRows.find(row => row.id === NEW_TOKEN).revokedBy, OWNER)
  assert.ok(f.requests.filter(row => row.path.endsWith('/api/device-tokens') && row.search.startsWith('?cursor=')).length >= 6)
  noSensitiveReport(report)
})

test('cleanup retains failed revoke HTTP status and redacted body without replaying the mutation', async () => {
  for (const [status, code] of [[500, 'internal_error'], [401, 'authRequired']]) {
    const f = fixture({ revokeReply: { status, body: { error: code, message: CREDENTIAL,
      cookie: COOKIE, [ENV.SMOKE_OWNER_PASSWORD]: ENV.SMOKE_OWNER_EMAIL } } })
    const report = await f.run()
    const failure = report.errors.find(row => row.phase === 'cleanup-credential')
    assert.equal(report.status, 'fail')
    assert.equal(failure.code, 'token_revoke_failed')
    assert.deepEqual(failure.http, { operation: 'device-tokens.revoke', method: 'POST', status,
      body: { error: code, message: '[redacted]', redactedFields: 2 } })
    assert.equal(report.cleanup.credentialRevoked, false)
    assert.equal(report.cleanup.oldCredentialRejected, false)
    assert.equal(report.cleanup.deviceRemoved, false)
    assert.equal(report.cleanup.sessionClosed, true)
    assert.equal(f.requests.filter(row => row.path.endsWith('/revoke')).length, 1)
    assert.equal(f.requests.some(row => row.action === 'agents.removeDevice'), false)
    assert.equal(f.tokenRows.find(row => row.id === OLD_TOKEN).revokedAt, null)
    noSensitiveReport(report)
  }
})

test('a 200 revoke reply with another token still fails and exposes only contract diagnostics', async () => {
  const f = fixture({ wrongRevokeReceipt: true }), report = await f.run()
  const failure = report.errors.find(row => row.phase === 'cleanup-credential')
  assert.equal(failure.code, 'token_revoke_failed')
  assert.deepEqual(failure.http, { operation: 'device-tokens.revoke', method: 'POST', status: 200,
    body: { tokenId: '[redacted]', revokedAt: '[redacted]', revokedBy: '[redacted]' } })
  assert.equal(report.cleanup.credentialRevoked, false)
  assert.equal(f.removed, false)
  noSensitiveReport(report)
})

test('a non-JSON revoke error keeps its status and size while withholding the raw body', async () => {
  const body = '<html>' + CREDENTIAL + COOKIE + '</html>'
  const f = fixture({ revokeReply: { status: 502, body } }), report = await f.run()
  const failure = report.errors.find(row => row.phase === 'cleanup-credential')
  assert.equal(failure.code, 'response_invalid')
  assert.deepEqual(failure.http, { operation: 'device-tokens.revoke', method: 'POST', status: 502,
    body: { format: 'non-json', bytes: Buffer.byteLength(body) } })
  assert.equal(report.cleanup.sessionClosed, true)
  assert.equal(f.removed, false)
  noSensitiveReport(report)
})

test('device removal failure records its own RPC response rather than the prior revoke response', async () => {
  const f = fixture({ removeReply: { status: 503, body: { version: 1, ok: false,
    error: { code: 'deviceNotFound', message: COOKIE, private: CREDENTIAL } } } })
  const report = await f.run(), failure = report.errors.find(row => row.phase === 'cleanup-device')
  assert.deepEqual(failure.http, { operation: 'agents.removeDevice', method: 'POST', status: 503,
    body: { version: 1, ok: false, error: { code: 'deviceNotFound', message: '[redacted]', redactedFields: 1 } } })
  assert.equal(report.cleanup.credentialRevoked, true)
  assert.equal(report.cleanup.oldCredentialRejected, true)
  assert.equal(report.cleanup.deviceRemoved, false)
  assert.equal(report.cleanup.sessionClosed, true)
  noSensitiveReport(report)
})

test('post-revoke credential probe records its own JSON failure instead of the successful revoke reply', async () => {
  const f = fixture({ rejectedCredentialReply: { status: 503, body: { error: 'internal_error', message: CREDENTIAL, cookie: COOKIE } } })
  const report = await f.run(), failure = report.errors.find(row => row.phase === 'cleanup-credential')
  assert.equal(failure.code, 'credential_still_admitted')
  assert.deepEqual(failure.http, { operation: 'devices.repos', method: 'GET', status: 503,
    body: { error: 'internal_error', message: '[redacted]', redactedFields: 1 } })
  assert.equal(report.cleanup.credentialRevoked, true)
  assert.equal(report.cleanup.oldCredentialRejected, false)
  assert.equal(f.removed, false)
  noSensitiveReport(report)
})

test('post-revoke non-JSON response retains its status and size without consuming the client response', async () => {
  const body = '<html>' + CREDENTIAL + COOKIE + '</html>'
  const f = fixture({ rejectedCredentialReply: { status: 502, body } })
  const report = await f.run(), failure = report.errors.find(row => row.phase === 'cleanup-credential')
  assert.deepEqual(failure.http, { operation: 'devices.repos', method: 'GET', status: 502,
    body: { format: 'non-json', bytes: Buffer.byteLength(body) } })
  assert.equal(report.cleanup.credentialRevoked, true)
  assert.equal(report.cleanup.oldCredentialRejected, false)
  assert.equal(f.removed, false)
  noSensitiveReport(report)
})

test('post-revoke admitted credential records the repos 200 rather than the prior revoke 200', async () => {
  const f = fixture({ rejectedCredentialReply: { status: 200, body: { repos: [] } } })
  const report = await f.run(), failure = report.errors.find(row => row.phase === 'cleanup-credential')
  assert.equal(failure.code, 'credential_still_admitted')
  assert.deepEqual(failure.http, { operation: 'devices.repos', method: 'GET', status: 200, body: { redactedFields: 1 } })
  assert.equal(report.cleanup.credentialRevoked, true)
  assert.equal(report.cleanup.oldCredentialRejected, false)
  assert.equal(f.removed, false)
  noSensitiveReport(report)
})

test('post-revoke transport failure clears the successful revoke HTTP response', async () => {
  const f = fixture({ rejectedCredentialTransportFailure: true })
  const report = await f.run(), failure = report.errors.find(row => row.phase === 'cleanup-credential')
  assert.deepEqual(failure.http, { operation: 'devices.repos', method: 'GET', status: null, body: { format: 'unavailable' } })
  assert.equal(report.cleanup.credentialRevoked, true)
  assert.equal(report.cleanup.oldCredentialRejected, false)
  assert.equal(f.removed, false)
  noSensitiveReport(report)
})

test('an old truncated page or an invalid cursor cannot authorize resource creation', async () => {
  for (const options of [{ tokenCount: 263, legacyTokenPage: true }, { tokenCount: 263, paginateTokens: true, repeatTokenCursor: true }]) {
    const f = fixture(options), report = await f.run()
    assert.equal(report.status, 'fail')
    assert.ok(report.errors.some(error => error.code === 'resource_baseline_invalid'))
    assert.equal(report.resources.enrollmentAttempts, 0)
    assert.equal(f.tokenRows.filter(row => row.revokedAt !== null).length, 0)
    assert.equal(report.cleanup.sessionClosed, true)
    noSensitiveReport(report)
  }
})

test('wrong ops context and wrong mobile owner cannot create production resources', async () => {
  const blocked = fixture()
  const first = await blocked.run({ env: { ...ENV, GITHUB_REF: 'refs/heads/main' } })
  assert.equal(first.status, 'fail')
  assert.equal(blocked.requests.length, 0)
  const wrong = fixture({ foreignMobile: true })
  const second = await wrong.run()
  assert.equal(second.status, 'fail')
  assert.equal(second.checks.mobileHomeOwner, false)
  assert.equal(wrong.requests.some(row => row.path.includes('/devices/enroll')), false)
  assert.equal(second.cleanup.sessionClosed, true)
  noSensitiveReport(second)
})

test('a missing published cleanup action stops before credential issuance', async () => {
  const f = fixture({ missingAction: true })
  const report = await f.run()
  assert.equal(report.status, 'fail')
  assert.equal(report.resources.enrollmentAttempts, 0)
  assert.equal(report.cleanup.sessionClosed, true)
})

test('ambiguous new credentials are never guessed, registered or revoked', async () => {
  const f = fixture({ concurrentCredential: true })
  const report = await f.run()
  assert.equal(report.status, 'fail')
  assert.ok(report.errors.some(row => row.code === 'credential_ambiguous'))
  assert.equal(f.requests.some(row => row.path.endsWith('/register') || row.path.endsWith('/revoke')), false)
  assert.equal(f.tokenRows.every(row => row.revokedAt === null), true)
  noSensitiveReport(report)
})

test('a lost registration reply is not replayed and only this nonce device is reconciled and removed', async () => {
  const f = fixture({ lostRegisterReply: true })
  const report = await f.run()
  assert.equal(report.status, 'fail')
  assert.equal(f.requests.filter(row => row.path.endsWith('/register')).length, 1)
  assert.equal(f.removed, true)
  assert.ok(Object.values(report.cleanup).every(Boolean), JSON.stringify(report))
  assert.equal(f.tokenRows.find(row => row.id === OLD_TOKEN).revokedAt, null)
  noSensitiveReport(report)
})

test('complete token baseline rejects eviction or altered unrelated permissions', () => {
  const old = storedToken(OLD_TOKEN), next = storedToken(NEW_TOKEN, 'SSH')
  assert.equal(newEnrollmentCredential([old], [old, next]), NEW_TOKEN)
  assert.throws(() => newEnrollmentCredential([old], [next]), /credential_ambiguous/)
  assert.throws(() => newEnrollmentCredential([old], [{ ...old, expiresAt: '2027-01-01' }, next]), /credential_ambiguous/)
  assert.throws(() => newEnrollmentCredential([old], [old, { ...next, name: 'Not this enrollment' }]), /credential_ambiguous/)
})

test('unknown exchange results never adopt or revoke a newly visible unrelated token', async () => {
  const f = fixture({ lostExchangeReply: true })
  const report = await f.run()
  assert.equal(report.status, 'fail')
  assert.equal(report.resources.issuedCredentials, 0)
  assert.equal(f.requests.filter(row => row.path.endsWith('/v1/devices/enroll')).length, 1)
  assert.equal(f.requests.some(row => row.path.endsWith('/register') || row.path.endsWith('/revoke')), false)
  assert.ok(report.errors.some(row => row.code === 'credential_ambiguous'))
  assert.equal(report.cleanup.sessionClosed, true)
  noSensitiveReport(report)
})

test('a returned id with a different nonce never authorizes disabling or removing that device', async () => {
  const f = fixture({ wrongDeviceMarker: true })
  const report = await f.run()
  assert.equal(report.status, 'fail')
  assert.equal(report.cleanup.credentialRevoked, true)
  assert.equal(report.cleanup.oldCredentialRejected, true)
  assert.equal(report.cleanup.deviceRemoved, false)
  assert.equal(f.requests.some(row => row.action === 'agents.setDeviceEnabled' || row.action === 'agents.removeDevice'), false)
  assert.equal(report.cleanup.sessionClosed, true)
  noSensitiveReport(report)
})

test('a malformed login reply with a real session cookie still uses normal sign-out', async () => {
  const f = fixture({ malformedLogin: true })
  const report = await f.run()
  assert.equal(report.status, 'fail')
  assert.equal(report.resources.enrollmentAttempts, 0)
  assert.equal(report.cleanup.sessionClosed, true)
  assert.equal(f.requests.filter(row => row.path.endsWith('/sign-out')).length, 1)
  noSensitiveReport(report)
})

function deployedFixture(business, originalEnv, { changed = () => false } = {}) {
  const env = { ...originalEnv, MIKKA_ACCEPTANCE_TARGET_MODE: 'deployed-target',
    GITHUB_REPOSITORY_OWNER: 'alexj11324', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main',
    GITHUB_WORKFLOW_REF: 'alexj11324/Mikka/.github/workflows/issue1415-deployed-production.yml@refs/heads/main',
    GITHUB_RUN_ID: '99', GITHUB_RUN_ATTEMPT: '1', WEB_DEPLOY_RUN_ID: '51',
    VERCEL_DEPLOYMENT_ID: 'dpl_transport', VERCEL_TEAM_TOKEN: 'SYNTHETIC_VERCEL_READ_TOKEN' }
  const repository = { full_name: 'alexj11324/Mikka', owner: { login: 'alexj11324' } }
  const event = { repository, inputs: { application_sha: env.APPLICATION_SHA,
    web_run_id: env.WEB_DEPLOY_RUN_ID, deployment_id: env.VERCEL_DEPLOYMENT_ID } }
  const api = 'https://api.github.com/repos/alexj11324/Mikka'
  const metadata = []
  const now = business.now ?? Date.now
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input)
    if (url.origin === 'https://api.github.com' || url.origin === 'https://api.vercel.com'
      || url.pathname === '/mikka/api/version') {
      metadata.push(url.pathname)
      assert.equal(init.method, 'GET')
      assert.equal(new Headers(init.headers).has('cookie'), false)
      if (url.origin === 'https://api.github.com') {
        assert.equal(new Headers(init.headers).get('authorization'), 'Bearer ' + env.GH_TOKEN)
        if (url.href === api + '/actions/runs/99') return Response.json({ id: 99, run_attempt: 1,
          url: url.href, path: '.github/workflows/issue1415-deployed-production.yml',
          repository, head_repository: repository, event: 'workflow_dispatch', head_branch: 'main',
          head_sha: env.GITHUB_SHA, status: 'in_progress', conclusion: null })
        if (url.href === api + '/issues/1415') return Response.json({ number: 1415, url: url.href,
          repository_url: api, state: 'open' })
        if (url.href === api + '/actions/runs/51') return Response.json({ id: 51, run_attempt: 1,
          url: url.href, name: 'Web deploy', path: '.github/workflows/web-deploy.yml',
          repository, head_repository: repository, event: 'push', head_branch: 'main',
          head_sha: env.APPLICATION_SHA, status: 'completed', conclusion: 'success' })
        if (url.pathname.endsWith('/actions/runs/51/attempts/1/jobs')) return Response.json({
          total_count: 1, jobs: [{ id: 61, run_id: 51, name: 'deploy', head_sha: env.APPLICATION_SHA,
            status: 'completed', conclusion: 'success', steps: [
              'Build (runs migrations last, as the Vercel build did)', 'Upload the prebuilt output to production',
              'Verify the public production version before releasing the deployment queue',
            ].map(name => ({ name, status: 'completed', conclusion: 'success' })) }] })
        assert.fail('Unexpected metadata path')
      }
      if (url.origin === 'https://api.vercel.com') {
        assert.equal(new Headers(init.headers).get('authorization'), 'Bearer ' + env.VERCEL_TEAM_TOKEN)
        if (url.pathname.startsWith('/v4/aliases/')) return Response.json({
          alias: PRODUCTION_ALIAS, projectId: PROJECT, deploymentId: changed() ? 'dpl_changed' : env.VERCEL_DEPLOYMENT_ID,
          updatedAt: 1 })
        if (url.pathname === '/v13/deployments/' + env.VERCEL_DEPLOYMENT_ID) return Response.json({
          id: env.VERCEL_DEPLOYMENT_ID, projectId: PROJECT, teamId: TEAM, readyState: 'READY',
          target: 'production', gitSource: { sha: env.APPLICATION_SHA } })
        assert.fail('Unexpected deployment path')
      }
      return Response.json({ build: env.APPLICATION_SHA })
    }
    return business.fetchImpl(input, init)
  }
  return { env, event, fetchImpl, metadata, now,
    proof: () => attestDeployedTarget({ env, event, fetchImpl, now }) }
}

test('deployed target mobile proof keeps the real driver client distinct from the immutable application', async () => {
  const f = fixture(), target = deployedFixture(f, ENV)
  const report = await f.run({ ...target, attestation: await target.proof() })
  assert.equal(report.status, 'pass', JSON.stringify(report))
  assert.equal(report.applicationSha, ENV.APPLICATION_SHA)
  assert.equal(report.driverRevision, ENV.GITHUB_SHA)
  assert.notEqual(report.applicationSha, report.driverRevision)
  assert.equal(report.client.sourceRevision, report.driverRevision)
  assert.equal(report.client.version, '0.0.1')
  assert.equal(report.client.protocolVersion, 3)
  assert.equal(report.targetMode, 'deployed-target')
  assert.equal(report.webDeployRunId, 51); assert.equal(report.webAttempt, 1)
  assert.equal(report.deploymentId, 'dpl_transport')
  assert.ok(target.metadata.filter(path => path.endsWith('/actions/runs/99')).length >= 3)
  assert.equal(target.metadata.some(path => path.endsWith('/git/ref/heads/main')), false)
  assert.ok(Object.values(report.cleanup).every(Boolean))
  noSensitiveReport(report)
})

test('deployed target mobile rejects an attestation from another driver before owner login', async () => {
  const f = fixture(), target = deployedFixture(f, ENV)
  const attestation = { ...await target.proof(), driverRevision: 'c'.repeat(40) }
  const report = await f.run({ ...target, attestation })
  assert.equal(report.status, 'fail')
  assert.equal(report.targetFailure.code, 'target_attestation')
  assert.equal(f.requests.length, 0)
  assert.equal(report.resources.enrollmentAttempts, 0)
  noSensitiveReport(report)
})

test('a deployed target drift cannot pass after exact daemon credential/device/session cleanup', async () => {
  const f = fixture(), target = deployedFixture(f, ENV, { changed: () => f.removed })
  const report = await f.run({ ...target, attestation: await target.proof() })
  assert.equal(report.status, 'fail')
  assert.equal(report.targetFailure.code, 'target_changed')
  assert.equal(report.targetFailure.status, 'inconclusive')
  assert.equal(report.checks.finalDeployment, false)
  assert.ok(Object.values(report.cleanup).every(Boolean), JSON.stringify(report))
  assert.equal(f.requests.filter(row => row.path.endsWith('/v1/devices/enroll')).length, 1)
  assert.equal(f.requests.filter(row => row.path.endsWith('/register')).length, 1)
  noSensitiveReport(report)
})

test('failed mobile business or cleanup still observes the final target without replacing original errors', async () => {
  for (const options of [{ lostRegisterReply: true }, { wrongDeviceMarker: true }]) {
    const originalFailure = await fixture(options).run()
    assert.equal(originalFailure.status, 'fail')
    const f = fixture(options), target = deployedFixture(f, ENV, {
      changed: () => f.requests.some(row => row.path.endsWith('/sign-out')),
    })
    const report = await f.run({ ...target, attestation: await target.proof() })
    assert.equal(report.status, 'fail')
    assert.equal(report.targetAfter.verified, false)
    assert.equal(report.targetAfter.status, 'inconclusive')
    assert.equal(report.targetAfter.code, 'target_changed')
    assert.equal(report.targetFailure.code, 'target_changed')
    assert.deepEqual(report.errors.filter(row => row.phase !== 'final-deployment'), originalFailure.errors)
    assert.equal(report.cleanup.credentialRevoked, true)
    assert.equal(report.cleanup.sessionClosed, true)
    if (options.lostRegisterReply) {
      assert.ok(Object.values(report.cleanup).every(Boolean))
    } else {
      assert.equal(report.cleanup.deviceRemoved, false)
      assert.ok(report.errors.some(row => row.phase === 'cleanup-device'))
      assert.equal(f.requests.some(row => row.action === 'agents.removeDevice'), false)
    }
    assert.equal(f.requests.filter(row => row.path.endsWith('/register')).length, 1)
    assert.equal(f.requests.filter(row => row.path.endsWith('/sign-out')).length, 1)
    noSensitiveReport(report)
  }
})

test('mobile refuses missing or ambiguous admin-bound teams before resource creation and still signs out', async () => {
  for (const [options, detail] of [[{ teamCount: 0 }, 'team_missing'],
    [{ adminMatches: 0 }, 'team_admin_missing'], [{ adminMatches: 2 }, 'team_admin_ambiguous']]) {
    const f = fixture(options), report = await f.run()
    assert.equal(report.status, 'fail')
    assert.deepEqual(report.teamFailure, { code: 'team_workspace_failed', detail })
    assert.equal(report.teamAdminMembershipVerified, false)
    assert.equal(report.resources.enrollmentAttempts, 0)
    assert.equal(f.requests.some(row => row.action === 'workspace.switchWorkspace'), false)
    assert.equal(f.requests.some(row => row.path.endsWith('/api/mobile/home')), false)
    assert.equal(report.cleanup.sessionClosed, true)
    noSensitiveReport(report)
  }
})

test('mobile requires the switched cookie readback and the actual home to identify the selected team', async () => {
  for (const options of [{ dropSwitchCookie: true }, { wrongMobileWorkspace: true }]) {
    const f = fixture(options), report = await f.run()
    assert.equal(report.status, 'fail')
    assert.equal(report.resources.enrollmentAttempts, 0)
    assert.equal(report.cleanup.sessionClosed, true)
    assert.equal(f.requests.filter(row => row.action === 'workspace.switchWorkspace').length, 1)
    if (options.dropSwitchCookie) {
      assert.deepEqual(report.teamFailure, { code: 'team_workspace_failed', detail: 'workspace_changed' })
      assert.equal(f.requests.some(row => row.path.endsWith('/api/mobile/home')), false)
    } else {
      assert.equal(report.teamWorkspaceConfirmed, true)
      assert.equal(report.checks.mobileHomeOwner, false)
      assert.ok(report.errors.some(row => row.code === 'mobile_home_failed'))
    }
    noSensitiveReport(report)
  }
})

function coreFixture(business, { changed = () => false } = {}) {
  const env = { ...ENV, MIKKA_ACCEPTANCE_TARGET_MODE: CORE_MODE, GITHUB_REPOSITORY_OWNER: 'alexj11324',
    GITHUB_EVENT_NAME: 'workflow_run', GITHUB_REF: 'refs/heads/main', GITHUB_RUN_ATTEMPT: '1',
    GITHUB_WORKFLOW_REF: 'alexj11324/Mikka/' + CORE_WORKFLOW + '@refs/heads/main' }
  const repository = { full_name: 'alexj11324/Mikka', owner: { login: 'alexj11324' } }
  const api = 'https://api.github.com/repos/alexj11324/Mikka'
  const release = { id: 51, run_attempt: 1, url: api + '/actions/runs/51', name: 'Web deploy', path: '.github/workflows/web-deploy.yml',
    repository, head_repository: repository, event: 'push', head_branch: 'main', head_sha: env.GITHUB_SHA,
    status: 'completed', conclusion: 'success' }
  const event = { action: 'completed', repository, workflow_run: release }
  const fetchImpl = async (input, init) => {
    const url = new URL(input), headers = new Headers(init.headers)
    if (url.origin === 'https://api.github.com') {
      assert.equal(init.method, 'GET'); assert.equal(headers.has('cookie'), false)
      assert.equal(headers.get('authorization'), 'Bearer ' + env.GH_TOKEN)
      if (url.href === api + '/actions/runs/17') return response({ id: 17, run_attempt: 1, repository, head_repository: repository,
        url: url.href, path: CORE_WORKFLOW, event: 'workflow_run', head_branch: 'main', head_sha: env.GITHUB_SHA,
        status: 'in_progress', conclusion: null })
      if (url.pathname.includes('/issues/')) {
        const number = Number(url.pathname.split('/').at(-1)); assert.ok(CORE_ISSUES.includes(number))
        return response({ number, url: url.href, repository_url: api, state: 'open' })
      }
      if (url.href === api + '/git/ref/heads/main') return response({ ref: 'refs/heads/main', object: { type: 'commit', sha: changed() ? 'c'.repeat(40) : env.GITHUB_SHA } })
      if (url.href === release.url) return response(release)
      if (url.href === release.url + '/attempts/1/jobs?per_page=100') return response({ total_count: 1, jobs: [{
        id: 61, name: 'deploy', run_id: 51, head_sha: env.GITHUB_SHA, status: 'completed', conclusion: 'success',
        steps: ['Verify the official runtime stays on the cloud edition', 'Build (runs migrations last, as the Vercel build did)',
          'Upload the prebuilt output to production', 'Verify the public production version before releasing the deployment queue']
          .map(name => ({ name, status: 'completed', conclusion: 'success' })),
      }] })
      assert.fail('Unexpected core target metadata')
    }
    if (url.pathname === '/mikka/api/version') {
      assert.equal(headers.has('authorization'), false); assert.equal(headers.has('cookie'), false)
      return response({ build: env.GITHUB_SHA })
    }
    return business.fetchImpl(input, init)
  }
  return { env, event, fetchImpl, now: business.now, socketFactory: business.socketFactory,
    proof: () => attestCoreProduction({ env, event, fetchImpl, now: business.now }) }
}

test('core workflow_run composes real source daemon HTTP, current target guards, both sockets and exact cleanup', async () => {
  for (const cloudComputer of [false, true]) {
    const f = fixture({ core: true, cloudComputer }), target = coreFixture(f)
    const report = await f.run({ ...target, attestation: await target.proof() })
    assert.equal(report.status, 'pass', JSON.stringify(report))
    assert.equal(report.core.flags.cloudComputer, cloudComputer)
    assert.equal(report.scope, 'mikka-cloud-core-compatibility'); assert.equal(report.targetMode, CORE_MODE)
    assert.ok(Object.values(report.checks).every(Boolean)); assert.ok(Object.values(report.cleanup).every(Boolean))
    assert.equal(report.core.billing.status, 'not_authorized')
    assert.equal(report.boundaries.quotaEnforcementExercised, false)
    assert.equal(report.boundaries.modelRequestsByDriver, 0)
    assert.equal(f.sockets.length, 2); assert.ok(f.sockets.every(socket => socket.readyState === 3))
    assert.equal(f.requests.filter(row => row.path.endsWith('/register')).length, 1)
    assert.equal(f.requests.some(row => row.action?.startsWith('billing.')), false)
    assert.equal(f.removed, true); noSensitiveReport(report)
  }
})

test('core gateway refusal and later deployment drift still close sockets and clean only this attempt', async () => {
  for (const gatewayCloses of [true, false]) {
    const f = fixture({ core: true, cloudComputer: false, gatewayCloses }), target = coreFixture(f, { changed: () => !gatewayCloses && f.removed })
    const report = await f.run({ ...target, attestation: await target.proof() })
    assert.equal(report.status, 'fail'); assert.ok(Object.values(report.cleanup).every(Boolean), JSON.stringify(report))
    assert.ok(f.sockets.every(socket => socket.readyState === 3)); assert.equal(f.removed, true)
    assert.equal(f.requests.filter(row => row.path.endsWith('/register')).length, 1)
    if (gatewayCloses) assert.ok(report.errors.some(error => error.phase === 'core-device-gateway' && error.code === 'core_socket'))
    else assert.deepEqual(report.targetFailure, { code: 'core_target_changed', detail: 'main' })
    noSensitiveReport(report)
  }
})
