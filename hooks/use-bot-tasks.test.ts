import test from 'node:test'
import assert from 'node:assert/strict'
import { inboxCount, inboxSelection, localTaskState, pendingTaskCount, tasksOf, TASK_GROUPS } from './use-bot-tasks'

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

test('an In Review task with an open PR whose newest run succeeded without an outcome waits for review (F1503-18)', () => {
  const task = issue('a', 'review', [{ url: 'https://github.com/o/r/pull/17', state: 'open' }])
  assert.deepEqual(localTaskState(task, { status: 'succeeded', outcome: null }), { state: 'waiting', reason: 'review' })
})

test('a closed task is done whatever its thread is doing', () => {
  const groups = tasksOf([thread('r1', 'a', 'running', '2026-11-07T10:00:00Z')], [issue('a', 'canceled')])
  assert.equal(groups.done[0]?.issue.id, 'a')
})

test('each task gets one state; the hand is only 等你处理, and the count leaves 受阻 and 失败 out', () => {
  const issues = [issue('a'), issue('b'), issue('c'), issue('d', 'review'), issue('e'), issue('f', 'todo'), issue('g', 'backlog'), issue('h', 'duplicate'), issue('i')]
  const threads = [
    thread('ra', 'a', 'waiting_input', '2026-11-07T10:00:00Z'),
    thread('rb', 'b', 'failed', '2026-11-07T09:00:00Z'),
    thread('rc', 'c', 'queued', '2026-11-07T08:00:00Z'),
    thread('rd', 'd', 'succeeded', '2026-11-07T07:00:00Z', 'done'),
    thread('re', 'e', 'paused', '2026-11-07T06:00:00Z'),
    thread('rf', 'f', 'succeeded', '2026-11-07T05:00:00Z', 'idle'),
    thread('rg', 'g', 'running', '2026-11-07T04:00:00Z'),
    thread('rh', 'h', 'running', '2026-11-07T03:00:00Z'),
    thread('ri', 'i', 'succeeded', '2026-11-07T02:00:00Z'),
  ]
  const groups = tasksOf(threads, issues)
  const states = Object.fromEntries(TASK_GROUPS.flatMap(group => groups[group].map(row => [row.issue.id, [group, row.state, row.reason]])))
  assert.deepEqual(states, {
    a: ['pending', 'waiting', 'needsReply'], b: ['pending', 'failed', null], c: ['running', 'queued', null],
    d: ['pending', 'waiting', 'review'], e: ['pending', 'blocked', 'quota'], f: ['todo', 'idle', null],
    g: ['running', 'running', null], h: ['done', 'duplicate', null], i: ['pending', 'waiting', 'confirm'],
  })
  assert.equal(pendingTaskCount(threads, issues), 3)
})

test('with no attempt a task shows its board status: backlog is 暂不处理, others 待办', () => {
  assert.deepEqual(localTaskState(issue('a', 'backlog')), { state: 'idle', reason: null })
  assert.deepEqual(localTaskState(issue('a', 'todo')), { state: 'todo', reason: null })
  assert.deepEqual(localTaskState(issue('a'), { status: 'succeeded', outcome: 'blocked' }), { state: 'blocked', reason: null })
  assert.deepEqual(localTaskState(issue('a', 'done', [{ url: 'u', state: 'merged' }]), null), { state: 'done', reason: null })
})

test("收件箱's count is what it lists: one row per waiting task (not per thread), a task waiting on a question once, then questions and suggestions", () => {
  const issues = [issue('a'), issue('b'), issue('c'), issue('d')]
  const threads = [
    // Task a has had three threads, all waiting: it is one item, not three.
    thread('a3', 'a', 'waiting_input', '2026-11-07T10:00:00Z'),
    thread('a2', 'a', 'waiting_input', '2026-11-07T09:00:00Z'),
    thread('a1', 'a', 'succeeded', '2026-11-07T08:00:00Z'),
    thread('rb', 'b', 'succeeded', '2026-11-07T07:00:00Z'),
    // Blocked and failed tasks are in 等待你 but not in 收件箱.
    thread('rc', 'c', 'paused', '2026-11-07T06:00:00Z'),
    thread('rd', 'd', 'failed', '2026-11-07T05:00:00Z'),
    // A thread whose task is not in this workspace's list, or that has none, is not an item.
    thread('rx', 'elsewhere', 'waiting_input', '2026-11-07T04:00:00Z'),
    thread('ry', null, 'waiting_input', '2026-11-07T03:00:00Z'),
  ]
  const questions = [{ questionId: 'q1', issueId: 'b' }, { questionId: 'q2', issueId: null }]
  const listed = inboxSelection(threads, issues, questions)
  assert.deepEqual(listed.tasks.map(row => row.issue.id), ['a'])
  assert.deepEqual(listed.questions.map(question => question.questionId), ['q1', 'q2'])
  assert.equal(inboxCount(threads, issues, questions, 4), 1 + 2 + 4)
  assert.equal(inboxCount(threads, issues, [], 0), 2, 'without its question, task b waits on the person itself')
})
