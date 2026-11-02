import assert from 'node:assert/strict'
import test from 'node:test'
import { eventPrompt } from './context'
import { eventLine } from './event-line'

const runId = 'de300000-2b09-4c5e-8a10-1234567890ab'
const issueId = 'de300000-2413-4c5e-8a10-1234567890ab'

test('every event the chat shows becomes a line kind, from the text the server itself writes (C1)', () => {
  const question = eventPrompt({ kind: 'run_question', issueId, runId, payload: { question: 'msw or just these two tests?' } })
  assert.deepEqual(eventLine('run_question', question), { kind: 'runQuestion', runId, issueId: null, status: null, title: null })

  const finished = eventPrompt({ kind: 'run_finished', issueId, runId, payload: { status: 'failed', stopReason: 'error' } })
  assert.deepEqual(eventLine('run_finished', finished, 'failed'), { kind: 'runFinished', runId, issueId, status: 'failed', title: null })
  assert.equal(eventLine('run_finished', finished).status, 'failed', 'older rows carry no observed state')

  const moved = eventPrompt({ kind: 'issue_status_changed', issueId, runId: null, payload: { title: '登录页在 Safari 17 上白屏', previousStatus: 'todo', status: 'in_review' } })
  assert.deepEqual(eventLine('issue_status_changed', moved), { kind: 'issueStatus', runId: null, issueId, status: 'in_review', title: '登录页在 Safari 17 上白屏' })
  const done = eventPrompt({ kind: 'issue_done', issueId, runId: null, payload: { title: 'Trim the bundle', previousStatus: 'doing' } })
  assert.equal(eventLine('issue_done', done).status, 'done')

  const retried = eventPrompt({ kind: 'run_retried', issueId, runId, payload: { retryRunId: 'x', attempt: 2, maxAttempts: 3, movedTo: { kind: 'cloud' } } })
  assert.equal(eventLine('run_retried', retried).kind, 'runRetried')
  assert.equal(eventLine('run_retried', retried).runId, runId)

  const declined = eventPrompt({ kind: 'action_decided', issueId: null, runId: null, payload: { action: 'send_email', actionId: 'a1', status: 'declined' } })
  assert.equal(eventLine('action_decided', declined, 'declined').status, 'declined')
})

test('an event kind the chat does not know is a plain line, never its text', () => {
  assert.deepEqual(eventLine('something_new', '[Event] Internal detail with ids'), { kind: 'other', runId: null, issueId: null, status: null, title: null })
  assert.equal(eventLine(undefined, '[Event] legacy').kind, 'other')
})
