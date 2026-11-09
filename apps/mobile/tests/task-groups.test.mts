// Lists show tasks only, grouped 待处理 · 进行中 · 待办 · 已完成 (decisions/2026-11-07-2045-tasks-only-threads-inside.md).
import assert from 'node:assert/strict'
import test from 'node:test'
import { attemptState, groupOf, groupOfThread, rowState, taskListRows } from '../features/tasks/model/task-groups.ts'
import { activityEntries, agentRunTitle, boundary, conversationSegments, reviewRun } from '../features/tasks/model/task-conversation.ts'

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


// 2026-11-07-2230: each row shows its own state's icon; the hand is only 等你处理.
test('a row shows the API\'s state; the app writes the reason\'s words', () => {
  assert.deepEqual(rowState({ group: 'pending', status: 'doing', state: 'failed', reason: null }), { state: 'failed', reason: '失败' })
  assert.deepEqual(rowState({ group: 'pending', status: 'review', state: 'waiting', reason: 'pr_review' }), { state: 'waiting', reason: '待审阅' })
  assert.deepEqual(rowState({ group: 'pending', status: 'doing', state: 'waiting', reason: 'approval' }), { state: 'waiting', reason: '等你确认' })
  assert.deepEqual(rowState({ group: 'running', status: 'doing', state: 'queued', reason: null }), { state: 'queued', reason: null })
  // todo, done, canceled and duplicate show the board's icon.
  assert.deepEqual(rowState({ group: 'todo', status: 'todo', state: 'todo', reason: 'blocked_by', blockedBy: 'MIK-12' }), { state: null, reason: '等 MIK-12' })
  assert.deepEqual(rowState({ group: 'done', status: 'canceled', state: 'canceled', reason: null }), { state: null, reason: null })
  assert.deepEqual(rowState({ group: 'todo', status: 'todo', state: 'todo', reason: 'flagged' }), { state: null, reason: '已标记受阻' })
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

test('an attempt shows its own result, never the hand: running, paused, done, failed, blocked', () => {
  assert.equal(attemptState({ group: 'blocked', failed: true }), 'failed')
  assert.equal(attemptState({ group: 'waiting', failed: false }), 'paused')
  assert.equal(attemptState({ group: 'running' }), 'running')
  assert.equal(attemptState({ group: 'resolved' }), 'done')
  assert.equal(attemptState({ group: 'idle' }), 'done')
  assert.equal(attemptState({ group: 'blocked', failed: false }), 'blocked')
  assert.equal(attemptState({ status: 'failed' }), 'failed')
  // The API's own attempt state wins; waiting for the person is a pause.
  assert.equal(attemptState({ group: 'waiting', state: 'done' }), 'done')
  assert.equal(attemptState({ group: 'running', state: 'waiting' }), 'paused')
})

// 受阻 (quota, login, key, a device offline) is its own state, the octagon: not the hand.
test('受阻 is its own state, with the API\'s code or read from the board until then', () => {
  assert.deepEqual(rowState({ group: 'pending', status: 'doing', state: 'blocked', reason: 'quota' }), { state: 'blocked', reason: '额度用完' })
  assert.deepEqual(rowState({ group: 'pending', status: 'doing', blocked: { reason: 'quota', blocker: null } }), { state: 'blocked', reason: '额度用完' })
  assert.deepEqual(rowState({ group: 'pending', status: 'doing', blocked: { reason: 'run', blocker: null } }), { state: 'blocked', reason: '受阻' })
})

// Alex 2026-11-07: the second run comes after the first. A task has one conversation.
test('a task\'s attempts read as one conversation, oldest first, each keeping only its own messages', () => {
  const attempt = (runId: string, n: number, harness: string, extra = {}) => ({ kind: 'attempt' as const, runId, n, group: 'resolved' as const, harness, createdAt: '', failed: false, ...extra })
  const activity = [attempt('r2', 2, 'claude_code'), attempt('r1', 1, 'codex', { failed: true }), { kind: 'created' as const, by: null, createdAt: '' }]
  const item = (id: string) => ({ kind: 'agent' as const, id, text: id, at: 0 })
  // The first thread's read also holds the second (R-81: a thread is its runs from this one on).
  const threads = new Map([['r1', { items: [item('a'), item('b'), item('c')], error: 'E_TOOL_FAILED' }], ['r2', { items: [item('c')], error: null }]])
  const segments = conversationSegments(activity, threads)
  assert.deepEqual(segments.map(segment => [segment.attempt.runId, segment.items.map(entry => entry.id), segment.error]), [['r1', ['a', 'b'], 'E_TOOL_FAILED'], ['r2', ['c'], null]])
  assert.deepEqual(conversationSegments([{ kind: 'created', by: null, createdAt: '' }], new Map()), [])
})

// Alex 2026-11-09: a task is one conversation; no 「尝试」 and no numbering, a divider only where the Agent changed.
test('runs with the same Agent read as one; a divider only where the Agent changed, naming the Agent that did not get through', () => {
  const run = (runId: string, n: number, harness: string, extra = {}) => ({ kind: 'attempt' as const, runId, n, group: 'resolved' as const, harness, createdAt: '', failed: false, ...extra })
  const r1 = run('r1', 1, 'codex'), r2 = run('r2', 2, 'codex'), r3 = run('r3', 3, 'codex', { failed: true, state: 'failed' }), r4 = run('r4', 4, 'claude_code'), r5 = run('r5', 5, 'cursor')
  // Same Agent: nothing between them, however many runs (follow-ups, waiting for a reply).
  assert.equal(boundary(r1, r2), null)
  // The Agent changed after a failure: the one that failed is named, nothing is numbered.
  assert.deepEqual(boundary(r3, r4), { kind: 'switch', text: 'Codex 没跑通 · 换 Claude Code 继续' })
  // The Agent changed without a failure.
  assert.deepEqual(boundary(r4, r5), { kind: 'switch', text: '换 Cursor 继续' })
})

// 2026-11-04-2200: verification belongs to 实现, and 审阅 is its own result card; only a fix is marked inline.
test('a fix starting with the same Agent is a small marker; review, verify, implement and no stage are not', () => {
  const run = (runId: string, n: number, stage?: string | null) => ({ kind: 'attempt' as const, runId, n, group: 'resolved' as const, harness: 'codex', createdAt: '', failed: false, ...(stage === undefined ? {} : { stage }) }) as never
  assert.deepEqual(boundary(run('r2', 2, 'review'), run('r4', 4, 'fix')), { kind: 'stage', text: '修复' })
  assert.equal(boundary(run('r1', 1, 'implement'), run('r2', 2, 'review')), null)
  assert.equal(boundary(run('r2', 2, 'review'), run('r3', 3, 'verify')), null)
  assert.equal(boundary(run('r1', 1), run('r2', 2)), null)
  assert.equal(boundary(run('r1', 1), run('r2', 2, null)), null)
  assert.equal(reviewRun({ stage: 'review' }), true)
  assert.equal(reviewRun({ stage: 'implement' }), false)
  assert.equal(reviewRun({}), false)
})

test('a factory task shows one stage and what it needs from you; 审阅 has one verdict; nothing without a flow', async () => {
  const { stageLine, verdictWord } = await import('../features/tasks/model/task-flow.ts')
  assert.equal(stageLine({ stage: 'review' }), '审阅')
  assert.equal(stageLine({ stage: 'handoff', needsYou: { kind: 'pr_review', since: '' } }), '交给你 · 需要你：PR 待审')
  assert.equal(stageLine({ stage: 'spec', needsYou: { kind: 'spec_review', since: '' } }), '方案 · 需要你：方案待审')
  assert.equal(stageLine(null), null)
  assert.equal(stageLine(undefined), null)
  assert.deepEqual(['passed', 'changes_requested', 'needs_judgment'].map(verdict => verdictWord({ stage: 'review', review: { verdict: verdict as never } })), ['通过', '需要修改', '需要你判断'])
  assert.equal(verdictWord({ stage: 'review', review: { verdict: null } }), null)
  assert.equal(verdictWord(undefined), null)
})

test('活动 merges an Agent\'s runs in a row into one row; a switch starts 「换 X」', () => {
  const run = (runId: string, n: number, harness: string, extra = {}) => ({ kind: 'attempt' as const, runId, n, group: 'waiting' as const, harness, createdAt: '2026-11-05T10:00:00.000Z', failed: false, ...extra })
  // The server sends 活动 newest first.
  const activity = [run('r4', 4, 'claude_code'), run('r3', 3, 'codex'), run('r2', 2, 'codex'), run('r1', 1, 'codex'), { kind: 'created' as const, by: 'Coordinator', createdAt: '2026-11-05T09:00:00.000Z' }]
  const entries = activityEntries(activity)
  assert.deepEqual(entries.map(entry => entry.kind === 'agent' ? [agentRunTitle(entry), entry.run.attempts.map(item => item.runId)] : entry.kind), ['created', ['Codex', ['r1', 'r2', 'r3']], ['换 Claude Code', ['r4']]])
})
