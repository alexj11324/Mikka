import assert from 'node:assert/strict'
import test from 'node:test'
import { probeWebServer } from './discovery'

const document = { name: 'Self hosted', version: 'v1', edition: 'community', basePath: '/mikka', signIn: { email: true, google: false, github: false }, web: { enabled: true, protocol: { min: 1, max: 1 } } }
test('discovery uses one origin, no credentials or redirects and the declared base path', async () => {
  const calls: string[] = []
  const result = await probeWebServer('self.test', { fetch: async (input, init) => {
    calls.push(String(input)); assert.equal(init?.credentials, 'omit'); assert.equal(init?.redirect, 'error'); assert.equal(new Headers(init?.headers).has('authorization'), false)
    return String(input).includes('/mikka/') ? Response.json(document) : new Response('', { status: 404 })
  } })
  assert.equal(result.status, 'ok'); if (result.status === 'ok') assert.equal(result.server.url, 'https://self.test/mikka')
  assert.ok(calls.every(url => new URL(url).origin === 'https://self.test'))
})
test('all documented discovery failures are distinct', async () => {
  const cases = [
    ['https://*.test', 'invalid_address', document], ['http://localhost:3000', 'https_required', document],
    ['https://self.test', 'not_mikka', {}], ['https://self.test', 'server_update_required', { ...document, web: undefined }],
    ['https://self.test', 'server_update_required', { ...document, web: { enabled: true, protocol: { min: 0, max: 0 } } }],
    ['https://self.test', 'app_update_required', { ...document, web: { enabled: true, protocol: { min: 2, max: 2 } } }],
    ['https://self.test', 'web_disabled', { ...document, web: { ...document.web, enabled: false } }],
  ] as const
  for (const [input, status, data] of cases) assert.equal((await probeWebServer(input, { fetch: async () => Response.json(data) })).status, status)
  assert.equal((await probeWebServer('https://self.test', { fetch: async () => { throw new TypeError('unreachable') } })).status, 'unreachable')
  assert.equal((await probeWebServer('https://self.test', { fetch: async input => String(input).endsWith('/version') ? Response.json({ build: 'old', minDesktopVersion: null }) : new Response('', { status: 404 }) })).status, 'server_update_required')
})
test('discovery cannot select another origin, dot path, non-JSON or unbounded body', async () => {
  for (const basePath of ['//evil.test', '/a/../mikka', '/%2e%2e/mikka', '/mikka?redirect=evil']) assert.notEqual((await probeWebServer('https://self.test', { fetch: async () => Response.json({ ...document, basePath }) })).status, 'ok')
  assert.equal((await probeWebServer('https://self.test', { fetch: async () => new Response('x'.repeat(70_000), { headers: { 'content-type': 'application/json' } }) })).status, 'not_mikka')
})

test('an explicit installation path must match the discovered installation before login', async () => {
  const fetch = async () => Response.json(document)
  assert.equal((await probeWebServer('https://self.test/other', { fetch })).status, 'not_mikka')
  assert.equal((await probeWebServer('https://self.test/mikka/', { fetch })).status, 'ok')
})
