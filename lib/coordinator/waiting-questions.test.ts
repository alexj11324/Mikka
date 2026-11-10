import assert from 'node:assert/strict'
import test from 'node:test'
import { waitingQuestionRuns } from './waiting-questions'
import type { EventLine } from './event-line'
import type { CitationSource } from './citations'

const question = (runId: string | null, title: string | null = null): EventLine => ({ kind: 'runQuestion', runId, issueId: null, status: null, title })

type Newest = { status: string; outcome: string | null; stopReason?: string | null } | null

/**
 * The run that asked and, on its task, the task's newest run (`issue.run`).
 * An answered question keeps the old run `stopped/needs_input` and starts a
 * continuation on the same task, so `newest` is what decides that it moved on.
 */
function run(id: string, options: { status?: string; outcome?: string | null; stopReason?: string | null; issue?: string; issueStatus?: string; merged?: boolean; openPr?: boolean; title?: string; newest?: Newest } = {}) {
  const status = options.status ?? 'stopped'
  const outcome = options.outcome === undefined ? (status === 'stopped' ? 'needs_input' : null) : options.outcome
  const stopReason = options.stopReason ?? (status === 'stopped' && outcome === 'needs_input' ? 'asked_human' : null)
  return {
    kind: 'run' as const,
    id,
    agentName: 'Coordinator',
    harness: 'codex',
    status,
    outcome,
    stopReason,
    summary: null,
    steps: 0,
    createdAt: '2026-11-10T19:00:00Z',
    finishedAt: status === 'waiting_input' ? null : '2026-11-10T19:30:00Z',
    name: options.title ?? `what ${id} was asked`,
    pullRequests: options.merged ? [{ url: 'https://github.com/o/r/pull/1', state: 'merged' as const }] : options.openPr ? [{ url: 'https://github.com/o/r/pull/1', state: 'open' as const }] : [],
    issue: options.issue ? { id: options.issue, number: 1, identifier: 'ALEX-1', title: '登录页白屏', status: options.issueStatus ?? 'todo', run: options.newest === undefined ? { status, outcome, stopReason } : options.newest } : null,
  } satisfies CitationSource
}

const sources = (entries: Record<string, CitationSource>) => entries

test('an ended run judged needs_input is still waiting: the live shape of a question', () => {
  assert.deepEqual(
    waitingQuestionRuns([{ position: 1, line: question('r1') }], sources({ r1: run('r1', { issue: 'i1' }) }), new Set()),
    [{ runId: 'r1', title: '登录页白屏' }],
  )
})

test('a run still waiting inside its turn is waiting', () => {
  assert.deepEqual(
    waitingQuestionRuns([{ position: 1, line: question('r1') }], sources({ r1: run('r1', { status: 'waiting_input', issue: 'i1' }) }), new Set()),
    [{ runId: 'r1', title: '登录页白屏' }],
  )
})

test('answering starts a continuation run: the task moved on, so the sentence goes', () => {
  const answered = run('r1', { issue: 'i1', newest: { status: 'queued', outcome: null } })
  assert.deepEqual(waitingQuestionRuns([{ position: 1, line: question('r1') }], sources({ r1: answered }), new Set()), [])
})

test('a run judged done, idle or blocked is not waiting', () => {
  assert.deepEqual(waitingQuestionRuns([{ position: 1, line: question('r1') }], sources({ r1: run('r1', { outcome: 'done' }) }), new Set()), [])
  assert.deepEqual(waitingQuestionRuns([{ position: 1, line: question('r1') }], sources({ r1: run('r1', { outcome: 'idle' }) }), new Set()), [])
  assert.deepEqual(waitingQuestionRuns([{ position: 1, line: question('r1') }], sources({ r1: run('r1', { outcome: 'blocked' }) }), new Set()), [])
})

test('the judge can hand a succeeded run back as needs_input; the inbox waits on that too', () => {
  assert.deepEqual(
    waitingQuestionRuns([{ position: 1, line: question('r1') }], sources({ r1: run('r1', { status: 'succeeded', outcome: 'needs_input', issue: 'i1' }) }), new Set()),
    [{ runId: 'r1', title: '登录页白屏' }],
  )
})

test('a stale event is not waiting', () => {
  assert.deepEqual(waitingQuestionRuns([{ position: 1, line: question('r1') }], sources({ r1: run('r1', { status: 'waiting_input' }) }), new Set([1])), [])
})

test('an unreadable run source is not invented from model text; the question waits for the next chat read', () => {
  assert.deepEqual(waitingQuestionRuns([{ position: 1, line: question('r1', 'what it was asked') }], undefined, new Set()), [])
})

test('two threads of one task answer the same question: the newest event wins and the task appears once', () => {
  const result = waitingQuestionRuns(
    [{ position: 1, line: question('r1') }, { position: 2, line: question('r2') }],
    sources({ r1: run('r1', { issue: 'i1' }), r2: run('r2', { issue: 'i1' }) }),
    new Set(),
  )
  assert.deepEqual(result, [{ runId: 'r2', title: '登录页白屏' }])
})

test('the task that has waited longest comes first', () => {
  const result = waitingQuestionRuns(
    [{ position: 1, line: question('r1') }, { position: 9, line: question('r2') }],
    sources({ r1: run('r1', { status: 'waiting_input', title: 'first' }), r2: run('r2', { status: 'waiting_input', title: 'second' }) }),
    new Set(),
  )
  assert.deepEqual(result.map(row => row.title), ['first', 'second'])
})

test('the latest question for one run replaces an earlier one', () => {
  const result = waitingQuestionRuns(
    [{ position: 1, line: question('r1', 'old') }, { position: 2, line: question('r1', 'new') }],
    sources({ r1: run('r1', { status: 'waiting_input', title: 'new' }) }),
    new Set(),
  )
  assert.deepEqual(result, [{ runId: 'r1', title: 'new' }])
})

test('a run that just ended on asked_human shows before the outcome judge answers', () => {
  assert.deepEqual(
    waitingQuestionRuns([{ position: 1, line: question('r1') }], sources({ r1: run('r1', { issue: 'i1', outcome: null, stopReason: 'asked_human' }) }), new Set()),
    [{ runId: 'r1', title: '登录页白屏' }],
  )
})

test('a newer active run on the task means nothing waits, even with a stale needs_input', () => {
  const moved = run('r1', { issue: 'i1', newest: { status: 'running', outcome: 'needs_input', stopReason: 'asked_human' } })
  assert.deepEqual(waitingQuestionRuns([{ position: 1, line: question('r1') }], sources({ r1: moved }), new Set()), [])
})

test('a closed task or a merged pull request ends the question', () => {
  assert.deepEqual(waitingQuestionRuns([{ position: 1, line: question('r1') }], sources({ r1: run('r1', { issue: 'i1', issueStatus: 'done' }) }), new Set()), [])
  assert.deepEqual(waitingQuestionRuns([{ position: 1, line: question('r1') }], sources({ r1: run('r1', { issue: 'i1', merged: true }) }), new Set()), [])
})

test('an issue whose newest run has not loaded waits for the next chat read', () => {
  assert.deepEqual(waitingQuestionRuns([{ position: 1, line: question('r1') }], sources({ r1: run('r1', { issue: 'i1', newest: null }) }), new Set()), [])
})

test('a task waiting for review or with an open pull request is not owed an answer', () => {
  assert.deepEqual(waitingQuestionRuns([{ position: 1, line: question('r1') }], sources({ r1: run('r1', { issue: 'i1', issueStatus: 'review' }) }), new Set()), [])
  assert.deepEqual(waitingQuestionRuns([{ position: 1, line: question('r1') }], sources({ r1: run('r1', { issue: 'i1', openPr: true }) }), new Set()), [])
})

test('quota and failed runs are not questions the person owes an answer to', () => {
  assert.deepEqual(waitingQuestionRuns([{ position: 1, line: question('r1') }], sources({ r1: run('r1', { status: 'paused', outcome: 'needs_input' }) }), new Set()), [])
  assert.deepEqual(waitingQuestionRuns([{ position: 1, line: question('r1') }], sources({ r1: run('r1', { outcome: 'failed' }) }), new Set()), [])
})

test('a live waiting_input still shows on a merged task, as the thread badge does', () => {
  assert.deepEqual(
    waitingQuestionRuns([{ position: 1, line: question('r1') }], sources({ r1: run('r1', { status: 'waiting_input', issue: 'i1', merged: true }) }), new Set()),
    [{ runId: 'r1', title: '登录页白屏' }],
  )
})

test('a judged outcome wins over asked_human: the run moved on', () => {
  assert.deepEqual(waitingQuestionRuns([{ position: 1, line: question('r1') }], sources({ r1: run('r1', { outcome: 'done', stopReason: 'asked_human' }) }), new Set()), [])
  assert.deepEqual(waitingQuestionRuns([{ position: 1, line: question('r1') }], sources({ r1: run('r1', { outcome: 'blocked', stopReason: 'asked_human' }) }), new Set()), [])
})

test('a thread with no task shows only its live wait, which can end', () => {
  assert.deepEqual(waitingQuestionRuns([{ position: 1, line: question('r1') }], sources({ r1: run('r1', { status: 'waiting_input' }) }), new Set()), [{ runId: 'r1', title: 'what r1 was asked' }])
  assert.deepEqual(waitingQuestionRuns([{ position: 1, line: question('r1') }], sources({ r1: run('r1') }), new Set()), [])
})
