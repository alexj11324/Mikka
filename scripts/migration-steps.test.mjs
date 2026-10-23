import assert from 'node:assert/strict'
import test from 'node:test'
import { isNonTransactional, migrationSteps } from './migration-steps.mjs'

test('a normal file is one query', () => {
  const sql = 'create table a (id int);\ncreate table b (id int);\n'
  assert.deepEqual(migrationSteps('x.sql', sql), [sql])
})

test('the marker splits a file into separate statements', () => {
  const sql = `-- Index for search.
-- migrate: no-transaction
create extension if not exists pg_trgm;
-- trigram index, built without blocking writes
create index concurrently if not exists issues_title_trgm_idx
  on issues using gin (title gin_trgm_ops);  -- trailing note
`
  assert.equal(isNonTransactional(sql), true)
  assert.deepEqual(migrationSteps('x.sql', sql), [
    'create extension if not exists pg_trgm',
    'create index concurrently if not exists issues_title_trgm_idx\n  on issues using gin (title gin_trgm_ops)',
  ])
})

test('the marker only counts in the header', () => {
  const sql = `${'select 1;\n'.repeat(12)}-- migrate: no-transaction\n`
  assert.equal(isNonTransactional(sql), false)
})

test('no-transaction files refuse $$ bodies and explicit transactions', () => {
  assert.throws(() => migrationSteps('x.sql', '-- migrate: no-transaction\ndo $$ begin end $$;\n'), /\$\$/)
  assert.throws(() => migrationSteps('x.sql', '-- migrate: no-transaction\nbegin;\nselect 1;\ncommit;\n'), /transaction/)
  assert.throws(() => migrationSteps('x.sql', '-- migrate: no-transaction\n-- nothing\n'), /no statements/)
})
