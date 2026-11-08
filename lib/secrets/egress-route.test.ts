import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import test from 'node:test'
import { CodedError } from '@mikka/protocol/coded-error'
import { issueEgressCapability } from './egress-capability'
import { executeEgressRequest } from './egress-http'
import { taskSecretEgressResponse } from './egress-route'

const env = { WORKSPACE_SECRETS_KEY: randomBytes(32).toString('hex') }
const runId = randomUUID()
const canary = `synthetic-only-${randomBytes(24).toString('hex')}`
const grant = () => issueEgressCapability({ ownerId: 'owner', workspaceId: null, repository: null, runId,
  deviceId: randomUUID(), deviceTokenId: randomUUID(), attempt: 1, name: 'API_KEY', secret: canary,
  http: { origin: 'https://api.example.com', header: 'x-api-key', prefix: '', rules: [{ method: 'POST', path: '/v1/items', match: 'exact' }] },
  leaseExpiresAt: Date.now() + 90_000 }, Date.now(), env)
const body = () => ({ capability: grant().capability, method: 'POST', path: '/v1/items', headers: [['content-type', 'application/json']], bodyBase64: Buffer.from('{"test":true}').toString('base64') })
const request = (value: unknown = body(), headers: Record<string, string> = {}) => new Request(`https://app.example.com/v1/task-secrets/${runId}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(value) })

test('the real egress envelope injects only at the trusted upstream and returns a bounded response', async () => {
  let calls = 0
  const response = await taskSecretEgressResponse(request(), runId, (input, expected, options) => executeEgressRequest(input, expected, { ...options, env,
    resolve: async () => [{ address: '93.184.216.34', family: 4 }],
    transport: async target => {
      calls++
      assert.equal(target.headers['x-api-key'], canary)
      assert.equal(target.url.href, 'https://api.example.com/v1/items')
      assert.equal(target.body.toString(), '{"test":true}')
      return { status: 201, headers: [['content-type', 'application/json']], body: Buffer.from('{"created":true}') }
    },
  }))
  assert.equal(response.status, 200)
  assert.equal(calls, 1)
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  const serialized = await response.text()
  assert.equal(serialized.includes(canary), false)
  const result = JSON.parse(serialized)
  assert.equal(result.status, 201)
  assert.equal(Buffer.from(result.bodyBase64, 'base64').toString(), '{"created":true}')
})

test('the route run id is independent of any caller-controlled envelope field', async () => {
  let reached = false
  const response = await taskSecretEgressResponse(request(), randomUUID(), (input, expected, options) => executeEgressRequest(input, expected, { ...options, env,
    resolve: async () => { reached = true; return [] },
  }))
  assert.equal(response.status, 401)
  assert.deepEqual(await response.json(), { code: 'task_secret_unavailable', detail: 'binding_mismatch' })
  assert.equal(reached, false)
})

test('browser and oversized envelopes never reach authorization or the upstream', async () => {
  const forbidden = async () => { assert.fail('refused request reached egress') }
  const browserHeaders: Array<Record<string, string>> = [{ origin: 'https://evil.example' }, { 'sec-fetch-site': 'same-origin' }]
  for (const headers of browserHeaders) {
    const response = await taskSecretEgressResponse(request(body(), headers), runId, forbidden)
    assert.equal(response.status, 400)
  }
  const announced = await taskSecretEgressResponse(request(body(), { 'content-length': String(2 * 1024 * 1024) }), runId, forbidden)
  assert.equal(announced.status, 413)
  const streamed = await taskSecretEgressResponse(request({ padding: 'x'.repeat(1024 * 1024) }), runId, forbidden)
  assert.equal(streamed.status, 413)
})

test('upstream causes and malformed JSON cannot escape through response diagnostics', async () => {
  const response = await taskSecretEgressResponse(request(), runId, async () => {
    throw new CodedError('task_secret_unavailable', { detail: 'upstream_unavailable', cause: new Error(canary) })
  })
  assert.equal(response.status, 502)
  assert.deepEqual(await response.json(), { code: 'task_secret_unavailable', detail: 'upstream_unavailable' })
  const malformed = await taskSecretEgressResponse(new Request('https://app.example.com', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' + canary }), runId)
  assert.equal(malformed.status, 400)
  assert.equal((await malformed.text()).includes(canary), false)
})
