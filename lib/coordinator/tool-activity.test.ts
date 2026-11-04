import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ChatTool } from './context'
import { toolAction, toolFailure, toolSummary, toolTarget } from './tool-activity'

const tool = (name: string, extra: Partial<ChatTool> = {}): ChatTool => ({ call: name, name, state: 'done', ...extra })

test('a tool that answers an error is a failure, with its code as the reason', () => {
  assert.deepEqual(toolFailure(tool('dispatch_factory_task', { output: '{"error": "factoryNotFound"}' })), { failed: true, reason: 'factoryNotFound' })
  assert.deepEqual(toolFailure(tool('get_issue', { output: '{"ok": false, "reason": "notFound"}' })), { failed: true, reason: 'notFound' })
  assert.deepEqual(toolFailure(tool('dispatch_run', { state: 'error', output: 'no device' })), { failed: true, reason: 'no device' })
})

test('a result that only mentions an error further in is not a failure, and an empty result is not either', () => {
  assert.deepEqual(toolFailure(tool('list_runs', { output: '{"runs": [{"id": "r1", "error": "old"}]}' })), { failed: false, reason: null })
  assert.deepEqual(toolFailure(tool('list_issues', { output: '[]' })), { failed: false, reason: null })
})

test('a call names its object from its input, cut short, even from a truncated preview', () => {
  assert.equal(toolTarget(tool('get_issue', { input: '{"identifier": "ALEX-45", "id": "x"}' })), 'ALEX-45')
  assert.equal(toolTarget(tool('web_search', { input: '{"query": "shadcn trace"}' })), 'shadcn trace')
  assert.equal(toolTarget(tool('dispatch_run', { input: `{"issueId": "i1", "instruction": "${'很长'.repeat(60)}` })), `${'很长'.repeat(29)}很…`)
  assert.equal(toolTarget(tool('list_runs', { input: '{}' })), null)
})

test('every tool has an action; unknown tools are other, never a bare "used a tool"', () => {
  assert.equal(toolAction('dispatch_run'), 'dispatch')
  assert.equal(toolAction('get_factory_task'), 'viewFactory')
  assert.equal(toolAction('resolve_factory_task'), 'factory')
  assert.equal(toolAction('schedule_create'), 'schedule')
  assert.equal(toolAction('mystery_tool'), 'other')
})

test('a summary names side effects first and counts failures', () => {
  const summary = toolSummary([
    tool('get_issue'), tool('list_runs'), tool('get_run'),
    tool('dispatch_run'),
    tool('dispatch_factory_task', { output: '{"error":"factoryNotFound"}' }),
    tool('get_issue', { state: 'running' }),
  ])
  assert.deepEqual(summary.parts, [{ action: 'dispatch', count: 2 }, { action: 'viewIssues', count: 2 }, { action: 'viewThreads', count: 2 }])
  assert.equal(summary.failed, 1)
})
