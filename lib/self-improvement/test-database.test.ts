import assert from 'node:assert/strict'
import test from 'node:test'
import { improvementTestDatabase } from './test-database'

const dedicated = 'postgresql://improvement@127.0.0.1:55437/mikka_improvement'
const target = 'postgresql://e2e:test@127.0.0.1:5432/mikka_e2e'
const ci = { CI: 'true', GITHUB_ACTIONS: 'true', REQUIRE_DB: '1', E2E_DATABASE_URL: target, MIKKA_DATABASE_URL: target, DATABASE_URL: target }

test('explicit isolated PG target and exact Actions service are accepted', () => {
  assert.equal(improvementTestDatabase({ IMPROVEMENT_TEST_URL: dedicated }), dedicated)
  assert.equal(improvementTestDatabase(ci), target)
})
test('absence is optional only outside a required DB gate; application URLs never supply it', () => {
  assert.equal(improvementTestDatabase({ MIKKA_DATABASE_URL: target, DATABASE_URL: target }), undefined)
  assert.throws(() => improvementTestDatabase({ REQUIRE_DB: '1' }), /refusing to skip/)
  assert.throws(() => improvementTestDatabase({ ...ci, E2E_DATABASE_URL: '' }), /refusing to skip/)
  assert.throws(() => improvementTestDatabase({ ...ci, GITHUB_ACTIONS: '' }), /refusing to skip/)
})
test('remote, application, malformed, query-bearing and mismatched targets fail closed', () => {
  for (const value of ['postgresql://remote.invalid/mikka_improvement', 'postgresql://localhost/mikka', target,
    `${dedicated}?options=-c%20search_path=public`, `${dedicated}#fragment`, 'https://localhost/mikka_improvement', 'not-a-url']) {
    assert.throws(() => improvementTestDatabase({ IMPROVEMENT_TEST_URL: value }))
  }
  for (const patch of [{ MIKKA_DATABASE_URL: dedicated }, { DATABASE_URL: dedicated }, { E2E_DATABASE_URL: dedicated.replace('/mikka_improvement', '/production') }]) {
    assert.throws(() => improvementTestDatabase({ ...ci, ...patch }))
  }
})
