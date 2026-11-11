import test from 'node:test'
import { taskPresentation } from '../lib/task-presentation'
import { groupPresentedTasks, waitingTasks } from '../lib/task-collection'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { taskStateOf, type TaskState as CanonicalTaskState, type TaskReason, type TaskStateRun } from '@/lib/task-state'
import type { listIssues } from '../app/actions/issues'
import type { Thread } from '../app/actions/task-runs'
import type { TaskState } from './use-bot-tasks'
import * as legacySlot from './use-bot-tasks'
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
    [['c', 'r4', 1], ['d', 'r5', 1]],
    [],
  ])
})

test('an In Review task with an open PR whose newest run succeeded without an outcome waits for review (F1503-18)', () => {
  const task = issue('a', 'review', [{ url: 'https://github.com/o/r/pull/17', state: 'open' }])
  // localTaskState is the legacy attempt-only slot: it intentionally ignores
  // the business Task's PR. The canonical mapper is what lists use.
  assert.deepEqual(localTaskState(task, { status: 'succeeded', outcome: null }), { state: 'done', reason: null })
  assert.deepEqual(taskStateOf(task, { runId: 'r', status: 'succeeded', outcome: null }),
    { state: 'waiting', reason: 'pr_review', blockedBy: null, group: 'pending' })
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
    a: ['pending', 'waiting', 'needs_input'], b: ['pending', 'failed', null], c: ['running', 'queued', null],
    d: ['pending', 'waiting', 'pr_review'], e: ['pending', 'blocked', 'quota'], f: ['todo', 'todo', null],
    g: ['running', 'running', null], h: ['done', 'duplicate', null], i: ['todo', 'todo', null],
  })
  assert.equal(pendingTaskCount(threads, issues), 2)
})

test('with no attempt the shared view preserves open tasks; a successful attempt alone never closes them', () => {
  for (const status of ['backlog', 'todo']) assert.deepEqual(taskStateOf(issue('a', status)), { state: 'todo', reason: null, blockedBy: null, group: 'todo' })
  assert.deepEqual(taskStateOf(issue('a'), { runId: 'r', status: 'succeeded', outcome: 'blocked' }), { state: 'blocked', reason: 'blocked', blockedBy: null, group: 'pending' })
  assert.deepEqual(taskStateOf(issue('a', 'done', [{ url: 'u', state: 'merged' }]), null), { state: 'done', reason: null, blockedBy: null, group: 'done' })
})

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

test('released hosted icon dictionaries keep idle without adding it to canonical Task rows', () => {
  const canonical = {
    waiting: 'waiting', blocked: 'blocked', failed: 'failed', running: 'running', queued: 'queued',
    todo: 'todo', done: 'done', canceled: 'canceled', duplicate: 'duplicate',
  } satisfies Record<CanonicalTaskState, string>
  const hosted = { ...canonical, idle: 'idle' } satisfies Record<TaskState, string>
  assert.equal(hosted.idle, 'idle')
  assert.equal(Object.hasOwn(canonical, 'idle'), false)
})

test('released hosted Run cards show a completed attempt while its business Task stays open', () => {
  const open = { status: 'doing', metadata: { pullRequests: [] } }
  const finished = { status: 'succeeded', outcome: 'done' }
  // The released hosted runState wrapper passes this exact two-field Run shape.
  assert.deepEqual(legacySlot.localTaskState(open, finished), { state: 'done', reason: null })
  assert.deepEqual(taskStateOf(open, { ...finished, runId: 'r', outcome: 'done' }), {
    state: 'todo', reason: null, group: 'todo', blockedBy: null,
  })
  const groups = tasksOf([thread('r', 'a', 'succeeded', '2026-11-07T10:00:00Z', 'done')], [issue('a')])
  assert.equal(groups.todo[0]?.state, 'todo')
  assert.equal(groups.done.length, 0)
  assert.deepEqual(legacySlot.localTaskState(open, { status: 'succeeded', outcome: 'idle' }), { state: 'idle', reason: null })
  assert.deepEqual(legacySlot.localTaskState({ ...open, status: 'backlog' }, null), { state: 'idle', reason: null })
  assert.deepEqual(legacySlot.localTaskState({ ...open, status: 'done' }, null), { state: 'done', reason: null })
  // Task closure and merged PRs must not hide a failed or idle attempt either.
  assert.deepEqual(legacySlot.localTaskState({ ...open, status: 'done' }, { status: 'failed' }), { state: 'failed', reason: null })
  const merged = { status: 'doing', metadata: { pullRequests: [{ url: 'https://example.test/pr/1', state: 'merged' as const }] } }
  assert.deepEqual(legacySlot.localTaskState(merged, { status: 'succeeded', outcome: 'idle' }), { state: 'idle', reason: null })
  assert.equal(taskStateOf(merged, { runId: 'r', status: 'succeeded', outcome: 'done' }).state, 'todo')
})

test('released hosted attempt labels use the shared approval and blocker facts', () => {
  const open = { status: 'doing', metadata: { pullRequests: [] } }
  const cases: { run: Omit<TaskStateRun, 'runId' | 'outcome'> & { outcome?: string | null }; state: TaskState; reason: TaskReason }[] = [
    { run: { status: 'queued' }, state: 'queued', reason: null },
    { run: { status: 'preparing' }, state: 'running', reason: null },
    { run: { status: 'running' }, state: 'running', reason: null },
    { run: { status: 'finishing' }, state: 'running', reason: null },
    { run: { status: 'waiting_input' }, state: 'waiting', reason: 'needs_input' },
    { run: { status: 'succeeded', outcome: 'needs_input' }, state: 'waiting', reason: 'needs_input' },
    { run: { status: 'running', awaitingApproval: true }, state: 'waiting', reason: 'approval' },
    { run: { status: 'paused', pauseReason: 'human_control' }, state: 'waiting', reason: 'approval' },
    { run: { status: 'paused', pauseReason: 'quota_exhausted' }, state: 'blocked', reason: 'quota' },
    { run: { status: 'paused' }, state: 'blocked', reason: 'quota' },
    { run: { status: 'queued', deviceOffline: true }, state: 'blocked', reason: 'offline' },
    { run: { status: 'succeeded', outcome: 'blocked' }, state: 'blocked', reason: 'blocked' },
    { run: { status: 'succeeded', outcome: 'failed' }, state: 'failed', reason: null },
    { run: { status: 'failed', threadReplacedBy: 'newer' }, state: 'idle', reason: null },
  ]
  for (const { run, state, reason } of cases) {
    assert.deepEqual(legacySlot.localTaskState(open, run), { state, reason }, JSON.stringify(run))
  }
})

test('both released hosted translation namespaces cover every canonical reason', () => {
  const keys = {
    needs_input: true, approval: true, pr_review: true, blocked: true,
    quota: true, offline: true, blocked_by: true, flagged: true,
  } satisfies Record<Exclude<TaskReason, null>, true>
  for (const locale of ['en', 'zh-CN']) {
    const messages = JSON.parse(readFileSync(new URL(`../messages/${locale}.json`, import.meta.url), 'utf8'))
    const reason = messages.Shell.panel.task.reason
    for (const key of Object.keys(keys)) assert.equal(typeof reason[key], 'string', `${locale}: ${key}`)
    assert.equal(reason.needs_input, reason.needsReply)
    assert.equal(reason.approval, reason.confirm)
    assert.equal(reason.pr_review, reason.review)
    assert.equal(reason.offline, messages.Devices.offline)
    assert.equal(reason.blocked_by, messages.Shell.board.card.block.dependency)
    assert.equal(reason.flagged, messages.Shell.board.card.block.flagged)
  }
})

test("收件箱's count is what it lists: one row per waiting task (not per thread), a task waiting on a question once, then questions and suggestions", () => {
  const issues = [issue('a'), issue('b'), issue('c'), issue('d')]
  const threads = [
    // Task a has had three threads, all waiting: it is one item, not three.
    thread('a3', 'a', 'waiting_input', '2026-11-07T10:00:00Z'),
    thread('a2', 'a', 'waiting_input', '2026-11-07T09:00:00Z'),
    thread('a1', 'a', 'succeeded', '2026-11-07T08:00:00Z'),
    thread('rb', 'b', 'waiting_input', '2026-11-07T07:00:00Z'),
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

test('workspace and Bot lists use the authorized Task presentation, including work without a thread', () => {
  const issues = [issue('draft', 'todo'), issue('review', 'doing'), issue('other-bot'), issue('revoked')]
  const threads = [thread('finished', 'review', 'succeeded', '2026-11-07', 'done'), thread('elsewhere', 'other-bot', 'queued', '2026-11-08')]
  const state = { version: 1, state: 'todo', reason: null, group: 'todo', blockedBy: null, primaryStatus: 'todo',
    runStatus: null, factoryStage: null, needsAction: null, blockedReason: null, completion: null } as const
  const presentations = { draft: state, review: { ...state, state: 'waiting', reason: 'pr_review', group: 'pending',
    primaryStatus: 'doing', runStatus: 'succeeded', factoryStage: 'handoff', needsAction: 'pr_review' }, 'other-bot': state } as const
  const workspace = groupPresentedTasks(issues, threads, presentations, 'workspace')
  assert.deepEqual(workspace.todo.map(row => [row.issue.id, row.attempts]), [['draft', 0], ['other-bot', 1]])
  assert.equal(workspace.todo[0]!.current, null)
  assert.equal(workspace.pending[0]!.state, 'waiting')
  assert.deepEqual(waitingTasks(workspace, [{ issueId: 'review' }]), [])
  const dispatched = groupPresentedTasks(issues, [threads[0]!], presentations, 'dispatched')
  assert.deepEqual(dispatched.todo, [])
  assert.deepEqual(dispatched.pending.map(row => row.issue.id), ['review'])
  assert.equal(dispatched.pending[0]!.factoryStage, 'handoff')
})

test('Tasks, Bot dispatches and Inbox consume the same canonical outcome table', () => {
  const at = '2026-11-07T10:00:00Z'
  type Case = {
    name: string; primary: Parameters<typeof taskPresentation>[0]['status']; run?: string; outcome?: string;
    factory?: Parameters<typeof taskPresentation>[2]; pr?: true; state: CanonicalTaskState; reason?: TaskReason; pending?: true
  }
  const cases: Case[] = [
    { name: 'zero-run', primary: 'todo', state: 'todo' },
    { name: 'queued', primary: 'doing', run: 'queued', state: 'queued' },
    { name: 'active', primary: 'doing', run: 'running', state: 'running' },
    { name: 'blocked', primary: 'doing', run: 'succeeded', outcome: 'blocked', state: 'blocked', reason: 'blocked' },
    { name: 'needs input', primary: 'doing', run: 'waiting_input', state: 'waiting', reason: 'needs_input', pending: true },
    { name: 'failed', primary: 'doing', run: 'failed', state: 'failed' },
    { name: 'review', primary: 'review', run: 'succeeded', pr: true, state: 'waiting', reason: 'pr_review', pending: true },
    { name: 'completed run, open issue', primary: 'doing', run: 'succeeded', outcome: 'done', state: 'todo' },
    { name: 'factory handoff overrides failed run', primary: 'doing', run: 'failed', factory: { stage: 'handoff', needsYou: { kind: 'pr_review', since: at } }, state: 'waiting', reason: 'pr_review', pending: true },
    { name: 'threadless factory question', primary: 'doing', factory: { stage: 'triage', needsYou: { kind: 'question', since: at } }, state: 'waiting', reason: 'needs_input', pending: true },
    { name: 'closed', primary: 'done', run: 'waiting_input', state: 'done' },
  ]
  for (const c of cases) {
    const task = { id: c.name, title: c.name, status: c.primary, metadata: { pullRequests: c.pr ? [{ url: 'https://github.com/org/repo/pull/1', state: 'open' as const }] : [] } }
    const run = c.run ? { runId: 'run', status: c.run, outcome: c.outcome ?? null } : undefined
    const result = taskPresentation(task, run, c.factory ?? null, () => false)
    assert.deepEqual([result.state, result.reason], [c.state, c.reason ?? null], c.name)
    const issueRows = [task as unknown as Awaited<ReturnType<typeof listIssues>>[number]]
    const threads: Thread[] = run ? [thread(run.runId, task.id, run.status, at, run.outcome)] : []
    const workspace = groupPresentedTasks(issueRows, threads, { [task.id]: result }, 'workspace')
    assert.equal(workspace[result.group][0].state, c.state, c.name)
    const bot = groupPresentedTasks(issueRows, threads, { [task.id]: result }, 'dispatched')
    assert.equal(bot[result.group][0]?.state, run ? c.state : undefined, c.name)
    assert.equal(waitingTasks(workspace, []).length, c.pending ? 1 : 0, c.name)
    assert.equal(waitingTasks(workspace, [{ issueId: task.id }]).length, 0, c.name)
  }
})
