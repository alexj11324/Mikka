import assert from 'node:assert/strict'
import test from 'node:test'
import { isIssueTeamAccessAllowed } from './issue-team-access-policy'

test('only active workspace members can access team-linked issues', () => {
  assert.equal(isIssueTeamAccessAllowed({ linked: false, allowed: false }), true)
  assert.equal(isIssueTeamAccessAllowed({ linked: true, allowed: true }), true)
  assert.equal(isIssueTeamAccessAllowed({ linked: true, allowed: false }), false)
})
