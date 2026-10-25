import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lostRunOutcome, MAX_RUN_ATTEMPTS, retryNote, retryPrompt } from './run-retry'

const run = { attempt: 1, stopRequestedAt: null, issueId: 'issue-1', deviceRepoId: 'repo-1' }

test('a run that lost its device is queued again as the next attempt', () => {
  assert.deepEqual(lostRunOutcome(run), { kind: 'retry', attempt: 2 })
  assert.deepEqual(lostRunOutcome({ ...run, attempt: MAX_RUN_ATTEMPTS - 1 }), { kind: 'retry', attempt: MAX_RUN_ATTEMPTS })
})

test('the last attempt fails instead, for the person', () => {
  const outcome = lostRunOutcome({ ...run, attempt: MAX_RUN_ATTEMPTS })
  assert.equal(outcome.kind, 'failed')
})

test('a run the person asked to stop just stops', () => {
  assert.deepEqual(lostRunOutcome({ ...run, stopRequestedAt: new Date() }), { kind: 'stopped' })
})

test('a run without its issue or repository cannot be queued again', () => {
  assert.equal(lostRunOutcome({ ...run, deviceRepoId: null }).kind, 'failed')
  assert.equal(lostRunOutcome({ ...run, issueId: null }).kind, 'failed')
})

test('the retry brief keeps the original and says what happened, once', () => {
  const second = retryPrompt('# Fix login\n\nThe redirect loops.', 2)
  assert.match(second, /^# Fix login\n\nThe redirect loops\.\n\n## This run is a retry/)
  assert.match(second, new RegExp(`attempt 2 of ${MAX_RUN_ATTEMPTS}`))
  const third = retryPrompt(second, 3)
  assert.equal(third.match(/## This run is a retry/g)?.length, 1)
  assert.match(third, /attempt 3 of/)
})

test('the retry brief stays within the prompt limit and keeps its note', () => {
  const prompt = retryPrompt('x'.repeat(100_000), 2)
  assert.ok(prompt.length <= 100_000)
  assert.match(prompt, /## This run is a retry/)
})

test('a resumed session gets only the note on what happened', () => {
  const note = retryNote(2)
  assert.match(note, /^## This run is a retry/)
  assert.ok(retryPrompt('# Fix login', 2).endsWith(note))
})
