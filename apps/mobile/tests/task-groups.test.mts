import { mobileMessages } from '../lib/messages.ts'
// Lists show tasks only, grouped 待处理 · 进行中 · 待办 · 已完成 (decisions/2026-11-07-2045-tasks-only-threads-inside.md).
import assert from 'node:assert/strict'
import test from 'node:test'
import { attemptState, groupOf, groupOfThread, rowState, taskListRows } from '../features/tasks/model/task-groups.ts'
import { conversationSegments, dividerText } from '../features/tasks/model/task-conversation.ts'

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
    [`${mobileMessages.MobileCore.groups.pending}1`, 'd', `${mobileMessages.MobileCore.groups.running}1`, 'c', `${mobileMessages.MobileCore.groups.todo}1`, 'b', `${mobileMessages.MobileCore.groups.done}2+`])
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
  assert.deepEqual(rowState({ group: 'pending', status: 'doing', state: 'failed', reason: null }), { state: 'failed', reason: mobileMessages.MobileCore.states.failed })
  assert.deepEqual(rowState({ group: 'pending', status: 'review', state: 'waiting', reason: 'pr_review' }), { state: 'waiting', reason: mobileMessages.MobileCore.reasons.pr_review })
  assert.deepEqual(rowState({ group: 'pending', status: 'doing', state: 'waiting', reason: 'approval' }), { state: 'waiting', reason: mobileMessages.MobileCore.reasons.approval })
  assert.deepEqual(rowState({ group: 'running', status: 'doing', state: 'queued', reason: null }), { state: 'queued', reason: null })
  // todo, done, canceled and duplicate show the board's icon.
  assert.deepEqual(rowState({ group: 'todo', status: 'todo', state: 'todo', reason: 'blocked_by', blockedBy: 'MIK-12' }), { state: null, reason: mobileMessages.MobileCore.reasons.blocked_by.replace('{task}', 'MIK-12') })
  assert.deepEqual(rowState({ group: 'done', status: 'canceled', state: 'canceled', reason: null }), { state: null, reason: null })
  assert.deepEqual(rowState({ group: 'todo', status: 'todo', state: 'todo', reason: 'flagged' }), { state: null, reason: mobileMessages.MobileCore.reasons.flagged })
})

test('until then, a failed attempt is a triangle, not a hand, and waiting rows say why', () => {
  assert.deepEqual(rowState({ group: 'pending', status: 'doing', blocked: { reason: 'failed', blocker: null } }), { state: 'failed', reason: mobileMessages.MobileCore.states.failed })
  assert.deepEqual(rowState({ group: 'pending', status: 'doing', blocked: { reason: 'question', blocker: null } }), { state: 'waiting', reason: mobileMessages.MobileCore.reasons.needs_input })
  assert.deepEqual(rowState({ group: 'pending', status: 'review' }), { state: 'waiting', reason: mobileMessages.MobileCore.reasons.pr_review })
  assert.deepEqual(rowState({ group: 'running', status: 'doing' }), { state: 'running', reason: null })
  assert.deepEqual(rowState({ group: 'todo', status: 'backlog' }), { state: null, reason: null })
  assert.deepEqual(rowState({ group: 'done', status: 'canceled' }), { state: null, reason: null })
})

test('waiting on another task, or flagged, never gets the hand; it says why', () => {
  assert.deepEqual(rowState({ group: 'pending', status: 'todo', blocked: { reason: 'dependency', blocker: 'MIK-12' } }), { state: null, reason: mobileMessages.MobileCore.reasons.blocked_by.replace('{task}', 'MIK-12') })
  assert.deepEqual(rowState({ group: 'todo', status: 'todo', blocked: { reason: 'flagged', blocker: null } }), { state: null, reason: mobileMessages.MobileCore.reasons.flagged })
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
  assert.deepEqual(rowState({ group: 'pending', status: 'doing', state: 'blocked', reason: 'quota' }), { state: 'blocked', reason: mobileMessages.MobileCore.reasons.quota })
  assert.deepEqual(rowState({ group: 'pending', status: 'doing', blocked: { reason: 'quota', blocker: null } }), { state: 'blocked', reason: mobileMessages.MobileCore.reasons.quota })
  assert.deepEqual(rowState({ group: 'pending', status: 'doing', blocked: { reason: 'run', blocker: null } }), { state: 'blocked', reason: mobileMessages.MobileCore.reasons.blocked })
})

// Alex 2026-11-07: 「第二次尝试明显应该在第一次之后」. A task has one conversation.
test('a task\'s attempts read as one conversation, oldest first, each keeping only its own messages', () => {
  const attempt = (runId: string, n: number, harness: string, extra = {}) => ({ kind: 'attempt' as const, runId, n, group: 'resolved' as const, harness, createdAt: '', failed: false, ...extra })
  const activity = [attempt('r2', 2, 'claude_code'), attempt('r1', 1, 'codex', { failed: true }), { kind: 'created' as const, by: null, createdAt: '' }]
  const item = (id: string) => ({ kind: 'agent' as const, id, text: id, at: 0 })
  // The first thread's read also holds the second (R-81: a thread is its runs from this one on).
  const threads = new Map([['r1', { items: [item('a'), item('b'), item('c')], error: 'E_TOOL_FAILED' }], ['r2', { items: [item('c')], error: null }]])
  const segments = conversationSegments(activity, threads)
  assert.deepEqual(segments.map(segment => [segment.attempt.runId, segment.items.map(entry => entry.id), segment.error]), [['r1', ['a', 'b'], 'E_TOOL_FAILED'], ['r2', ['c'], null]])
  assert.equal(dividerText(segments[0]!.attempt, segments[1]!.attempt), '第 1 次尝试失败 · 换 Claude Code 再试')
  assert.equal(dividerText(attempt('r1', 1, 'codex', { group: 'blocked' }), attempt('r2', 2, 'codex')), '第 1 次尝试受阻 · 再试')
  assert.deepEqual(conversationSegments([{ kind: 'created', by: null, createdAt: '' }], new Map()), [])
})

// Alex 2026-11-08: the folded steps row opens to each command and tool call, labelled as Codex does.
test('a steps row says what ran: commands and tools, or the plain count without the steps', async () => {
  const { stepsLabel, stepLine, commandText, stepDuration } = await import('../features/tasks/model/thread-steps.ts')
  const steps = [
    { name: 'bash', detail: '/bin/bash -lc "pnpm test"' },
    { name: 'Bash', detail: 'git status' },
    { name: 'mcp__mikka__record_decision', detail: 'Choose provider receipts' },
  ]
  const words = mobileMessages.MobileCore
  assert.equal(stepsLabel(steps, 3), `${words.threadSteps.commands.replace('{count}', '2')} · ${words.threadSteps.tool}`)
  assert.equal(stepsLabel([steps[2]!], 1), words.threadSteps.tool)
  assert.equal(stepsLabel(undefined, 3), words.steps.replace('{count}', '3'))
  assert.equal(commandText('/bin/bash -lc "pnpm test"'), 'pnpm test')
  assert.equal(commandText(`/bin/bash -lc "python3 - <<'PY' import json…`), `python3 - <<'PY' import json…`)
  assert.deepEqual(stepLine(steps[2]!), { title: 'record_decision', detail: 'Choose provider receipts', code: false })
  assert.deepEqual(stepLine({ name: 'apply_patch', detail: '/home/user/.mikka/worker/worktrees/abc/apps/mobile/lib/a.ts' }), { title: 'apply_patch', detail: 'lib/a.ts', code: false })
  assert.deepEqual(stepLine(steps[0]!), { title: 'pnpm test', detail: null, code: true })
  assert.deepEqual([stepDuration(850), stepDuration(1240), stepDuration(125_000), stepDuration(undefined)], [words.threadSteps.milliseconds.replace('{count}', '850'), words.threadSteps.seconds.replace('{count}', '1.2'), words.threadSteps.minutes.replace('{minutes}', '2').replace('{seconds}', '5'), null])
})
