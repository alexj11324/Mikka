import assert from 'node:assert/strict'
import test from 'node:test'
import { requireLockedIssueScope } from './issue-scope-authorization'

test('the locked row retains the authorized workspace and generation for every reader', () => {
  for (const reader of ['owner', 'member']) {
    for (const scope of ['personal', 'workspace']) assert.doesNotThrow(() => requireLockedIssueScope({ userId: 'owner', scope, workspaceId: 'alpha', scopeVersion: 2 }, reader, 2, 'alpha'))
    for (const row of [undefined, { workspaceId: null, scopeVersion: 2 }, { workspaceId: 'beta', scopeVersion: 2 }, { workspaceId: 'alpha', scopeVersion: 4 }]) {
      assert.throws(() => requireLockedIssueScope(row, reader, 2, 'alpha'), { code: 'issueNotFound' })
    }
    assert.throws(() => requireLockedIssueScope({ workspaceId: 'alpha', scopeVersion: 2 }, reader, 2, null), { code: 'issueNotFound' })
  }
})
