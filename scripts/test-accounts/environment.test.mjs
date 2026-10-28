import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, chmod, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { assertDatabaseIdentity, databaseTarget, deploymentAttestation, environmentFingerprint, loadEnvironment, validateEnvironment } from './environment.mjs'
import { readBoundedBody } from './http-body.mjs'

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
    { POSTHOG_SECRET_KEY: 'synthetic-service-canary' }, { DECISION_GATEWAY_API_KEY: 'synthetic-model-canary' },
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
  } finally { if (process.env.MIKKA_RETAIN_TEST_FILES === '1') console.log('Retained private test-account fixture'); else await rm(directory, { recursive: true, force: true }) }
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
