import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { ciIssueAuthorized } from './authority'
const issue = { userId: 'owner', scope: 'workspace', scopeVersion: 3, content: {} }
const deleted = (content: unknown) => Boolean((content as { deleted?: boolean }).deleted)

test('owner or still-active workspace member may receive only the current nondeleted issue', () => {
  assert.equal(ciIssueAuthorized(issue, 'owner', 3, false, deleted), true)
  assert.equal(ciIssueAuthorized(issue, 'member', 3, true, deleted), true)
  assert.equal(ciIssueAuthorized(issue, 'member', 3, false, deleted), false)
  assert.equal(ciIssueAuthorized({ ...issue, scope: 'personal' }, 'member', 3, true, deleted), false)
  assert.equal(ciIssueAuthorized(issue, 'member', 2, true, deleted), false)
  assert.equal(ciIssueAuthorized({ ...issue, content: { deleted: true } }, 'owner', 3, false, deleted), false)
  assert.equal(ciIssueAuthorized(undefined, 'owner', 3, false, deleted), false)
})
