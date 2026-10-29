#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, lstat, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Pool } from 'pg'
import { assertDatabaseIdentity, databaseTarget, environmentFingerprint, EnvironmentError, validateEnvironment } from './environment.mjs'
import { recordAuthenticationSecrets } from './session.mjs'

/** Capture the runner's existing secrets before a server or account can start. */
export async function recordRunnerEvidenceSecrets(environment) {
  validateEnvironment(environment)
  const authSecret = process.env.BETTER_AUTH_SECRET
  if (typeof authSecret !== 'string' || authSecret.length < 32) throw new EnvironmentError('RUNNER_AUTH_SECRET_REQUIRED')
  const databasePassword = decodeURIComponent(new URL(process.env.E2E_DATABASE_URL).password)
  await recordAuthenticationSecrets([authSecret, databasePassword], { environment })
}

/**
 * Only an owning test harness may install the initial marker. The normal CLI's
 * prepare/acquire/inspect paths never create one. authorizeDatabase must prove
 * this exact disposable resource belongs to the harness before the first DDL.
 */
export async function bootstrapEnvironment({ connectionString, origin, deploymentSha, id, outputFile, authorizeDatabase }) {
  if (typeof authorizeDatabase !== 'function') throw new EnvironmentError('DISPOSABLE_RESOURCE_OWNERSHIP_REQUIRED')
  const output = resolve(outputFile)
  let existing
  try {
    const stat = await lstat(output)
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new EnvironmentError('ENVIRONMENT_FILE_UNSAFE')
    existing = JSON.parse(await readFile(output, 'utf8'))
  } catch (error) { if (error.code !== 'ENOENT') throw new EnvironmentError('ENVIRONMENT_BOOTSTRAP_FILE_INVALID') }
  const descriptor = validateEnvironment({
    version: 1, id, kind: 'isolated-ci', origin, basePath: '/mikka', deploymentSha,
    database: databaseTarget(connectionString), instanceId: existing?.instanceId ?? randomUUID(),
    capabilities: { provision: true, mail: 'disabled', reset: true },
  })
  if (existing && environmentFingerprint(existing) !== environmentFingerprint(descriptor)) throw new EnvironmentError('ENVIRONMENT_BOOTSTRAP_BINDING_MISMATCH')
  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000, statement_timeout: 5000 })
  try {
    await authorizeDatabase(pool, descriptor)
    const actual = (await pool.query('SELECT current_database() AS name, current_schema() AS schema, session_user AS "user"')).rows[0]
    if (actual.name !== descriptor.database.name || actual.schema !== descriptor.database.schema || actual.user !== descriptor.database.user) throw new EnvironmentError('ACTUAL_DATABASE_MISMATCH')
    const marker = (await pool.query("SELECT to_regclass('mikka_test_accounts.environment') AS marker")).rows[0].marker
    if (marker) {
      if (!existing) throw new EnvironmentError('ENVIRONMENT_OWNERSHIP_FILE_REQUIRED')
      await assertDatabaseIdentity(pool, descriptor)
      return descriptor
    }
    if (existing) throw new EnvironmentError('ENVIRONMENT_EXISTING_MARKER_MISSING')
    // Never adopt pre-existing people. This bootstrap is run immediately after
    // disposable DB schema setup and before any account fixture creates a user.
    const authTable = (await pool.query("SELECT to_regclass('public.\"user\"') AS users")).rows[0].users
    if (authTable && (await pool.query('SELECT 1 FROM public."user" LIMIT 1')).rowCount) throw new EnvironmentError('ENVIRONMENT_DATABASE_NOT_FRESH')
    if ((await pool.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', ['mikka_test_accounts'])).rowCount) throw new EnvironmentError('ENVIRONMENT_NAMESPACE_ALREADY_EXISTS')
    await pool.query('BEGIN')
    try {
      await pool.query('CREATE SCHEMA mikka_test_accounts')
      await pool.query(`CREATE TABLE mikka_test_accounts.environment (
        singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
        environment_id text NOT NULL,
        instance_id uuid NOT NULL,
        binding_sha256 text NOT NULL,
        attestation_key text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp()
      )`)
      await pool.query('INSERT INTO mikka_test_accounts.environment (environment_id, instance_id, binding_sha256, attestation_key) VALUES ($1,$2,$3,$4)', [descriptor.id, descriptor.instanceId, environmentFingerprint(descriptor), randomBytes(32).toString('hex')])
      await pool.query('COMMIT')
    } catch (error) { await pool.query('ROLLBACK'); throw error }
    await mkdir(dirname(output), { recursive: true, mode: 0o700 })
    await writeFile(output, `${JSON.stringify(descriptor, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
    return descriptor
  } catch (error) {
    if (error instanceof EnvironmentError) throw error
    throw new EnvironmentError('ENVIRONMENT_BOOTSTRAP_FAILED')
  } finally { await pool.end() }
}

async function main() {
  const args = process.argv.slice(2)
  if (args.length !== 2 || args[0] !== '--output') throw new EnvironmentError('USAGE_BOOTSTRAP_OUTPUT_FILE')
  const env = process.env
  if (process.platform !== 'linux' || env.CI !== 'true' || env.GITHUB_ACTIONS !== 'true' || env.RUNNER_ENVIRONMENT !== 'github-hosted' || !/^\d+$/.test(env.GITHUB_RUN_ID ?? '') || !env.GITHUB_WORKSPACE) throw new EnvironmentError('OWNED_GITHUB_SERVICE_REQUIRED')
  let sha
  try { sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', cwd: env.GITHUB_WORKSPACE }).trim() } catch { throw new EnvironmentError('CHECKED_OUT_SHA_UNAVAILABLE') }
  if (sha !== env.MIKKA_TEST_DEPLOYMENT_SHA) throw new EnvironmentError('CHECKED_OUT_SHA_MISMATCH')
  const target = databaseTarget(env.E2E_DATABASE_URL)
  if (target.host !== '127.0.0.1' || target.port !== 5432 || target.name !== 'mikka_e2e' || target.user !== 'e2e') throw new EnvironmentError('OWNED_GITHUB_SERVICE_MISMATCH')
  const descriptor = await bootstrapEnvironment({
    connectionString: env.E2E_DATABASE_URL, origin: env.BETTER_AUTH_URL, deploymentSha: sha,
    id: `github-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT ?? '1'}`,
    outputFile: args[1],
    authorizeDatabase: async pool => {
      // Workflow-owned PG service, never a server discovered through PG* fallbacks.
      const server = (await pool.query('SELECT inet_server_addr() AS address, inet_server_port() AS port')).rows[0]
      if (!server.address || server.port !== 5432) throw new EnvironmentError('OWNED_GITHUB_SERVICE_UNVERIFIED')
    },
  })
  // A startup failure may precede the first account acquisition. Its log still
  // needs the real runner secret inventory; do not invent an account or let the
  // scanner accept a missing store. Account credentials/cookies append later.
  await recordRunnerEvidenceSecrets(descriptor)
  console.log(JSON.stringify({ environmentId: descriptor.id, deploymentSha: descriptor.deploymentSha, origin: descriptor.origin, status: 'prepared' }))
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error('Test environment bootstrap blocked; verify the disposable resource, exact SHA and environment configuration.'); process.exitCode = 1 })
}
