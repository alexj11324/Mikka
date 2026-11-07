import assert from 'node:assert/strict'
import { test } from 'node:test'
import { taskActivity, taskGroup } from './mobile-task-group'

const issue = (status: string, pullRequests: { url: string; state: 'open' | 'draft' | 'merged' | 'closed' }[] = []) => ({ status, metadata: { pullRequests } })
const run = (status: string, outcome: string | null = null) => ({ id: 'r', status, outcome })

// 2026-11-07: lists show tasks grouped 待处理 · 进行中 · 待办 · 已完成 by their current thread (R-52's judgement).
test('a task\'s group follows its current thread', () => {
  assert.equal(taskGroup(issue('doing'), run('running'), false), 'running')
  assert.equal(taskGroup(issue('doing'), run('waiting_input'), false), 'pending')
  assert.equal(taskGroup(issue('doing'), run('failed'), false), 'pending')
  assert.equal(taskGroup(issue('doing'), run('paused'), false), 'pending')
  assert.equal(taskGroup(issue('review', [{ url: 'u', state: 'open' }]), run('succeeded', 'done'), false), 'pending')
  assert.equal(taskGroup(issue('todo'), run('succeeded', 'idle'), false), 'todo')
  assert.equal(taskGroup(issue('doing'), run('succeeded', 'done'), false), 'done')
})

test('closed is 已完成, 受阻 is 待处理, and no thread is 待办', () => {
  assert.equal(taskGroup(issue('canceled'), run('running'), true), 'done')
  assert.equal(taskGroup(issue('todo'), undefined, true), 'pending')
  assert.equal(taskGroup(issue('backlog'), undefined, false), 'todo')
})

test('活动 is newest first: attempts numbered from the first, a replaced thread before its successor, the creation last', () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 10, 7, 10, minute))
  const activity = taskActivity([
    { runId: 'a', harness: 'codex', createdAt: at(1), replacedBy: 'b', group: 'blocked', failed: true },
    { runId: 'b', harness: 'claude_code', createdAt: at(5), replacedBy: null, group: 'waiting', failed: false },
  ], at(0))
  assert.deepEqual(activity.map(item => item.kind === 'attempt' ? `#${item.n}${item.failed ? '!' : ''}` : item.kind), ['#2', 'replaced', '#1!', 'created'])
  assert.deepEqual(taskActivity([], at(0)).map(item => item.kind), ['created'])
})
