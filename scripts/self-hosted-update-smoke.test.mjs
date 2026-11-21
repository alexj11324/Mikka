import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import test from 'node:test'
import { healthTarget, localResponse, upgradedSmoke } from './self-hosted-update-smoke.mjs'

const revision = 'f'.repeat(40)
const env = { BETTER_AUTH_URL: 'https://self.example.invalid', MIKKA_EXPECTED_REVISION: revision }

test('upgrade acceptance checks real revision, community protocol and database but never assumes localhost origin', async () => {
  const observed = []
  const serve = path => {
    observed.push(path)
    if (path === '/mikka/api/version') return { status: 200, body: JSON.stringify({ build: revision }) }
    if (path === '/mikka/api/desktop/discovery') return { status: 200, body: JSON.stringify({ version: revision, edition: 'community' }) }
    if (path === '/mikka/api/server') return { status: 200, body: JSON.stringify({ version: revision, status: { database: 'ready' } }) }
    if (path === '/mikka/sign-in') return { status: 200, body: '<html></html>' }
    return { status: 404, body: '' }
  }
  assert.deepEqual(await upgradedSmoke(env, serve), { status: 'passed', revision, database: 'ready', desktop: true, signIn: true })
  assert.deepEqual(observed, ['/mikka/api/version', '/mikka/api/desktop/discovery', '/mikka/api/server', '/mikka/sign-in'])
  for (const bad of [
    { path: '/mikka/api/version', response: { status: 500, body: '' } },
    { path: '/mikka/api/version', response: { status: 200, body: JSON.stringify({ build: 'a'.repeat(40) }) } },
    { path: '/mikka/api/desktop/discovery', response: { status: 200, body: JSON.stringify({ version: revision, edition: 'cloud' }) } },
    { path: '/mikka/api/server', response: { status: 200, body: JSON.stringify({ version: revision, status: { database: 'down' } }) } },
    { path: '/mikka/sign-in', response: { status: 200, body: 'not html' } }
  ]) {
    await assert.rejects(upgradedSmoke(env, p => p === bad.path ? bad.response : serve(p)))
  }
  await assert.rejects(upgradedSmoke({ BETTER_AUTH_URL: 'https://self.example.invalid' }, serve), /SMOKE_EXPECTED_REVISION_REQUIRED/)
})

test('loopback transport preserves configured Host header for custom HTTPS origin', async () => {
  const server = createServer((req, res) => {
    assert.equal(req.headers.host, 'self.example.invalid')
    assert.equal(req.url, '/mikka/api/version')
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ build: revision }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const port = server.address().port
    const requestEnv = { ...env, PORT: String(port) }
    assert.deepEqual(healthTarget(requestEnv), { host: 'self.example.invalid', port })
    const response = await localResponse('/mikka/api/version', requestEnv)
    assert.equal(response.status, 200)
    assert.equal(JSON.parse(response.body).build, revision)
  } finally { server.closeAllConnections(); server.close(); await once(server, 'close') }
})

test('loopback transport refuses invalid public origin and invalid socket target', () => {
  for (const bad of [
    'https://user:pass@self.example.invalid', 'https://self.example.invalid/mikka',
    'https://self.example.invalid?redirect=1', 'javascript:alert(1)'
  ]) assert.throws(() => healthTarget({ BETTER_AUTH_URL: bad }), /SMOKE_ORIGIN_INVALID/)
  for (const port of ['0', '65536', 'not-a-port']) {
    assert.throws(() => healthTarget({ ...env, PORT: port }), /SMOKE_PORT_INVALID/)
  }
})
