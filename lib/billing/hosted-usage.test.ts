import assert from 'node:assert/strict'
import test from 'node:test'
import { balancePoints, HOSTED_STATES, hostedRefusal, refusalOffer, type HostedUsage } from './hosted-usage'

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
  assert.equal(balancePoints({ verified: true, free: 0, plan: 2_340_000, purchased: 10_000 }), 235)
})

test('the refusal line offers only what the person\'s state allows', () => {
  const usage = (over: Partial<HostedUsage>): HostedUsage => ({ state: 'verification_required', balance: { verified: false, free: 0, purchased: 0 }, personal: true, subscribed: false, ...over })
  // No subscription, personal, no card: both ways on.
  assert.deepEqual(refusalOffer('verification_required', usage({})), { transient: false, billing: false, card: true, connect: true, topUp: false })
  assert.deepEqual(refusalOffer('free_allowance_used', usage({})), { transient: false, billing: false, card: true, connect: true, topUp: false })
  // A team workspace: verification lands on the personal one, so no 验证银行卡.
  assert.deepEqual(refusalOffer('verification_required', usage({ personal: false })), { transient: false, billing: true, card: false, connect: true, topUp: false })
  // A team with no points: 打开计费, even with a subscription connected, since retrying would not help.
  assert.deepEqual(refusalOffer('points_exhausted', usage({ personal: false, subscribed: true })), { transient: false, billing: true, card: false, connect: false, topUp: false })
  assert.deepEqual(refusalOffer('usage_in_progress', usage({ personal: false })), { transient: true, billing: false, card: false, connect: false, topUp: false })
  // A verified card: the used-up allowance is not fixed by verifying again.
  assert.deepEqual(refusalOffer('points_exhausted', usage({ balance: { verified: true, free: 0, purchased: 0 } })), { transient: false, billing: false, card: false, connect: true, topUp: true })
  assert.deepEqual(refusalOffer('platform_paused', usage({})), { transient: false, billing: false, card: false, connect: true, topUp: false })
  // A subscription connected: it serves the person anywhere (#838), so only 暂时不可用 and 重试.
  assert.deepEqual(refusalOffer('verification_required', usage({ subscribed: true })), { transient: true, billing: false, card: false, connect: false, topUp: false })
  assert.deepEqual(refusalOffer('usage_in_progress', usage({})), { transient: true, billing: false, card: false, connect: false, topUp: false })
  // Before the state is read, nothing is offered that may turn out wrong.
  assert.deepEqual(refusalOffer('verification_required', null), { transient: false, billing: false, card: false, connect: false, topUp: false })
  assert.deepEqual(refusalOffer('usage_budget_exhausted', usage({})), { transient: false, billing: true, card: false, connect: false, topUp: false })
})

test('a refused turn moves to the person\'s own subscription: the first in the menu\'s order', async () => {
  const { ownSubscriptionOption } = await import('../bot-model-menu-view')
  const option = (id: string, provider: string) => ({ id, modelId: id, provider })
  assert.equal(ownSubscriptionOption({ groups: [{ kind: 'hosted', options: [option('h', 'mikka')] }, { kind: 'shared', provider: 'claude', owner: '林二', options: [option('s', 'claude')] }] }), null, 'a teammate\'s shared subscription is not the person\'s own')
  assert.equal(ownSubscriptionOption({ groups: [{ kind: 'subscription', provider: 'claude', owner: '林二', credentialLabel: '林二', options: [option('s', 'claude')] }] }), null, 'a shared subscription group cannot become an own-account recovery option')
  assert.deepEqual(ownSubscriptionOption({ groups: [
    { kind: 'hosted', options: [option('h', 'mikka')] },
    { kind: 'subscription', provider: 'claude', plan: 'Max', options: [option('opus', 'claude'), option('sonnet', 'claude')] },
    { kind: 'subscription', provider: 'codex', plan: 'Pro', options: [option('gpt', 'codex')] },
  ] }), { option: 'opus', provider: 'claude', plan: 'Max' })
})
