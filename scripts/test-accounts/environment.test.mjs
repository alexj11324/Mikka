import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, chmod, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { assertDatabaseIdentity, databaseTarget, deploymentAttestation, environmentFingerprint, loadEnvironment, validateEnvironment } from './environment.mjs'
import { readBoundedBody } from './http-body.mjs'
import { MVP_DECISION_KEY, installMvpTransport, verifyMvpTransport, hasBoundMvpTransport } from '../../tests/mvp/transport.mjs'
import { hasBoundDevLocalTransport, installDevLocalTransport, verifyDevLocalTransport } from '../dev-local/transport.mjs'
import { LOCAL_RESEND_KEY } from '../dev-local/services.mjs'

function withSyntheticCredentials(value) {
  const target = new URL(value)
  target.username = 'e2e'
  target.password = randomUUID()
  return target.href
}

const url = withSyntheticCredentials('postgresql://127.0.0.1:5432/mikka_e2e')
const descriptor = {
  version: 1, id: 'guard-fixture', kind: 'isolated-ci', origin: 'http://localhost:3100', basePath: '/mikka',
  deploymentSha: 'a'.repeat(40), database: { host: '127.0.0.1', port: 5432, name: 'mikka_e2e', schema: 'public', user: 'e2e' },
  instanceId: '00000000-0000-4000-8000-000000000000', capabilities: { provision: true, mail: 'disabled', reset: true },
}
const env = { E2E_DATABASE_URL: url, MIKKA_DATABASE_URL: url, DATABASE_URL: url, BETTER_AUTH_URL: descriptor.origin, MIKKA_TEST_DEPLOYMENT_SHA: descriptor.deploymentSha }

test('environment binds all explicit database aliases, origin, SHA and capability policy', () => {
  assert.deepEqual(validateEnvironment(descriptor, env), descriptor)
  assert.deepEqual(databaseTarget(url), descriptor.database)
  for (const change of [
    { E2E_DATABASE_URL: undefined }, { MIKKA_DATABASE_URL: undefined }, { DATABASE_URL: undefined },
    { DATABASE_URL: 'postgresql://elsewhere.invalid/production' }, { ORVILO_DATABASE_URL: 'postgresql://elsewhere.invalid/production' },
    { BETTER_AUTH_URL: 'https://app.aspectlylabs.com' }, { E2E_BASE_URL: 'http://localhost:9999' },
    { MIKKA_TEST_DEPLOYMENT_SHA: 'b'.repeat(40) }, { RESEND_API_KEY: 'synthetic-mail-canary' }, { VERCEL_ENV: 'production' }, { VERCEL: '1' }, { MIKKA_NATIVE_COORDINATOR: '1' },
    { AI_GATEWAY_API_KEY: 'synthetic-model-canary' }, { OPENAI_API_KEY: 'synthetic-model-canary' },
    { ANTHROPIC_API_KEY: 'synthetic-model-canary' }, { COMPOSIO_API_KEY: 'synthetic-service-canary' }, { E2B_API_KEY: 'synthetic-service-canary' }, { EXPO_ACCESS_TOKEN: 'synthetic-service-canary' },
    { POSTHOG_SECRET_KEY: 'synthetic-service-canary' }, { AI_GATEWAY_API_KEY: MVP_DECISION_KEY },
  ]) assert.throws(() => validateEnvironment(descriptor, { ...env, ...change }))
})

test('production, unspecified preview, wildcard origins and deceptive database labels fail before any connection', () => {
  for (const change of [
    { kind: 'production' }, { kind: 'isolated-preview' }, { origin: 'https://app.aspectlylabs.com' },
    { origin: 'http://localhost:3100/' }, { origin: withSyntheticCredentials('http://production.invalid') },
    { basePath: '/' }, { database: { ...descriptor.database, name: 'mikka' } },
    { database: { ...descriptor.database, host: 'prod.invalid' } }, { database: { ...descriptor.database, schema: 'another' } },
    { database: { ...descriptor.database, user: 'someone' } }, { deploymentSha: 'main' },
    { capabilities: { provision: true, mail: 'enabled', reset: true } },
  ]) assert.throws(() => validateEnvironment({ ...descriptor, ...change }, env))
  for (const invalid of [withSyntheticCredentials('postgresql://127.0.0.1/mikka_e2e?options=-csearch_path=prod'), withSyntheticCredentials('postgresql://127.0.0.1/mikka_e2e#fragment'), 'not-a-url']) assert.throws(() => databaseTarget(invalid))
})

test('descriptor files must be private regular files; reading does not modify them', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mikka-environment-guard-'))
  const file = join(directory, 'environment.json')
  try {
    await writeFile(file, JSON.stringify(descriptor), { mode: 0o600 })
    assert.deepEqual(await loadEnvironment({ ...env, MIKKA_TEST_ENVIRONMENT_FILE: file }), descriptor)
    await chmod(file, 0o644)
    await assert.rejects(loadEnvironment({ ...env, MIKKA_TEST_ENVIRONMENT_FILE: file }), /ENVIRONMENT_FILE_UNSAFE/)
    await chmod(file, 0o600)
    const alias = join(directory, 'alias.json')
    await symlink(file, alias)
    await assert.rejects(loadEnvironment({ ...env, MIKKA_TEST_ENVIRONMENT_FILE: alias }), /ENVIRONMENT_FILE_UNSAFE/)
    await assert.rejects(loadEnvironment(env), /ENVIRONMENT_FILE_REQUIRED/)
  } finally { console.error(`Retained test fixture directory: ${directory}`) }
})

test('database check is SELECT-only and rejects actual identity, missing marker and copied binding', async () => {
  const queries = []
  const db = { query: async sql => {
    queries.push(sql)
    return queries.length === 1
      ? { rows: [{ name: 'mikka_e2e', schema: 'public', user: 'e2e' }], rowCount: 1 }
      : { rows: [{ environment_id: descriptor.id, instance_id: descriptor.instanceId, binding_sha256: environmentFingerprint(descriptor) }], rowCount: 1 }
  } }
  await assertDatabaseIdentity(db, descriptor)
  assert.equal(queries.length, 2)
  assert(queries.every(sql => sql.startsWith('SELECT ')))
  await assert.rejects(assertDatabaseIdentity({ query: async () => ({ rows: [{ name: 'production', schema: 'public', user: 'e2e' }] }) }, descriptor), /ACTUAL_DATABASE_MISMATCH/)
  await assert.rejects(assertDatabaseIdentity({ query: async () => { throw new Error('synthetic-private-driver-canary') } }, descriptor), error => error.message === 'DATABASE_IDENTITY_UNAVAILABLE')
  queries.length = 0
  await assert.rejects(assertDatabaseIdentity(db, { ...descriptor, origin: 'http://localhost:3200' }), /DATABASE_IDENTITY_MISMATCH/)
})

test('challenge proof cannot be replayed across origin, build, database, environment, capability or challenge', () => {
  const key = '1'.repeat(64), challenge = '2'.repeat(64)
  const proof = deploymentAttestation(descriptor, challenge, key)
  for (const change of [
    { id: 'other-run' }, { origin: 'http://localhost:3200' }, { deploymentSha: 'b'.repeat(40) },
    { instanceId: '00000000-0000-4000-8000-000000000001' }, { database: { ...descriptor.database, port: 5433 } },
    { capabilities: { ...descriptor.capabilities, provision: false } },
  ]) assert.notEqual(deploymentAttestation({ ...descriptor, ...change }, challenge, key), proof)
  assert.notEqual(deploymentAttestation(descriptor, '3'.repeat(64), key), proof)
  assert.throws(() => deploymentAttestation(descriptor, 'invalid', key), /ATTESTATION_CHALLENGE_INVALID/)
})

test('HTTP body bounds cancel an oversized or endless stream before consuming it', async () => {
  let reads = 0, cancelled = false
  const stream = new ReadableStream({
    pull(controller) { reads++; controller.enqueue(new Uint8Array(32)) },
    cancel() { cancelled = true },
  })
  await assert.rejects(readBoundedBody(new Response(stream), 64), /RESPONSE_BODY_TOO_LARGE/)
  assert.equal(cancelled, true)
  assert.ok(reads <= 4, 'must stop pulling instead of draining an endless response')
  const value = new TextEncoder().encode('bounded UTF-8: 修')
  assert.deepEqual(await readBoundedBody(new Response(value), value.byteLength), value)
  await assert.rejects(readBoundedBody(new Response('x', { headers: { 'content-length': '4097' } }), 4096), /RESPONSE_BODY_TOO_LARGE/)
})

test('only the exact isolated MVP key with a proven current loopback transport can attest its environment', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mikka-mvp-environment-guard-'))
  const file = join(directory, 'environment.json')
  const fixtureEnv = {
    ...env, MIKKA_TEST_ENVIRONMENT_FILE: file,
    CI: 'true', GITHUB_ACTIONS: 'true', MIKKA_MVP_E2E: '1', MIKKA_TEST_MODE: '1',
    AI_GATEWAY_API_KEY: MVP_DECISION_KEY,
  }
  let upstreamCalls = 0
  // This is a pure transport/descriptor fixture. No database, app server or
  // provider is started, and no test-only flags are installed in process.env.
  const upstream = async () => { upstreamCalls++; return new Response(null, { status: 204 }) }
  let restore
  try {
    await writeFile(file, JSON.stringify(descriptor), { mode: 0o600 })
    assert.equal(await verifyMvpTransport(fixtureEnv), false)
    assert.throws(() => validateEnvironment(descriptor, fixtureEnv), /EXTERNAL_SERVICE_CREDENTIALS_FORBIDDEN/)
    await assert.rejects(loadEnvironment(fixtureEnv), /EXTERNAL_SERVICE_CREDENTIALS_FORBIDDEN/)

    restore = installMvpTransport(fixtureEnv, upstream)
    assert.equal(hasBoundMvpTransport(fixtureEnv), false)
    assert.throws(() => validateEnvironment(descriptor, fixtureEnv), /EXTERNAL_SERVICE_CREDENTIALS_FORBIDDEN/)
    assert.deepEqual(await loadEnvironment(fixtureEnv), descriptor)
    assert.equal(hasBoundMvpTransport(fixtureEnv), true)
    assert.equal(upstreamCalls, 0, 'attestation challenge must be answered inside the transport, without a server request')

    for (const change of [
      { CI: undefined }, { GITHUB_ACTIONS: undefined }, { MIKKA_MVP_E2E: undefined }, { MIKKA_TEST_MODE: undefined },
      { VERCEL: '1' }, { VERCEL_ENV: 'production' }, { MIKKA_NATIVE_COORDINATOR: '1' },
      { E2E_BASE_URL: 'https://outside.invalid' }, { BETTER_AUTH_URL: 'https://outside.invalid' },
      { MIKKA_TEST_DEPLOYMENT_SHA: 'b'.repeat(40) }, { DATABASE_URL: 'postgresql://outside.invalid/production' },
      ...['AI_GATEWAY_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'COMPOSIO_API_KEY', 'E2B_API_KEY', 'EXPO_ACCESS_TOKEN', 'POSTHOG_SECRET_KEY', 'RESEND_API_KEY'].map(name => ({ [name]: 'synthetic-live-key-canary' })),
    ]) {
      assert.throws(() => validateEnvironment(descriptor, { ...fixtureEnv, ...change }))
      await assert.rejects(loadEnvironment({ ...fixtureEnv, ...change }))
    }
    assert.throws(() => validateEnvironment({ ...descriptor, kind: 'production' }, fixtureEnv), /ENVIRONMENT_KIND_FORBIDDEN/)
    assert.throws(() => validateEnvironment({ ...descriptor, kind: 'isolated-preview' }, fixtureEnv), /PREVIEW_APPROVAL_REQUIRED/)
    assert.equal(upstreamCalls, 0, 'rejected environments cannot reach a provider or server')

    const boundary = globalThis.fetch
    globalThis.fetch = (input, init) => boundary(input, init)
    assert.equal(hasBoundMvpTransport(fixtureEnv), false, 'a new Next-style wrapper must establish its own current-path proof')
    assert.throws(() => validateEnvironment(descriptor, fixtureEnv), /EXTERNAL_SERVICE_CREDENTIALS_FORBIDDEN/)
    assert.deepEqual(await loadEnvironment(fixtureEnv), descriptor)
    assert.equal(hasBoundMvpTransport(fixtureEnv), true)
    assert.equal(upstreamCalls, 0)

    globalThis.fetch = upstream
    assert.equal(hasBoundMvpTransport(fixtureEnv), false)
    assert.equal(await verifyMvpTransport(fixtureEnv), false, 'a replacement fetch cannot guess the private challenge response')
    assert.throws(() => validateEnvironment(descriptor, fixtureEnv), /EXTERNAL_SERVICE_CREDENTIALS_FORBIDDEN/)
    await assert.rejects(loadEnvironment(fixtureEnv), /EXTERNAL_SERVICE_CREDENTIALS_FORBIDDEN/)
  } finally {
    restore?.()
    console.error(`Retained test fixture directory: ${directory}`)
  }
})

test('local placeholders require a proven active stub transport while real keys remain forbidden', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mikka-local-environment-guard-'))
  const file = join(directory, 'environment.json')
  const local = { ...env, MIKKA_LOCAL_TEST_ACCOUNTS: '1', MIKKA_TEST_ENVIRONMENT_FILE: file, AI_GATEWAY_API_KEY: MVP_DECISION_KEY, RESEND_API_KEY: LOCAL_RESEND_KEY }
  let upstreamCalls = 0
  const upstream = async () => { upstreamCalls++; return new Response(null, { status: 204 }) }
  let restore
  try {
    await writeFile(file, JSON.stringify(descriptor), { mode: 0o600 })
    assert.throws(() => validateEnvironment(descriptor, local), /EXTERNAL_MAIL_FORBIDDEN/)
    await assert.rejects(loadEnvironment(local), /EXTERNAL_MAIL_FORBIDDEN/)
    restore = installDevLocalTransport(local, upstream)
    assert.equal(hasBoundDevLocalTransport(local), false)
    assert.deepEqual(await loadEnvironment(local), descriptor)
    assert.equal(hasBoundDevLocalTransport(local), true)
    assert.equal(upstreamCalls, 0)
    for (const change of [
      { MIKKA_LOCAL_TEST_ACCOUNTS: undefined }, { VERCEL_ENV: 'production' },
      { AI_GATEWAY_API_KEY: 'real-key' }, { RESEND_API_KEY: 'real-mail-key' }, { OPENAI_API_KEY: 'real-key' },
      { E2E_DATABASE_URL: 'postgresql://outside.invalid/production' },
    ]) await assert.rejects(loadEnvironment({ ...local, ...change }))
    const boundary = globalThis.fetch
    globalThis.fetch = (input, init) => boundary(input, init)
    assert.equal(hasBoundDevLocalTransport(local), false)
    assert.deepEqual(await loadEnvironment(local), descriptor)
    globalThis.fetch = upstream
    assert.equal(hasBoundDevLocalTransport(local), false)
    assert.equal(await verifyDevLocalTransport(local), false)
    await assert.rejects(loadEnvironment(local), /EXTERNAL_MAIL_FORBIDDEN/)
  } finally {
    restore?.()
    console.error(`Retained test fixture directory: ${directory}`)
  }
})
