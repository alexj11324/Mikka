import test from 'node:test'
import assert from 'node:assert/strict'
import { tasksOf, TASK_GROUPS } from './use-bot-tasks'

const issue = (id: string, status = 'doing', pullRequests: { url: string; state: 'open' | 'draft' | 'merged' | 'closed' }[] = []) =>
  ({ id, status, title: id, metadata: { pullRequests } }) as never
const thread = (id: string, issueId: string | null, status: string, createdAt: string, outcome: string | null = null) =>
  ({ id, issueId, status, createdAt, outcome, botId: 'bot', prompt: '', updatedAt: createdAt }) as never

test('a task is one row, grouped by its newest thread; threads without a listed task have none', () => {
  const groups = tasksOf([
    thread('r2', 'a', 'running', '2026-11-07T10:00:00Z'),
    thread('r1', 'a', 'failed', '2026-11-07T09:00:00Z'),
    thread('r3', 'b', 'waiting_input', '2026-11-07T08:00:00Z'),
    thread('r4', 'c', 'succeeded', '2026-11-07T07:00:00Z', 'idle'),
    thread('r5', 'd', 'succeeded', '2026-11-07T06:00:00Z', 'done'),
    thread('r6', null, 'running', '2026-11-07T05:00:00Z'),
    thread('r7', 'missing', 'running', '2026-11-07T04:00:00Z'),
  ], [issue('a'), issue('b'), issue('c', 'todo'), issue('d')])
  assert.deepEqual(TASK_GROUPS.map(group => groups[group].map(row => [row.issue.id, row.current.id, row.attempts])), [
    [['b', 'r3', 1]],
    [['a', 'r2', 2]],
    [['c', 'r4', 1]],
    [['d', 'r5', 1]],
  ])
})

test('a closed task is done whatever its thread is doing', () => {
  const groups = tasksOf([thread('r1', 'a', 'running', '2026-11-07T10:00:00Z')], [issue('a', 'canceled')])
  assert.equal(groups.done[0]?.issue.id, 'a')
})
