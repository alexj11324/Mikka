import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lostRunOutcome, MAX_RUN_ATTEMPTS, pickTakeover, remoteKey, retryNote, retryPrompt, type TakeoverCandidate } from './run-retry'

const run = { attempt: 1, stopRequestedAt: null, issueId: 'issue-1', deviceRepoId: 'repo-1' }

test('a run that lost its device is queued again as the next attempt', () => {
  assert.deepEqual(lostRunOutcome(run), { kind: 'retry', attempt: 2 })
  assert.deepEqual(lostRunOutcome({ ...run, attempt: MAX_RUN_ATTEMPTS - 1 }), { kind: 'retry', attempt: MAX_RUN_ATTEMPTS })
})

test('the last attempt fails instead, for the person', () => {
  const outcome = lostRunOutcome({ ...run, attempt: MAX_RUN_ATTEMPTS })
  assert.equal(outcome.kind, 'failed')
})

test('a lost question continuation never enters generic device takeover or retry', () => {
  for (const questionContinuation of [{ questionId: 'question-1', originSessionId: 'original-session' }, {}]) {
    const outcome = lostRunOutcome({ ...run, questionContinuation })
    assert.equal(outcome.kind, 'failed')
    if (outcome.kind === 'failed') assert.match(outcome.error, /original-session.*explicit recovery/)
    assert.deepEqual(lostRunOutcome({ ...run, questionContinuation, stopRequestedAt: new Date() }), { kind: 'stopped' })
  }
  assert.deepEqual(lostRunOutcome({ ...run, questionContinuation: null }), { kind: 'retry', attempt: 2 })
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

test('https and ssh spellings of one remote match', () => {
  const key = 'v2/github.com/alexj11324/mikka'
  for (const url of ['https://github.com/alexj11324/Mikka.git', 'git@github.com:alexj11324/Mikka.git', 'ssh://git@github.com/alexj11324/Mikka']) {
    assert.equal(remoteKey(url), key, url)
  }
  assert.equal(remoteKey('ssh://git@host:2222/team/repo.git'), 'v2/ssh/host/2222/user/git/absolute/team/repo.git')
  assert.throws(() => remoteKey('https://token@github.com/alexj11324/mikka/'))
})

const candidate = (deviceId: string, extra: Partial<TakeoverCandidate> = {}): TakeoverCandidate => ({
  deviceId, harnesses: [{ harness: 'codex', installed: true }], ...extra,
})
const lostRun = { remoteUrl: 'https://github.com/a/b', harness: 'codex', lostDeviceId: 'd1' }

test('a run goes on another machine with the harness, without registering a repository', () => {
  assert.equal(pickTakeover([candidate('d1'), candidate('d2')], lostRun)?.deviceId, 'd2')
})

test('no other machine fits: the run waits for its own', () => {
  assert.equal(pickTakeover([candidate('d1')], lostRun), null)
  assert.equal(pickTakeover([candidate('d2', { harnesses: [{ harness: 'codex', installed: false }] })], lostRun), null)
  assert.equal(pickTakeover([candidate('d2', { harnesses: [{ harness: 'claude_code', installed: true }] })], lostRun), null)
  assert.equal(pickTakeover([candidate('d2')], { ...lostRun, remoteUrl: null }), null)
})
