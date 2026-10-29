import assert from 'node:assert/strict'
import test from 'node:test'
import { requireLockedIssueScope } from './issue-scope-authorization'

test('locked scope preserves owner access and only the still-authorized publication for a teammate', () => {
  for (const scope of ['personal', 'workspace']) assert.doesNotThrow(() => requireLockedIssueScope({ userId: 'owner', scope, scopeVersion: 4 }, 'owner', 1))
  assert.doesNotThrow(() => requireLockedIssueScope({ userId: 'owner', scope: 'workspace', scopeVersion: 2 }, 'member', 2))
  for (const row of [undefined, { userId: 'owner', scope: 'personal', scopeVersion: 2 }, { userId: 'owner', scope: 'workspace', scopeVersion: 4 }]) {
    assert.throws(() => requireLockedIssueScope(row, 'member', 2), { code: 'issueNotFound' })
  }
})
