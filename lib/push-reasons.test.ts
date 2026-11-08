import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pushInput, pushQuestions, pushTask, readPush } from './push-reasons'

const answer = (choice: string) => new Map([['push', { type: 'choice' as const, name: 'push', choice }]])

test('whether a reply goes to the phone is the Decisions API\'s choice, not a table of event kinds', () => {
  const [question] = pushQuestions()
  assert.deepEqual(question.type === 'choice' && question.choices.map(choice => choice.value), ['decide', 'review', 'finished', 'briefing', 'none'])
  // A reply to the person's own message can be pushed if the model says so; a finished run can stay quiet.
  assert.equal(readPush(answer('decide')), 'decide')
  assert.equal(readPush(answer('none')), 'none')
  // No usable answer pushes nothing.
  assert.equal(readPush(null), null)
  assert.equal(readPush(answer('everything')), null)
})

test('the events and the reply are evidence; a withheld code is never quoted', () => {
  const input = pushInput([{ kind: 'user_message', tier: 'attention' }, { kind: 'run_finished', tier: 'result' }], 'Done: the PR is open.')
  assert.match(input, /answeredEvents: user_message \(attention\), run_finished \(result\)/)
  assert.match(input, /answersAMessageFromThePerson: yes/)
  assert.match(input, /reply: Done: the PR is open\./)
  assert.doesNotMatch(pushInput([{ kind: 'matter_handoff', tier: 'attention' }], null), /\d{6}/)
  assert.match(pushInput([{ kind: 'matter_handoff', tier: 'attention' }], null), /text withheld/)
})

test('a decide or review push about one task opens that task at its attempt; anything else opens the chat', () => {
  const event = (issueId: string | null, runId: string | null) => ({ kind: 'run_question' as never, tier: null, issueId, runId })
  assert.deepEqual(pushTask([event('t1', 'r1')], 'decide'), { issueId: 't1', runId: 'r1' })
  assert.deepEqual(pushTask([event('t1', 'r1'), event(null, null)], 'review'), { issueId: 't1', runId: 'r1' })
  assert.deepEqual(pushTask([event('t1', 'r1'), event('t1', 'r2')], 'decide'), { issueId: 't1', runId: null })
  assert.equal(pushTask([event('t1', 'r1'), event('t2', 'r2')], 'decide'), null)
  assert.equal(pushTask([event('t1', 'r1')], 'finished'), null)
  assert.equal(pushTask([{ kind: 'user_message' as never, tier: null }], 'decide'), null)
})
