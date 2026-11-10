import assert from 'node:assert/strict'
import test from 'node:test'
import { waitingQuestionRuns } from './waiting-questions'
import type { EventLine } from './event-line'
import type { CitationSource } from './citations'

const question = (runId: string | null, title: string | null = null): EventLine => ({ kind: 'runQuestion', runId, issueId: null, status: null, title })

function run(id: string, options: { status?: string; finishedAt?: string | null; issue?: string; title?: string } = {}) {
  return {
    kind: 'run' as const,
    id,
    status: options.status ?? 'waiting_input',
    finishedAt: options.finishedAt ?? null,
    name: options.title ?? `what ${id} was asked`,
    issue: options.issue ? { id: options.issue, number: 1, identifier: 'ALEX-1', title: '登录页白屏' } : null,
  } satisfies CitationSource
}

const sources = (entries: Record<string, CitationSource>) => entries

test('a waiting run with a live source is shown by its thread title, without the task code', () => {
  assert.deepEqual(
    waitingQuestionRuns([{ position: 1, line: question('r1') }], sources({ r1: run('r1', { issue: 'i1' }) }), new Set()),
    [{ runId: 'r1', title: '登录页白屏' }],
  )
})

test('a run that moved on, finished, or whose event is stale is not waiting', () => {
  assert.deepEqual(waitingQuestionRuns([{ position: 1, line: question('r1') }], sources({ r1: run('r1', { status: 'running' }) }), new Set()), [])
  assert.deepEqual(waitingQuestionRuns([{ position: 1, line: question('r1') }], sources({ r1: run('r1', { finishedAt: '2026-11-10T19:00:00Z' }) }), new Set()), [])
  assert.deepEqual(waitingQuestionRuns([{ position: 1, line: question('r1') }], sources({ r1: run('r1') }), new Set([1])), [])
})

test('an unreadable source falls back to the event, and a question with no title disappears instead of rendering a bare row', () => {
  assert.deepEqual(waitingQuestionRuns([{ position: 1, line: question('r1', 'what it was asked') }], undefined, new Set()), [{ runId: 'r1', title: 'what it was asked' }])
  assert.deepEqual(waitingQuestionRuns([{ position: 1, line: question('r1') }], undefined, new Set()), [])
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
    sources({ r1: run('r1', { title: 'first' }), r2: run('r2', { title: 'second' }) }),
    new Set(),
  )
  assert.deepEqual(result.map(row => row.title), ['first', 'second'])
})

test('the latest question for one run replaces an earlier one', () => {
  const result = waitingQuestionRuns(
    [{ position: 1, line: question('r1', 'old') }, { position: 2, line: question('r1', 'new') }],
    undefined,
    new Set(),
  )
  assert.deepEqual(result, [{ runId: 'r1', title: 'new' }])
})
