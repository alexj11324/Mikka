import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Pool } from 'pg'
import { readBoundedBody } from './http-body.mjs'
import { MVP_DECISION_KEY, hasBoundMvpTransport, verifyMvpTransport } from '../../tests/mvp/transport.mjs'

const IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/
const LABEL = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/
const SHA = /^[a-f0-9]{40}$/
const INSTANCE = /^[a-f0-9-]{36}$/
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

export class EnvironmentError extends Error {
  constructor(code) { super(code); this.name = 'EnvironmentError'; this.code = code }
}
const fail = code => { throw new EnvironmentError(code) }

/** Deliberately never include a URL, driver error, password or response body in errors. */
export function databaseTarget(connectionString) {
  let target
  try { target = new URL(connectionString) } catch { fail('DATABASE_URL_REQUIRED') }
  if (!['postgres:', 'postgresql:'].includes(target.protocol) || target.search || target.hash || !target.username || !target.password) fail('DATABASE_URL_INVALID')
  const name = target.pathname.slice(1)
  if (!IDENTIFIER.test(name) || !IDENTIFIER.test(decodeURIComponent(target.username))) fail('DATABASE_TARGET_INVALID')
  return { host: target.hostname, port: Number(target.port || 5432), name, schema: 'public', user: decodeURIComponent(target.username) }
}

export function bindingValue(value) {
  return {
    version: value.version, id: value.id, kind: value.kind, origin: value.origin,
    basePath: value.basePath, deploymentSha: value.deploymentSha,
    database: { host: value.database.host, port: value.database.port, name: value.database.name, schema: value.database.schema, user: value.database.user },
    instanceId: value.instanceId,
    capabilities: { provision: value.capabilities.provision, mail: value.capabilities.mail, reset: value.capabilities.reset },
  }
}
export function environmentFingerprint(value) { return createHash('sha256').update(JSON.stringify(bindingValue(value))).digest('hex') }

export function validateEnvironment(value, env = process.env) {
  if (!value || value.version !== 1 || !LABEL.test(value.id ?? '') || !SHA.test(value.deploymentSha ?? '') || !INSTANCE.test(value.instanceId ?? '')) fail('ENVIRONMENT_DESCRIPTOR_INVALID')
  if (!['isolated-ci', 'isolated-preview'].includes(value.kind)) fail('ENVIRONMENT_KIND_FORBIDDEN')
  // Preview onboarding requires a separately authorized adapter. An arbitrary flag
  // or a descriptor called "preview" cannot authorize its database or credentials.
  if (value.kind !== 'isolated-ci') fail('PREVIEW_APPROVAL_REQUIRED')
  let origin
  try { origin = new URL(value.origin) } catch { fail('ENVIRONMENT_ORIGIN_INVALID') }
  if (origin.origin !== value.origin || origin.username || origin.password || origin.search || origin.hash || !LOOPBACK.has(origin.hostname) || !['http:', 'https:'].includes(origin.protocol) || value.basePath !== '/mikka') fail('ENVIRONMENT_ORIGIN_FORBIDDEN')
  if (env.VERCEL_ENV || env.VERCEL === '1') fail('DEPLOYED_ENVIRONMENT_REQUIRES_APPROVAL')
  if (!value.database || !LOOPBACK.has(value.database.host) || !Number.isInteger(value.database.port) || value.database.port < 1 || value.database.port > 65535 || !IDENTIFIER.test(value.database.name ?? '') || !value.database.name.endsWith('_e2e') || value.database.schema !== 'public' || !IDENTIFIER.test(value.database.user ?? '')) fail('ENVIRONMENT_DATABASE_FORBIDDEN')
  if (typeof value.capabilities?.provision !== 'boolean' || value.capabilities.mail !== 'disabled' || typeof value.capabilities.reset !== 'boolean') fail('ENVIRONMENT_CAPABILITIES_INVALID')
  if (env.RESEND_API_KEY) fail('EXTERNAL_MAIL_FORBIDDEN')
  if ((env.AI_GATEWAY_API_KEY && !(env.AI_GATEWAY_API_KEY === MVP_DECISION_KEY && hasBoundMvpTransport(env))) || ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'COMPOSIO_API_KEY', 'E2B_API_KEY', 'EXPO_ACCESS_TOKEN', 'POSTHOG_SECRET_KEY'].some(name => Boolean(env[name])) || env.MIKKA_NATIVE_COORDINATOR === '1') fail('EXTERNAL_SERVICE_CREDENTIALS_FORBIDDEN')
  if (!env.E2E_DATABASE_URL || !env.MIKKA_DATABASE_URL || !env.DATABASE_URL) fail('DATABASE_TARGET_CONFIGURATION_REQUIRED')
  if (env.MIKKA_DATABASE_URL !== env.E2E_DATABASE_URL || env.DATABASE_URL !== env.E2E_DATABASE_URL || (env.ORVILO_DATABASE_URL && env.ORVILO_DATABASE_URL !== env.E2E_DATABASE_URL)) fail('DATABASE_FALLBACK_MISMATCH')
  const target = databaseTarget(env.E2E_DATABASE_URL)
  if (JSON.stringify(target) !== JSON.stringify(bindingValue(value).database)) fail('DATABASE_TARGET_MISMATCH')
  if (env.BETTER_AUTH_URL !== value.origin || (env.E2E_BASE_URL && env.E2E_BASE_URL !== value.origin)) fail('AUTH_ORIGIN_MISMATCH')
  if (env.MIKKA_TEST_DEPLOYMENT_SHA !== value.deploymentSha) fail('DEPLOYMENT_SHA_MISMATCH')
  return Object.freeze(bindingValue(value))
}

export async function loadEnvironment(env = process.env) {
  const path = env.MIKKA_TEST_ENVIRONMENT_FILE
  if (!path) fail('ENVIRONMENT_FILE_REQUIRED')
  try {
    const stat = await lstat(resolve(path))
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.size > 16384) fail('ENVIRONMENT_FILE_UNSAFE')
    const descriptor = JSON.parse(await readFile(resolve(path), 'utf8'))
    if (env.AI_GATEWAY_API_KEY === MVP_DECISION_KEY) {
      // Check every ordinary isolation/credential guard before even the local
      // challenge. Final validation still requires the actual current fetch
      // path to reach the isolated MVP preload; a key or flag is not proof.
      validateEnvironment(descriptor, { ...env, AI_GATEWAY_API_KEY: undefined })
      await verifyMvpTransport(env)
    }
    return validateEnvironment(descriptor, env)
  } catch (error) {
    if (error instanceof EnvironmentError) throw error
    fail('ENVIRONMENT_FILE_UNREADABLE')
  }
}

export async function assertDatabaseIdentity(client, descriptor) {
  // SELECT only, including the first call. The pool's prepare operation cannot
  // create the marker that would authorize its own writes.
  try {
    const actual = await client.query('SELECT current_database() AS name, current_schema() AS schema, session_user AS "user"')
    const row = actual.rows[0]
    if (row?.name !== descriptor.database.name || row?.schema !== descriptor.database.schema || row?.user !== descriptor.database.user) fail('ACTUAL_DATABASE_MISMATCH')
    const marker = await client.query('SELECT environment_id, instance_id, binding_sha256 FROM mikka_test_accounts.environment WHERE singleton = true')
    const record = marker.rows[0]
    if (marker.rowCount !== 1 || record.environment_id !== descriptor.id || record.instance_id !== descriptor.instanceId || record.binding_sha256 !== environmentFingerprint(descriptor)) fail('DATABASE_IDENTITY_MISMATCH')
  } catch (error) {
    if (error instanceof EnvironmentError) throw error
    fail('DATABASE_IDENTITY_UNAVAILABLE')
  }
}

/** Only test runners and the read-only attestation route call this; never log it. */
export async function readIdentityMaterial(client, descriptor) {
  await assertDatabaseIdentity(client, descriptor)
  const result = await client.query('SELECT attestation_key FROM mikka_test_accounts.environment WHERE singleton = true')
  const key = result.rows[0]?.attestation_key
  if (!/^[a-f0-9]{64}$/.test(key ?? '')) fail('DATABASE_ATTESTATION_UNAVAILABLE')
  return key
}

export function deploymentAttestation(descriptor, challenge, key) {
  if (!/^[a-f0-9]{64}$/.test(challenge ?? '')) fail('ATTESTATION_CHALLENGE_INVALID')
  return createHmac('sha256', key).update(`${environmentFingerprint(descriptor)}\n${challenge}`).digest('hex')
}

/** No cookies, registration, refresh, redirects or writes are permitted here. */
export async function assertDeploymentIdentity(descriptor, fetchImpl = fetch) {
  validateEnvironment(descriptor)
  const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL, max: 1, connectionTimeoutMillis: 5000, statement_timeout: 5000 })
  try {
    const key = await readIdentityMaterial(pool, descriptor)
    const challenge = randomBytes(32).toString('hex')
    const expected = deploymentAttestation(descriptor, challenge, key)
    const url = `${descriptor.origin}${descriptor.basePath}/api/test-environment?challenge=${challenge}`
    const response = await fetchImpl(url, { method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(10_000) })
    if (!response.ok || response.headers.has('set-cookie')) fail('DEPLOYMENT_ATTESTATION_REJECTED')
    let body
    try { body = new TextDecoder().decode(await readBoundedBody(response, 4096)) }
    catch { fail('DEPLOYMENT_ATTESTATION_REJECTED') }
    let result
    try { result = JSON.parse(body) } catch { fail('DEPLOYMENT_ATTESTATION_REJECTED') }
    if (result.environmentId !== descriptor.id || result.instanceId !== descriptor.instanceId || result.deploymentSha !== descriptor.deploymentSha || result.origin !== descriptor.origin || result.fingerprint !== environmentFingerprint(descriptor) || !/^[a-f0-9]{64}$/.test(result.proof ?? '') || !timingSafeEqual(Buffer.from(result.proof), Buffer.from(expected))) fail('DEPLOYMENT_IDENTITY_MISMATCH')
    return { environmentId: descriptor.id, deploymentSha: descriptor.deploymentSha, origin: descriptor.origin, fingerprint: result.fingerprint }
  } catch (error) {
    if (error instanceof EnvironmentError) throw error
    fail('DEPLOYMENT_IDENTITY_UNAVAILABLE')
  } finally { await pool.end() }
}
