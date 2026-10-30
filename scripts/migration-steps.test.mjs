import assert from 'node:assert/strict'
import test from 'node:test'
import { assertIndexValid, dropInvalidIndex, headerLines, planMigration } from './migration-steps.mjs'

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
  const sql = `-- Trigram index.\n${NOTX}-- built without blocking writes, see MIK-16\ncreate index concurrently if not exists issues_title_trgm_idx\n  on issues using gin (title gin_trgm_ops); -- trailing note\n`
  assert.deepEqual(plan(sql), { target: 'MIKKA_DATABASE_URL', noTransaction: true, sql, concurrentIndex: 'issues_title_trgm_idx' })
  assert.equal(plan(`${NOTX}/* block comment */ create index concurrently "q_idx" on t (a)`).concurrentIndex, 'q_idx')
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

test('no-transaction: the ; count must survive comment stripping', () => {
  rejects(`${NOTX}-- note; with a semicolon\ncreate index concurrently i on t (a)`, /; inside a comment/)
  rejects(`${NOTX}/* a; b */ create index concurrently i on t (a)`, /; inside a comment/)
  rejects(`${NOTX}create index concurrently i on t (a); -- trailing; note`, /; inside a comment/)
  // A ; inside a string after -- would be stripped along with it; the count catches it.
  rejects(`${NOTX}create index concurrently i on t (a) where b <> '--;'`, /; inside a comment/)
  assert.equal(plan(`${NOTX}-- plain note\ncreate index concurrently i on t (a);`).concurrentIndex, 'i')
})

test('all tracked SQL preflights without altering historical migration bytes', async () => {
  const { readdirSync, readFileSync } = await import('node:fs')
  const dir = new URL('../drizzle/', import.meta.url)
  for (const name of readdirSync(dir).filter(name => name.endsWith('.sql'))) {
    const sql = readFileSync(new URL(name, dir), 'utf8')
    const result = planMigration(name, sql)
    assert.equal(result.sql, sql)
    assert.equal(result.target, /^--\s*target:\s*(\w+)/m.exec(sql)?.[1] ?? 'MIKKA_DATABASE_URL', 'historical routing unchanged')
    if (name.startsWith('2026102601300') && /CREATE INDEX CONCURRENTLY/.test(sql)) {
      assert.equal(result.noTransaction, true)
      assert.ok(result.concurrentIndex)
      assert.throws(() => planMigration(name, sql + '\n'), /no-transaction/, 'compatibility requires exact historical bytes')
    }
  }
})

test('dropInvalidIndex drops only an INVALID index, concurrently; valid or missing is left alone', async () => {
  const calls = []
  const fake = (rows) => async (text, values) => { calls.push(text); return { rows: text.startsWith('select') ? rows : [] } }
  assert.equal(await dropInvalidIndex(fake([{ indisvalid: true }]), 'i', 'x.sql', () => {}), false)
  assert.equal(await dropInvalidIndex(fake([]), 'i', 'x.sql', () => {}), false)
  assert.equal(calls.some(c => /drop/i.test(c)), false)
  assert.equal(await dropInvalidIndex(fake([{ indisvalid: false }]), 'i', 'x.sql', () => {}), true)
  assert.equal(calls.at(-1), 'DROP INDEX CONCURRENTLY IF EXISTS "i"')
})
