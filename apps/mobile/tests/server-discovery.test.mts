import assert from 'node:assert/strict'
import test from 'node:test'
import { liveSocketUrl, probeMobileServer, serverAddress, serverUrl } from '../lib/server-discovery.ts'

const document = { name: 'Acme Mikka', version: 'a'.repeat(40), edition: 'community', basePath: '/mikka',
  desktopProtocol: { min: 0, max: 1 }, signIn: { google: false, github: false, email: true }, minDesktopVersion: null, mobileReady: true }
const options = (fetch: typeof globalThis.fetch) => ({ fetch, appVersion: '1.0.0' })
const reply = (body: unknown = document, status = 200) => Response.json(body, { status })

test('address rules match desktop HTTPS and exact loopback support', () => {
  for (const [value, expected] of [['self.example.test', 'https://self.example.test'], ['https://self.example.test/mikka/', 'https://self.example.test/mikka'], ['http://localhost:3000/mikka', 'http://localhost:3000/mikka'], ['http://[::1]:3000', 'http://[::1]:3000']]) {
    const address = serverAddress(value)
    assert.ok(address instanceof URL)
    assert.equal(serverUrl(address), expected)
  }
  for (const value of ['', 'https://user:secret@self.example', 'https://*.example', 'https://self.example?token=private', 'https://self.example#link', 'https://self.example/a/../mikka', 'https://self.example/%2e%2e/mikka', 'https://self.example\\evil', 'ftp://self.example']) assert.equal(serverAddress(value), 'invalid_address', value)
  for (const value of ['http://self.example', 'http://192.168.1.4', 'http://localhost.example']) assert.equal(serverAddress(value), 'https_required')
})

test('discovery falls back from a bare origin and never sends session credentials or follows redirects', async () => {
  const calls: string[] = []
  const result = await probeMobileServer('self.example.test', options(async (input, init) => {
    const url = String(input); calls.push(url)
    assert.equal(init?.credentials, 'omit'); assert.equal(init?.redirect, 'error')
    const headers = new Headers(init?.headers)
    assert.equal(headers.has('cookie'), false); assert.equal(headers.has('authorization'), false)
    assert.equal(headers.get('x-mikka-client'), 'mobile'); assert.equal(headers.get('x-mikka-desktop-protocol'), '1')
    return url.includes('/mikka/') ? reply() : new Response('not found', { status: 404 })
  }))
  assert.equal(result.status, 'ok')
  if (result.status === 'ok') assert.deepEqual(result.server, { url: 'https://self.example.test/mikka', name: document.name,
    version: document.version, edition: 'community', signIn: { ...document.signIn, apple: false }, mobileReady: true })
  assert.deepEqual(calls, ['https://self.example.test/api/desktop/discovery', 'https://self.example.test/mikka/api/desktop/discovery'])
})

test('discovery reports mobile trust, server and app incompatibility using fixed outcomes', async () => {
  for (const [patch, status] of [
    [{ mobileReady: false }, 'mobile_not_ready'], [{ mobileReady: undefined }, 'mobile_not_ready'],
    [{ desktopProtocol: { min: 0, max: 0 } }, 'server_update_required'],
    [{ desktopProtocol: { min: 2, max: 2 } }, 'app_update_required'],
    [{ minDesktopVersion: '2.0.0' }, 'app_update_required'], [{ minDesktopVersion: 'garbage' }, 'not_mikka'],
    [{ basePath: '//attacker.test' }, 'not_mikka'], [{ basePath: '/mikka/../outside' }, 'not_mikka'],
  ] as const) {
    const result = await probeMobileServer('https://self.example/mikka', options(async () => reply({ ...document, ...patch })))
    assert.equal(result.status, status)
  }
  const upgrade = await probeMobileServer('self.example', options(async () => reply({ minDesktopVersion: '3.0.0', error: { code: 'desktop_client_update_required' } }, 426)))
  assert.deepEqual(upgrade, { status: 'app_update_required', minimum: '3.0.0' })
})

test('legacy Mikka, unavailable hosts, malformed JSON and oversized answers are distinct', async () => {
  assert.equal((await probeMobileServer('self.example', options(async () => { throw new TypeError('unreachable') }))).status, 'unreachable')
  assert.equal((await probeMobileServer('self.example', options(async () => new Response('<html>site</html>')))).status, 'not_mikka')
  assert.equal((await probeMobileServer('self.example', options(async () => reply({ ...document, extra: '大'.repeat(24_000) })))).status, 'not_mikka')
  assert.equal((await probeMobileServer('self.example', options(async () => new Response(null, { status: 302, headers: { location: 'https://other.example' } })))).status, 'not_mikka')
  const old = await probeMobileServer('self.example', options(async input => String(input).endsWith('/api/version') ? reply({ build: 'revision', minDesktopVersion: null }) : new Response('', { status: 404 })))
  assert.deepEqual(old, { status: 'server_update_required', version: null })
})

test('cancelled discovery does not make another candidate request', async () => {
  const controller = new AbortController()
  let calls = 0
  const result = await probeMobileServer('self.example', { ...options(async () => { calls++; controller.abort(); throw Error('cancelled') }), signal: controller.signal })
  assert.equal(result.status, 'unreachable'); assert.equal(calls, 1)
})

test('server-selected WebSockets require TLS except exact local loopback', () => {
  for (const url of ['wss://self.example/mikka/v1/live/channel/socket', 'wss://own-worker.example/v1/live/channel/socket', 'ws://localhost:3000/mikka/v1/live/channel/socket', 'ws://[::1]:3000/v1/live/channel/socket']) assert.equal(liveSocketUrl(url), true)
  for (const url of ['ws://self.example/v1/live/channel/socket', 'ws://192.168.1.5/socket', 'https://self.example/socket', 'wss://user:password@self.example/socket', 'wss://self.example/socket?token=secret']) assert.equal(liveSocketUrl(url), false)
})


test('Apple sign-in requires an explicit boolean in discovery', async () => {
  for (const apple of [true, false, undefined, 'true']) {
    const result = await probeMobileServer('self.example/mikka', options(async () => reply({ ...document, signIn: { ...document.signIn, apple } })))
    assert.equal(result.status, 'ok')
    if (result.status === 'ok') assert.equal(result.server.signIn.apple, apple === true)
  }
})

test('a typed installation path cannot select another installation on the same origin', async () => {
  const base = 'https://self.example/team-a'
  const check = (basePath: string) => probeMobileServer(base, options(async () => reply({ ...document, basePath })))
  assert.deepEqual(await check('/team-b'), { status: 'not_mikka' })
  const correct = await check('/team-a')
  assert.equal(correct.status, 'ok')
  if (correct.status === 'ok') assert.equal(correct.server.url, base)
})

test('legacy discovery uses only reachable candidates after checking both modern paths', async () => {
  const calls: string[] = []
  const result = await probeMobileServer('self.example.test', options(async input => {
    const path = new URL(String(input)).pathname
    calls.push(path)
    if (path === '/api/desktop/discovery') throw new TypeError('unreachable')
    if (path === '/mikka/api/version') return reply({ build: 'legacy', minDesktopVersion: null })
    return new Response(null, { status: 404 })
  }))
  assert.deepEqual(result, { status: 'server_update_required', version: null })
  assert.deepEqual(calls, ['/api/desktop/discovery', '/mikka/api/desktop/discovery', '/mikka/api/version'])
})

test('a slow legacy root cannot exhaust the discovery deadline before a working installation', async () => {
  const result = await probeMobileServer('self.example.test', {
    ...options(async (input, init) => {
      const path = new URL(String(input)).pathname
      if (path === '/api/desktop/discovery') return new Response(null, { status: 404 })
      if (path === '/mikka/api/desktop/discovery') return reply()
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('deadline')), { once: true })
      })
    }),
    timeoutMs: 100,
  })
  assert.equal(result.status, 'ok')
})
