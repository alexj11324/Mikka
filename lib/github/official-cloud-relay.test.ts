import assert from 'node:assert/strict'
import { test } from 'node:test'
import { officialGitHubRelayEndpoint, relayOfficialGitHubWebhook } from './official-cloud-relay'

const env = { MIKKA_EDITION: 'cloud', MIKKA_CLOUD_BACKEND_URL: 'https://private.example.com' }
const delivery = { event: 'pull_request', deliveryId: 'fixture-delivery', signature: `sha256=${'a'.repeat(64)}`, body: '{"installation":{"id":99},"private":"fixture"}' }

test('only the explicitly configured official deployment has a fixed relay target', () => {
  assert.equal(officialGitHubRelayEndpoint({ MIKKA_EDITION: 'community', MIKKA_CLOUD_BACKEND_URL: env.MIKKA_CLOUD_BACKEND_URL }), null)
  assert.equal(officialGitHubRelayEndpoint({ MIKKA_EDITION: 'cloud' }), null)
  assert.equal(officialGitHubRelayEndpoint(env), 'https://private.example.com/mikka/cloud/v1/github/webhook')
  for (const target of ['http://private.example.com', 'https://user:pass@private.example.com', 'https://private.example.com/path', 'https://private.example.com?next=https://other.example', 'https://private.example.com#fragment', 'https://private.example.com/']) {
    assert.throws(() => officialGitHubRelayEndpoint({ ...env, MIKKA_CLOUD_BACKEND_URL: target }), { code: 'cloud_invalid_request' })
  }
})

test('relay preserves the signed bytes and bounded metadata, forbids redirects and forwards no caller identity', async () => {
  let calls = 0
  await relayOfficialGitHubWebhook(delivery, { env, send: async (url, init) => {
    calls++; assert.equal(String(url), 'https://private.example.com/mikka/cloud/v1/github/webhook')
    assert.equal(init?.redirect, 'error'); assert.equal(init?.credentials, 'omit'); assert.equal(init?.cache, 'no-store')
    assert.equal(init?.body, delivery.body)
    const headers = new Headers(init?.headers)
    assert.deepEqual([...headers.keys()].sort(), ['content-type', 'x-github-delivery', 'x-github-event', 'x-hub-signature-256'])
    assert.equal(headers.get('x-hub-signature-256'), delivery.signature)
    assert.equal(headers.get('x-github-delivery'), delivery.deliveryId)
    return new Response(null, { status: 202 })
  } })
  assert.equal(calls, 1)
})

test('an unconfigured/community relay makes no request; configured errors fail instead of acknowledging a lost event', async () => {
  const unexpected = async () => { throw new Error('must not send') }
  await relayOfficialGitHubWebhook(delivery, { env: { MIKKA_EDITION: 'cloud' }, send: unexpected })
  await relayOfficialGitHubWebhook(delivery, { env: { ...env, MIKKA_EDITION: 'community' }, send: unexpected })
  await assert.rejects(relayOfficialGitHubWebhook(delivery, { env, send: async () => new Response('private provider error', { status: 503 }) }), { code: 'cloud_unavailable' })
  const cause = new Error('fixture transport error')
  await assert.rejects(relayOfficialGitHubWebhook(delivery, { env, send: async () => { throw cause } }), error => error instanceof Error && error.cause === cause)
  await assert.rejects(relayOfficialGitHubWebhook({ ...delivery, deliveryId: 'invalid\nheader' }, { env, send: unexpected }), { code: 'cloud_invalid_request' })
})
