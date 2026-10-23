import { test } from 'node:test'
import assert from 'node:assert/strict'
import { answersByName, callCostUsd, DEFAULT_MONTHLY_BUDGET_USD, decisionInput, monthlyBudgetUsd, monthStart } from './decision'

test('the monthly budget defaults to the Gateway free quota', () => {
  assert.equal(monthlyBudgetUsd({}), DEFAULT_MONTHLY_BUDGET_USD)
  assert.equal(monthlyBudgetUsd({ DECISION_MONTHLY_BUDGET_USD: '' }), 5)
  assert.equal(monthlyBudgetUsd({ DECISION_MONTHLY_BUDGET_USD: 'lots' }), 5)
  assert.equal(monthlyBudgetUsd({ DECISION_MONTHLY_BUDGET_USD: '-1' }), 5)
  assert.equal(monthlyBudgetUsd({ DECISION_MONTHLY_BUDGET_USD: '2.5' }), 2.5)
  assert.equal(monthlyBudgetUsd({ DECISION_MONTHLY_BUDGET_USD: '0' }), 0)
})

test('spend counts from the first of the month, UTC', () => {
  assert.equal(monthStart(new Date('2026-10-23T14:00:00Z')).toISOString(), '2026-10-01T00:00:00.000Z')
  assert.equal(monthStart(new Date('2026-01-01T00:00:00Z')).toISOString(), '2026-01-01T00:00:00.000Z')
})

test('a call costs what the Gateway reports, else input tokens at list price', () => {
  assert.equal(callCostUsd({ provider_metadata: { gateway: { cost: '0.0000096' } }, usage: { input_tokens: 1 } }), 0.0000096)
  assert.equal(callCostUsd({ usage: { input_tokens: 500 } }), 0.00005)
  assert.equal(callCostUsd({}), 0)
})

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
