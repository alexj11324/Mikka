import assert from 'node:assert/strict'
import test from 'node:test'
import { TARGET } from './subscription-inventory.mjs'
import { projectGitHub, runRuntimeCapabilities } from './runtime-capabilities.mjs'

const email = 'capability+mikka-smoke@example.test', password = 'offline-password-123456', cookie = 'offline-cookie-123456'
const owner = 'normal-owner-id'
const env = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'alexj11324/Mikka', GITHUB_REF: 'refs/heads/acceptance/proactive-1157-1163', GITHUB_EVENT_NAME: 'push', SMOKE_OWNER_EMAIL: email, SMOKE_OWNER_PASSWORD: password }
const verifySource = async () => ({ revision: TARGET.revision, isSmokeAccountEmail: value => value === email })
const github = () => ({ viewerId: owner, configured: true, connected: true, installed: true, login: 'private login', repositories: [
  { id: '101', fullName: 'public-owner/acceptance', htmlUrl: 'https://github.com/public-owner/acceptance', private: false },
  { id: '102', fullName: 'private-owner/private-repo', htmlUrl: 'https://github.com/private-owner/private-repo', private: true },
] })
function harness({ driftBefore = false, driftAfter = false, foreign = false, failGithub = false, failLogout = false } = {}) {
  const calls = []; let versions = 0
  const fetchImpl = async (input, init) => {
    const url = new URL(input); assert.equal(url.origin, 'https://app.aspectlylabs.com'); assert.equal(init.redirect, 'error')
    calls.push({ path: url.pathname, method: init.method })
    if (url.pathname === '/mikka/api/version') return Response.json({ build: (versions++ === 0 ? driftBefore : driftAfter) ? 'dpl_Changed' : TARGET.deployment })
    if (url.pathname === '/mikka/api/auth/sign-in/email') {
      assert.deepEqual(JSON.parse(init.body), { email, password })
      return Response.json({}, { headers: { 'set-cookie': `better-auth.session_token=${cookie}; Path=/; Secure; HttpOnly` } })
    }
    assert.ok(init.headers.cookie.includes(cookie))
    if (url.pathname === '/mikka/api/auth/get-session') return Response.json({ user: { id: owner, email }, session: { userId: owner, token: 'offline-token-123456' } })
    if (url.pathname === '/mikka/api/integrations/github') {
      if (failGithub) throw Error(password)
      return Response.json({ ...github(), viewerId: foreign ? 'other-owner' : owner })
    }
    if (url.pathname === '/mikka/api/integrations/github/permissions') return Response.json({ viewerId: owner, push: 'ask', pullRequest: 'allow', version: '1:2', body: password })
    if (url.pathname === '/mikka/api/mobile/threads') return Response.json({ threads: [{ title: 'private task', prompt: password }], devices: [{ id: '00000000-0000-4000-8000-000000000001', name: 'private laptop', kind: 'laptop', online: true }] })
    if (url.pathname === '/mikka/api/auth/sign-out') return Response.json({ success: !failLogout })
    throw Error('unexpected path')
  }
  return { calls, fetchImpl }
}
const run = (fixture, overrides = {}) => runRuntimeCapabilities({ env, verifySource, fetchImpl: fixture.fetchImpl, ...overrides })

test('execution/source/account and deployment guards precede login', async () => {
  for (const changed of [{ GITHUB_REF: 'refs/heads/main' }, { GITHUB_EVENT_NAME: 'workflow_dispatch' }, { SMOKE_OWNER_PASSWORD: '' }]) {
    const fixture = harness(); await assert.rejects(run(fixture, { env: { ...env, ...changed } })); assert.equal(fixture.calls.length, 0)
  }
  const wrongSource = harness(); await assert.rejects(run(wrongSource, { verifySource: async () => ({ ...(await verifySource()), revision: '0'.repeat(40) }) })); assert.equal(wrongSource.calls.length, 0)
  const fixture = harness({ driftBefore: true }); const result = await run(fixture)
  assert.equal(result.status, 'failed'); assert.equal(fixture.calls.length, 1); assert.equal(fixture.calls[0].method, 'GET')
})

test('success performs exactly six GETs and only authentication POSTs with safe projections', async () => {
  const fixture = harness(); const result = await run(fixture)
  assert.equal(result.status, 'passed'); assert.equal(result.getRequests, 6)
  assert.deepEqual(fixture.calls.filter(call => call.method !== 'GET').map(call => call.path), ['/mikka/api/auth/sign-in/email', '/mikka/api/auth/sign-out'])
  assert.deepEqual(fixture.calls.filter(call => call.path.includes('/integrations/') || call.path.includes('/mobile/')).map(call => call.path), ['/mikka/api/integrations/github', '/mikka/api/integrations/github/permissions', '/mikka/api/mobile/threads'])
  assert.equal(result.github.repositories[0].publicUrl, 'https://github.com/public-owner/acceptance')
  assert.equal(result.github.repositories[1].publicUrl, undefined)
  assert.match(result.github.repositories[1].repositoryHash, /^[a-f0-9]{64}$/)
  assert.equal(result.permissions.legacyStoredPermissionsOnly, true)
  assert.equal(result.github.writePermissionVerified, false)
  assert.equal(result.devices.registrationOrHarnessReadinessVerified, false)
  assert.equal(result.authentication.sessionEnded, true)
  for (const forbidden of [email, password, cookie, 'private-owner', 'private-repo', 'private login', 'private laptop', 'private task', 'offline-token', 'threads', 'prompt']) assert.equal(JSON.stringify(result).includes(forbidden), false)
})

test('foreign owner or unknown request outcome fails without retry and still signs out', async () => {
  for (const config of [{ foreign: true }, { failGithub: true }]) {
    const fixture = harness(config); const result = await run(fixture)
    assert.equal(result.status, 'failed'); assert.equal(result.authentication.sessionEnded, true)
    assert.equal(fixture.calls.filter(call => call.path === '/mikka/api/integrations/github').length, 1)
    assert.equal(result.versionAfter, TARGET.deployment)
    assert.equal(JSON.stringify(result).includes(password), false)
  }
  assert.throws(() => projectGitHub({ ...github(), repositories: [{ ...github().repositories[0], htmlUrl: 'https://evil.example.test' }] }, owner))
})

test('final deployment drift or unconfirmed sign-out cannot report success', async () => {
  for (const config of [{ driftAfter: true }, { failLogout: true }]) {
    const result = await run(harness(config)); assert.equal(result.status, 'failed')
    assert.ok(result.errors.includes(config.driftAfter ? 'capability_deployment' : 'capability_logout'))
  }
})
