import assert from 'node:assert/strict'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import test from 'node:test'
import { liveReady } from '../../lib/live/events.ts'
import { CORE_MODE, CORE_WORKFLOW, CORE_ISSUES, coreProductionGuard, attestCoreProduction, assertCoreProductionTarget } from './self-hosted-production-target.mjs'
import { coreLiveSocket, coreDeviceSocket, readCoreCapabilities } from './self-hosted-production-probes.mjs'

// Reuse the WebSocket peer already bundled by Nitro's Node adapter. No extra
// dependency or installation is needed for this disposable loopback proof.
const rootRequire = createRequire(import.meta.url)
const nitroRequire = createRequire(rootRequire.resolve('nitro/package.json'))
const { WebSocketServer } = createRequire(nitroRequire.resolve('crossws/adapters/node'))('ws')

const SHA = 'a'.repeat(40), API = 'https://api.github.com/repos/alexj11324/Mikka'
const repository = { full_name: 'alexj11324/Mikka', owner: { login: 'alexj11324' } }
const env = { MIKKA_ACCEPTANCE_TARGET_MODE: CORE_MODE, GITHUB_REPOSITORY: repository.full_name,
  GITHUB_REPOSITORY_OWNER: 'alexj11324', GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_run',
  GITHUB_SHA: SHA, GITHUB_RUN_ID: '17', GITHUB_RUN_ATTEMPT: '1',
  GITHUB_WORKFLOW_REF: repository.full_name + '/' + CORE_WORKFLOW + '@refs/heads/main', GH_TOKEN: 'fixture-token' }
const release = { id: 51, run_attempt: 2, repository, head_repository: repository,
  url: API + '/actions/runs/51', name: 'Web deploy', path: '.github/workflows/web-deploy.yml',
  event: 'push', head_branch: 'main', head_sha: SHA, status: 'completed', conclusion: 'success' }
const event = { action: 'completed', repository, workflow_run: release }
const steps = ['Verify the official runtime stays on the cloud edition', 'Build (runs migrations last, as the Vercel build did)',
  'Upload the prebuilt output to production', 'Verify the public production version before releasing the deployment queue']
const now = () => Date.parse('2026-11-07T12:00:00Z')

function metadata(options = {}) {
  const calls = []
  const fetchImpl = async (input, init) => {
    const url = new URL(input); calls.push(url.href)
    assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error')
    const headers = new Headers(init.headers)
    assert.equal(headers.has('cookie'), false)
    if (url.origin === 'https://app.aspectlylabs.com') {
      assert.equal(url.pathname, '/mikka/api/version'); assert.equal(headers.has('authorization'), false)
      return Response.json({ build: options.version ?? SHA })
    }
    assert.equal(headers.get('authorization'), 'Bearer fixture-token')
    assert.equal(url.origin, 'https://api.github.com')
    const path = url.href.slice(API.length)
    if (path === '/actions/runs/17') return Response.json({ id: 17, run_attempt: 1, repository, head_repository: repository,
      url: url.href, path: CORE_WORKFLOW, event: 'workflow_run', head_branch: 'main', head_sha: SHA,
      status: 'in_progress', conclusion: null, ...options.driver })
    if (path.startsWith('/issues/')) {
      const number = Number(path.slice(8)); assert.ok(CORE_ISSUES.includes(number))
      return Response.json({ number, url: url.href, repository_url: API,
        state: options.openIssues ? (options.openIssues.includes(number) ? 'open' : 'closed') : options.closed ? 'closed' : 'open', ...options.issue })
    }
    if (path === '/git/ref/heads/main') return Response.json({ ref: 'refs/heads/main', object: { type: 'commit', sha: options.main ?? SHA } })
    if (path === '/actions/runs/51') return Response.json({ ...release, ...options.release })
    if (path === '/actions/runs/51/attempts/2/jobs?per_page=100') return Response.json({ total_count: 1,
      jobs: [{ id: 61, name: 'deploy', run_id: 51, head_sha: SHA, status: 'completed', conclusion: 'success',
        steps: steps.map(name => ({ name, status: 'completed', conclusion: options.skippedStep === name ? 'skipped' : 'success' })) }] })
    assert.fail('Unexpected metadata request')
  }
  return { calls, fetchImpl, prove: (extra = {}) => attestCoreProduction({ env, event, fetchImpl, now, ...extra }) }
}

test('core production accepts only the actual same-repository main Web workflow_run, not a relabelled dispatch', () => {
  assert.equal(coreProductionGuard(env, event).applicationSha, SHA)
  for (const patch of [{ GITHUB_EVENT_NAME: 'workflow_dispatch' }, { GITHUB_REF: 'refs/pull/1/merge' },
    { GITHUB_SHA: 'b'.repeat(40) }, { GITHUB_WORKFLOW_REF: repository.full_name + '/.github/workflows/issue1415-deployed-production.yml@refs/heads/main' },
    { GITHUB_REPOSITORY: 'someone/fork' }, { GITHUB_RUN_ATTEMPT: '0' }])
    assert.throws(() => coreProductionGuard({ ...env, ...patch }, event), /core_configuration/)
  for (const patch of [{ event: 'workflow_dispatch' }, { status: 'in_progress' }, { conclusion: 'failure' },
    { path: '.github/workflows/other.yml' }, { head_repository: { full_name: 'someone/fork' } }, { head_branch: 'topic' }])
    assert.throws(() => coreProductionGuard(env, { ...event, workflow_run: { ...release, ...patch } }), /core_configuration/)
})

test('target proof never accesses owner credentials and requires actual publication, current main and runtime cloud guard', async () => {
  const f = metadata(), guardedEnv = { ...env }
  for (const key of ['SMOKE_OWNER_EMAIL', 'SMOKE_OWNER_PASSWORD', 'VERCEL_TEAM_TOKEN'])
    Object.defineProperty(guardedEnv, key, { get() { return assert.fail('Target proof must not read ' + key) } })
  const proof = await f.prove({ env: guardedEnv })
  assert.equal(proof.status, 'ready'); assert.deepEqual(proof.openIssues, [...CORE_ISSUES])
  assert.equal(proof.webAttempt, 2); assert.equal(proof.webDeployJobId, 61)
  assert.equal(f.calls.filter(url => url.endsWith('/mikka/api/version')).length, 2)
  for (const options of [{ main: 'b'.repeat(40) }, { version: 'b'.repeat(40) },
    { driver: { event: 'workflow_dispatch' } }, { issue: { pull_request: {} } },
    { release: { conclusion: 'failure' } }, ...steps.map(skippedStep => ({ skippedStep }))])
    await assert.rejects(metadata(options).prove(), /core_(target_changed|driver|issue|release)/)
})

test('all related issues closed is an explicit skip before credentials or application requests', async () => {
  const f = metadata({ closed: true }), proof = await f.prove()
  assert.equal(proof.status, 'skipped'); assert.equal(proof.readable, false); assert.equal(proof.code, 'core_issues_closed')
  assert.equal(f.calls.some(url => url.startsWith('https://app.aspectlylabs.com')), false)
})

test('the cleanup regression issue alone keeps exact-revision Core acceptance enabled', async () => {
  const f = metadata({ openIssues: [1826] }), proof = await f.prove()
  assert.equal(proof.status, 'ready')
  assert.deepEqual(proof.openIssues, [1826])
  assert.equal(f.calls.filter(url => url.endsWith('/mikka/api/version')).length, 2)
  await assert.rejects(metadata({ openIssues: [1826], version: 'b'.repeat(40) }).prove(), /core_target_changed/)
})

test('a proof from another driver/attempt, an expired proof or subsequent target drift cannot authorize owner work', async () => {
  const f = metadata(), attestation = await f.prove()
  for (const patch of [{ driverRunId: 99 }, { driverRunAttempt: 2 }, { applicationSha: 'b'.repeat(40) },
    { checkedAt: new Date(now() - 300_001).toISOString() }, { status: 'skipped' }])
    await assert.rejects(assertCoreProductionTarget({ env, event, attestation: { ...attestation, ...patch }, now,
      fetchImpl: () => assert.fail('Invalid proof must fail before requests') }), /core_attestation/)
  await assert.rejects(assertCoreProductionTarget({ env, event, attestation, now,
    fetchImpl: metadata({ main: 'c'.repeat(40) }).fetchImpl }), /core_target_changed/)
})

const ownerId = 'fixture-owner', workspaceId = '30000000-0000-4000-8000-000000000002'
const deviceId = '30000000-0000-4000-8000-000000000003'
const gateway = 'wss://mikka-gateway.aspectlylabs.com'
const protocol = 'mikka-ticket-' + Math.floor((now() + 299_000) / 1000) + '-' + 'a'.repeat(64)
const channel = createHash('sha256').update(JSON.stringify([ownerId, workspaceId])).digest('hex')
const liveTicket = () => ({ url: gateway + '/v1/live/' + channel + '/socket', protocol, expiresAt: now() + 299_000 })
const deviceTicket = () => ({ url: gateway + '/v1/devices/' + deviceId + '/socket', protocol,
  runControl: 'push', computerReviews: 'push', coordinatorResults: 'push' })

test('tickets cannot leave the existing gateway, swap scope or carry arbitrary URL/query credentials', () => {
  const options = { ownerId, workspaceId, now, socketFactory: () => assert.fail('Invalid ticket reached WebSocket') }
  for (const patch of [{ url: 'wss://other.invalid/v1/live/' + channel + '/socket' },
    { url: liveTicket().url + '?token=secret' }, { url: gateway + '/v1/live/' + 'b'.repeat(64) + '/socket' },
    { protocol: 'arbitrary-secret' }, { expiresAt: now() }, { protocol: 'mikka-ticket-1-' + 'a'.repeat(64) }])
    assert.throws(() => coreLiveSocket({ ...liveTicket(), ...patch }, options), /core_ticket/)
  assert.throws(() => coreDeviceSocket(deviceTicket(), { deviceId: workspaceId, now, socketFactory: options.socketFactory }), /core_ticket/)
})

test('real Node WebSockets observe the owner live key and source-device ping/pong, then close both sockets', async t => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(server, 'listening')
  t.after(() => new Promise(resolve => { for (const socket of server.clients) socket.terminate(); server.close(resolve) }))
  const opened = []
  server.on('connection', socket => {
    opened.push(socket)
    socket.send(JSON.stringify(liveReady()))
    socket.on('message', data => { if (data.toString() === 'ping') socket.send('pong') })
  })
  // The production origin/path/protocol were already validated; only this
  // offline test's factory maps the connection to a disposable loopback peer.
  const clients = []
  const socketFactory = (_url, offered) => {
    const client = new WebSocket('ws://127.0.0.1:' + server.address().port, offered)
    clients.push(client); return client
  }
  const live = coreLiveSocket(liveTicket(), { ownerId, workspaceId, now, socketFactory, timeoutMs: 2_000 })
  await live.ready()
  let accepted = false
  const receipt = live.expectDeviceList()().then(() => { accepted = true })
  const foreignFrame = once(clients[0], 'message')
  opened[0].send(JSON.stringify({ kind: 'device_list', id: deviceId }))
  await foreignFrame
  await Promise.resolve()
  assert.equal(accepted, false, 'a different workspace cannot satisfy the live receipt')
  opened[0].send(JSON.stringify({ kind: 'device_list', id: workspaceId }))
  await receipt
  const device = coreDeviceSocket(deviceTicket(), { deviceId, now, socketFactory, timeoutMs: 2_000 })
  await device.ping()
  await device.close(); await live.close()
})

test('ordinary flags preserve cloud UI rollout values without billing mutations or team elevation', async () => {
  const actions = []
  const fixture = (role, cloudComputer) => ({ ownerId, workspaceId, role, applicationSha: SHA,
    owner: async path => {
      assert.equal(path, '/api/desktop/discovery')
      return { status: 200, body: { version: SHA, edition: 'cloud', basePath: '/mikka', desktopProtocol: { min: 0, max: 1 },
        signIn: { google: true, github: true, email: true }, cloud: { connected: false }, mobileReady: true } }
    },
    rpc: async (action, args) => {
      actions.push(action); assert.deepEqual(args, [workspaceId])
      if (action === 'desktop.bootstrap') return { user: { id: ownerId }, cacheWorkspace: { workspaceId, role },
        edition: 'cloud', emailEnabled: true, features: { ...(cloudComputer === undefined ? {} : { cloudComputer }),
          flags: { 'mikka-computer-billing': false, 'mikka-computer-tab-off': false } } }
      assert.equal(action, 'billing.getBilling')
      return { configured: true, live: false, hasCustomer: false, seats: 0, members: 2, purchasedPoints: 0 }
    } })
  const member = await readCoreCapabilities(fixture('member', true))
  assert.equal(member.billing.status, 'not_authorized'); assert.deepEqual(actions, ['desktop.bootstrap'])
  actions.length = 0
  const admin = await readCoreCapabilities(fixture('admin', true))
  assert.equal(admin.billing.status, 'read'); assert.equal(admin.billing.quotaEnforcementExercised, false)
  assert.deepEqual(actions, ['desktop.bootstrap', 'billing.getBilling'])
  assert.equal(admin.flags.cloudComputer, true)

  actions.length = 0
  const hidden = await readCoreCapabilities(fixture('member', false))
  assert.equal(hidden.flags.cloudComputer, false)
  assert.equal(hidden.billing.status, 'not_authorized')
  assert.deepEqual(actions, ['desktop.bootstrap'])

  for (const cloudComputer of [undefined, null, 'false', 0]) {
    actions.length = 0
    await assert.rejects(readCoreCapabilities(fixture('member', cloudComputer)),
      error => error.code === 'core_features' && error.detail === 'flags')
    assert.deepEqual(actions, ['desktop.bootstrap'])
  }
})

test('the dedicated workflow has only the existing narrow OIDC delivery and API/CLI production entry', async () => {
  const text = await readFile(new URL('../../.github/workflows/self-hosted-production.yml', import.meta.url), 'utf8')
  assert.equal((text.match(/identity-id: 2cf9fa19-b9db-4c08-8ca0-b31859f2cbac/g) ?? []).length, 2)
  assert.deepEqual([...text.matchAll(/secret-name: (.+)/g)].map(match => match[1]), ['SMOKE_OWNER_EMAIL', 'SMOKE_OWNER_PASSWORD'])
  assert.ok(text.indexOf('self-hosted-production.mjs --attest') < text.indexOf('uses: Infisical/secrets-action'))
  assert.doesNotMatch(text, /workflow_dispatch:|playwright|chromium|contents: write|secret-path: \/(?:platform|vercel|neon)/)
  assert.match(text, /workflow_run:[\s\S]*workflows: \['Web deploy'\]/)
})
