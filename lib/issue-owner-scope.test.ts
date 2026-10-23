import assert from 'node:assert/strict'
import test from 'node:test'
import { PgDialect } from 'drizzle-orm/pg-core'
import { issueOwnerScope } from './issue-owner-scope'

test('owner issue scope requires caller ownership or membership', () => {
  const { sql, params } = new PgDialect().sqlToQuery(issueOwnerScope('member', 'owner')!)
  assert.equal(sql, '("issues"."userId" = $1 and ("issues"."userId" = $2 or ("issues"."scope" = $3 and "issue_members"."userId" = "issues"."userId" and "issue_members"."memberId" = $4)))')
  assert.deepEqual(params, ['owner', 'member', 'workspace', 'member'])
})
