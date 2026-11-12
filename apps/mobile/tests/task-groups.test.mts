import { mobileMessages } from '../lib/messages.ts'
// Lists show tasks only, grouped 待处理 · 进行中 · 待办 · 已完成 (decisions/2026-11-07-2045-tasks-only-threads-inside.md).
import assert from 'node:assert/strict'
import test from 'node:test'
import { attemptState, groupOf, groupOfThread, rowState, taskListRows } from '../features/tasks/model/task-groups.ts'
import { activityEntries, activityEntryId, boundary, conversationReplyRun, conversationSegments, reviewRun } from '../features/tasks/model/task-conversation.ts'

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

test('opening another segment keeps the reply target, and a read-only response has no composer', () => {
  const run = (runId: string, n: number, stage: 'review' | 'implement' | 'verify') => ({ kind: 'attempt' as const, runId, n, stage, group: 'idle' as const, harness: 'codex', createdAt: '', failed: false })
  const activity = [run('review', 3, 'review'), run('write', 2, 'implement'), run('verify', 1, 'verify')]
  assert.equal(conversationReplyRun({ replyRunId: 'write' }, activity), 'write')
  assert.equal(conversationReplyRun({ replyRunId: null }, activity), null)
  assert.equal(conversationReplyRun({}, activity), 'write')
  assert.equal(conversationReplyRun({}, activity.filter(row => row.runId !== 'write')), null)
})

// Alex 2026-11-09: a task is one conversation; no 「尝试」, no numbering and no switch verb (as Warp): where the Agent changed, the next Agent itself.
test('runs with the same Agent read as one; where the Agent changed, the divider is the next Agent', () => {
  const run = (runId: string, n: number, harness: string, extra = {}) => ({ kind: 'attempt' as const, runId, n, group: 'resolved' as const, harness, createdAt: '', failed: false, ...extra })
  const r1 = run('r1', 1, 'codex'), r2 = run('r2', 2, 'codex'), r3 = run('r3', 3, 'codex', { failed: true, state: 'failed' }), r4 = run('r4', 4, 'claude_code'), r5 = run('r5', 5, 'cursor')
  // Same Agent: nothing between them, however many runs (follow-ups, waiting for a reply).
  assert.equal(boundary(r1, r2), null)
  // The Agent changed, after a failure or not: the divider is the next Agent, with no 「换」 and no 「没跑通」.
  assert.deepEqual(boundary(r3, r4), { kind: 'agent', harness: 'claude_code' })
  assert.deepEqual(boundary(r4, r5), { kind: 'agent', harness: 'cursor' })
})

// 2026-11-04-2200: verification belongs to 实现, and 审阅 is its own result card; only a fix is marked inline.
test('a fix starting with the same Agent is a small marker; review, verify, implement and no stage are not', () => {
  const run = (runId: string, n: number, stage?: string | null) => ({ kind: 'attempt' as const, runId, n, group: 'resolved' as const, harness: 'codex', createdAt: '', failed: false, ...(stage === undefined ? {} : { stage }) }) as never
  assert.deepEqual(boundary(run('r2', 2, 'review'), run('r4', 4, 'fix')), { kind: 'stage', text: mobileMessages.MobileCore.conversation.fix })
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
  const flow = mobileMessages.FactoryFlow, needs = (what: string) => mobileMessages.MobileCore.conversation.needsYou.replace('{what}', what)
  assert.equal(stageLine({ stage: 'review' }), flow.stages.review)
  assert.equal(stageLine({ stage: 'handoff', needsYou: { kind: 'pr_review', since: '' } }), `${flow.stages.handoff} · ${needs(flow.card.needsYou.pr_review)}`)
  assert.equal(stageLine({ stage: 'spec', needsYou: { kind: 'spec_review', since: '' } }), `${flow.stages.spec} · ${needs(flow.card.needsYou.spec_review)}`)
  assert.equal(stageLine(null), null)
  assert.equal(stageLine(undefined), null)
  assert.deepEqual(['passed', 'changes_requested', 'needs_judgment'].map(verdict => verdictWord({ stage: 'review', review: { verdict: verdict as never } })), [mobileMessages.MobileCore.conversation.verdicts.passed, mobileMessages.MobileCore.conversation.verdicts.changes_requested, mobileMessages.MobileCore.conversation.verdicts.needs_judgment])
  assert.equal(verdictWord({ stage: 'review', review: { verdict: null } }), null)
  assert.equal(verdictWord(undefined), null)
})

test('活动 merges an Agent\'s runs in a row into one row; the next Agent starts its own row', () => {
  const run = (runId: string, n: number, harness: string, extra = {}) => ({ kind: 'attempt' as const, runId, n, group: 'waiting' as const, harness, createdAt: '2026-11-05T10:00:00.000Z', failed: false, ...extra })
  // The server sends 活动 newest first.
  const activity = [run('r4', 4, 'claude_code'), run('r3', 3, 'codex'), run('r2', 2, 'codex'), run('r1', 1, 'codex'), { kind: 'created' as const, by: 'Coordinator', createdAt: '2026-11-05T09:00:00.000Z' }]
  const entries = activityEntries(activity)
  assert.deepEqual(entries.map(entry => entry.kind === 'agent' ? [entry.run.harness, entry.run.attempts.map(item => item.runId)] : entry.kind), ['created', ['codex', ['r1', 'r2', 'r3']], ['claude_code', ['r4']]])
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

// Alex 2026-11-09: the Agents' real brand marks, from @lobehub/icons-static-svg (MIT) as files.
test('an Agent brand mark is the package\'s own markup, sized by its caller, without Codex\'s white backdrop', async () => {
  const { readFileSync } = await import('node:fs')
  const { createRequire } = await import('node:module')
  const { agentMark } = await import('../features/tasks/model/agent-marks.ts')
  const file = (name: string) => readFileSync(createRequire(import.meta.url).resolve(`@lobehub/icons-static-svg/icons/${name}`), 'utf8')
  for (const name of ['claudecode-color.svg', 'codex-color.svg', 'cursor.svg']) {
    const mark = agentMark(file(name))
    assert.match(mark, /^<svg[^>]*viewBox="0 0 24 24"/)
    assert.doesNotMatch(mark, /1em|style=/)
  }
  assert.match(file('codex-color.svg'), /fill="#fff"/)
  assert.doesNotMatch(agentMark(file('codex-color.svg')), /fill="#fff"/)
  assert.match(agentMark(file('cursor.svg')), /currentColor/)
})

test('native task activity interleaves discussion and history facts with runs, once and oldest first', () => {
  const at = '2026-11-01T09:00:00Z'
  const later = '2026-11-01T09:01:00Z'
  const run = { kind: 'attempt' as const, runId: 'a', n: 1, group: 'running' as const, harness: 'Codex', createdAt: later, failed: false }
  const discussion = { kind: 'reply' as const, id: 'discussion:t:m2', threadId: 't', messageId: 'm2', at, author: 'Alex', authorId: 'u', body: 'Ack', resolved: false }
  const history = { kind: 'history' as const, id: 'history:created-v1', at, event: { id: 'created-v1', at, kind: 'created' as const } }
  const activity = [run, { kind: 'created' as const, by: 'Alex', createdAt: at }]
  assert.deepEqual(activityEntries(activity, [history, discussion]).map(activityEntryId), ['discussion:t:m2', 'history:created-v1', 'run:a'])
  assert.deepEqual(activityEntries(activity).map(activityEntryId), ['created', 'run:a'])
})
