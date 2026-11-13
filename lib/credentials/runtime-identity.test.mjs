import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import { cloudflareCredentialToken, credentialRuntimeEnvironment } from './runtime-identity.ts'

const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  const modules = {
    '@vercel/oidc': 'export async function getVercelOidcToken() { return "vercel.fixture.token" }',
    aws4fetch: 'export class AwsClient { constructor(options) { this.options = options } }',
    '@/lib/edition': 'export function isCloudEdition() { return true }',
  }
  if (context.parentURL?.endsWith('/kms.ts') && specifier === './contracts') {
    return { url: 'data:text/javascript,export class CredentialError extends Error { constructor() { super("credential_unavailable"); this.code = "credential_unavailable"; this.status = 503 } }', shortCircuit: true }
  }
  if (context.parentURL?.endsWith('/kms.ts') && specifier === './runtime-identity') {
    return { url: new URL('./runtime-identity.ts', import.meta.url).href, shortCircuit: true }
  }
  if (modules[specifier]) return { url: 'data:text/javascript,' + encodeURIComponent(modules[specifier]), shortCircuit: true }
  return nextResolve(specifier, context)
} })
const { assumeVercelRole } = await import('./kms.ts')
hooks.deregister()

function runtime(t, environment = 'preview') {
  const saved = { ...process.env }
  process.env.CREDENTIAL_RUNTIME = 'cloudflare'
  process.env.CREDENTIAL_ENVIRONMENT = environment
  process.env.CREDENTIAL_APP_ROLE_ARN = 'arn:aws:iam::123456789012:role/mikka-credential-app-preview'
  delete process.env.CREDENTIAL_BROKER_ROLE_ARN
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
    Object.assign(process.env, saved)
  })
}

test('runtime selection is explicit and rejects incomplete or unknown Cloudflare configuration', () => {
  assert.equal(credentialRuntimeEnvironment({}), null)
  for (const environment of ['preview', 'production']) {
    assert.equal(credentialRuntimeEnvironment({ CREDENTIAL_RUNTIME: 'cloudflare', CREDENTIAL_ENVIRONMENT: environment }), environment)
  }
  for (const env of [{ CREDENTIAL_RUNTIME: 'other' }, { CREDENTIAL_RUNTIME: 'cloudflare' },
    { CREDENTIAL_RUNTIME: 'cloudflare', CREDENTIAL_ENVIRONMENT: 'development' }]) assert.throws(() => credentialRuntimeEnvironment(env))
})

test('the real STS exchange uses the private runtime token and requests exactly 900 seconds for its own role', async t => {
  runtime(t)
  const requests = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push({ url, init })
    if (url === 'https://identity.internal/token') return Response.json({ token: 'cloudflare.fixture.token' })
    return new Response('<Credentials><AccessKeyId>fixture-access</AccessKeyId><SecretAccessKey>fixture-secret</SecretAccessKey><SessionToken>fixture-session</SessionToken></Credentials>')
  })
  await assumeVercelRole('app')
  assert.deepEqual(requests.map(request => request.url), ['https://identity.internal/token', 'https://sts.amazonaws.com/'])
  assert.equal(requests[0].init.method, 'POST')
  assert.equal(requests[0].init.body, undefined)
  assert.equal(requests[0].init.headers, undefined)
  assert.equal(requests[0].init.redirect, 'error')
  assert.equal(requests[0].init.cache, 'no-store')
  assert.deepEqual(Object.fromEntries(requests[1].init.body), {
    Action: 'AssumeRoleWithWebIdentity', Version: '2011-06-15',
    RoleArn: process.env.CREDENTIAL_APP_ROLE_ARN, RoleSessionName: 'mikka-credential-app',
    DurationSeconds: '900', WebIdentityToken: 'cloudflare.fixture.token',
  })
  await assert.rejects(assumeVercelRole('broker'), { code: 'credential_unavailable' })
  assert.equal(requests.length, 2)
})

test('legacy deployments retain the Vercel exchange when the Cloudflare runtime is absent', async t => {
  runtime(t)
  delete process.env.CREDENTIAL_RUNTIME
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, 'https://sts.amazonaws.com/')
    assert.equal(init.body.get('WebIdentityToken'), 'vercel.fixture.token')
    return new Response('<AccessKeyId>fixture</AccessKeyId><SecretAccessKey>fixture</SecretAccessKey><SessionToken>fixture</SessionToken>')
  })
  await assumeVercelRole('app')
})

test('identity failures never fall through to Vercel or expose provider bodies', async t => {
  runtime(t)
  let calls = 0
  t.mock.method(globalThis, 'fetch', async url => {
    calls++
    assert.equal(url, 'https://identity.internal/token')
    return new Response('sensitive-provider-body', { status: 503 })
  })
  await assert.rejects(assumeVercelRole('app'), error => error.message === 'credential_unavailable' && error.cause === undefined)
  assert.equal(calls, 1)
})

test('the private identity response has a streaming size bound and requires a JWT', async t => {
  runtime(t, 'production')
  for (const body of ['{}', '{"token":"opaque"}', JSON.stringify({ token: 'a'.repeat(16_385) })]) {
    t.mock.method(globalThis, 'fetch', async () => new Response(body))
    await assert.rejects(cloudflareCredentialToken())
    t.mock.restoreAll()
  }
})
