import { test } from 'node:test'
import assert from 'node:assert/strict'
import { issueDoneEvent, runFinishedEvent } from './coordinator-events'

const issue = { id: 'issue-1', userId: 'user-1', title: 'Fix login', status: 'done', revision: 4 }

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
