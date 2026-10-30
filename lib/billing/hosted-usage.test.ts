import assert from 'node:assert/strict'
import test from 'node:test'
import { HOSTED_STATES, hostedRefusal, hostedRemaining, usdFromMicro, waitForVerification, type HostedUsage } from './hosted-usage'

test('finds the hosted refusal code in a failed turn', () => {
  for (const state of HOSTED_STATES.filter(state => state !== 'ready')) assert.equal(hostedRefusal(state), state)
  assert.equal(hostedRefusal('Error: verification_required'), 'verification_required')
  assert.equal(hostedRefusal('PaidResourceError: platform_paused'), 'platform_paused')
  assert.equal(hostedRefusal('generation_failed_not_replayed'), null)
  assert.equal(hostedRefusal('ready'), null)
  assert.equal(hostedRefusal(null), null)
})

test('shows dollars rounded down to the cent', () => {
  assert.equal(usdFromMicro(1_000_000), 1)
  assert.equal(usdFromMicro(734_999), 0.73)
  assert.equal(usdFromMicro(-5), 0)
  assert.equal(hostedRemaining({ verified: true, free: 250_000, purchased: 2_000_000 }), 2.25)
})

const unverified: HostedUsage = { state: 'verification_required', balance: { verified: false, free: 0, purchased: 0 } }
const verified: HostedUsage = { state: 'ready', balance: { verified: true, free: 1_000_000, purchased: 0 } }

test('waits for the webhook to record the card', async () => {
  const reads = [unverified, null, verified]
  const sleeps: number[] = []
  const result = await waitForVerification(async () => reads.shift() ?? null, { interval: 5, sleep: async ms => { sleeps.push(ms) } })
  assert.deepEqual(result, verified)
  assert.deepEqual(sleeps, [5, 5])
})

test('gives up when the webhook has not recorded the card', async () => {
  let reads = 0
  const result = await waitForVerification(async () => { reads++; return unverified }, { attempts: 3, sleep: async () => {} })
  assert.equal(result, null)
  assert.equal(reads, 3)
})
