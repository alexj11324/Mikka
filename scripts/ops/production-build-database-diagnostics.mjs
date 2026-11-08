import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const SOURCE = 'c275637ed73966875610da7f831548d566868a62'
export const BASE = 'e676918397ff546d8b2c749946975906d397b477'
export const REF = 'refs/heads/ops/production-build-databases-20261108'
export const FILES = ['.github/workflows/infisical-cloud-capabilities.yml',
  'scripts/ops/production-build-database-diagnostics.mjs', 'scripts/ops/production-build-database-diagnostics.test.mjs']
const fail = code => { const error = new Error(code); error.code = code; throw error }
const hash = value => createHash('sha256').update(value).digest('hex')
const codes = ['28000', '28P01', '3D000', '42501', '53300', '53400', '57014', '57P01', '57P03', '08001', '08003', '08006', '08P01',
  'ECONNREFUSED', 'ECONNRESET', 'EAI_AGAIN', 'ENETUNREACH', 'ENOTFOUND', 'ETIMEDOUT', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'PROBE_SOURCE_SCOPE', 'PROBE_MAIN_CHANGED', 'PROBE_INPUT_REQUIRED', 'PROBE_READ_ONLY_REQUIRED', 'PROBE_HISTORY_INVALID', 'PROBE_METADATA_INVALID']
export const safeCode = error => codes.includes(error?.code) ? error.code : 'OTHER'
export function compilerExit(value) {
  if (typeof value !== 'string' || !/^\d{1,3}$/.test(value) || Number(value) > 255) fail('PROBE_METADATA_INVALID')
  return Number(value)
}

// Match the original builder's file codec and nonempty-job precedence, while
// reading only the two database keys needed for this read-only diagnostic.
export function databaseInputs(text, env) {
  const file = new Map()
  for (const line of text.split('\n')) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
    if (!match || !['MIKKA_DATABASE_URL', 'DATABASE_URL'].includes(match[1])) continue
    const raw = match[2].trim()
    let value = raw
    if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
      try { value = JSON.parse(raw) } catch { value = raw.slice(1, -1) }
    } else if (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2) value = raw.slice(1, -1)
    file.set(match[1], value)
  }
  const values = {}, sources = {}
  for (const target of ['MIKKA_DATABASE_URL', 'DATABASE_URL']) {
    if (!file.has(target)) fail('PROBE_INPUT_REQUIRED')
    values[target] = env[target] || file.get(target)
    if (!values[target]) fail('PROBE_INPUT_REQUIRED')
    sources[target] = env[target] ? 'nonempty_job' : 'vercel_file'
  }
  return { values, sources }
}

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

export async function inspectTarget(pool, target, files, helpers, observe = () => {}) {
  if (!['MIKKA_DATABASE_URL', 'DATABASE_URL'].includes(target)) fail('PROBE_INPUT_REQUIRED')
  observe('metadata-select')
  const row = (await pool.query(METADATA_SQL)).rows?.[0]
  if (row?.read_only !== true) fail('PROBE_READ_ONLY_REQUIRED')
  if (typeof row.database !== 'string' || typeof row.role !== 'string' || !Number.isSafeInteger(row.model_tables)) fail('PROBE_METADATA_INVALID')
  observe('history-select')
  const names = (await pool.query(HISTORY_SQL)).rows.map(row => row.name)
  if (names.length > 1000 || !names.every(name => typeof name === 'string' && /^\d{4,14}_[a-z0-9_-]+\.sql$/.test(name))) fail('PROBE_HISTORY_INVALID')
  const pending = files.filter(file => file.plan.target === target), applied = new Set(names)
  let missing
  observe('history-validation')
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

// Fixed catalog/settings reads on the original migrator session. No SET or DDL.
export const SESSION_SQL = `SELECT current_database() AS database, current_user AS role,
  current_setting('transaction_read_only') = 'on' AS transaction_read_only,
  current_setting('default_transaction_read_only') = 'on' AS default_read_only,
  pg_is_in_recovery() AS recovery, current_schema() = 'public' AS public_schema,
  to_regclass('schema_migrations') = to_regclass('public.schema_migrations') AS public_journal,
  to_regclass('byos_connections') = to_regclass('public.byos_connections') AS public_connections,
  to_regclass('model_api_keys') = to_regclass('public.model_api_keys') AS public_keys,
  current_setting('statement_timeout') <> '0' AS statement_timeout_configured,
  p.oid IS NOT NULL AS function_present,
  CASE WHEN p.oid IS NOT NULL THEN pg_has_role(p.proowner, 'USAGE') ELSE NULL END AS function_owned,
  CASE WHEN p.oid IS NOT NULL THEN p.prorettype = 'pg_catalog.trigger'::regtype ELSE NULL END AS function_returns_trigger
  FROM (SELECT to_regprocedure('model_api_key_catalogue_settings()') AS oid) f
  LEFT JOIN pg_proc p ON p.oid = f.oid`
const sessionFlags = ['transaction_read_only', 'default_read_only', 'recovery', 'public_schema', 'public_journal',
  'public_connections', 'public_keys', 'statement_timeout_configured', 'function_present']
export async function inspectDefaultSession(pool, target, directUrl) {
  if (!['MIKKA_DATABASE_URL', 'DATABASE_URL'].includes(target)) fail('PROBE_INPUT_REQUIRED')
  const row = (await pool.query({ text: SESSION_SQL, query_timeout: 5000 })).rows?.[0]
  if (!row || typeof row.database !== 'string' || typeof row.role !== 'string'
    || sessionFlags.some(key => typeof row[key] !== 'boolean')
    || ['function_owned', 'function_returns_trigger'].some(key => row.function_present
      ? typeof row[key] !== 'boolean' : row[key] !== null)) fail('PROBE_METADATA_INVALID')
  const host = new URL(directUrl).hostname
  return { target, connected: true, databaseHash: hash(row.database), roleHash: hash(row.role), hostnameHash: hash(host),
    expectedBranchEndpoint: host.split('.')[0] === 'ep-twilight-violet-b5lbqgbv',
    ...Object.fromEntries([...sessionFlags, 'function_owned', 'function_returns_trigger'].map(key => [key, row[key]])) }
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
  if (process.argv[2] === '--compiler-receipt') {
    const receiptRoot = resolve(root, 'diagnostic-receipt')
    if (git(receiptRoot, 'rev-parse', 'HEAD') !== '554ad12e56ca59452876cbbf88c28ddbe435f100') fail('PROBE_SOURCE_SCOPE')
    const { buildFailureEvidence } = await import(pathToFileURL(resolve(receiptRoot, 'scripts/release/build-vercel.mjs')).href)
    const exitStatus = compilerExit(env.COMPILER_EXIT)
    const log = readFileSync(resolve(env.RUNNER_TEMP, 'official-web-build.log'))
    const evidence = buildFailureEvidence({ result: { status: null, signal: null }, sourceSha: SOURCE,
      overlaySha: '0aef26958544fb9579c4d2b01dd1d34cfa22c051', log })
    console.log(JSON.stringify({ ...evidence, event: 'production_compiler_diagnostics', compilerWrapperExit: exitStatus,
      migrationSuppressed: true, deployed: false }))
    return
  }
  if (process.argv[2] === '--default-session') {
    const { productionBuildEnvironment } = await import(pathToFileURL(resolve(sourceRoot, 'scripts/release/build-vercel.mjs')).href)
    const buildEnv = productionBuildEnvironment({ text: readFileSync(resolve(sourceRoot, '.vercel/.env.production.local'), 'utf8'),
      env: { ...env, GITHUB_SHA: SOURCE }, sourceSha: SOURCE })
    // Preserve the original Ops event identity for the child's independent guard;
    // all PostgreSQL defaults and file/job values stay exactly as in the build.
    const child = spawnSync(process.execPath, [process.argv[1], '--default-session-child'], {
      cwd: root, env: { ...buildEnv, GITHUB_SHA: env.GITHUB_SHA }, stdio: 'inherit', timeout: 45000 })
    if (child.error || child.status !== 0) fail('PROBE_METADATA_INVALID')
    return
  }
  if (process.argv[2] === '--default-session-child') {
    const { directDatabaseURL } = await import(pathToFileURL(resolve(sourceRoot, 'scripts/postgres-connection.mjs')).href)
    const { Pool } = createRequire(resolve(sourceRoot, 'package.json'))('pg')
    const receipts = []
    for (const target of ['MIKKA_DATABASE_URL', 'DATABASE_URL']) {
      let pool
      try {
        if (!env[target]) fail('PROBE_INPUT_REQUIRED')
        const url = directDatabaseURL(env[target])
        // Exact original migrator Pool options; do not override PGOPTIONS,
        // readonly, search_path, application_name or connection URL parameters.
        pool = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 10000, idleTimeoutMillis: 20000 })
        pool.on('error', () => {})
        receipts.push(await inspectDefaultSession(pool, target, url))
      } catch (error) { receipts.push({ target, status: 'failed', code: safeCode(error) }) }
      finally { await pool?.end() }
    }
    console.log(JSON.stringify({ event: 'production_migration_default_sessions', source: SOURCE,
      fixedSelects: 2, sqlMutations: 0, migrations: 0, modelRequests: 0, deployed: false, receipts }))
    if (receipts.some(row => row.connected !== true)) process.exitCode = 1
    return
  }
  if (process.argv[2] !== '--inspect') fail('PROBE_INPUT_REQUIRED')
  const load = name => import(pathToFileURL(resolve(sourceRoot, 'scripts', name)).href)
  const [connection, order, steps, scope] = await Promise.all([
    load('postgres-connection.mjs'), load('migration-order.mjs'), load('migration-steps.mjs'), load('scope-migration-history.mjs')])
  const { Pool } = createRequire(resolve(sourceRoot, 'package.json'))('pg')
  const inputs = databaseInputs(readFileSync(resolve(root, '.vercel/.env.production.local'), 'utf8'), env)
  const files = order.orderMigrations(readdirSync(resolve(sourceRoot, 'drizzle')).filter(name => name.endsWith('.sql')))
    .map(name => { const sql = readFileSync(resolve(sourceRoot, 'drizzle', name), 'utf8'); return { name, sql, plan: steps.planMigration(name, sql) } })
  scope.validateScopeMigrationSources(files)
  const receipts = []
  for (const target of ['MIKKA_DATABASE_URL', 'DATABASE_URL']) {
    let pool, stage = 'connection-input'
    try {
      pool = new Pool({ connectionString: connection.directDatabaseURL(inputs.values[target]), max: 1,
        connectionTimeoutMillis: 10000, idleTimeoutMillis: 1000,
        options: '-c default_transaction_read_only=on -c statement_timeout=5000', application_name: 'mikka-build-db-diagnostics' })
      pool.on('error', () => {})
      receipts.push(await inspectTarget(pool, target, files, { ...order, ...scope }, value => { stage = value }))
    } catch (error) { receipts.push({ target, status: 'failed', stage, code: safeCode(error) }) }
    finally { await pool?.end() }
  }
  console.log(JSON.stringify({ event: 'production_build_db_diagnostics', source: SOURCE, input: 'original_vercel_pull_and_job_precedence', inputSources: inputs.sources,
    readOnly: true, sqlMutations: 0, modelRequests: 0, receipts }))
  if (receipts.some(row => row.connected !== true)) process.exitCode = 1
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  run().catch(error => { console.error(JSON.stringify({ event: 'production_build_db_diagnostics_failed', code: safeCode(error) })); process.exitCode = 1 })
}
