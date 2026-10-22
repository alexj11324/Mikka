import assert from 'node:assert/strict'
import test from 'node:test'
import { PgDialect } from 'drizzle-orm/pg-core'
import { issueOwnerScope } from './issue-owner-scope'

test('owner issue scope requires caller ownership or membership', () => {
  const { sql, params } = new PgDialect().sqlToQuery(issueOwnerScope('member', 'owner')!)
  assert.equal(sql, '("issues"."userId" = $1 and ("issues"."userId" = $2 or "issue_members"."memberId" = $3))')
  assert.deepEqual(params, ['owner', 'member', 'member'])
})
