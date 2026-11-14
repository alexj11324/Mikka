import assert from 'node:assert/strict'
import test from 'node:test'
import { hostConfiguration, nativeRequest } from '../runtime/config.mjs'

const sourceSha = 'a'.repeat(40), uiSha = 'b'.repeat(40)
function environment() {
  return {
    EVE_SOURCE_SHA: sourceSha, EVE_UI_SHA: uiSha, EVE_RELEASE_ID: 'fixture-1',
    EVE_PUBLIC_ORIGIN: 'https://eve.example.test',
    EVE_ENV_MIKKA_DATABASE_URL: 'postgres://fixture:private-password@127.0.0.1/product_e2e',
    EVE_ENV_BETTER_AUTH_URL: 'https://app.example.test',
    EVE_ENV_MIKKA_DEPLOYMENT_STAGE: 'preview',
    EVE_ENV_BETTER_AUTH_SECRET: 'private-fixture-auth-key-at-least-thirty-two',
  }
}
test('platform credentials and deployment identity remain distinct from customer connections', () => {
  const env = { ...environment(), EVE_ENV_NEW_PROVIDER_CLIENT_SECRET: 'private-platform-fixture',
    SOME_OTHER_BINDING: { fetch() {} }, ANOTHER_SECRET: 'never-deliver' }
  const selected = hostConfiguration(env)
  assert.equal(selected.runtimeEnv.NEW_PROVIDER_CLIENT_SECRET, 'private-platform-fixture')
  assert.equal(selected.runtimeEnv.ANOTHER_SECRET, undefined)
  assert.equal(selected.runtimeEnv.SOME_OTHER_BINDING, undefined)
  assert.equal(selected.runtimeEnv.WORKFLOW_TARGET_WORLD, '@workflow/world-postgres')
  assert.equal(selected.runtimeEnv.MIKKA_HOSTED_MODEL_FALLBACK, 'cloudflare-workers-ai')
  assert.equal(selected.runtimeEnv.MIKKA_EVE_PUBLIC_ORIGIN, 'https://eve.example.test')
  assert.equal(selected.runtimeEnv.BETTER_AUTH_URL, 'https://app.example.test')
})

test('native routing preserves protocol, cookies, body and origin while replacing forged forwarding fields', async () => {
  const original = new Request('https://app.example.test/mikka/api/agents/eve/v1/session/s1?botId=owned-bot', {
    method: 'POST', headers: { cookie: 'owned=fixture', origin: 'https://app.example.test',
      'x-mikka-submission-id': 'owned-operation', 'x-forwarded-host': 'forged.example.test',
      'x-forwarded-proto': 'http' }, body: '{"message":"fixture"}',
  })
  const forwarded = nativeRequest(original)
  assert.equal(forwarded.url, 'https://app.example.test/eve/v1/session/s1?botId=owned-bot')
  assert.equal(forwarded.headers.get('cookie'), 'owned=fixture')
  assert.equal(forwarded.headers.get('origin'), 'https://app.example.test')
  assert.equal(forwarded.headers.get('x-mikka-submission-id'), 'owned-operation')
  assert.equal(forwarded.headers.get('x-forwarded-host'), 'app.example.test')
  assert.equal(forwarded.headers.get('x-forwarded-proto'), 'https')
  assert.equal(await forwarded.text(), '{"message":"fixture"}')
})

test('the ingress forwards request streams without reading them and propagates cancellation', async () => {
  const abort = new AbortController()
  let read = false
  const body = new ReadableStream({ pull(controller) { read = true; controller.close() } }, { highWaterMark: 0 })
  const original = new Request('https://app.example.test/mikka/api/agents/eve/v1/session', {
    method: 'POST', body, duplex: 'half', signal: abort.signal,
  })
  const forwarded = nativeRequest(original)
  assert.equal(read, false)
  abort.abort()
  assert.equal(forwarded.signal.aborted, true)
  await forwarded.body.cancel()
})

test('WebSocket headers and namespaced Workflow callbacks retain their native transport', () => {
  const socket = nativeRequest(new Request('https://app.example.test/mikka/api/agents/eve/v1/session/s1/stream', {
    headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-protocol': 'owned-fixture' },
  }))
  assert.equal(socket.headers.get('upgrade'), 'websocket')
  assert.equal(socket.headers.get('sec-websocket-protocol'), 'owned-fixture')
  const callback = nativeRequest(new Request('https://app.example.test/mikka/api/agents/.well-known/workflow/v1/flow'))
  assert.equal(callback, null)
  assert.equal(new URL(nativeRequest(new Request('https://app.example.test/mikka/api/webhooks/slack')).url).pathname, '/eve/v1/slack')
  for (const path of ['/mikka/api/auth/session', '/.well-known/workflow/v1/flow',
    '/mikka/api/agents/eve/v1/%2fprivate', '/mikka/api/agents/another-service']) {
    assert.equal(nativeRequest(new Request('https://app.example.test' + path)), null)
  }
})
