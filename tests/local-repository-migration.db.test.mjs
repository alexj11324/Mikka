import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, symlink, unlink, writeFile } from 'node:fs/promises'
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

// Immutable old candidate identities; production P0 filenames remain canonical.
const workspaceHistory = new Map([
  ['20261109035000_task_workspace_ownership.sql', '20261108120200_task_workspace_ownership.sql'],
  ['20261109035001_linear_workspace_policy.sql', '20261108120201_linear_workspace_policy.sql'],
  ['20261109035002_phone_push_session.sql', '20261108120202_phone_push_session.sql'],
  ['20261109035003_account_task_history.sql', '20261108120203_account_task_history.sql'],
  ['20261109143000_project_v2.sql', '20261108120300_project_v2.sql'],
  ['20261109143001_task_identity.sql', '20261108120301_task_identity.sql'],
  ['20261109143002_task_identity_aliases.sql', '20261108120302_task_identity_aliases.sql'],
  ['20261109143003_team_lifecycle.sql', '20261108120303_team_lifecycle.sql'],
  ['20261109143004_project_resources.sql', '20261108120304_project_resources.sql'],
  ['20261109143005_project_lifecycle.sql', '20261108120305_project_lifecycle.sql'],
  ['20261109143006_project_history_retention.sql', '20261108120306_project_history_retention.sql'],
  ['20261109143007_task_alias_tenant.sql', '20261108120307_task_alias_tenant.sql'],
  ['20261109143008_project_writer_fence.sql', '20261108120308_project_writer_fence.sql'],
  ['20261109143100_coding_review_sessions.sql', '20261108230400_coding_review_sessions.sql'],
  ['20261109143101_coding_review_task_workspace.sql', '20261108230500_coding_review_task_workspace.sql'],
  ['20261109143102_coding_review_task_thread.sql', '20261108230600_coding_review_task_thread.sql'],
])

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
    for (const name of ['migrate.mjs', 'postgres-connection.mjs', 'migration-order.mjs', 'migration-steps.mjs', 'migration-targets.mjs', 'migration-guard.mjs', 'preview-database-url.mjs', 'scope-migration-history.mjs', 'integration-migration-history.mjs', 'task-workspace-backfill.mjs', 'task-workspace-evidence.mjs', 'task-identity-backfill.mjs', 'project-v2-backfill.mjs'])
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
    const ledger = async pool => (await pool.query('SELECT name, "appliedAt" FROM schema_migrations ORDER BY name')).rows
    const triggerState = async (pool, names = null) => (await pool.query(`
      SELECT c.relname AS table_name, t.tgname AS trigger_name,
        t.tgdeferrable AS deferrable, t.tginitdeferred AS initially_deferred,
        pg_get_triggerdef(t.oid) AS definition, pg_get_functiondef(t.tgfoid) AS function_definition
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE NOT t.tgisinternal AND n.nspname='public' AND ($1::text[] IS NULL OR t.tgname=ANY($1::text[]))
      ORDER BY c.relname,t.tgname`, [names])).rows
    for (const historical of [old, '20261028143922_local_repository_defaults.sql']) {
      const existing = await fixture(historical)
      try {
        await migrate(existing.url); await migrate(existing.url)
        assert.deepEqual((await existing.pool.query('SELECT name FROM schema_migrations ORDER BY name')).rows.map(r => r.name), expectedNames(historical))
        assert.equal((await existing.pool.query("SELECT is_nullable FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='device_repos' AND column_name='baseBranch'")).rows[0].is_nullable, 'NO')
      } finally { await existing.pool.end() }
    }
    await t.test('published P0 upgrade preserves its ledger timestamps and tenant triggers', async () => {
      const fresh = await fixture(false)
      const additions = [...workspaceHistory.keys()].filter(name => !name.startsWith('202611090350'))
      assert.equal(additions.length, 12)
      try {
        // Run the actual main SQL set on a new isolated catalog, then upgrade
        // through the same entrypoint after adding this batch's twelve files.
        for (const name of additions) await unlink(join(root, 'drizzle', name))
        try { await migrate(fresh.url) }
        finally {
          for (const name of additions)
            await writeFile(join(root, 'drizzle', name), await readFile(new URL(name, migrationDirectory)))
        }
        const before = await ledger(fresh.pool)
        assert.equal(before.length, files.length - additions.length)
        const p0Triggers = ['preserve_task_workspace', 'require_run_task_workspace',
          'require_factory_task_workspace', 'require_artifact_task_workspace',
          'advance_issue_scope_generation', 'detach_personal_issue', 'preserve_linear_workspace_binding']
        const triggers = await triggerState(fresh.pool, p0Triggers)
        assert.equal(triggers.length, p0Triggers.length)
        await migrate(fresh.url); await migrate(fresh.url)
        const after = new Map((await ledger(fresh.pool)).map(row => [row.name, row]))
        for (const row of before) assert.deepEqual(after.get(row.name), row, 'main ledger identity and appliedAt are unchanged')
        assert.deepEqual(await triggerState(fresh.pool, p0Triggers), triggers, 'batch upgrade retains published tenant enforcement')
        assert.deepEqual((await fresh.pool.query('SELECT name FROM schema_migrations ORDER BY name')).rows.map(r => r.name), expectedNames())
        assert.equal((await fresh.pool.query("SELECT is_nullable FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='device_repos' AND column_name='baseBranch'")).rows[0].is_nullable, 'YES')
      } finally { await fresh.pool.end() }
    })
    await t.test('old complete candidate receipts never replay P0, Project or Coding trigger bodies', async () => {
      const candidate = await fixture(false)
      try {
        await migrate(candidate.url)
        // The exact SQL has run. Only this isolated synthetic ledger adopts
        // its known byte-identical old candidate names; no production receipt
        // is inferred or rewritten by the migration runner.
        for (const [canonical, previous] of workspaceHistory)
          assert.equal((await candidate.pool.query('UPDATE schema_migrations SET name=$1 WHERE name=$2', [previous, canonical])).rowCount, 1)
        const before = await ledger(candidate.pool), triggers = await triggerState(candidate.pool)
        assert.ok(triggers.some(row => row.trigger_name === 'coding_review_task_workspace_update'))
        assert.ok(triggers.some(row => row.trigger_name === 'workspace_projects_v2_writer_fence'))
        const newRunTriggers = triggers.filter(row => row.trigger_name === 'coding_review_new_run')
        assert.equal(newRunTriggers.length, 1)
        assert.equal(newRunTriggers[0].table_name, 'agent_runs')
        assert.equal(newRunTriggers[0].deferrable, true)
        assert.equal(newRunTriggers[0].initially_deferred, true)
        assert.match(newRunTriggers[0].definition, /^CREATE CONSTRAINT TRIGGER coding_review_new_run\b/,
          'the later task-thread migration replaces the immediate trigger with a deferred constraint trigger')
        await migrate(candidate.url); await migrate(candidate.url)
        assert.deepEqual(await ledger(candidate.pool), before, 'aliases preserve names and appliedAt instead of inserting replacement receipts')
        assert.deepEqual(await triggerState(candidate.pool), triggers, 'no old function or trigger body is replayed over its later refinement')
      } finally { await candidate.pool.end() }
    })
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
