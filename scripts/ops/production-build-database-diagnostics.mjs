import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const SOURCE = '75930406dda8708a84786475656ae449f5ffda88'
export const BASE = '19d22245c13f753fcf7d3e925eebfc5aaadc922b'
export const REF = 'refs/heads/ops/production-build-databases-20261108'
export const FILES = ['.github/workflows/infisical-cloud-capabilities.yml',
  'scripts/ops/production-build-database-diagnostics.mjs', 'scripts/ops/production-build-database-diagnostics.test.mjs']
const fail = code => { const error = new Error(code); error.code = code; throw error }
const hash = value => createHash('sha256').update(value).digest('hex')
const codes = ['28000', '28P01', '3D000', '42501', '53300', '53400', '57014', '57P01', '57P03', '08001', '08003', '08006', '08P01',
  'ECONNREFUSED', 'ECONNRESET', 'EAI_AGAIN', 'ENETUNREACH', 'ENOTFOUND', 'ETIMEDOUT', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'PROBE_SOURCE_SCOPE', 'PROBE_MAIN_CHANGED', 'PROBE_INPUT_REQUIRED', 'PROBE_READ_ONLY_REQUIRED', 'PROBE_HISTORY_INVALID', 'PROBE_METADATA_INVALID']
export const safeCode = error => codes.includes(error?.code) ? error.code : 'OTHER'

export function sourceGuard({ env, event, head, parent, changed, source }) {
  if (env.GITHUB_REPOSITORY !== 'alexj11324/Mikka' || env.GITHUB_ACTOR !== 'alexj11324' || env.GITHUB_REF !== REF
    || env.GITHUB_RUN_ATTEMPT !== '1' || event.repository?.id !== 1427517699 || event.repository?.owner?.id !== 183887963
    || event.repository?.fork !== false || event.ref !== REF || event.deleted || event.forced || event.after !== head
    || env.GITHUB_SHA !== head || !/^[a-f0-9]{40}$/.test(head) || parent !== BASE || source !== SOURCE
    || changed.length !== FILES.length || [...changed].sort().some((path, i) => path !== [...FILES].sort()[i])) fail('PROBE_SOURCE_SCOPE')
}

export const METADATA_SQL = `SELECT current_database() AS database, current_user AS role,
  current_setting('transaction_read_only') = 'on' AS read_only,
  has_schema_privilege('public', 'USAGE') AS schema_usage, has_schema_privilege('public', 'CREATE') AS schema_create,
  (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='public' AND c.relname IN ('byos_connections','model_api_keys','user')) AS model_tables,
  (SELECT bool_and(pg_has_role(c.relowner, 'USAGE')) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='public' AND c.relname IN ('byos_connections','model_api_keys','user')) AS owns_model_tables`
export const HISTORY_SQL = 'SELECT name FROM schema_migrations ORDER BY name'

export async function inspectTarget(pool, target, files, helpers) {
  if (!['MIKKA_DATABASE_URL', 'DATABASE_URL'].includes(target)) fail('PROBE_INPUT_REQUIRED')
  const row = (await pool.query(METADATA_SQL)).rows?.[0]
  if (row?.read_only !== true) fail('PROBE_READ_ONLY_REQUIRED')
  if (typeof row.database !== 'string' || typeof row.role !== 'string' || !Number.isSafeInteger(row.model_tables)) fail('PROBE_METADATA_INVALID')
  const names = (await pool.query(HISTORY_SQL)).rows.map(row => row.name)
  if (names.length > 1000 || !names.every(name => typeof name === 'string' && /^\d{4,14}_[a-z0-9_-]+\.sql$/.test(name))) fail('PROBE_HISTORY_INVALID')
  const pending = files.filter(file => file.plan.target === target), applied = new Set(names)
  let missing
  try {
    helpers.validateScopeMigrationHistory(pending, applied)
    missing = pending.filter(file => !helpers.alreadyApplied(file.name, applied, file.sql)).map(file => file.name)
  } catch (cause) { const error = new Error('PROBE_HISTORY_INVALID', { cause }); error.code = 'PROBE_HISTORY_INVALID'; throw error }
  return { target, connected: true, readOnly: true, databaseHash: hash(row.database), roleHash: hash(row.role),
    schemaUsage: row.schema_usage === true, schemaCreate: row.schema_create === true,
    modelTableCount: row.model_tables, ownsModelTables: row.owns_model_tables === true,
    appliedMigrationCount: names.length, historyValid: true, pendingMigrationCount: missing.length,
    pendingMigrationNames: missing.slice(0, 5), pendingNamesTruncated: missing.length > 5 }
}

async function run() {
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const root = process.cwd(), sourceRoot = resolve(root, 'diagnostic-source'), env = process.env
  sourceGuard({ env, event: JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')), head: git(root, 'rev-parse', 'HEAD'),
    parent: git(root, 'rev-parse', 'HEAD^'), changed: git(root, 'diff', '--name-only', 'HEAD^', 'HEAD').split('\n'),
    source: git(sourceRoot, 'rev-parse', 'HEAD') })
  const response = await fetch('https://api.github.com/repos/alexj11324/Mikka/git/ref/heads/main', {
    headers: { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(10000) })
  if (!response.ok || (await response.json()).object?.sha !== SOURCE) fail('PROBE_MAIN_CHANGED')
  if (process.argv[2] === '--preflight') { console.log(JSON.stringify({ event: 'production_build_db_preflight', source: SOURCE, mutations: 0 })); return }
  if (process.argv[2] !== '--inspect') fail('PROBE_INPUT_REQUIRED')
  const load = name => import(pathToFileURL(resolve(sourceRoot, 'scripts', name)).href)
  const [connection, order, steps, scope] = await Promise.all([
    load('postgres-connection.mjs'), load('migration-order.mjs'), load('migration-steps.mjs'), load('scope-migration-history.mjs')])
  const { Pool } = createRequire(resolve(sourceRoot, 'package.json'))('pg')
  const files = order.orderMigrations(readdirSync(resolve(sourceRoot, 'drizzle')).filter(name => name.endsWith('.sql')))
    .map(name => { const sql = readFileSync(resolve(sourceRoot, 'drizzle', name), 'utf8'); return { name, sql, plan: steps.planMigration(name, sql) } })
  scope.validateScopeMigrationSources(files)
  const receipts = []
  for (const target of ['MIKKA_DATABASE_URL', 'DATABASE_URL']) {
    let pool
    try {
      if (!env[target]) fail('PROBE_INPUT_REQUIRED')
      pool = new Pool({ connectionString: connection.directDatabaseURL(env[target]), max: 1,
        connectionTimeoutMillis: 10000, idleTimeoutMillis: 1000,
        options: '-c default_transaction_read_only=on -c statement_timeout=5000', application_name: 'mikka-build-db-diagnostics' })
      pool.on('error', () => {})
      receipts.push(await inspectTarget(pool, target, files, { ...order, ...scope }))
    } catch (error) { receipts.push({ target, status: 'failed', code: safeCode(error) }) }
    finally { await pool?.end() }
  }
  console.log(JSON.stringify({ event: 'production_build_db_diagnostics', source: SOURCE, input: 'existing_prod_vercel_secrets',
    readOnly: true, sqlMutations: 0, modelRequests: 0, receipts }))
  if (receipts.some(row => row.connected !== true)) process.exitCode = 1
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  run().catch(error => { console.error(JSON.stringify({ event: 'production_build_db_diagnostics_failed', code: safeCode(error) })); process.exitCode = 1 })
}
