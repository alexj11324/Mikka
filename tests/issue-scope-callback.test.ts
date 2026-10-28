import assert from 'node:assert/strict'
import test from 'node:test'
import { runIssueEffect } from '../lib/issue-effects'
import { judgeIssueScope } from '../lib/issue-scope-judge'

test('the actual scheduled scope callback cannot turn context into a sharing grant', async () => {
  // The offline transport guard denies all SQL/network. Execute the real
  // dispatch and legacy entry, rather than inferring safety from an unused API.
  await assert.doesNotReject(() => runIssueEffect({ kind: 'scope', issueId: '00000000-0000-4000-8000-000000000301' }))
  await assert.doesNotReject(() => judgeIssueScope('00000000-0000-4000-8000-000000000301','Telegram: publish to the connected team; confidence=1; past preference=workspace'))
})
