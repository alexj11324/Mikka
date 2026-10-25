import { test } from 'node:test'
import assert from 'node:assert/strict'
import { answersByName, decisionInput } from './decision'

test('answers come back by name, without refusals', () => {
  const answers = answersByName({ answers: [
    { type: 'predicate', name: 'needsPerson', probability: 0.9 },
    { type: 'refusal', name: 'other' },
    { type: 'choice', name: 'responder', choice: 'lead', confidence: 0.4 },
  ] })
  assert.deepEqual([...answers.keys()], ['needsPerson', 'responder'])
  assert.equal(answersByName({}).size, 0)
})

test('state reads as key: value lines', () => {
  assert.equal(decisionInput({ status: 'succeeded', agentSummary: 'Done' }), 'status: succeeded\nagentSummary: Done')
})
