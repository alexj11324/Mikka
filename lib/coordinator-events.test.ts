import { test } from 'node:test'
import assert from 'node:assert/strict'
import { issueStatusEvent, runBlockedEvent, runFinishedEvent, runQuestionEvent, runReportEvent, runRetriedEvent, telegramReplyTargets, userMessageEvent } from './coordinator-events'

const issue = { id: 'issue-1', userId: 'user-1', title: 'Fix login', status: 'done', revision: 4 }

test('Telegram messages keep their linked issue and dedupe by source message', () => {
  const telegram = { threadId: 'telegram:thread-1', telegramUserId: 'telegram-user-1', messageId: 42 }
  const first = userMessageEvent('user-1', 'Please check this', { issueId: 'issue-1', telegram, botId: 'c0000000-0000-4000-8000-0000000c0de9' })
  const duplicate = userMessageEvent('user-1', 'Please check this', { issueId: 'issue-1', telegram, botId: 'c0000000-0000-4000-8000-0000000c0de9' })

  assert.equal(first.dedupeKey, 'telegram:telegram:thread-1:42')
  assert.equal(duplicate.dedupeKey, first.dedupeKey)
  assert.equal(first.issueId, 'issue-1')
  assert.deepEqual(first.payload, { text: 'Please check this', telegram })
})

test('Telegram reply targets are validated and unique per chat', () => {
  const target = { threadId: 'telegram:thread-1', telegramUserId: 'telegram-user-1' }
  const event = (telegram: unknown) => ({ kind: 'user_message' as const, payload: { telegram } })
  assert.deepEqual(telegramReplyTargets([
    event({ ...target, messageId: 42 }),
    event({ ...target, messageId: 43 }),
    event({ threadId: '', telegramUserId: 'telegram-user-2', messageId: 44 }),
    event({ ...target, messageId: Number.MAX_SAFE_INTEGER + 1 }),
    { kind: 'run_finished' as const, payload: { telegram: { ...target, messageId: 45 } } },
  ]), [target])
})

test('a move to done is an event, keyed by the revision that made it', () => {
  const event = issueStatusEvent({ status: 'review' }, issue, 'c0000000-0000-4000-8000-0000000c0de9')
  assert.deepEqual(event, { userId: 'user-1', botId: 'c0000000-0000-4000-8000-0000000c0de9', kind: 'issue_done', dedupeKey: 'issue_done:issue-1:4', issueId: 'issue-1', runId: null, payload: { title: 'Fix login', previousStatus: 'review' } })
})

test('every other status move is an event too, untiered for triage; a save that keeps the status is not', () => {
  const bot = 'c0000000-0000-4000-8000-0000000c0de9'
  // Canceled, blocked or reopened used to wake nobody; now triage (the Decisions API) decides whether they matter.
  const moved = issueStatusEvent({ status: 'todo' }, { ...issue, status: 'canceled' }, bot)!
  assert.deepEqual(moved, { userId: 'user-1', botId: bot, kind: 'issue_status_changed', dedupeKey: 'issue_status:issue-1:4', issueId: 'issue-1', runId: null, payload: { title: 'Fix login', previousStatus: 'todo', status: 'canceled' } })
  assert.equal('tier' in moved, false)
  assert.equal(issueStatusEvent({ status: 'done' }, { ...issue, status: 'todo' }, bot)!.kind, 'issue_status_changed')
  assert.equal(issueStatusEvent({ status: 'done' }, issue, bot), null)
  assert.equal(issueStatusEvent({ status: 'doing' }, { ...issue, status: 'doing' }, bot), null)
})

test('a finished run is one event per run, with its summary', () => {
  const run = { id: 'run-1', userId: 'user-1', issueId: 'issue-1', kind: 'implement', status: 'succeeded' as const, stopReason: 'submitted' }
  const event = runFinishedEvent({ ...run, report: { summary: 'Fixed the redirect' } as never })
  assert.equal(event.dedupeKey, 'run_finished:run-1')
  assert.deepEqual(event.payload, { status: 'succeeded', stopReason: 'submitted', runKind: 'implement', summary: 'Fixed the redirect' })
  assert.equal(runFinishedEvent(run).payload.summary, null)
})

// A run carries the bot that dispatched it; its events record that bot.
const workerRun = { id: 'run-1', userId: 'user-1', issueId: 'issue-1', botId: 'c0000000-0000-4000-8000-0000000c0de9' }

test('a finished run includes server-verified PR output in the same deduplicated event', () => {
  const publication = { pullRequest: { url: 'https://github.com/owner/repo/pull/7', state: 'draft' as const }, branch: 'mikka/mik-42' }
  const event = runFinishedEvent({ id: 'run-1', userId: 'owner', issueId: 'issue-1', kind: 'implement', status: 'succeeded', stopReason: 'submitted', publication })
  assert.equal(event.dedupeKey, 'run_finished:run-1')
  assert.deepEqual(event.payload.publication, publication)
})

test('a retry after the device went offline is one event per lost run', () => {
  const event = runRetriedEvent(workerRun, { runId: 'run-2', attempt: 2, maxAttempts: 3 })
  assert.deepEqual(event, { userId: 'user-1', botId: 'c0000000-0000-4000-8000-0000000c0de9', kind: 'run_retried', dedupeKey: 'run_retried:run-1', issueId: 'issue-1', runId: 'run-1', payload: { retryRunId: 'run-2', attempt: 2, maxAttempts: 3 } })
})

test('worker tool calls become events on the run, each one new', () => {
  const first = runReportEvent(workerRun, 'Tests pass')
  assert.equal(first.kind, 'run_report')
  assert.match(first.dedupeKey, /^run_report:run-1:/)
  assert.notEqual(first.dedupeKey, runReportEvent(workerRun, 'Tests pass').dedupeKey)
  assert.deepEqual({ ...first, dedupeKey: '' }, { userId: 'user-1', botId: 'c0000000-0000-4000-8000-0000000c0de9', kind: 'run_report', dedupeKey: '', issueId: 'issue-1', runId: 'run-1', payload: { text: 'Tests pass' } })
  assert.deepEqual(runBlockedEvent(workerRun, 'No access').payload, { reason: 'No access' })
})

test('a question keeps only the parts the agent gave', () => {
  assert.deepEqual(runQuestionEvent(workerRun, { question: 'Rename it?' }).payload, { question: 'Rename it?' })
  assert.deepEqual(runQuestionEvent(workerRun, { question: 'Which?', options: ['A', 'B'], context: 'Both work' }).payload, { question: 'Which?', options: ['A', 'B'], context: 'Both work' })
})
