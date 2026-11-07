import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { cloudEndpoint, cloudServiceUrl, selfHostedAddress } from './config'
import { CloudServiceError } from './errors'
import { cloudHandlers } from './http'
import type { CloudClientStore } from './store'
import { cloudJson, parseCloudToken, readCloudJson } from './transport'

test('configured service and callback preserve the exact authority and mount', () => {
  assert.equal(cloudServiceUrl(), 'https://app.aspectlylabs.com/mikka/cloud')
  assert.deepEqual(selfHostedAddress({ BETTER_AUTH_URL: 'https://self.example', MIKKA_BASE_PATH: '/mikka' }), { origin: 'https://self.example', basePath: '/mikka', redirectUri: 'https://self.example/mikka/api/cloud/callback' })
  for (const address of ['https://user:password@self.example', 'https://self.example/mikka', 'http://not-loopback.example', 'https://self.example?next=elsewhere', 'data:text/plain,hello']) assert.throws(() => selfHostedAddress({ BETTER_AUTH_URL: address }), { code: 'cloud_invalid_request' })
  for (const path of ['//attacker.example/token', '/v1/../token', 'https://attacker.example', '/v1/%2e%2e']) assert.throws(() => cloudEndpoint('https://cloud.example', path))
  assert.equal(cloudEndpoint('https://cloud.example/mikka/cloud', '/oauth/token'), 'https://cloud.example/mikka/cloud/oauth/token')
})

test('real HTTP token exchange is form-encoded and rejects redirects, unbounded bodies and malformed grants', async t => {
  const seen: { path: string; contentType: string | undefined; body: string }[] = []
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk))
    seen.push({ path: request.url!, contentType: request.headers['content-type'], body: Buffer.concat(chunks).toString() })
    if (request.url!.endsWith('/redirect')) { response.writeHead(302, { location: '/should-not-follow' }); response.end(); return }
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ ok: true }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections() }))
  const address = server.address() as { port: number }, origin = `http://127.0.0.1:${address.port}`
  assert.deepEqual(await cloudJson(origin, '/oauth/token', new URLSearchParams({ grant_type: 'refresh_token', refresh_token: 'synthetic-opaque-value' })), { ok: true })
  assert.equal(seen[0].contentType, 'application/x-www-form-urlencoded')
  assert.equal(new URLSearchParams(seen[0].body).get('refresh_token'), 'synthetic-opaque-value')
  await assert.rejects(cloudJson(origin, '/redirect', {}), { code: 'cloud_unavailable', detail: 'network' })
  assert.equal(seen.some(item => item.path === '/should-not-follow'), false)
  await assert.rejects(readCloudJson(new Response('x'.repeat(65 * 1024))), { code: 'cloud_unavailable' })
  await assert.rejects(readCloudJson(Response.json({ code: 'cloud_server_revoked', error: 'invalid_token' }, { status: 401 })), { code: 'cloud_server_revoked' })
  const response = { access_token: 'a'.repeat(128), token_type: 'Bearer', expires_in: 3600, scope: 'github models', server_id: 'server', workspace_id: 'workspace', subject: 'user:person', grant_type: 'user', refresh_token: 'r'.repeat(43) }
  assert.equal(parseCloudToken(response, 'server', 1000).expiresAt, 3_601_000)
  for (const invalid of [{ ...response, server_id: 'other' }, { ...response, expires_in: 7200 }, { ...response, scope: 'github root' }, { ...response, refresh_token: undefined }]) assert.throws(() => parseCloudToken(invalid, 'server'), { code: 'cloud_unavailable' })
})

test('HTTP controls bind to fresh local identity and reject cross-site and non-admin writes before client access', async () => {
  const calls: unknown[][] = []
  let viewer: { user: { id: string }; session: { id: string } } | null = { user: { id: 'member' }, session: { id: 'session-A' } }
  const client = {
    beginBinding: async (...args: unknown[]) => { calls.push(args); return { url: 'https://cloud.example/authorize' } },
    completeBinding: async (...args: unknown[]) => { calls.push(args) },
    register: async (...args: unknown[]) => { calls.push(args) },
    view: async () => ({ registered: true }),
  } as unknown as CloudClientStore
  const handlers = cloudHandlers({ client, session: async () => viewer, administrator: userId => userId === 'admin', community: () => true, env: { BETTER_AUTH_URL: 'https://self.example' }, changed: async () => {} })
  const request = (body: unknown, origin = 'https://self.example') => new Request('https://self.example/mikka/api/cloud/connect', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  assert.equal((await handlers.connect(request({ action: 'register', name: 'Test' }))).status, 403)
  assert.equal((await handlers.connect(request({ action: 'bind', scopes: ['github'] }, 'https://attacker.example'))).status, 403)
  assert.equal((await handlers.connect(request({ action: 'bind', scopes: ['computer'] }))).status, 400)
  assert.equal(calls.length, 0)
  assert.equal((await handlers.connect(request({ action: 'bind', scopes: ['github', 'models'] }))).status, 200)
  assert.deepEqual(calls[0], ['member', 'session-A', ['github', 'models']])
  viewer = null
  assert.equal((await handlers.callback(new Request('https://self.example/mikka/api/cloud/callback?state=x&code=y'))).status, 401)
  assert.equal(calls.length, 1)
  viewer = { user: { id: 'admin' }, session: { id: 'session-B' } }
  assert.equal((await handlers.connect(request({ action: 'register', name: 'Test' }))).status, 200)
  assert.deepEqual(calls[1], ['Test'])
})

test('provider errors retain causes without exposing upstream response text', async () => {
  const cause = new Error('secret-bearing provider failure')
  await assert.rejects(cloudJson('https://cloud.example', '/oauth/token', {}, async () => { throw cause }), (error: unknown) => {
    assert.ok(error instanceof CloudServiceError); assert.equal(error.cause, cause); assert.ok(!error.message.includes('secret-bearing')); return true
  })
})
