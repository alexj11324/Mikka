import assert from 'node:assert/strict'
import test from 'node:test'
import { toolApprovalDefault } from './composio-tool-hints'

test('a write asks by default only when its tool says destructive, or says nothing', () => {
  assert.equal(toolApprovalDefault(['important', 'openWorldHint']), 'allow')
  assert.equal(toolApprovalDefault([]), 'allow')
  assert.equal(toolApprovalDefault(['destructiveHint', 'idempotentHint']), 'ask')
  assert.equal(toolApprovalDefault(undefined), 'ask')
  assert.equal(toolApprovalDefault('destructiveHint'), 'ask')
})
