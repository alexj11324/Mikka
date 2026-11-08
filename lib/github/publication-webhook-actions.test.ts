import assert from 'node:assert/strict'
import test from 'node:test'
import { reviewRefreshEvent } from './publication-webhook-actions'

test('only already subscribed native review changes invalidate the Task review', () => {
  for (const action of ['submitted', 'edited', 'dismissed']) assert.equal(reviewRefreshEvent('pull_request_review', action), true)
  for (const action of ['created', 'edited', 'deleted']) assert.equal(reviewRefreshEvent('pull_request_review_comment', action), true)
  for (const event of ['check_run', 'check_suite', 'workflow_run', 'push', 'pull_request', 'issue_comment'])
    for (const action of ['submitted', 'edited', 'dismissed', 'created', 'deleted', 'completed']) assert.equal(reviewRefreshEvent(event, action), false)
  for (const action of [undefined, null, 1, {}, 'requested', 'labeled', '']) {
    assert.equal(reviewRefreshEvent('pull_request_review', action), false)
    assert.equal(reviewRefreshEvent('pull_request_review_comment', action), false)
  }
})
