// Required suite: executes only in the shared GitHub Actions ephemeral PG17 service.
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyMigration, planMigration } from '../scripts/migration-steps.mjs'
import { validateTarget } from '../scripts/run-db-tests.mjs'

// The test body includes DELETE; block it until preservation review is complete.

// Fail closed even when accidentally invoked locally, before importing/connecting pg.
validateTarget(process.env)
const { Client } = await import('pg')
const NOTX = '-- migrate: no-transaction\n'

test('PG17: the real runner converges fresh and upgraded databases with an older missing migration', async t => {
  const client = new Client({ connectionString: process.env.E2E_DATABASE_URL })
  await client.connect()
  const databases = []
  t.after(async () => {
    try { for (const name of databases) await client.query('DROP DATABASE ' + name) }
    finally { await client.end() }
  })
  const root = mkdtempSync(join(tmpdir(), 'migration-ledger-'))
  const scripts = join(root, 'scripts'), directory = join(root, 'drizzle')
  mkdirSync(scripts); mkdirSync(directory)
  const actualScripts = fileURLToPath(new URL('../scripts/', import.meta.url))
  const actualMigrations = fileURLToPath(new URL('../drizzle/', import.meta.url))
  // The actual command, helpers, audited source SQL and pg stay intact. Only
  // independent fixture migrations and disposable target databases are added.
  writeFileSync(join(scripts, 'migrate.mjs'), readFileSync(new URL('../scripts/migrate.mjs', import.meta.url)))
  for (const name of readdirSync(actualScripts).filter(name => name.endsWith('.mjs') && name !== 'migrate.mjs')) symlinkSync(join(actualScripts, name), join(scripts, name))
  symlinkSync(fileURLToPath(new URL('../node_modules/', import.meta.url)), join(root, 'node_modules'), 'dir')
  const existing = readdirSync(actualMigrations).filter(name => name.endsWith('.sql'))
  for (const name of existing) writeFileSync(join(directory, name), readFileSync(join(actualMigrations, name)))
  const older = '20261112000000_rails_ledger_older.sql', newer = '20261112040000_rails_ledger_newer.sql'
  const olderSql = 'CREATE TABLE rails_older_feature(id integer); INSERT INTO rails_older_feature VALUES (1);'
  writeFileSync(join(directory, newer), 'CREATE TABLE rails_newer_feature(id integer); INSERT INTO rails_newer_feature VALUES (2);')
  const target = name => { const url = new URL(process.env.E2E_DATABASE_URL); url.pathname = '/' + name; return url.href }
  const run = name => {
    const url = target(name)
    const result = spawnSync(process.execPath, [join(scripts, 'migrate.mjs')], {
      cwd: root, encoding: 'utf8', env: { ...process.env, MIGRATE: '1', VERCEL: '', VERCEL_ENV: '',
        E2E_DATABASE_URL: url, MIKKA_DATABASE_URL: url, DATABASE_URL: url },
    })
    assert.equal(result.status, 0, result.stderr)
    return [...result.stdout.matchAll(/migrate: applied (\S+) to/g)].map(match => match[1])
  }
  const snapshot = async name => {
    const connection = new Client({ connectionString: target(name) })
    await connection.connect()
    try { return {
      columns: (await connection.query("SELECT table_name,column_name,data_type FROM information_schema.columns WHERE table_schema='public' AND table_name LIKE 'rails_%' ORDER BY table_name,ordinal_position")).rows,
      rows: (await connection.query("SELECT 'older' kind,id FROM rails_older_feature UNION ALL SELECT 'newer' kind,id FROM rails_newer_feature ORDER BY kind")).rows,
      applied: (await connection.query('SELECT name FROM schema_migrations ORDER BY name')).rows.map(row => row.name),
    } } finally { await connection.end() }
  }
  const results = []
  for (const mode of ['fresh', 'upgrade']) {
    const name = 'rails_migration_' + mode + '_' + randomUUID().replaceAll('-', '') + '_e2e'
    assert.match(name, /^rails_migration_(fresh|upgrade)_[a-f0-9]{32}_e2e$/)
    await client.query('CREATE DATABASE ' + name)
    databases.push(name)
    if (mode === 'fresh') writeFileSync(join(directory, older), olderSql)
    else unlinkSync(join(directory, older))
    run(name)
    if (mode === 'upgrade') {
      writeFileSync(join(directory, older), olderSql)
      assert.deepEqual(run(name), [older], 'only the lower-timestamp missing file runs after a newer file was recorded')
    }
    const complete = await snapshot(name)
    assert.deepEqual(complete.applied, [...existing, older, newer].sort())
    assert.deepEqual(run(name), [], 'a retry replays no recorded file')
    assert.deepEqual(await snapshot(name), complete)
    results.push(complete)
  }
  assert.deepEqual(results[0], results[1], 'fresh replay and the lower-timestamp upgrade converge')
  console.log('Retained real migration runner fixture: ' + root)
})

test('PG17: nontransactional indexes, invalid retry, ledger and separate validation', async (t) => {
  const client = new Client({ connectionString: process.env.E2E_DATABASE_URL })
  await client.connect()
  const version = Number((await client.query('show server_version_num')).rows[0].server_version_num)
  assert.ok(version >= 170000 && version < 180000, 'Requires PostgreSQL 17')
  const schema = `migration_steps_${randomUUID().replaceAll('-', '')}`
  t.after(async () => {
    console.log(`Retained migration steps schema: ${schema}`)
    await client.end()
  })
  await client.query(`create schema ${schema}; set search_path to ${schema}`)
  await client.query('create table schema_migrations (name text primary key); create table t (a int); insert into t values (1), (1)')
  const recorded = async () => (await client.query('select name from schema_migrations order by name')).rows.map(r => r.name)
  const apply = (name, sql, log) => applyMigration(client, name, planMigration(name, sql), log)

  // A normal multi-statement file still executes atomically as one query.
  await assert.rejects(apply('rollback.sql', 'create table rolled_back (id int); select 1/0;'), { code: '22012' })
  assert.equal((await client.query("select to_regclass('rolled_back') as name")).rows[0].name, null)
  assert.deepEqual(await recorded(), [])

  const ok = `${NOTX}create index concurrently if not exists Ok_Idx on t (a)`
  await apply('ok.sql', ok)
  assert.deepEqual(await recorded(), ['ok.sql'], 'successful concurrent index is outside implicit transaction and recorded')
  const dup = `${NOTX}create unique index concurrently if not exists u_idx on t (a)`
  const hints = []
  await assert.rejects(apply('dup.sql', dup, message => hints.push(message)), { code: '23505' })
  assert.match(hints.join('\n'), /u_idx is INVALID.*DROP INDEX CONCURRENTLY/)
  const valid = async (name) => (await client.query('select i.indisvalid from pg_index i join pg_class c on c.oid = i.indexrelid join pg_namespace n on n.oid = c.relnamespace where c.relname = $1 and n.nspname = $2', [name, schema])).rows.map(r => r.indisvalid)
  assert.deepEqual(await valid('u_idx'), [false], 'the failed build left an INVALID index')
  // Retry of the unrecorded file: its own INVALID index (same table, same schema) is dropped and rebuilt;
  // the data still has duplicates, so the rebuild fails again and nothing is recorded.
  const retryLog = []
  await assert.rejects(apply('dup.sql', dup, message => retryLog.push(message)), { code: '23505' })
  assert.match(retryLog.join('\n'), new RegExp(`u_idx on ${schema}\\.t is INVALID from a failed concurrent build; dropping and rebuilding`))
  assert.deepEqual(await recorded(), ['ok.sql'], 'INVALID retry never enters ledger')
  await client.query('delete from t; insert into t values (1), (2)')
  await apply('dup.sql', dup)
  assert.deepEqual(await valid('u_idx'), [true], 'the retry dropped the INVALID index and rebuilt it')
  assert.deepEqual(await recorded(), ['dup.sql', 'ok.sql'])

  // QA #431: a decoy INVALID index with the file's index name, but on another table (and one in another
  // schema), is never dropped; only an INVALID index on pending_actions in this schema would be.
  await client.query('create table pending_actions (a int); create table decoy (a int); insert into decoy values (1), (1)')
  await client.query(`create schema ${schema}_other; create table ${schema}_other.pending_actions (a int); insert into ${schema}_other.pending_actions values (1), (1)`)
  t.after(async () => { console.log(`Retained decoy schema: ${schema}_other`) })
  await assert.rejects(client.query('create unique index concurrently decoy_idx on decoy (a)'), { code: '23505' })
  await assert.rejects(client.query(`create unique index concurrently other_idx on ${schema}_other.pending_actions (a)`), { code: '23505' })
  assert.deepEqual(await valid('decoy_idx'), [false])
  const decoyLog = []
  await assert.rejects(apply('decoy.sql', `${NOTX}create index concurrently if not exists decoy_idx on pending_actions (a)`, m => decoyLog.push(m)), /decoy_idx is INVALID.*not recorded/)
  assert.deepEqual(await valid('decoy_idx'), [false], 'the decoy on another table is still there, still INVALID')
  assert.equal(decoyLog.some(m => /dropping/.test(m)), false)
  assert.equal((await client.query("select r.relname from pg_index i join pg_class c on c.oid = i.indexrelid join pg_class r on r.oid = i.indrelid where c.relname = 'decoy_idx'")).rows[0].relname, 'decoy')
  // Same table name, other schema: not this file's index either (the file targets current_schema()).
  await apply('other.sql', `${NOTX}create index concurrently if not exists other_idx on pending_actions (a)`)
  assert.deepEqual((await client.query(`select n.nspname, i.indisvalid from pg_index i join pg_class c on c.oid = i.indexrelid join pg_namespace n on n.oid = c.relnamespace where c.relname = 'other_idx' order by 1`)).rows, [{ nspname: schema, indisvalid: true }, { nspname: `${schema}_other`, indisvalid: false }])
  assert.deepEqual(await recorded(), ['dup.sql', 'ok.sql', 'other.sql'])

  // General no-transaction statements are supported, not just concurrent indexes.
  await apply('constraint.sql', `${NOTX}alter table t add constraint positive check (a > 0) not valid`)
  // A second session can validate after the ADD query returns: its table lock was
  // released. First prove this assertion would fail while an exclusive lock is held.
  const other = new Client({ connectionString: process.env.E2E_DATABASE_URL })
  await other.connect()
  t.after(async () => { await other.end() })
  await other.query(`set search_path to ${schema}`)
  await other.query("set lock_timeout = '500ms'")
  const validation = planMigration('validate.sql', `${NOTX}alter table t validate constraint positive`)
  await client.query('begin; lock table t in access exclusive mode')
  try {
    await assert.rejects(applyMigration(other, 'validate.sql', validation), { code: '55P03' })
    assert.deepEqual(await recorded(), ['constraint.sql', 'dup.sql', 'ok.sql', 'other.sql'])
  } finally { await client.query('rollback') }
  await applyMigration(other, 'validate.sql', validation)
  assert.equal((await client.query("select convalidated from pg_constraint where conrelid='t'::regclass and conname='positive'")).rows[0].convalidated, true)
  assert.deepEqual(await recorded(), ['constraint.sql', 'dup.sql', 'ok.sql', 'other.sql', 'validate.sql'])
})
