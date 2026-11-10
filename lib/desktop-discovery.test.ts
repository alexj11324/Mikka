import assert from 'node:assert/strict'
import test from 'node:test'
import { desktopDiscovery, desktopDiscoveryResponse } from './desktop-discovery'
import { UPDATE_REQUIRED } from './desktop-rpc/wire'

const revision = 'a'.repeat(40)
const env = { MIKKA_SERVER_NAME: 'Acme Mikka', MIKKA_BUILD_REVISION: revision, BETTER_AUTH_URL: 'https://self.example.test',
  GITHUB_CLIENT_ID: 'fixture-id', GITHUB_CLIENT_SECRET: 'private-provider-secret' }

test('discovery matches the desktop contract without a login or provider credentials', async () => {
  const request = new Request('https://self.example.test/mikka/api/desktop/discovery', {
    headers: { 'x-mikka-client': 'desktop', 'x-mikka-client-version': '1.2.3', 'x-mikka-desktop-protocol': '1' },
  })
  const response = desktopDiscoveryResponse(request, env)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('location'), null)
  assert.equal(response.headers.get('set-cookie'), null)
  assert.match(response.headers.get('content-type')!, /^application\/json/)
  assert.match(response.headers.get('cache-control')!, /no-store/)
  const text = await response.text()
  assert.ok(Buffer.byteLength(text) < 64 * 1024)
  assert.equal(text.includes(env.GITHUB_CLIENT_SECRET), false)
  assert.deepEqual(JSON.parse(text), {
    name: 'Acme Mikka', version: revision, edition: 'community', basePath: '/mikka', desktopProtocol: { min: 0, max: 1 },
    signIn: { google: false, github: true, apple: false, email: true }, minDesktopVersion: null, cloud: { connected: false }, mobileReady: false,
    web: { enabled: true, protocol: { min: 1, max: 1 } },
  })
})

test('only configured sign-in methods and effective mobile trust are advertised', () => {
  assert.deepEqual(desktopDiscovery({ ...env, GITHUB_CLIENT_SECRET: '' }).signIn, { google: false, github: false, apple: false, email: true })
  assert.deepEqual(desktopDiscovery({ ...env, GOOGLE_CLIENT_ID: 'fixture-google', GOOGLE_CLIENT_SECRET: 'fixture-secret' }).signIn,
    { google: true, github: true, apple: false, email: true })
  assert.equal(desktopDiscovery({ ...env, AUTH_TRUSTED_ORIGINS: 'mikka://' }).mobileReady, true)
  assert.equal(desktopDiscovery({ ...env, MIKKA_EDITION: 'cloud' }).mobileReady, true)
  assert.equal(desktopDiscovery({ ...env, MIKKA_SERVER_NAME: ' '.repeat(10_000) }).name, 'Mikka')
  assert.equal(desktopDiscovery({ ...env, MIKKA_SERVER_NAME: 'x'.repeat(10_000) }).name.length, 120)
})

test('manifest-managed GitHub sign-in can supply its initialized provider status', async () => {
  const response = desktopDiscoveryResponse(new Request('https://self.example.test/mikka/api/desktop/discovery'),
    { ...env, GITHUB_CLIENT_ID: '', GITHUB_CLIENT_SECRET: '' }, { google: false, github: true, apple: false, email: true })
  assert.equal((await response.json()).signIn.github, true)
})

test('version negotiation preserves the fixed update error and still returns server capabilities', async () => {
  const minimum = { ...env, MIN_CLIENT_VERSION: '2.0.0' }
  for (const version of ['1.0.0', 'invalid-client-version']) {
    const response = desktopDiscoveryResponse(new Request('https://self.example.test/mikka/api/desktop/discovery', {
      headers: { 'x-mikka-client': 'desktop', 'x-mikka-client-version': version, 'x-mikka-desktop-protocol': '1' },
    }), minimum)
    assert.equal(response.status, 426)
    const body = await response.json()
    assert.equal(body.error.code, UPDATE_REQUIRED)
    assert.equal(body.minDesktopVersion, '2.0.0')
    assert.deepEqual(body.desktopProtocol, { min: 0, max: 1 })
  }
  const current = desktopDiscoveryResponse(new Request('https://self.example.test/mikka/api/desktop/discovery', {
    headers: { 'x-mikka-client': 'desktop', 'x-mikka-client-version': '2.0.0' },
  }), minimum)
  assert.equal(current.status, 200)
  assert.equal(desktopDiscoveryResponse(new Request('https://self.example.test/mikka/api/desktop/discovery'), minimum).status, 200)
  assert.equal(desktopDiscovery({ ...env, MIN_CLIENT_VERSION: 'latest' }).minDesktopVersion, null)
})
