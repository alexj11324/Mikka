import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ChatTool } from './context'
import { toolAction, toolFailure, toolObjectId, toolSummary, toolTarget } from './tool-activity'

const tool = (name: string, extra: Partial<ChatTool> = {}): ChatTool => ({ call: name, name, state: 'done', ...extra })

test('a tool that answers an error is a failure, with its code as the reason', () => {
  assert.deepEqual(toolFailure(tool('dispatch_factory_task', { output: '{"error": "factoryNotFound"}' })), { failed: true, reason: 'factoryNotFound' })
  assert.deepEqual(toolFailure(tool('get_issue', { output: '{"ok": false, "reason": "notFound"}' })), { failed: true, reason: 'notFound' })
  assert.deepEqual(toolFailure(tool('dispatch_run', { state: 'error', output: 'no device' })), { failed: true, reason: 'no device' })
})

test('a result that only mentions an error further in is not a failure, and an empty result is not either', () => {
  assert.deepEqual(toolFailure(tool('list_runs', { output: '{"runs": [{"id": "r1", "error": "old"}]}' })), { failed: false, reason: null })
  assert.deepEqual(toolFailure(tool('list_runs', { output: '{"runs": [{"id": "r1", "ok": false}], "ok": true}' })), { failed: false, reason: null }, 'a nested ok:false is the item\'s')
  assert.deepEqual(toolFailure(tool('list_runs', { output: '{"runs": [{"id": "r1", "ok": false, "reason": "stale"' })), { failed: false, reason: null }, 'nor in a cut preview')
  assert.deepEqual(toolFailure(tool('get_run', { output: '{"error": "notFound", "detail": "' + 'x'.repeat(300) })), { failed: true, reason: 'notFound' }, 'a cut preview that opens with an error failed')
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
  assert.equal(toolAction('dispatch_factory_task'), 'dispatchFactory')
  assert.equal(toolAction('wake_bot_computer'), 'wake')
  assert.equal(toolAction('get_factory_task'), 'viewFactory')
  assert.equal(toolAction('resolve_factory_task'), 'factory')
  assert.equal(toolAction('schedule_create'), 'schedule')
  assert.equal(toolAction('mystery_tool'), 'other')
})

test('a summary counts only what succeeded, names side effects first, and counts failures apart', () => {
  const summary = toolSummary([
    tool('get_issue'), tool('list_runs'), tool('get_run'),
    tool('dispatch_run'),
    tool('dispatch_factory_task', { output: '{"error":"factoryNotFound"}' }),
    tool('get_issue', { state: 'running' }),
  ])
  // The failed Factory dispatch is not 「派发了」 anything: it is only in the failure count.
  assert.deepEqual(summary.parts, [{ action: 'dispatch', count: 1 }, { action: 'viewIssues', count: 1 }, { action: 'viewThreads', count: 2 }])
  assert.equal(summary.failed, 1)
  assert.deepEqual(summary.failedNames, ['dispatch_factory_task'])
})

test('a group in which every call failed has no success parts, only the failed tools', () => {
  const summary = toolSummary([tool('dispatch_factory_task', { output: '{"error":"factoryNotFound"}' }), tool('dispatch_factory_task', { state: 'error', output: 'boom' })])
  assert.deepEqual(summary.parts, [])
  assert.equal(summary.failed, 2)
  assert.deepEqual(summary.failedNames, ['dispatch_factory_task'])
})

test('a call that names a task or thread by id gives that id, for the chat to show its name', () => {
  assert.equal(toolObjectId(tool('get_run', { input: '{"runId": "r1"}' })), 'r1')
  assert.equal(toolObjectId(tool('list_runs', { input: '{"issueId": "i1", "limit": 5}' })), 'i1')
  assert.equal(toolObjectId(tool('web_search', { input: '{"query": "x"}' })), null)
})
