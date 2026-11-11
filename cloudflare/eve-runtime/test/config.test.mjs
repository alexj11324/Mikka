import assert from 'node:assert/strict'
import test from 'node:test'
import { hostConfiguration, nativeRequest, validateHostBuild } from '../runtime/config.mjs'

const sourceSha = 'a'.repeat(40), uiSha = 'b'.repeat(40)
function environment() {
  return {
    EVE_SOURCE_SHA: sourceSha, EVE_UI_SHA: uiSha, EVE_RELEASE_ID: 'fixture-1',
    EVE_HOST_POLICY: 'shared-warm', EVE_PUBLIC_ORIGIN: 'https://eve.example.test',
    EVE_HOST_WARM_UNTIL: new Date(Date.now() + 60_000).toISOString(),
    WORLD_QUEUE_PUBLIC_KEY: Buffer.alloc(32, 2).toString('base64'), WORLD_SERVICE: { fetch() {} },
    EVE_ENV_MIKKA_DATABASE_URL: 'postgres://fixture:private-password@127.0.0.1/product_e2e',
    EVE_ENV_BETTER_AUTH_URL: 'https://app.example.test',
    EVE_ENV_MIKKA_DEPLOYMENT_STAGE: 'preview',
    EVE_ENV_BETTER_AUTH_SECRET: 'private-fixture-auth-key-at-least-thirty-two',
  }
}
const build = { version: 1, eve: '1.0.0-rc.9', revision: sourceSha, preset: 'node-server',
  world: '@mikka/eve-cloudflare-world', worldVersion: '5.1.0' }
const host = { version: 1, releaseId: 'fixture-1', sourceSha, uiSha }

test('platform credentials and deployment identity remain distinct from customer connections', () => {
  const env = { ...environment(), EVE_ENV_NEW_PROVIDER_CLIENT_SECRET: 'private-platform-fixture',
    SOME_OTHER_BINDING: { fetch() {} }, ANOTHER_SECRET: 'never-deliver' }
  const selected = hostConfiguration(env)
  assert.equal(selected.runtimeEnv.NEW_PROVIDER_CLIENT_SECRET, 'private-platform-fixture')
  assert.equal(selected.runtimeEnv.ANOTHER_SECRET, undefined)
  assert.equal(selected.runtimeEnv.SOME_OTHER_BINDING, undefined)
  assert.equal(selected.runtimeEnv.MIKKA_EVE_WORKFLOW_WORLD, 'cloudflare')
  assert.equal(selected.runtimeEnv.MIKKA_HOSTED_MODEL_FALLBACK, 'cloudflare-workers-ai')
  assert.equal(selected.runtimeEnv.MIKKA_EVE_PUBLIC_ORIGIN, 'https://eve.example.test')
  assert.equal(selected.runtimeEnv.BETTER_AUTH_URL, 'https://app.example.test')
  assert.deepEqual(validateHostBuild(build, host, selected.runtimeEnv), host)
})

test('missing durable storage, unsafe origins or incompatible hosting fail without disclosing values', () => {
  for (const change of [
    { EVE_ENV_MIKKA_HOSTED_MODEL_FALLBACK: 'vercel-gateway' },
    { EVE_ENV_VERCEL_OIDC_TOKEN: 'unusable-fixture' }, { EVE_ENV_AI_GATEWAY_API_KEY: 'unusable-fixture' },
    { WORLD_QUEUE_PUBLIC_KEY: '' }, { WORLD_SERVICE: undefined },
    { EVE_PUBLIC_ORIGIN: 'https://private-password@eve.example.test' },
    { EVE_PUBLIC_ORIGIN: 'https://eve.example.test/another-path' },
    { EVE_ENV_BETTER_AUTH_URL: 'http://app.example.test' }, { EVE_ENV_BETTER_AUTH_SECRET: 'short' },
    { EVE_SOURCE_SHA: 'moving-main' }, { EVE_HOST_POLICY: 'idle-sleep' },
    { EVE_ENV_VERCEL: '1' }, { EVE_ENV_MIKKA_EVE_ORIGIN: 'https://legacy.example.test' },
    { EVE_ENV_WORKFLOW_TARGET_WORLD: 'local' }, { EVE_ENV_SLACK_USER_BINDINGS: '{"private-person":"private-owner"}' },
    { EVE_ENV_SLACK_BOT_TOKEN: 'private-bot-token' },
    { EVE_HOST_WARM_UNTIL: undefined }, { EVE_HOST_WARM_UNTIL: '' },
    { EVE_HOST_WARM_UNTIL: new Date(Date.now() + 25 * 60 * 60_000).toISOString() },
    { EVE_ENV_MIKKA_DEPLOYMENT_STAGE: undefined }, { EVE_ENV_MIKKA_DEPLOYMENT_STAGE: 'development' },
  ]) {
    assert.throws(() => hostConfiguration({ ...environment(), ...change }), error => {
      assert.equal(error.message, 'CF_EVE_HOST_CONFIGURATION_INVALID')
      assert.doesNotMatch(error.stack, /private-password|private-person|private-bot-token/)
      return true
    })
  }
})

test('an image cannot silently start another build, local World or Vercel output', () => {
  const env = hostConfiguration(environment()).runtimeEnv
  for (const changed of [
    { ...build, world: 'local' }, { ...build, worldVersion: '4.0.0' },
    { ...build, revision: 'c'.repeat(40) }, { ...build, preset: 'vercel' },
  ]) assert.throws(() => validateHostBuild(changed, host, env))
  assert.throws(() => validateHostBuild(build, { ...host, uiSha: 'c'.repeat(40) }, env))
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
