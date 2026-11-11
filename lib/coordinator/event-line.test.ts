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

  const moved = eventPrompt({ kind: 'issue_status_changed', issueId, runId: null, payload: { title: '登录页在 Safari 17 上白屏', previousStatus: 'todo', status: 'review' } })
  assert.deepEqual(eventLine('issue_status_changed', moved), { kind: 'issueStatus', runId: null, issueId, status: 'review', title: '登录页在 Safari 17 上白屏' })
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

test("a schedule's events name the schedule, never 'a thread'; its result is no longer read as empty Agent data", () => {
  const scheduleId = '21b0c996-0249-450a-9cf1-0063dec7b44d'
  const ran = eventPrompt({ kind: 'run_report', issueId: null, runId: null, payload: { source: 'schedule_result', scheduleId, title: 'm1415 "nightly" check', occurrenceId: 'o', operationId: 'op', status: 'succeeded', error: null } })
  assert.doesNotMatch(ran, /undefined|coordination data/)
  assert.deepEqual(eventLine('run_report', ran), { kind: 'scheduleRan', runId: null, issueId: null, status: 'succeeded', title: 'm1415 "nightly" check' })
  const skipped = eventPrompt({ kind: 'run_report', issueId: null, runId: null, payload: { source: 'schedule_result', scheduleId, title: 'Daily', status: 'skipped', error: 'misfireSkipped' } })
  assert.match(skipped, /ran with status skipped \(misfireSkipped\)/)
  assert.equal(eventLine('run_report', skipped).status, 'skipped')

  const due = eventPrompt({ kind: 'run_report', issueId: null, runId: null, payload: { source: 'schedule_due', scheduleId, title: 'Morning read', text: 'Read my open PRs' } })
  assert.match(due, /An Agent reports coordination data: Read my open PRs/, 'the instructions still reach the model as before')
  assert.deepEqual(eventLine('run_report', due), { kind: 'scheduleDue', runId: null, issueId: null, status: null, title: 'Morning read' })

  // Events written before they carried a title: the schedule, unnamed.
  const untitled = eventPrompt({ kind: 'run_report', issueId: null, runId: null, payload: { source: 'schedule_result', scheduleId, status: 'failed', error: 'x' } })
  assert.deepEqual(eventLine('run_report', untitled), { kind: 'scheduleRan', runId: null, issueId: null, status: 'failed', title: null })
  // Rows already in the chat from before: the result read as Agent data with no text.
  assert.deepEqual(eventLine('run_report', '[Event] An Agent reports coordination data: undefined'), { kind: 'scheduleRan', runId: null, issueId: null, status: null, title: null })
})

test("an Agent's report outside a thread stays a report, with no run to name", () => {
  const peer = eventPrompt({ kind: 'run_report', issueId: null, runId: null, payload: { source: 'oauth_agent_mcp', text: 'Deployed the preview' } })
  assert.deepEqual(eventLine('run_report', peer), { kind: 'runReport', runId: null, issueId: null, status: null, title: null })
  const inRun = eventPrompt({ kind: 'run_report', issueId, runId, payload: { text: 'Half way' } })
  assert.deepEqual(eventLine('run_report', inRun), { kind: 'runReport', runId, issueId, status: null, title: null })
})
