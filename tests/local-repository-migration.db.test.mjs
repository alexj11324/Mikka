import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { Pool } from 'pg'
import { disposableDatabase } from './helpers/e2e-target.mjs'

const old = '20261028020000_local_repository_defaults.sql'
const current = '20261029022353_local_repository_defaults.sql'
const baseline = '20261023221259_application_baseline.sql'
const run = promisify(execFile)

test('migration runner handles historical and new names without replay and rejects changed SQL', { skip: !process.env.PR359_MIGRATION_TEST_URL && process.env.REQUIRE_DB !== '1' && !disposableDatabase(), timeout: 120000 }, async (t) => {
  const target = new URL(process.env.PR359_MIGRATION_TEST_URL || process.env.E2E_DATABASE_URL)
  assert.ok(['postgres:', 'postgresql:'].includes(target.protocol) && !target.search && !target.hash)
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname))
  assert.ok(target.pathname === '/mikka_alias_test' || disposableDatabase(process.env, target.toString()))
  const root = await mkdtemp(join(tmpdir(), 'pr359-migration-'))
  const admin = new Pool({ connectionString: target.toString() })
  const databases = []
  const migrationDirectory = new URL('../drizzle/', import.meta.url)
  const files = (await readdir(migrationDirectory)).filter(name => name.endsWith('.sql')).sort()
  assert.ok(files.includes(baseline) && files.includes(current))
  const expectedNames = historical => files.map(name => name === current && historical ? historical : name).sort()
  const sql = await readFile(new URL('../drizzle/' + current, import.meta.url), 'utf8')
  try {
    await mkdir(join(root, 'scripts')); await mkdir(join(root, 'drizzle'))
    for (const name of ['migrate.mjs', 'migration-order.mjs', 'migration-steps.mjs', 'migration-targets.mjs', 'migration-guard.mjs', 'preview-database-url.mjs', 'scope-migration-history.mjs', 'integration-migration-history.mjs'])
      await writeFile(join(root, 'scripts', name), await readFile(new URL('../scripts/' + name, import.meta.url)))
    await symlink(new URL('../node_modules', import.meta.url).pathname, join(root, 'node_modules'))
    // The production runner validates the complete scope manifest before DDL.
    // Exercise that same runner and SQL, not a shortened manifest or fake ledger.
    for (const name of files)
      await writeFile(join(root, 'drizzle', name), await readFile(new URL(name, migrationDirectory)))
    async function fixture(historical) {
      const name = 'pr359_' + randomUUID().replaceAll('-', '')
      // Historical migrations inspect some constraint names database-wide;
      // each retained fixture gets its own catalog and extension namespace.
      await admin.query(`CREATE DATABASE "${name}"`)
      databases.push(name)
      const url = new URL(target); url.pathname = `/${name}`
      const pool = new Pool({ connectionString: url.toString() })
      if (historical) {
        await migrate(url.toString())
        // The actual canonical SQL has executed. Give this synthetic receipt
        // its byte-identical historical name before exercising alias handling.
        assert.equal((await pool.query('UPDATE schema_migrations SET name=$1 WHERE name=$2', [historical,current])).rowCount,1)
        // If the renamed SQL runs again, this deliberately restored constraint disappears.
        await pool.query('ALTER TABLE device_repos ALTER COLUMN "baseBranch" SET NOT NULL')
      }
      return { pool, url: url.toString() }
    }
    async function migrate(url) {
      return run(process.execPath, [join(root, 'scripts/migrate.mjs')], { env: { ...process.env, MIGRATE:'1', VERCEL_ENV:'', DATABASE_URL:url, MIKKA_DATABASE_URL:url } })
    }
    for (const historical of [old, '20261028143922_local_repository_defaults.sql']) {
      const existing = await fixture(historical)
      try {
        await migrate(existing.url); await migrate(existing.url)
        assert.deepEqual((await existing.pool.query('SELECT name FROM schema_migrations ORDER BY name')).rows.map(r => r.name), expectedNames(historical))
        assert.equal((await existing.pool.query("SELECT is_nullable FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='device_repos' AND column_name='baseBranch'")).rows[0].is_nullable, 'NO')
      } finally { await existing.pool.end() }
    }
    const fresh = await fixture(false)
    try {
      await migrate(fresh.url); await migrate(fresh.url)
      assert.deepEqual((await fresh.pool.query('SELECT name FROM schema_migrations ORDER BY name')).rows.map(r => r.name), expectedNames())
      assert.equal((await fresh.pool.query("SELECT is_nullable FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='device_repos' AND column_name='baseBranch'")).rows[0].is_nullable, 'YES')
    } finally { await fresh.pool.end() }
    const conflict = await fixture(old)
    try {
      await writeFile(join(root, 'drizzle', current), sql + '\n-- unexpected change\n')
      await assert.rejects(migrate(conflict.url), /equivalent migration content changed/)
      assert.deepEqual((await conflict.pool.query('SELECT name FROM schema_migrations ORDER BY name')).rows.map(r => r.name), expectedNames(old))
      assert.equal((await conflict.pool.query("SELECT is_nullable FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='device_repos' AND column_name='baseBranch'")).rows[0].is_nullable, 'NO')
    } finally { await conflict.pool.end() }
  } finally {
    t.diagnostic(`Retained migration fixtures: directory=${root}; databases=${databases.join(',')}`)
    await admin.end()
  }
})
