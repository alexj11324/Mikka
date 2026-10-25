import assert from 'node:assert/strict'
import test from 'node:test'
import { APPLICATION_BASELINE, orderMigrations } from './migration-order.mjs'

test('only the explicit baseline precedes legacy migrations, without changing their IDs', () => {
  const names = ['20261024000000_future.sql', '0004_b.sql', APPLICATION_BASELINE, '0001_a.sql', '0004_a.sql']
  assert.deepEqual(orderMigrations(names), [APPLICATION_BASELINE, '0001_a.sql', '0004_a.sql', '0004_b.sql', '20261024000000_future.sql'])
  assert.equal(names[0], '20261024000000_future.sql', 'does not mutate caller input')
})
test('missing baseline fails before connecting to any database', () => {
  assert.throws(() => orderMigrations(['0001_a.sql']), /missing required baseline/)
})
