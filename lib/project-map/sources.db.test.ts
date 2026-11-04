import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { Pool } from 'pg'
import { assertE2eTarget } from '../../tests/helpers/e2e-target.mjs'

const target = process.env.E2E_DATABASE_URL
if (target) {
  assertE2eTarget(target)
  assert.equal(process.env.MIKKA_DATABASE_URL, target)
  assert.equal(process.env.DATABASE_URL, target)
}
if (!target && process.env.REQUIRE_DB === '1') throw Error('An isolated source database is required')

// The service suite checks real owner/peer writes. This additional schema gate
// compiles every private-source lookup, including rarely populated question,
// artifact and group tables, against the migrated isolated database.
test('all source lookup SQL compiles against the real migrated schema', { skip: !target }, async t => {
  const pool = new Pool({ connectionString: target })
  t.after(() => pool.end())
  const source = await readFile(new URL('./sources.ts', import.meta.url), 'utf8')
  const queries = [...source.matchAll(/pool\.query(?:<[\s\S]*?>)?\((?:'((?:\\.|[^'\\])*)'|`([^`]*)`)/g)]
    .map(match => match[2] ?? match[1].replace(/\\([\\'])/g, '$1'))
  assert.ok(queries.length >= 17, 'every source-specific lookup must reach the schema gate')
  for (const query of queries) {
    const count = Math.max(...[...query.matchAll(/\$(\d+)/g)].map(match => Number(match[1])))
    const values = Array.from({ length: count }, () => '00000000-0000-4000-8000-000000000001')
    const result = await pool.query('EXPLAIN (FORMAT JSON) ' + query, values)
    assert.equal(result.rows.length, 1)
    assert.ok(result.rows[0]['QUERY PLAN'])
  }
})
