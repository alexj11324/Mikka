import { test } from 'node:test'
import assert from 'node:assert/strict'
import { issueDoneEvent, runBlockedEvent, runFinishedEvent, runQuestionEvent, runReportEvent, telegramReplyTargets, userMessageEvent } from './coordinator-events'

const issue = { id: 'issue-1', userId: 'user-1', title: 'Fix login', status: 'done', revision: 4 }

test('Telegram messages keep their linked issue and dedupe by source message', () => {
  const telegram = { threadId: 'telegram:thread-1', telegramUserId: 'telegram-user-1', messageId: 42 }
  const first = userMessageEvent('user-1', 'Please check this', { issueId: 'issue-1', telegram })
  const duplicate = userMessageEvent('user-1', 'Please check this', { issueId: 'issue-1', telegram })

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
  const event = issueDoneEvent({ status: 'review' }, issue)
  assert.deepEqual(event, { userId: 'user-1', kind: 'issue_done', dedupeKey: 'issue_done:issue-1:4', issueId: 'issue-1', runId: null, payload: { title: 'Fix login', previousStatus: 'review' } })
})

test('saves that do not move the issue to done are not events', () => {
  assert.equal(issueDoneEvent({ status: 'done' }, issue), null)
  assert.equal(issueDoneEvent({ status: 'todo' }, { ...issue, status: 'doing' }), null)
})

test('a finished run is one event per run, with its summary', () => {
  const run = { id: 'run-1', userId: 'user-1', issueId: 'issue-1', kind: 'implement', status: 'succeeded' as const, stopReason: 'submitted' }
  const event = runFinishedEvent({ ...run, report: { summary: 'Fixed the redirect' } as never })
  assert.equal(event.dedupeKey, 'run_finished:run-1')
  assert.deepEqual(event.payload, { status: 'succeeded', stopReason: 'submitted', runKind: 'implement', summary: 'Fixed the redirect' })
  assert.equal(runFinishedEvent(run).payload.summary, null)
})

const workerRun = { id: 'run-1', userId: 'user-1', issueId: 'issue-1' }

test('worker tool calls become events on the run, each one new', () => {
  const first = runReportEvent(workerRun, 'Tests pass')
  assert.equal(first.kind, 'run_report')
  assert.match(first.dedupeKey, /^run_report:run-1:/)
  assert.notEqual(first.dedupeKey, runReportEvent(workerRun, 'Tests pass').dedupeKey)
  assert.deepEqual({ ...first, dedupeKey: '' }, { userId: 'user-1', kind: 'run_report', dedupeKey: '', issueId: 'issue-1', runId: 'run-1', payload: { text: 'Tests pass' } })
  assert.deepEqual(runBlockedEvent(workerRun, 'No access').payload, { reason: 'No access' })
})

test('a question keeps only the parts the agent gave', () => {
  assert.deepEqual(runQuestionEvent(workerRun, { question: 'Rename it?' }).payload, { question: 'Rename it?' })
  assert.deepEqual(runQuestionEvent(workerRun, { question: 'Which?', options: ['A', 'B'], context: 'Both work' }).payload, { question: 'Which?', options: ['A', 'B'], context: 'Both work' })
})
