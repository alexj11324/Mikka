import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import { issueRuntimeIdentity, runtimeIdentityMetadata } from './identity.mjs'

const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === 'cloudflare:workers') {
    return { url: 'data:text/javascript,export class WorkerEntrypoint { constructor(ctx, env) { this.env = env } }', shortCircuit: true }
  }
  return nextResolve(specifier, context)
} })
const { default: worker, AppIdentity, BrokerIdentity } = await import('./worker.mjs')
hooks.deregister()

const algorithm = { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }
const pair = await webcrypto.subtle.generateKey(algorithm, true, ['sign', 'verify'])
const otherPair = await webcrypto.subtle.generateKey(algorithm, true, ['sign', 'verify'])
const exported = await webcrypto.subtle.exportKey('jwk', pair.publicKey)
const jwk = { kty: exported.kty, n: exported.n, e: exported.e, kid: 'fixture-key', alg: 'RS256', use: 'sig' }
const der = await webcrypto.subtle.exportKey('pkcs8', pair.privateKey)
const pem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(der).toString('base64')}\n-----END PRIVATE KEY-----\n`

function fixture(overrides = {}) {
  let reads = 0
  const env = {
    CREDENTIAL_ENVIRONMENT: 'preview',
    ISSUER_URL: 'https://identity.example.test',
    SIGNING_KEY_ID: 'fixture-key',
    SIGNING_PUBLIC_JWK: JSON.stringify(jwk),
    SIGNING_KEY: { async get() { reads++; return pem } },
    ...overrides,
  }
  return { env, reads: () => reads }
}

function decode(token) {
  const [header, payload] = token.split('.')
  return {
    header: JSON.parse(Buffer.from(header, 'base64url')),
    payload: JSON.parse(Buffer.from(payload, 'base64url')),
  }
}

async function verify(token, subject, before, after) {
  const [header, payload, signature] = token.split('.')
  assert.equal(token.split('.').length, 3)
  assert.ok(await webcrypto.subtle.verify('RSASSA-PKCS1-v1_5', pair.publicKey,
    Buffer.from(signature, 'base64url'), Buffer.from(`${header}.${payload}`)))
  const decoded = decode(token)
  assert.deepEqual(decoded.header, { alg: 'RS256', typ: 'JWT', kid: 'fixture-key' })
  assert.ok(Number.isInteger(decoded.payload.iat))
  assert.ok(decoded.payload.iat >= before && decoded.payload.iat <= after)
  assert.deepEqual(decoded.payload, {
    iss: 'https://identity.example.test', sub: subject, aud: 'sts.amazonaws.com',
    iat: decoded.payload.iat, exp: decoded.payload.iat + 300,
  })
  assert.equal(await webcrypto.subtle.verify('RSASSA-PKCS1-v1_5', pair.publicKey,
    Buffer.from(signature, 'base64url'), Buffer.from(`${header}.${payload}x`)), false)
}

test('configured deployment labels issue independently verifiable fixed role identities for exactly 300 seconds', async () => {
  for (const environment of ['preview', 'production', 'customer_stage']) {
    for (const role of ['app', 'broker']) {
      const { env, reads } = fixture({ CREDENTIAL_ENVIRONMENT: environment })
      const before = Math.floor(Date.now() / 1000)
      const token = await issueRuntimeIdentity(role, env)
      await verify(token, `cloudflare:mikka:${role}:${environment}`, before, Math.floor(Date.now() / 1000))
      assert.equal(reads(), 1)
    }
  }
})

test('public discovery and JWKS contain only configured public metadata and never access the private binding', async () => {
  const { env } = fixture()
  Object.defineProperty(env, 'SIGNING_KEY', { get() { return assert.fail('Private binding accessed') } })
  for (const [path, expected] of [
    ['/.well-known/openid-configuration', {
      issuer: 'https://identity.example.test',
      jwks_uri: 'https://identity.example.test/.well-known/jwks.json',
      response_types_supported: ['id_token'], subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
    }],
    ['/.well-known/jwks.json', { keys: [jwk] }],
  ]) {
    const response = await worker.fetch(new Request(`https://incoming.example.test${path}`), env)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), expected)
  }
  const metadata = await runtimeIdentityMetadata({ ...fixture().env, ISSUER_URL: 'https://identity.example.test/' })
  assert.equal(metadata.configuration.issuer, 'https://identity.example.test')
})

test('public fetch rejects issuance, RPC-shaped paths, alternate methods and metadata queries before reading bindings', async () => {
  const env = new Proxy({}, { get() { assert.fail('Bindings accessed on rejected public request') } })
  for (const [path, method] of [
    ['/token', 'POST'], ['/token', 'GET'], ['/AppIdentity/token', 'POST'],
    ['/issueRuntimeIdentity', 'POST'], ['/', 'GET'],
    ['/.well-known/jwks.json', 'POST'], ['/.well-known/jwks.json', 'HEAD'],
    ['/.well-known/openid-configuration', 'OPTIONS'],
    ['/.well-known/jwks.json?role=broker', 'GET'],
  ]) {
    assert.equal((await worker.fetch(new Request(`https://identity.example.test${path}`, { method }), env)).status, 404)
  }
})

test('named entrypoints choose the role in class code and the environment in trusted bindings', async () => {
  for (const environment of ['preview', 'production', 'customer_stage']) {
    for (const [Entrypoint, role] of [[AppIdentity, 'app'], [BrokerIdentity, 'broker']]) {
      const { env } = fixture({ CREDENTIAL_ENVIRONMENT: environment })
      const before = Math.floor(Date.now() / 1000)
      const response = await new Entrypoint({}, env).fetch(new Request('https://identity.internal/token', {
        method: 'POST', headers: { role: 'admin', subject: 'override', audience: 'other', environment: 'other' },
      }))
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('cache-control'), 'no-store')
      const body = await response.json()
      assert.deepEqual(Object.keys(body), ['token'])
      await verify(body.token, `cloudflare:mikka:${role}:${environment}`, before, Math.floor(Date.now() / 1000))
    }
  }
})

test('private entrypoints reject every request override before private key access', async () => {
  for (const Entrypoint of [AppIdentity, BrokerIdentity]) {
    const { env, reads } = fixture()
    const entrypoint = new Entrypoint({}, env)
    for (const [url, options] of [
      ['https://identity.internal/token', { method: 'GET' }],
      ['https://identity.internal/token', { method: 'PUT' }],
      ['https://identity.internal/token?role=broker', { method: 'POST' }],
      ['https://identity.internal/token?', { method: 'POST' }],
      ['https://identity.internal/token#override', { method: 'POST' }],
      ['https://identity.internal/token/', { method: 'POST' }],
      ['https://identity.internal/other', { method: 'POST' }],
      ['https://other.internal/token', { method: 'POST' }],
      ['http://identity.internal/token', { method: 'POST' }],
      ['https://identity.internal/token', { method: 'POST', body: JSON.stringify({ role: 'broker' }) }],
      ['https://identity.internal/token', { method: 'POST', body: ' ' }],
    ]) {
      const response = await entrypoint.fetch(new Request(url, options))
      assert.equal(response.status, 404, `${options.method} ${url}`)
      assert.equal(await response.text(), '')
    }
    assert.equal(reads(), 0)
    assert.equal((await entrypoint.fetch(new Request('https://identity.internal/token', { method: 'POST', body: '' }))).status, 200)
  }
})

test('unknown helper roles and malformed trusted configuration fail before reading a signing key', async () => {
  const invalid = [
    { CREDENTIAL_ENVIRONMENT: 42 }, { CREDENTIAL_ENVIRONMENT: '' }, { CREDENTIAL_ENVIRONMENT: undefined },
    { ISSUER_URL: 'http://identity.example.test' }, { ISSUER_URL: 'https://identity.example.test/path' },
    { ISSUER_URL: 'https://identity.example.test?override=1' }, { ISSUER_URL: 'https://identity.example.test#fragment' },
    { ISSUER_URL: 'https://user:password@identity.example.test' }, { ISSUER_URL: ' https://identity.example.test' },
    { ISSUER_URL: 'https://identity.example.test/../' }, { ISSUER_URL: 'invalid' }, { ISSUER_URL: undefined },
    { SIGNING_KEY_ID: '' }, { SIGNING_KEY_ID: undefined },
  ]
  for (const overrides of invalid) {
    const { env, reads } = fixture(overrides)
    await assert.rejects(issueRuntimeIdentity('app', env), { message: 'Runtime identity unavailable' })
    await assert.rejects(runtimeIdentityMetadata(env), { message: 'Runtime identity unavailable' })
    assert.equal(reads(), 0)
  }
  const { env, reads } = fixture()
  for (const role of ['admin', '', undefined, 'app:production']) {
    await assert.rejects(issueRuntimeIdentity(role, env), { message: 'Runtime identity unavailable' })
  }
  assert.equal(reads(), 0)
})

test('JWKS rejects private parameters, unknown fields and invalid or mismatched public key metadata', async () => {
  for (const value of [
    'invalid-json', 'null', '[]', '{}',
    ...['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'extra'].map(field => JSON.stringify({ ...jwk, [field]: 'forbidden' })),
    ...[{ kty: 'EC' }, { alg: 'RS512' }, { use: 'enc' }, { kid: 'other' }, { n: '' }, { n: '===' }, { e: '' }, { e: 65537 }]
      .map(overrides => JSON.stringify({ ...jwk, ...overrides })),
  ]) {
    const { env, reads } = fixture({ SIGNING_PUBLIC_JWK: value })
    await assert.rejects(runtimeIdentityMetadata(env), { message: 'Runtime identity unavailable' })
    await assert.rejects(issueRuntimeIdentity('broker', env), { message: 'Runtime identity unavailable' })
    assert.equal(reads(), 0)
  }
})

test('invalid, missing or mismatched private signing keys fail with opaque errors', async () => {
  const otherDer = await webcrypto.subtle.exportKey('pkcs8', otherPair.privateKey)
  const otherPem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(otherDer).toString('base64')}\n-----END PRIVATE KEY-----`
  for (const binding of [
    undefined, pem,
    { async get() { return undefined } },
    { async get() { return 'provider-secret-value' } },
    { async get() { return '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----' } },
    { async get() { return otherPem } },
    { async get() { throw new Error('provider-secret-value') } },
  ]) {
    const { env } = fixture({ SIGNING_KEY: binding })
    await assert.rejects(issueRuntimeIdentity('app', env), error => {
      assert.equal(error.message, 'Runtime identity unavailable')
      assert.equal(error.cause, undefined)
      return true
    })
    const response = await new AppIdentity({}, env).fetch(new Request('https://identity.internal/token', { method: 'POST' }))
    assert.equal(response.status, 503)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal(await response.text(), 'Runtime identity unavailable')
  }
})

test('metadata configuration failures remain opaque over the public interface', async () => {
  const { env, reads } = fixture({ SIGNING_PUBLIC_JWK: 'provider-secret-value' })
  const response = await worker.fetch(new Request('https://identity.example.test/.well-known/jwks.json'), env)
  assert.equal(response.status, 503)
  assert.equal(await response.text(), 'Runtime identity unavailable')
  assert.equal(reads(), 0)
})
