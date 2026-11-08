import assert from 'node:assert/strict'
import test from 'node:test'
import type { listIssues } from '../app/actions/issues'
import type { Thread } from '../app/actions/task-runs'
import { tasksOf, pendingTaskCount } from './use-bot-tasks'

test('web groups and window count use current task state, excluding blocked, failed, closed and old attempts', () => {
  const issues = ['reply', 'approval', 'review', 'quota', 'blocked', 'failed', 'closed', 'retry', 'relation'].map(id => ({ id, status: id === 'closed' ? 'done' : id === 'review' ? 'review' : 'todo', identifier: `MIK-${id}`, metadata: { pullRequests: [], blockedByIds: id === 'relation' ? ['retry'] : [] } })) as unknown as Awaited<ReturnType<typeof listIssues>>
  const threads = issues.map(issue => ({ id: issue.id, issueId: issue.id, createdAt: '2026-11-07T00:00:00Z', status: ({ reply: 'waiting_input', approval: 'running', quota: 'paused', failed: 'failed', closed: 'waiting_input', retry: 'running' } as Record<string, string>)[issue.id] ?? 'succeeded', outcome: issue.id === 'blocked' ? 'blocked' : 'idle', awaitingApproval: issue.id === 'approval' })) as Thread[]
  threads.push({ ...threads[0], id: 'older', issueId: 'retry', createdAt: '2026-11-06T00:00:00Z' })
  const groups = tasksOf(threads, issues)
  assert.equal(pendingTaskCount(threads, issues), 3)
  assert.deepEqual(groups.pending.map(row => row.state), ['waiting', 'waiting', 'waiting', 'blocked', 'blocked', 'failed'])
  assert.equal(groups.done[0].state, 'done')
  assert.equal(groups.running[0].current.id, 'retry')
  assert.equal(groups.running[0].attempts, 2)
  assert.deepEqual([groups.todo[0].reason, groups.todo[0].blockedBy], ['blocked_by', 'MIK-retry'])
})
