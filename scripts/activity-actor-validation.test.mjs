import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { planMigration } from './migration-steps.mjs'

test('actor checks are validated independently in replay-safe standalone files', () => {
  for (const [name, constraint] of [
    ['20261031044135_validate_activity_actor_type.sql', 'issue_versions_actor_type_check'],
    ['20261031044136_validate_activity_actor_id.sql', 'issue_versions_actor_id_needs_type_check'],
  ]) {
    const sql = readFileSync(`drizzle/${name}`, 'utf8')
    const plan = planMigration(name, sql)
    assert.equal(plan.noTransaction, true)
    assert.equal(plan.target, 'MIKKA_DATABASE_URL')
    assert.match(sql, new RegExp(`ALTER TABLE issue_versions VALIDATE CONSTRAINT ${constraint};`, 'i'))
  }
})
