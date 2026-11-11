import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Pool } from 'pg'
import { sessionDatabaseURL } from './postgres-connection.mjs'

const generatedKeys = ['BETTER_AUTH_SECRET', 'WORKSPACE_SECRETS_KEY', 'CREDENTIAL_MASTER_KEY', 'DEVICE_GATEWAY_PUSH_SECRET', 'CRON_SECRET']

/** Atomically persist per-installation keys. Explicit environment values stay
 * in memory; the image never includes or prints an installation's secrets. */
export async function installationSecrets(directory, env) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, 'installation-secrets.json')
  let contents
  try { contents = await readFile(path, 'utf8') }
  catch (cause) {
    if (cause.code !== 'ENOENT') throw cause
    const generated = Object.fromEntries(generatedKeys.map(key => [key, randomBytes(32).toString('base64')]))
    const temporary = join(directory, `.installation-secrets-${randomUUID()}.json`)
    await writeFile(temporary, `${JSON.stringify(generated)}\n`, { flag: 'wx', mode: 0o600 })
    try { await link(temporary, path) }
    catch (error) { if (error.code !== 'EEXIST') throw error }
    finally { await unlink(temporary) }
    contents = await readFile(path, 'utf8')
  }
  let values
  try { values = JSON.parse(contents) }
  catch (cause) { throw new Error('SELF_HOSTED_SECRETS_INVALID', { cause }) }
  if (!values || typeof values !== 'object' || generatedKeys.some(key => typeof values[key] !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(values[key]))) {
    throw new Error('SELF_HOSTED_SECRETS_INVALID')
  }
  for (const key of generatedKeys) if (!env[key]) env[key] = values[key]
}

export function selfHostedEnvironment(env, root) {
  if (env.VERCEL || env.VERCEL_ENV) throw new Error('SELF_HOSTED_PLATFORM_ENV_REFUSED')
  env.BETTER_AUTH_URL ||= 'http://localhost:3000'
  let origin
  try { origin = new URL(env.BETTER_AUTH_URL) }
  catch (cause) { throw new Error('SELF_HOSTED_ORIGIN_INVALID', { cause }) }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)
  if ((origin.protocol !== 'https:' && !(origin.protocol === 'http:' && loopback)) || origin.username || origin.password
    || origin.pathname !== '/' || origin.search || origin.hash || origin.hostname.includes('*')) throw new Error('SELF_HOSTED_ORIGIN_INVALID')
  env.BETTER_AUTH_URL = origin.origin
  env.MIKKA_DATABASE_URL ||= env.DATABASE_URL
  env.DATABASE_URL ||= env.MIKKA_DATABASE_URL
  if (!env.MIKKA_DATABASE_URL || !env.DATABASE_URL) throw new Error('SELF_HOSTED_DATABASE_REQUIRED')
  env.WORKFLOW_TARGET_WORLD ||= 'local'
  if (env.WORKFLOW_TARGET_WORLD !== 'local') throw new Error('SELF_HOSTED_LOCAL_WORKFLOW_REQUIRED')
  env.MIKKA_DATA_DIR ||= join(root, 'data')
  env.WORKFLOW_LOCAL_DATA_DIR ||= join(env.MIKKA_DATA_DIR, 'workflow')
  // Nitro mounts the SDK consumers at the origin root, outside /mikka.
  // The SDK preserves this URL's pathname when appending its consumer route.
  env.WORKFLOW_LOCAL_BASE_URL ||= env.BETTER_AUTH_URL
  return env
}

/** Startup's cross-replica migration advisory lock owns a PostgreSQL session.
 * PgBouncer transaction pooling cannot preserve that session; use the
 * explicitly configured unpooled endpoint, or Neon's verified direct host.
 * Do not mutate the pooled URL used by normal application queries. */
export function migrationLockConnectionString(env) {
  return sessionDatabaseURL(env.MIKKA_DATABASE_URL, env)
}

async function migrate(root, env) {
  // One startup owns DDL, including the two logical databases, while another
  // replica waits. The lock belongs to this connection and dies with it.
  const pool = new Pool({ connectionString: migrationLockConnectionString(env), max: 1, connectionTimeoutMillis: 10_000 })
  const connection = await pool.connect()
  try {
    await connection.query("SET lock_timeout = '120s'")
    await connection.query("SELECT pg_advisory_lock(hashtextextended('mikka-self-hosted-migrations',0))")
    const child = spawn(process.execPath, ['scripts/migrate.mjs', '--allow-remote'], { cwd: root, env: { ...env, MIGRATE: '1' }, stdio: 'inherit' })
    const stop = signal => child.kill(signal)
    const terminate = () => stop('SIGTERM'), interrupt = () => stop('SIGINT')
    process.on('SIGTERM', terminate); process.on('SIGINT', interrupt)
    try {
      await new Promise((accept, reject) => {
        child.once('error', reject)
        child.once('exit', (code, signal) => code === 0 ? accept() : reject(new Error(`SELF_HOSTED_MIGRATION_FAILED:${signal || code}`)))
      })
    } finally { process.off('SIGTERM', terminate); process.off('SIGINT', interrupt) }
  } finally { connection.release(); await pool.end() }
}

export async function startSelfHosted(root = process.cwd(), env = process.env) {
  if (!process.version.startsWith('v24.')) throw new Error('SELF_HOSTED_NODE24_REQUIRED')
  selfHostedEnvironment(env, root)
  await installationSecrets(env.MIKKA_DATA_DIR, env)
  await mkdir(env.WORKFLOW_LOCAL_DATA_DIR, { recursive: true, mode: 0o700 })
  await migrate(root, env)
  await import(pathToFileURL(join(root, 'server/mikka-entry.mjs')).href)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await startSelfHosted() }
  catch (error) {
    // Database URLs, invalid persisted JSON and provider configuration can be
    // present in nested causes. Keep startup logs to a bounded product code.
    console.error(/^SELF_HOSTED_[A-Z0-9_:]+$/.test(error?.message ?? '') ? error.message : 'SELF_HOSTED_START_FAILED')
    process.exitCode = 1
  }
}
