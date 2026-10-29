import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { Pool } from 'pg'

const old = '20261028020000_local_repository_defaults.sql'
const current = '20261029022353_local_repository_defaults.sql'
const baseline = '20261023221259_application_baseline.sql'
const run = promisify(execFile)

test('migration runner handles historical and new names without replay and rejects changed SQL', { skip: !process.env.PR359_MIGRATION_TEST_URL && process.env.REQUIRE_DB !== '1', timeout: 30000 }, async (t) => {
  const target = new URL(process.env.PR359_MIGRATION_TEST_URL || process.env.E2E_DATABASE_URL)
  assert.ok(['postgres:', 'postgresql:'].includes(target.protocol) && !target.search && !target.hash)
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname))
  assert.ok(target.pathname === '/mikka_alias_test' || (process.env.CI === 'true' && target.pathname === '/mikka_e2e'))
  const root = await mkdtemp(join(tmpdir(), 'pr359-migration-'))
  const admin = new Pool({ connectionString: target.toString() })
  const schemas = []
  const sql = await readFile(new URL('../drizzle/' + current, import.meta.url), 'utf8')
  try {
    await mkdir(join(root, 'scripts')); await mkdir(join(root, 'drizzle'))
    for (const name of ['migrate.mjs', 'migration-order.mjs', 'migration-steps.mjs', 'migration-targets.mjs', 'preview-database-url.mjs'])
      await writeFile(join(root, 'scripts', name), await readFile(new URL('../scripts/' + name, import.meta.url)))
    await symlink(new URL('../node_modules', import.meta.url).pathname, join(root, 'node_modules'))
    await writeFile(join(root, 'drizzle', baseline), 'SELECT 1;\n')
    await writeFile(join(root, 'drizzle', current), sql)
    async function fixture(historical) {
      const name = 'pr359_' + randomUUID().replaceAll('-', '')
      schemas.push(name)
      await admin.query(`CREATE SCHEMA "${name}"`)
      const url = new URL(target); url.searchParams.set('options', `-c search_path=${name}`)
      const pool = new Pool({ connectionString: url.toString() })
      await pool.query('CREATE TABLE device_repos ("baseBranch" text NOT NULL); CREATE TABLE agent_runs ("baseBranch" text NOT NULL); CREATE TABLE schema_migrations (name text PRIMARY KEY, "appliedAt" timestamptz NOT NULL DEFAULT now())')
      if (historical) {
        await pool.query(sql)
        await pool.query('INSERT INTO schema_migrations(name) VALUES ($1)', [historical])
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
        assert.deepEqual((await existing.pool.query('SELECT name FROM schema_migrations ORDER BY name')).rows.map(r => r.name), [historical, baseline].sort())
        assert.equal((await existing.pool.query("SELECT is_nullable FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='device_repos' AND column_name='baseBranch'")).rows[0].is_nullable, 'NO')
      } finally { await existing.pool.end() }
    }
    const fresh = await fixture(false)
    try {
      await migrate(fresh.url); await migrate(fresh.url)
      assert.deepEqual((await fresh.pool.query('SELECT name FROM schema_migrations ORDER BY name')).rows.map(r => r.name), [baseline, current].sort())
      assert.equal((await fresh.pool.query("SELECT is_nullable FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='device_repos' AND column_name='baseBranch'")).rows[0].is_nullable, 'YES')
    } finally { await fresh.pool.end() }
    const conflict = await fixture(old)
    try {
      await writeFile(join(root, 'drizzle', current), sql + '\n-- unexpected change\n')
      await assert.rejects(migrate(conflict.url), /equivalent migration content changed/)
      assert.deepEqual((await conflict.pool.query('SELECT name FROM schema_migrations ORDER BY name')).rows.map(r => r.name), [old, baseline].sort())
      assert.equal((await conflict.pool.query("SELECT is_nullable FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='device_repos' AND column_name='baseBranch'")).rows[0].is_nullable, 'NO')
    } finally { await conflict.pool.end() }
  } finally {
    t.diagnostic(`Retained migration fixtures: directory=${root}; schemas=${schemas.join(',')}`)
    await admin.end()
  }
})
