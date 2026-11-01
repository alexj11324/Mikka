import assert from 'node:assert/strict'
import test from 'node:test'
import { balancePoints, HOSTED_STATES, hostedRefusal, pollUntil, refusalOffer, type HostedUsage } from './hosted-usage'

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

test('the refusal line offers only what the person\'s state allows', () => {
  const usage = (over: Partial<HostedUsage>): HostedUsage => ({ state: 'verification_required', balance: { verified: false, free: 0, purchased: 0 }, personal: true, subscribed: false, ...over })
  // No subscription, personal, no card: both ways on.
  assert.deepEqual(refusalOffer('verification_required', usage({})), { transient: false, card: true, connect: true })
  assert.deepEqual(refusalOffer('free_allowance_used', usage({})), { transient: false, card: true, connect: true })
  // A team workspace: verification lands on the personal one, so no 验证银行卡.
  assert.deepEqual(refusalOffer('verification_required', usage({ personal: false })), { transient: false, card: false, connect: true })
  // A verified card: the used-up allowance is not fixed by verifying again.
  assert.deepEqual(refusalOffer('points_exhausted', usage({ balance: { verified: true, free: 0, purchased: 0 } })), { transient: false, card: false, connect: true })
  assert.deepEqual(refusalOffer('platform_paused', usage({})), { transient: false, card: false, connect: true })
  // A subscription connected: it serves the person anywhere (#838), so only 暂时不可用 and 重试.
  assert.deepEqual(refusalOffer('verification_required', usage({ subscribed: true })), { transient: true, card: false, connect: false })
  assert.deepEqual(refusalOffer('usage_in_progress', usage({})), { transient: true, card: false, connect: false })
  // Before the state is read, nothing is offered that may turn out wrong.
  assert.deepEqual(refusalOffer('verification_required', null), { transient: false, card: false, connect: false })
})
