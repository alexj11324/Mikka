import './offline-transport.mjs'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import https from 'node:https'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { Readable } from 'node:stream'
import test from 'node:test'
import { Client, Pool } from 'pg'
import { bootstrapDockerEnvironment } from './bootstrap.mjs'
import { assertDatabaseIdentity, dockerDescriptorSignature, environmentFingerprint, loadEnvironment, validateEnvironment } from './environment.mjs'
import { consumeDockerOwnership, verifyDockerOwnership } from './docker-ownership.mjs'
import { dockerOrigin } from './docker-target.mjs'

const sandboxUid = 'sbx_001m6p98ev958vppx9366vfp8ea'
const origin = dockerOrigin(sandboxUid, 3000)
const deploymentSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const connectionString = 'postgresql://e2e:synthetic-docker-db-canary@127.0.0.1:5432/mikka_docker_e2e'
const request = { sandboxUid, port: 3000, origin, deploymentSha, connectionString, accessToken: 'synthetic-docker-owner-token-canary' }
const database = { host: '127.0.0.1', port: 5432, name: 'mikka_docker_e2e', schema: 'public', user: 'e2e' }
const publicationUid = '3ba10920-8300-4c68-8f51-a9215a29ab3a'
const fixture = () => [{ name: `sandboxes/${sandboxUid}`, uid: sandboxUid, core: {
  status: 'running', endpoint: { sandbox: `sandboxes/${sandboxUid}`, sandboxUid }, ports: [{ sandboxPort: 3000, url: origin }],
} }, { published: [{ name: `sandboxes/${sandboxUid}/ports/3000`, uid: publicationUid, number: 3000, protocol: 'tcp', url: origin }] }]

function management(t, values = fixture(), responseOptions = {}) {
  const calls = []
  t.mock.method(https, 'request', (url, options, callback) => {
    calls.push({ url: url.href, ...options })
    const body = JSON.stringify(values[calls.length - 1])
    const req = new EventEmitter()
    req.setTimeout = () => req
    req.destroy = () => {}
    req.end = () => queueMicrotask(() => {
      const response = Readable.from([Buffer.from(body ?? '')])
      response.statusCode = responseOptions.statusCode ?? 200
      response.headers = responseOptions.headers ?? {}
      callback(response)
    })
    return req
  })
  return calls
}

function configuredEnvironment(t, overrides = {}) {
  const env = { E2E_DATABASE_URL: connectionString, MIKKA_DATABASE_URL: connectionString, DATABASE_URL: connectionString,
    BETTER_AUTH_URL: origin, MIKKA_TEST_DEPLOYMENT_SHA: deploymentSha, ...overrides }
  const keys = [...Object.keys(env), 'ORVILO_DATABASE_URL', 'E2E_BASE_URL', 'VERCEL', 'VERCEL_ENV', 'DOCKER_PAT', 'DOCKER_ACCESS_TOKEN', 'DOCKER_TOKEN', 'RESEND_API_KEY', 'AI_GATEWAY_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'COMPOSIO_API_KEY', 'E2B_API_KEY', 'EXPO_ACCESS_TOKEN', 'POSTHOG_SECRET_KEY']
  const before = new Map(keys.map(key => [key, process.env[key]]))
  for (const key of keys) { if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key] }
  t.after(() => { for (const [key, value] of before) { if (value === undefined) delete process.env[key]; else process.env[key] = value } })
  return env
}

function disposableDatabase(t, state = {}) {
  const queries = []
  let marker = state.marker
  t.mock.method(Pool.prototype, 'query', async (sql, values = []) => {
    queries.push(sql)
    if (sql.includes('inet_server_addr')) return { rows: [{ address: state.address ?? '127.0.0.1', port: 5432 }] }
    if (sql.includes('current_database')) return { rows: [state.identity ?? database], rowCount: 1 }
    if (sql.includes("to_regclass('mikka_test_accounts.environment')")) return { rows: [{ marker: marker ? 'mikka_test_accounts.environment' : null }] }
    if (sql.includes('to_regclass(\'public.')) return { rows: [{ users: 'user' }] }
    if (sql === 'SELECT 1 FROM public."user" LIMIT 1') return { rows: state.users ? [{}] : [], rowCount: state.users ? 1 : 0 }
    if (sql.includes('pg_namespace')) return { rows: state.namespace ? [{}] : [], rowCount: state.namespace ? 1 : 0 }
    if (sql.startsWith('INSERT INTO mikka_test_accounts.environment')) {
      marker = { environment_id: values[0], instance_id: values[1], binding_sha256: values[2], attestation_key: values[3] }
    }
    if (sql.startsWith('SELECT environment_id')) return { rows: marker ? [marker] : [], rowCount: marker ? 1 : 0 }
    return { rows: [], rowCount: 0 }
  })
  t.mock.method(Pool.prototype, 'end', async () => {})
  return { queries, marker: () => marker }
}

async function temporaryOutput(t) {
  const directory = await mkdtemp(join(tmpdir(), 'mikka-docker-adapter-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return join(directory, 'environment.json')
}

test('offline adapter guard rejects real pg and management transport without mocks', async () => {
  const forbidden = { code: 'OFFLINE_TRANSPORT_FORBIDDEN' }
  // Without the guard these argument-less calls fail before any connection;
  // prove both entry points are guarded before exercising the locked driver.
  assert.throws(() => net.connect(), forbidden)
  const socket = new net.Socket()
  try { assert.throws(() => socket.connect(), forbidden) } finally { socket.destroy() }
  assert.throws(() => https.request(), forbidden)
  const client = new Client({ connectionString, connectionTimeoutMillis: 0 })
  try { await assert.rejects(client.connect(), forbidden) }
  finally { client.connection.stream.destroy() }
  await assert.rejects(verifyDockerOwnership(request), forbidden)
})

test('live ownership requires two exact authenticated GETs and returns an opaque one-use binding', async t => {
  const calls = management(t)
  const ownership = await verifyDockerOwnership(request)
  assert.deepEqual(calls.map(call => [call.url, call.method]), [
    [`https://connect.docker.com/sandboxes/v1/sandboxes/${sandboxUid}`, 'GET'],
    [`https://connect.docker.com/sandboxes/v1/sandboxes/${sandboxUid}/ports`, 'GET'],
  ])
  assert(calls.every(call => call.headers.authorization === `Bearer ${request.accessToken}`))
  assert.equal(JSON.stringify(ownership).includes(request.accessToken), false)
  assert.equal(Object.isFrozen(ownership), true)
  assert.throws(() => consumeDockerOwnership(JSON.parse(JSON.stringify(ownership)), request), { code: 'DOCKER_OWNERSHIP_PROOF_REQUIRED' })
  assert.deepEqual(consumeDockerOwnership(ownership, request), { sandboxUid, port: 3000, publicationUid })
  assert.throws(() => consumeDockerOwnership(ownership, request), { code: 'DOCKER_OWNERSHIP_PROOF_REQUIRED' })
})

test('wrong origin, sandbox, port, SHA or database fails before contacting Docker', async t => {
  const calls = management(t)
  for (const change of [
    { origin: 'https://app.aspectlylabs.com' }, { origin: `${origin}/` }, { origin: origin.replace('https:', 'http:') },
    { sandboxUid: 'sbx_001aaaaaaaaaaaaaaaaaaaaaaaa' }, { port: 3001 }, { deploymentSha: '0'.repeat(40) },
    { deploymentSha: 'main' }, { accessToken: '' }, { accessToken: 'synthetic\nheader-injection' },
    { connectionString: connectionString.replace('127.0.0.1', 'database.example.com') },
    { connectionString: connectionString.replace('e2e:', 'postgres:') },
    { connectionString: connectionString.replace('mikka_docker_e2e', 'production') },
  ]) await assert.rejects(verifyDockerOwnership({ ...request, ...change }))
  assert.equal(calls.length, 0)
})

test('only live matching ownership and an unambiguous current publication authorize bootstrap', async t => {
  for (const transform of [
    values => { values[0].uid = 'sbx_other' },
    values => { values[0].core.status = 'stopped' },
    values => { values[0].core.endpoint.sandboxUid = 'sbx_other' },
    values => { values[0].core.ports[0].url = 'https://foreign.invalid' },
    values => { values[1].published[0].number = 3001 },
    values => { values[1].published[0].name = `sandboxes/${sandboxUid}/ports/3001` },
    values => { values[1].published[0].uid = 'not-a-publication-id' },
    values => { values[1].published[0].protocol = 'udp' },
    values => { values[1].published[0].url = origin.replace('3000-', '3001-') },
    values => { values[1].published.push({ ...values[1].published[0] }) },
    values => { values[1].published = { filter: 'fabricated-receipt' } },
  ]) {
    const values = fixture(); transform(values)
    management(t, values)
    await assert.rejects(verifyDockerOwnership(request))
    t.mock.restoreAll()
  }
  for (const options of [{ statusCode: 401 }, { statusCode: 403 }, { statusCode: 302, headers: { location: origin } }, { headers: { 'set-cookie': 'synthetic=x' } }]) {
    management(t, fixture(), options)
    await assert.rejects(verifyDockerOwnership(request), { code: 'DOCKER_OWNERSHIP_REJECTED' })
    t.mock.restoreAll()
  }
})

test('a live receipt cannot cross the database, origin, revision or bootstrap time boundary', async t => {
  for (const change of [
    { connectionString: connectionString.replace('mikka_docker_e2e', 'other_e2e') },
    { origin: dockerOrigin('sbx_001m6p8qt9pcng01mwgkmshdz6m', 3000) }, { deploymentSha: 'b'.repeat(40) },
  ]) {
    management(t)
    const ownership = await verifyDockerOwnership(request)
    assert.throws(() => consumeDockerOwnership(ownership, { ...request, ...change }), { code: 'DOCKER_OWNERSHIP_BINDING_MISMATCH' })
    assert.throws(() => consumeDockerOwnership(ownership, request), { code: 'DOCKER_OWNERSHIP_PROOF_REQUIRED' })
    t.mock.restoreAll()
  }
  management(t)
  const ownership = await verifyDockerOwnership(request)
  const now = performance.now()
  t.mock.method(performance, 'now', () => now + 60_001)
  assert.throws(() => consumeDockerOwnership(ownership, request), { code: 'DOCKER_OWNERSHIP_PROOF_EXPIRED' })
})

test('public bootstrap signs the exact fresh instance and refuses fabricated or replayed authority', async t => {
  const env = configuredEnvironment(t)
  management(t)
  const db = disposableDatabase(t)
  const outputFile = await temporaryOutput(t)
  const options = { ...request, id: 'docker-guard-fixture', outputFile }
  for (const ownership of [undefined, { docker: { sandboxUid, port: 3000, publicationUid }, ...request }, 'approved']) {
    await assert.rejects(bootstrapDockerEnvironment({ ...options, ownership }), { code: 'DOCKER_OWNERSHIP_PROOF_REQUIRED' })
  }
  assert.equal(db.queries.length, 0)
  const ownership = await verifyDockerOwnership(request)
  const descriptor = await bootstrapDockerEnvironment({ ...options, ownership })
  assert.equal(descriptor.kind, 'isolated-docker')
  assert.equal(descriptor.descriptorSignature, dockerDescriptorSignature(descriptor, db.marker().attestation_key))
  assert.deepEqual(JSON.parse(await readFile(outputFile, 'utf8')), descriptor)
  assert.equal((await stat(outputFile)).mode & 0o077, 0)
  assert.deepEqual(await loadEnvironment({ ...env, MIKKA_TEST_ENVIRONMENT_FILE: outputFile }), descriptor)
  await assertDatabaseIdentity(new Pool(), descriptor)
  assert.equal(JSON.stringify(descriptor).includes(request.accessToken), false)
  assert.equal(JSON.stringify(descriptor).includes(db.marker().attestation_key), false)
  await assert.rejects(bootstrapDockerEnvironment({ ...options, ownership }), { code: 'DOCKER_OWNERSHIP_PROOF_REQUIRED' })
  for (const change of [
    { descriptorSignature: '0'.repeat(64) }, { origin: dockerOrigin('sbx_001m6p8qt9pcng01mwgkmshdz6m', 3000), docker: { ...descriptor.docker, sandboxUid: 'sbx_001m6p8qt9pcng01mwgkmshdz6m' } },
    { deploymentSha: 'b'.repeat(40) }, { docker: { ...descriptor.docker, publicationUid: '00000000-0000-4000-8000-000000000001' } },
  ]) await assert.rejects(assertDatabaseIdentity(new Pool(), { ...descriptor, ...change }))
  assert.equal(environmentFingerprint(descriptor), db.marker().binding_sha256)
})

test('public bootstrap never adopts users, a marker, an existing descriptor or another database role', async t => {
  configuredEnvironment(t)
  for (const state of [
    { users: true }, { namespace: true }, { marker: {} }, { identity: { ...database, user: 'postgres' } }, { address: '10.0.0.1' },
  ]) {
    management(t)
    const db = disposableDatabase(t, state)
    const outputFile = await temporaryOutput(t)
    const ownership = await verifyDockerOwnership(request)
    await assert.rejects(bootstrapDockerEnvironment({ ...request, id: 'docker-refused-fixture', outputFile, ownership }))
    assert(db.queries.every(sql => sql.startsWith('SELECT ')))
    await assert.rejects(stat(outputFile), { code: 'ENOENT' })
    t.mock.restoreAll()
  }
  management(t)
  const db = disposableDatabase(t)
  const outputFile = await temporaryOutput(t)
  await writeFile(outputFile, '{}', { mode: 0o600 })
  const ownership = await verifyDockerOwnership(request)
  await assert.rejects(bootstrapDockerEnvironment({ ...request, id: 'docker-refused-fixture', outputFile, ownership }), { code: 'DOCKER_BOOTSTRAP_ALREADY_BOUND' })
  assert.equal(db.queries.length, 0)
})

test('public descriptor configuration stays confined to exact HTTP and database boundaries', () => {
  const descriptor = { version: 1, id: 'docker-guard-fixture', kind: 'isolated-docker', origin, basePath: '/mikka', deploymentSha,
    database, instanceId: '00000000-0000-4000-8000-000000000000', capabilities: { provision: true, reset: true, mail: 'disabled' },
    docker: { sandboxUid, port: 3000, publicationUid }, descriptorSignature: 'a'.repeat(64) }
  const env = { E2E_DATABASE_URL: connectionString, MIKKA_DATABASE_URL: connectionString, DATABASE_URL: connectionString, BETTER_AUTH_URL: origin, MIKKA_TEST_DEPLOYMENT_SHA: deploymentSha }
  assert.deepEqual(validateEnvironment(descriptor, env), descriptor)
  for (const change of [
    { origin: 'https://app.aspectlylabs.com' }, { origin: `${origin}/` }, { descriptorSignature: undefined },
    { database: { ...database, user: 'postgres' } }, { database: { ...database, name: 'production' } },
    { kind: 'isolated-ci' }, { docker: { ...descriptor.docker, sandboxUid: 'sbx_unowned' } },
  ]) assert.throws(() => validateEnvironment({ ...descriptor, ...change }, env))
  for (const change of [{ VERCEL: '1' }, { BETTER_AUTH_URL: 'http://localhost:3000' }, { MIKKA_TEST_DEPLOYMENT_SHA: 'b'.repeat(40) },
    { DOCKER_PAT: 'synthetic-runtime-credential' }, { DOCKER_ACCESS_TOKEN: 'synthetic-runtime-credential' }, { DOCKER_TOKEN: 'synthetic-runtime-credential' },
    { DATABASE_URL: connectionString.replace('mikka_docker_e2e', 'other_e2e') }]) assert.throws(() => validateEnvironment(descriptor, { ...env, ...change }))
})
