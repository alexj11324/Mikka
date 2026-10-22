import assert from 'node:assert/strict'
import test from 'node:test'
import { isPostgresUniqueViolation } from './unique-violation'

test('recognizes PostgreSQL unique violations directly and through Drizzle causes', () => {
  assert.equal(isPostgresUniqueViolation({ code: '23505' }), true)
  assert.equal(isPostgresUniqueViolation({ cause: { code: '23505' } }), true)
  assert.equal(isPostgresUniqueViolation(new Error('other database error')), false)
})
