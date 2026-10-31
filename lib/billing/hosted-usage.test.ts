import assert from 'node:assert/strict'
import test from 'node:test'
import { balancePoints, HOSTED_STATES, hostedRefusal, pollUntil } from './hosted-usage'

test('finds the hosted refusal code in a failed turn', () => {
  for (const state of HOSTED_STATES.filter(state => state !== 'ready')) assert.equal(hostedRefusal(state), state)
  assert.equal(hostedRefusal('Error: verification_required'), 'verification_required')
  assert.equal(hostedRefusal('PaidResourceError: platform_paused'), 'platform_paused')
  assert.equal(hostedRefusal('generation_failed_not_replayed'), null)
  assert.equal(hostedRefusal('ready'), null)
  assert.equal(hostedRefusal(null), null)
})

test('shows the allowance and purchased points as one balance, 100 points per dollar, rounded down', () => {
  assert.equal(balancePoints({ verified: true, free: 1_000_000, purchased: 0 }), 100)
  assert.equal(balancePoints({ verified: true, free: 734_999, purchased: 2_000_000 }), 273)
  assert.equal(balancePoints({ verified: false, free: 0, purchased: -5 }), 0)
})

test('polls until the webhook has recorded the result', async () => {
  const reads = ['pending', 'pending', 'verified']
  const sleeps: number[] = []
  const result = await pollUntil(async () => reads.shift()!, value => value === 'verified', { interval: 5, sleep: async ms => { sleeps.push(ms) } })
  assert.equal(result, 'verified')
  assert.deepEqual(sleeps, [5, 5])
})

test('returns the last read when the webhook has not arrived', async () => {
  let reads = 0
  const result = await pollUntil(async () => ++reads, () => false, { attempts: 3, sleep: async () => {} })
  assert.equal(result, 3)
})
