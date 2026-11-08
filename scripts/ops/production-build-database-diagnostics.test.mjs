import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BASE, FILES, SOURCE, REF, HISTORY_SQL, METADATA_SQL, compilerExit, databaseInputs, inspectTarget, inspectDefaultSession, SESSION_SQL, safeCode, sourceGuard } from './production-build-database-diagnostics.mjs'
import { REQUIRED, buildEnvironmentValues } from '../release/web-deploy.mjs'

const head = 'a'.repeat(40)
const env = { GITHUB_REPOSITORY: 'alexj11324/Mikka', GITHUB_ACTOR: 'alexj11324', GITHUB_REF: REF, GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: head }
const event = { repository: { id: 1427517699, owner: { id: 183887963 }, fork: false }, ref: REF, after: head, forced: false, deleted: false }
const input = { env, event, head, parent: BASE, changed: FILES, source: SOURCE }
test('only the reviewed three-file child and exact original source can reach authentication', () => {
  sourceGuard(input)
  for (const invalid of [{ source: head }, { parent: head }, { changed: FILES.slice(1) },
    { changed: [...FILES, 'unreviewed'] }, { env: { ...env, GITHUB_RUN_ATTEMPT: '2' } },
    { env: { ...env, GITHUB_REF: 'refs/heads/main' } }, { event: { ...event, forced: true } },
    { event: { ...event, repository: { ...event.repository, fork: true } } }]) {
    assert.throws(() => sourceGuard({ ...input, ...invalid }), { code: 'PROBE_SOURCE_SCOPE' })
  }
})

const metadata = { database: 'private-db-fixture', role: 'private-role-fixture', read_only: true,
  schema_usage: true, schema_create: true, model_tables: 3, owns_model_tables: true }
const files = [{ name: '20261108120101_enabled_models.sql', sql: 'private SQL fixture', plan: { target: 'MIKKA_DATABASE_URL' } }]
const helpers = { validateScopeMigrationHistory() {}, alreadyApplied(name, applied) { return applied.has(name) } }
const fakePool = (row = metadata, names = []) => ({ calls: [], async query(sql) {
  this.calls.push(sql)
  assert.ok(sql === METADATA_SQL || sql === HISTORY_SQL)
  assert.match(sql, /^SELECT /)
  return { rows: sql === METADATA_SQL ? [row] : names.map(name => ({ name })) }
} })
test('read-only metadata and original history functions emit no raw role, database or SQL', async () => {
  const pool = fakePool()
  const observed = []
  const receipt = await inspectTarget(pool, 'MIKKA_DATABASE_URL', files, helpers, value => { observed.push(value) })
  assert.equal(receipt.connected, true)
  assert.equal(receipt.readOnly, true)
  assert.equal(receipt.ownsModelTables, true)
  assert.deepEqual(receipt.pendingMigrationNames, ['20261108120101_enabled_models.sql'])
  assert.equal(pool.calls.length, 2)
  assert.deepEqual(observed, ['metadata-select', 'history-select', 'history-validation'])
  for (const value of [metadata.database, metadata.role, files[0].sql]) assert.equal(JSON.stringify(receipt).includes(value), false)
})
test('a writable session fails before any migration-history read', async () => {
  const pool = fakePool({ ...metadata, read_only: false })
  await assert.rejects(inspectTarget(pool, 'MIKKA_DATABASE_URL', files, helpers), { code: 'PROBE_READ_ONLY_REQUIRED' })
  assert.equal(pool.calls.length, 1)
})
test('invalid target and unbounded or malformed history fail closed', async () => {
  await assert.rejects(inspectTarget(fakePool(), 'OTHER', files, helpers), { code: 'PROBE_INPUT_REQUIRED' })
  for (const names of [['private unexpected name'], Array.from({ length: 1001 }, () => '0001_fixture.sql')]) {
    await assert.rejects(inspectTarget(fakePool(metadata, names), 'DATABASE_URL', files, helpers), { code: 'PROBE_HISTORY_INVALID' })
  }
})
test('migration history errors retain only a fixed code, and pending names are bounded', async () => {
  await assert.rejects(inspectTarget(fakePool(), 'MIKKA_DATABASE_URL', files, { ...helpers,
    validateScopeMigrationHistory() { throw new Error('private-sql-fixture') } }), { code: 'PROBE_HISTORY_INVALID' })
  const many = Array.from({ length: 9 }, (_, n) => ({ ...files[0], name: `000${n}_fixture.sql` }))
  const receipt = await inspectTarget(fakePool(), 'MIKKA_DATABASE_URL', many, helpers)
  assert.equal(receipt.pendingMigrationCount, 9)
  assert.equal(receipt.pendingMigrationNames.length, 5)
  assert.equal(receipt.pendingNamesTruncated, true)
})
test('only fixed connection and authorization codes leave the process', () => {
  assert.equal(safeCode({ code: '28P01', message: 'private-password' }), '28P01')
  assert.equal(safeCode({ code: 'PRIVATE_VALUE', message: 'private-password' }), 'OTHER')
  assert.equal(safeCode(new Error('postgresql://private:password@host/db')), 'OTHER')
})

test('the diagnostic matches original builder database precedence and escaping without other secrets', () => {
  const fileDb = 'postgresql://fixture:back\\$quote"@localhost/workspace_e2e'
  const app = 'postgresql://fixture:application@localhost/application_e2e'
  for (const jobDatabase of [undefined, '', app, 'postgresql://fixture:literal\\n@localhost/job_e2e']) {
    const file = ['VERCEL_ENV="production"', ...REQUIRED.map(key => `${key}=${JSON.stringify(key.endsWith('DATABASE_URL') ? fileDb : 'synthetic-fixture')}`)].join('\n')
    const job = { GITHUB_SHA: SOURCE, MIKKA_DATABASE_URL: app, DATABASE_URL: jobDatabase }
    const original = buildEnvironmentValues(file, job), actual = databaseInputs(file, job)
    for (const target of ['MIKKA_DATABASE_URL', 'DATABASE_URL']) assert.equal(actual.values[target], job[target] || original[target])
    assert.equal(actual.sources.MIKKA_DATABASE_URL, 'nonempty_job')
    assert.equal(actual.sources.DATABASE_URL, jobDatabase ? 'nonempty_job' : 'vercel_file')
    assert.deepEqual(Object.keys(actual.values).sort(), ['DATABASE_URL', 'MIKKA_DATABASE_URL'])
  }
  assert.throws(() => databaseInputs('DATABASE_URL=""', {}), { code: 'PROBE_INPUT_REQUIRED' })
  assert.throws(() => databaseInputs('DATABASE_URL="file"', { MIKKA_DATABASE_URL: app }), { code: 'PROBE_INPUT_REQUIRED' })
})

test('compiler exit input cannot contain raw errors, shell fragments or out-of-range values', () => {
  assert.equal(compilerExit('0'), 0)
  assert.equal(compilerExit('137'), 137)
  for (const value of [undefined, '', '-1', '256', '1; private-value', 'private-error', 1]) {
    assert.throws(() => compilerExit(value), { code: 'PROBE_METADATA_INVALID' })
  }
})

const session = { database: 'private-db', role: 'private-role', transaction_read_only: false, default_read_only: false,
  recovery: false, public_schema: true, public_journal: true, public_connections: true, public_keys: true,
  statement_timeout_configured: false, function_present: true, function_owned: true, function_returns_trigger: true }
test('default-session inspection preserves writable or read-only facts and only sends one fixed SELECT', async () => {
  for (const readonly of [true, false]) {
    const calls = []
    const receipt = await inspectDefaultSession({ async query(input) { calls.push(input); return { rows: [{ ...session,
      transaction_read_only: readonly, default_read_only: readonly }] } } }, 'MIKKA_DATABASE_URL',
    'postgresql://private:password@ep-twilight-violet-b5lbqgbv.fixture.neon.tech/private-db?options=private')
    assert.deepEqual(calls, [{ text: SESSION_SQL, query_timeout: 5000 }])
    assert.match(SESSION_SQL, /^SELECT /)
    assert.doesNotMatch(SESSION_SQL, /\b(SET|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/i)
    assert.equal(receipt.default_read_only, readonly)
    assert.equal(receipt.expectedBranchEndpoint, true)
    for (const secret of ['private-db', 'private-role', 'password', 'fixture.neon.tech', '?options=private']) {
      assert.equal(JSON.stringify(receipt).includes(secret), false)
    }
  }
})
test('function absence is explicit N/A; malformed, arbitrary or nullable catalog facts fail closed', async () => {
  const pool = row => ({ async query() { return { rows: [row] } } })
  const receipt = await inspectDefaultSession(pool({ ...session, function_present: false, function_owned: null,
    function_returns_trigger: null }), 'DATABASE_URL', 'postgres://fixture@localhost/db')
  assert.equal(receipt.function_owned, null)
  for (const row of [{ ...session, default_read_only: 'on' }, { ...session, public_keys: null },
    { ...session, function_owned: null }]) {
    await assert.rejects(inspectDefaultSession(pool(row), 'DATABASE_URL', 'postgres://fixture@localhost/db'),
      { code: 'PROBE_METADATA_INVALID' })
  }
})
