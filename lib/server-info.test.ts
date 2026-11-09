import assert from 'node:assert/strict'
import test from 'node:test'
import { readServerInfo, serverInfoResponse } from './server-info'

const env = { BETTER_AUTH_URL: 'https://server.example', MIKKA_SERVER_NAME: ' Test Mikka ', MIKKA_BUILD_REVISION: 'a'.repeat(40) }
const request = (init?: RequestInit) => new Request('https://attacker.invalid/mikka/api/server', init)

test('fresh and existing installations use one boolean query without disclosing accounts or server credentials', async () => {
  for (const hasUsers of [false, true]) {
    let queries = 0
    const options = { env: { ...env, SMTP_URL: 'smtps://synthetic-secret@smtp.example:465' }, query: async (sql: string) => {
      queries++; assert.equal(sql, 'SELECT EXISTS (SELECT 1 FROM "user") AS "hasUsers"')
      return { rows: [{ hasUsers, email: 'must-not-escape@example.test', token: 'must-not-escape' }] }
    } }
    const response = await serverInfoResponse(request(), options)
    assert.equal(response.status, 200)
    const body = await response.text(), info = JSON.parse(body)
    assert.equal(queries, 1)
    assert.equal(info.address, 'https://server.example/mikka')
    assert.equal(info.setup.state, hasUsers ? 'ready' : 'required')
    assert.equal(info.setup.signUpUrl, hasUsers ? null : 'https://server.example/mikka/sign-up')
    assert.equal(info.setup.accountRole, 'personal_workspace_admin')
    assert.equal(info.communityUI.enabled, false)
    assert.equal(info.clients.web.enabled, true)
    assert.equal(info.clients.ios.url, null)
    assert.doesNotMatch(body, /synthetic-secret|must-not-escape|attacker/)
    assert.equal(response.headers.get('set-cookie'), null)
    assert.match(response.headers.get('cache-control')!, /no-store/)
  }
})

test('database errors and invalid configuration cannot reopen setup or leak error details', async () => {
  const failed = await serverInfoResponse(request(), { env, query: async () => { throw new Error('postgres://private-password@private-host/customer') } })
  assert.equal(failed.status, 503)
  const body = await failed.text(), info = JSON.parse(body)
  assert.equal(info.status.database, 'unavailable'); assert.equal(info.setup.state, 'unavailable'); assert.equal(info.setup.signUpUrl, null)
  assert.doesNotMatch(body, /private-password|private-host|customer/)
  for (const origin of ['http://remote.example', 'https://user:password@server.example', 'https://server.example/path', 'https://*.example']) {
    let called = false
    const invalid = await readServerInfo({ env: { ...env, BETTER_AUTH_URL: origin }, query: async () => { called = true; return { rows: [] } } })
    assert.equal(called, false); assert.equal(invalid!.address, null); assert.equal(invalid!.setup.state, 'unavailable')
  }
})

test('email delivery and effective OAuth availability are separate from existing account state', async () => {
  const query = async () => ({ rows: [{ hasUsers: false }] })
  const missing = await readServerInfo({ env, query })
  assert.equal(missing!.setup.state, 'required'); assert.equal(missing!.setup.signIn.email, true)
  assert.equal(missing!.setup.emailDeliveryConfigured, false); assert.equal(missing!.setup.signUpUrl, null)
  const managed = await readServerInfo({ env: { ...env, GITHUB_SIGN_IN_USE_APP: 'true' }, query,
    signIn: async () => ({ email: true, google: false, github: true, apple: false }) })
  assert.equal(managed!.setup.signIn.github, true); assert.equal(managed!.setup.signUpUrl, 'https://server.example/mikka/sign-up')
  const failed = await serverInfoResponse(request(), { env, query, signIn: async () => { throw new Error('private-client-secret') } })
  assert.equal(failed.status, 503); assert.doesNotMatch(await failed.text(), /private-client-secret/)
})

test('cloud and wrong methods do no database work; HEAD has no body; compatibility UI and HTTPS state are explicit', async () => {
  const never = async (): Promise<never> => { throw new Error('must-not-read') }
  assert.equal((await serverInfoResponse(request(), { env: { MIKKA_EDITION: 'cloud' }, query: never })).status, 404)
  assert.equal((await serverInfoResponse(request({ method: 'POST' }), { env, query: never })).status, 405)
  const options = { env: { ...env, BETTER_AUTH_URL: 'http://localhost:3000', MIKKA_COMMUNITY_UI: '1', MIKKA_OFFICIAL_WEB_ENABLED: '0' }, query: async () => ({ rows: [{ hasUsers: true }] }) }
  const info = await readServerInfo(options)
  assert.equal(info!.communityUI.enabled, true); assert.equal(info!.clients.web.enabled, false); assert.equal(info!.clients.web.requiresHttps, true); assert.equal(info!.clients.web.serverAddressSupported, false)
  const head = await serverInfoResponse(request({ method: 'HEAD' }), options)
  assert.equal(head.status, 200); assert.equal(await head.text(), '')
})
