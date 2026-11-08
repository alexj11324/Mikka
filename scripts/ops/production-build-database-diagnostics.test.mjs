import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BASE, FILES, SOURCE, REF, HISTORY_SQL, METADATA_SQL, inspectTarget, safeCode, sourceGuard } from './production-build-database-diagnostics.mjs'

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
  const receipt = await inspectTarget(pool, 'MIKKA_DATABASE_URL', files, helpers)
  assert.equal(receipt.connected, true)
  assert.equal(receipt.readOnly, true)
  assert.equal(receipt.ownsModelTables, true)
  assert.deepEqual(receipt.pendingMigrationNames, ['20261108120101_enabled_models.sql'])
  assert.equal(pool.calls.length, 2)
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
