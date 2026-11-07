// Lists show tasks only, grouped 待处理 · 进行中 · 待办 · 已完成 (decisions/2026-11-07-2045-tasks-only-threads-inside.md).
import assert from 'node:assert/strict'
import test from 'node:test'
import { attemptState, attemptTitle, groupOf, groupOfThread, rowState, taskListRows } from '../features/tasks/model/task-groups.ts'

test('a task\'s current thread decides its group, by R-52\'s judgement', () => {
  assert.equal(groupOfThread('waiting'), 'pending')
  assert.equal(groupOfThread('blocked'), 'pending')
  assert.equal(groupOfThread('running'), 'running')
  assert.equal(groupOfThread('idle'), 'todo')
  assert.equal(groupOfThread('resolved'), 'done')
})

test('the server\'s group wins; without one the task\'s own fields stand in', () => {
  assert.equal(groupOf({ group: 'todo', status: 'doing', blocked: null }), 'todo')
  assert.equal(groupOf({ status: 'done' }), 'done')
  assert.equal(groupOf({ status: 'canceled' }), 'done')
  assert.equal(groupOf({ status: 'todo', blocked: { reason: 'question', blocker: null } }), 'pending')
  assert.equal(groupOf({ status: 'review' }), 'pending')
  assert.equal(groupOf({ status: 'doing' }), 'running')
  assert.equal(groupOf({ status: 'backlog' }), 'todo')
})

test('groups come in order with counts; 已完成 starts folded and opens when toggled', () => {
  const tasks = [
    { id: 'a', status: 'done' }, { id: 'b', status: 'todo' }, { id: 'c', status: 'doing' },
    { id: 'd', status: 'review' }, { id: 'e', status: 'done' },
  ]
  const rows = taskListRows(tasks, new Set())
  assert.deepEqual(rows.map(row => row.kind === 'section' ? `${row.title}${row.count}${row.folded ? '+' : ''}` : (row.task as { id: string }).id),
    ['等待你1', 'd', '进行中1', 'c', '待办1', 'b', '已完成2+'])
  const opened = taskListRows(tasks, new Set(['done', 'pending']))
  assert.deepEqual(opened.map(row => row.kind === 'section' ? row.id : (row.task as { id: string }).id),
    ['pending', 'running', 'c', 'todo', 'b', 'done', 'a', 'e'])
})

test('a filter shows its group alone; an empty group has no header', () => {
  const rows = taskListRows([{ status: 'doing' }, { status: 'todo' }], new Set(), 'running')
  assert.deepEqual(rows.map(row => row.kind), ['section', 'task'])
  assert.equal(taskListRows([], new Set()).length, 0)
})

test('an attempt is titled by its number and Agent', () => {
  assert.equal(attemptTitle(2, 'Codex'), '第 2 次尝试 · Codex')
})

// 2026-11-07-2230: each row shows its own state's icon; the hand is only 等你处理.
test('a row shows the server\'s state and reason when it sends them', () => {
  assert.deepEqual(rowState({ group: 'pending', status: 'todo', state: 'failed', reason: '失败' }), { state: 'failed', reason: '失败' })
  assert.deepEqual(rowState({ group: 'todo', status: 'todo', state: null, reason: '等 MIK-12' }), { state: null, reason: '等 MIK-12' })
})

test('until then, a failed attempt is a triangle, not a hand, and waiting rows say why', () => {
  assert.deepEqual(rowState({ group: 'pending', status: 'doing', blocked: { reason: 'failed', blocker: null } }), { state: 'failed', reason: '失败' })
  assert.deepEqual(rowState({ group: 'pending', status: 'doing', blocked: { reason: 'question', blocker: null } }), { state: 'waiting', reason: '等你回复' })
  assert.deepEqual(rowState({ group: 'pending', status: 'review' }), { state: 'waiting', reason: '待审阅' })
  assert.deepEqual(rowState({ group: 'running', status: 'doing' }), { state: 'running', reason: null })
  assert.deepEqual(rowState({ group: 'todo', status: 'backlog' }), { state: null, reason: null })
  assert.deepEqual(rowState({ group: 'done', status: 'canceled' }), { state: null, reason: null })
})

test('waiting on another task, or flagged, never gets the hand; it says why', () => {
  assert.deepEqual(rowState({ group: 'pending', status: 'todo', blocked: { reason: 'dependency', blocker: 'MIK-12' } }), { state: null, reason: '等 MIK-12' })
  assert.deepEqual(rowState({ group: 'todo', status: 'todo', blocked: { reason: 'flagged', blocker: null } }), { state: null, reason: '已标记受阻' })
})

test('an attempt\'s icon comes from its own result', () => {
  assert.equal(attemptState({ group: 'blocked', failed: true }), 'failed')
  assert.equal(attemptState({ group: 'waiting', failed: false }), 'waiting')
  assert.equal(attemptState({ group: 'running' }), 'running')
  assert.equal(attemptState({ group: 'resolved' }), 'done')
  assert.equal(attemptState({ group: 'idle' }), 'todo')
  assert.equal(attemptState({ status: 'failed' }), 'failed')
})
