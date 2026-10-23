import assert from 'node:assert/strict'
import test from 'node:test'
import { applyMigration, assertIndexValid, headerLines, planMigration } from './migration-steps.mjs'

const NOTX = '-- migrate: no-transaction\n'
const plan = (sql) => planMigration('x.sql', sql)
const rejects = (sql, pattern) => assert.throws(() => plan(sql), pattern)

test('a normal file is sent whole, in one transaction', () => {
  const sql = 'create table a (id int);\ncreate table b (id int);\n'
  assert.deepEqual(plan(sql), { target: 'MIKKA_DATABASE_URL', noTransaction: false, sql, concurrentIndex: null })
})

test('directives count only in the header (leading comment / blank lines)', () => {
  assert.equal(plan('-- note\n\n-- target: DATABASE_URL\ncreate table a (id int);\n').target, 'DATABASE_URL')
  // QA: `-- target:` after the first statement used to be honoured by a multiline regex.
  assert.equal(plan('create table a (id int);\n-- target: DATABASE_URL\n').target, 'MIKKA_DATABASE_URL')
  // QA: the marker after the first statement does not make the file no-transaction.
  assert.equal(plan('select 1;\n-- migrate: no-transaction\n').noTransaction, false)
  assert.deepEqual(headerLines('-- a\n\n-- b\nselect 1;\n-- c\n'), ['-- a', '', '-- b'])
})

test('no-transaction: exactly one statement, trailing semicolon optional, comments ignored', () => {
  const sql = `-- Trigram index.\n${NOTX}-- built without blocking writes; see MIK-16\ncreate index concurrently if not exists issues_title_trgm_idx\n  on issues using gin (title gin_trgm_ops); -- trailing; note\n`
  assert.deepEqual(plan(sql), { target: 'MIKKA_DATABASE_URL', noTransaction: true, sql, concurrentIndex: 'issues_title_trgm_idx' })
  assert.equal(plan(`${NOTX}/* block; comment */ create index concurrently "q_idx" on t (a)`).concurrentIndex, 'q_idx')
  assert.equal(plan(`${NOTX}create unique index concurrently u_idx on t (a);`).concurrentIndex, 'u_idx')
  assert.equal(plan(`${NOTX}alter type s add value if not exists 'x';`).concurrentIndex, null)
})

test('no-transaction rejects a second statement (QA: files used to be split on ;)', () => {
  rejects(`${NOTX}create extension if not exists pg_trgm;\ncreate index concurrently i on t (a);\n`, /exactly one statement/)
  rejects(`${NOTX}select 1; select 2`, /exactly one statement/)
  rejects(`${NOTX}select ';'`, /exactly one statement/)
})

test('no-transaction rejects any $ quoting', () => {
  rejects(`${NOTX}do $$ begin perform 1; end $$;`, /\$ quoting|exactly one/)
  rejects(`${NOTX}do $body$ select 1 $body$`, /\$ quoting/)
  rejects(`${NOTX}select $1`, /\$ quoting/)
})

test('no-transaction rejects BEGIN / COMMIT / END / ROLLBACK', () => {
  for (const word of ['begin', 'COMMIT', 'End', 'rollback']) rejects(`${NOTX}${word}`, new RegExp(word.toUpperCase()))
  rejects(`${NOTX}select case when true then 1 end`, /END/)
})

test('empty files and misplaced CONCURRENTLY are rejected', () => {
  rejects(`${NOTX}-- nothing\n`, /no statements/)
  rejects('-- only comments\n', /no statements/)
  rejects('create index concurrently i on t (a);', /no-transaction/)
  rejects(`${NOTX}reindex index concurrently i`, /only CREATE/)
})

test('assertIndexValid passes a valid index and fails a missing or INVALID one', async () => {
  const fake = (rows) => async () => ({ rows })
  await assertIndexValid(fake([{ indisvalid: true }]), 'i', 'x.sql')
  await assert.rejects(assertIndexValid(fake([]), 'i', 'x.sql'), /was not created/)
  await assert.rejects(assertIndexValid(fake([{ indisvalid: false }]), 'i', 'x.sql'), /INVALID.*DROP INDEX CONCURRENTLY IF EXISTS i;.*not recorded/)
})

test('index names are looked up the way Postgres stores them', () => {
  assert.equal(plan(`${NOTX}create index concurrently Issues_Title_Idx on t (a)`).concurrentIndex, 'issues_title_idx')
  assert.equal(plan(`${NOTX}create index concurrently if not exists "Issues_Title_Idx" on t (a)`).concurrentIndex, 'Issues_Title_Idx')
})

// QA tried these three by hand: comment markers and a semicolon inside string literals.
// The checks use the comment-stripped text; Postgres always gets the file unchanged.
test('QA string forms: the raw file is executed, never the stripped text', () => {
  const dashes = `${NOTX}create index concurrently d_idx on t (a) where b <> '--x'\n`
  assert.equal(plan(dashes).sql, dashes)
  const block = `${NOTX}create index concurrently b_idx on t (a) where b <> '/* x */'\n`
  assert.equal(plan(block).sql, block)
  // A semicolon inside a string is rejected conservatively (no SQL lexer).
  rejects(`${NOTX}create index concurrently s_idx on t (a) where b <> ';'`, /exactly one statement/)
})

// Integration test for the post-execution check (migrate.mjs -> applyMigration).
const databaseUrl = process.env.MIKKA_DATABASE_URL ?? process.env.ORVILO_DATABASE_URL
if (!databaseUrl && process.env.REQUIRE_DB === '1') test('database required', () => assert.fail('REQUIRE_DB=1 but no MIKKA_DATABASE_URL'))
const dbTest = databaseUrl ? test : test.skip

dbTest('applyMigration: INVALID index after execution fails and is not recorded', async (t) => {
  const { default: pg } = await import('pg')
  const client = new pg.Client({ connectionString: databaseUrl })
  await client.connect()
  const schema = `mig_test_${process.pid}_${Date.now()}`
  t.after(async () => { await client.query(`drop schema if exists ${schema} cascade`); await client.end() })
  await client.query(`create schema ${schema}; set search_path to ${schema}`)
  await client.query('create table schema_migrations (name text primary key); create table t (a int); insert into t values (1), (1)')
  const recorded = async () => (await client.query('select name from schema_migrations')).rows.map(r => r.name)

  const ok = `${NOTX}create index concurrently if not exists Ok_Idx on t (a)`
  await applyMigration(client, 'ok.sql', planMigration('ok.sql', ok))
  assert.deepEqual(await recorded(), ['ok.sql'], 'valid index (mixed-case name) is found and recorded')

  const dup = `${NOTX}create unique index concurrently if not exists u_idx on t (a)`
  const hints = []
  await assert.rejects(applyMigration(client, 'dup.sql', planMigration('dup.sql', dup), m => hints.push(m)), { code: '23505' })
  assert.match(hints.join('\n'), /u_idx is INVALID.*DROP INDEX CONCURRENTLY IF EXISTS u_idx/)
  // The statement now succeeds (IF NOT EXISTS skips the INVALID index); only the post-execution check catches it.
  await assert.rejects(applyMigration(client, 'dup.sql', planMigration('dup.sql', dup)), /u_idx is INVALID.*not recorded/)
  assert.deepEqual(await recorded(), ['ok.sql'], 'failed file not recorded')
})
