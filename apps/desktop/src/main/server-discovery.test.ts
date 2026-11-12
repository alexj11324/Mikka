import test from 'node:test'
import assert from 'node:assert/strict'
import { canonicalServerUrl, parseDiscovery, probeServer, serverAddress } from './server-discovery'

const discovery = { name: 'Acme Mikka', version: '2026.11.6', edition: 'community', basePath: '/mikka', desktopProtocol: { min: 0, max: 1 }, signIn: { google: false, github: true, email: true } }
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
const options = (routes: Record<string, () => Response | Promise<Response>>, seen: string[] = []) => ({
  appVersion: '2026.10000.50', enforceMinimum: true,
  fetch: async (url: string, init: RequestInit) => {
    seen.push(url)
    assert.equal(init.redirect, 'manual')
    assert.equal(init.credentials, 'omit')
    assert.equal(new Headers(init.headers).get('authorization'), null)
    const route = routes[url]
    if (!route) return new Response('<html>not found</html>', { status: 404, headers: { 'content-type': 'text/html' } })
    return route()
  },
})

test('typed addresses become one canonical HTTPS base; plain HTTP only on this computer', () => {
  assert.equal(String(serverAddress('mikka.example.com')), 'https://mikka.example.com/')
  assert.equal(String(serverAddress(' https://mikka.example.com/mikka/ ')), 'https://mikka.example.com/mikka')
  assert.equal(String(serverAddress('http://127.0.0.1:3100/mikka')), 'http://127.0.0.1:3100/mikka')
  assert.equal(serverAddress('http://mikka.example.com'), 'https_required')
  for (const bad of ['', 'ftp://mikka.example.com', 'https://someone@mikka.example.com', 'https://mikka.example.com/?a=1', 'https://mikka.example.com/#x', 'mikka example', 42]) assert.equal(serverAddress(bad), 'invalid_address', String(bad))
  assert.equal(canonicalServerUrl('https://Mikka.Example.com:443/mikka/'), 'https://mikka.example.com/mikka')
})

test('discovery needs a name, version, edition, base path, protocol range and sign-in methods', () => {
  assert.deepEqual(parseDiscovery(discovery)?.protocol, [0, 1])
  assert.deepEqual(parseDiscovery({ ...discovery, desktopProtocol: [1, 0], signIn: ['email'] })?.signIn, { google: false, github: false, email: true })
  for (const broken of [null, [], { ...discovery, name: '' }, { ...discovery, edition: 'other' }, { ...discovery, basePath: '/../x' }, { ...discovery, desktopProtocol: { min: 2, max: 1 } }, { ...discovery, signIn: undefined }]) assert.equal(parseDiscovery(broken), null)
})

test('a bare host finds the server under /mikka and keeps exactly the origin that answered', async () => {
  const seen: string[] = []
  const result = await probeServer('mikka.example.com', options({ 'https://mikka.example.com/mikka/api/desktop/discovery': () => json(discovery) }, seen))
  assert.deepEqual(result, { status: 'ok', server: { url: 'https://mikka.example.com/mikka', name: 'Acme Mikka', version: '2026.11.6', edition: 'community', signIn: { google: false, github: true, email: true } } })
  assert.deepEqual(seen.filter(url => url.endsWith('/discovery')), ['https://mikka.example.com/api/desktop/discovery', 'https://mikka.example.com/mikka/api/desktop/discovery'])
})

test('unreachable, not Mikka and a redirect stay distinct; a redirect is never followed', async () => {
  assert.deepEqual(await probeServer('https://down.example', { ...options({}), fetch: async () => { throw new TypeError('fetch failed') } }), { status: 'unreachable' })
  assert.deepEqual(await probeServer('https://blog.example', options({})), { status: 'not_mikka' })
  assert.deepEqual(await probeServer('https://moved.example/mikka', options({ 'https://moved.example/mikka/api/desktop/discovery': () => new Response(null, { status: 302, headers: { location: 'https://evil.example/mikka/api/desktop/discovery' } }) })), { status: 'not_mikka' })
  assert.deepEqual(await probeServer('http://mikka.example.com', options({})), { status: 'https_required' })
})

test('version answers: server too old, app too old, and an older Mikka without discovery', async () => {
  const base = 'https://self.example/mikka'
  assert.deepEqual(await probeServer(base, options({ [`${base}/api/desktop/discovery`]: () => json({ ...discovery, desktopProtocol: { min: 0, max: 0 } }) })), { status: 'server_update_required', version: '2026.11.6' })
  assert.deepEqual(await probeServer(base, options({ [`${base}/api/desktop/discovery`]: () => json({ ...discovery, desktopProtocol: { min: 2, max: 2 }, minDesktopVersion: '2026.10000.90' }) })), { status: 'app_update_required', minimum: '2026.10000.90' })
  assert.deepEqual(await probeServer(base, options({ [`${base}/api/desktop/discovery`]: () => json({ ...discovery, minDesktopVersion: '2026.10000.90' }) })), { status: 'app_update_required', minimum: '2026.10000.90' })
  assert.deepEqual(await probeServer(base, options({ [`${base}/api/desktop/discovery`]: () => json({ version: 1, ok: false, error: { code: 'desktop_client_update_required' } }, 426) })), { status: 'app_update_required', minimum: null })
  assert.deepEqual(await probeServer(base, options({ [`${base}/api/version`]: () => json({ build: 'abc1234', minDesktopVersion: null }) })), { status: 'server_update_required', version: null })
})

test('a typed installation path cannot select another installation on the same origin', async () => {
  const base = 'https://self.example/team-a'
  const check = (basePath: string) => probeServer(base, options({
    [base + '/api/desktop/discovery']: () => json({ ...discovery, basePath }),
  }))
  assert.deepEqual(await check('/team-b'), { status: 'not_mikka' })
  const correct = await check('/team-a')
  assert.equal(correct.status, 'ok')
  if (correct.status === 'ok') assert.equal(correct.server.url, base)
})
