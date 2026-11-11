import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import test from 'node:test'
import { stripeConfig, stripeForm, stripePost, StripeRequestError, verifyStripeSignature } from './stripe'
import { resourcePrice, subscriptionEntitlement } from './resource-plan'

test('config is null without a key; form encoding nests the way Stripe expects', () => {
  assert.equal(stripeConfig({}), null)
  assert.equal(stripeConfig({ STRIPE_SECRET_KEY: 'sk_test_x' }), null)
  assert.deepEqual(stripeConfig({ MIKKA_EDITION: 'cloud', STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_TEAM_PRICE_ID: 'price_1' }), { secretKey: 'sk_test_x', teamPriceId: 'price_1', resourcePriceId: null, webhookSecret: null })
  assert.deepEqual(stripeForm({ mode: 'subscription', line_items: [{ price: 'p', quantity: 2 }], metadata: { workspaceId: 'w' }, skip: undefined }),
    ['mode=subscription', 'line_items%5B0%5D%5Bprice%5D=p', 'line_items%5B0%5D%5Bquantity%5D=2', 'metadata%5BworkspaceId%5D=w'])
})

test('a resource price requires configured identity and explicit resource metadata', () => {
  const price = { id: 'price_resource', active: true, currency: 'usd', type: 'recurring', billing_scheme: 'per_unit', unit_amount: 2000,
    recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' },
    metadata: { mikka_billing_model: 'resource_v1', mikka_plan: 'pro', mikka_monthly_points: '2000' } }
  assert.deepEqual(resourcePrice(price, price.id), { id: price.id, plan: 'pro', monthlyPoints: 2000, amountCents: 2000, currency: 'usd', version: 'resource_v1' })
  assert.throws(() => resourcePrice({ ...price, metadata: { ...price.metadata, mikka_billing_model: 'seat' } }, price.id))
  assert.throws(() => resourcePrice(price, 'price_legacy'))
  assert.throws(() => resourcePrice({ ...price, active: false }, price.id))
  assert.equal(resourcePrice({ ...price, active: false }, price.id, { requireActive: false }).plan, 'pro', 'archiving a price does not invalidate already-paid subscriptions')
  assert.throws(() => resourcePrice({ ...price, recurring: { ...price.recurring, interval: 'year' } }, price.id))
})

test('paid entitlements expire; unpaid, canceled and unrecognized plans cannot grant access', () => {
  const now = new Date('2026-11-10T00:00:00Z'), end = Math.floor(now.getTime() / 1000) + 86400
  const input = { status: 'active', paid: true, plan: 'pro' as const, periodEnd: end, now }
  assert.equal(subscriptionEntitlement(input).plan, 'pro')
  for (const status of ['canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'paused', 'trialing']) {
    assert.equal(subscriptionEntitlement({ ...input, status }).plan, 'free')
  }
  assert.equal(subscriptionEntitlement({ ...input, paid: false }).plan, 'free')
  assert.equal(subscriptionEntitlement({ ...input, paid: false, previousPaidUntil: new Date((end - 60) * 1000) }).expiresAt?.getTime(), (end - 60) * 1000)
  assert.equal(subscriptionEntitlement({ ...input, periodEnd: null }).plan, 'free')
  assert.equal(subscriptionEntitlement({ ...input, plan: null }).plan, 'free')
  assert.equal(subscriptionEntitlement({ ...input, status: 'past_due', previousPaidUntil: new Date((end - 60) * 1000) }).expiresAt?.getTime(), (end - 60) * 1000)
})

test('requests carry the key as a bearer header; failures keep only the status', async () => {
  const seen: Array<[string, RequestInit]> = []
  const ok = (async (url: string, init: RequestInit) => { seen.push([url, init]); return new Response(JSON.stringify({ url: 'https://billing.stripe.com/s' })) }) as unknown as typeof fetch
  assert.deepEqual(await stripePost({ secretKey: 'sk_test_x', teamPriceId: null, webhookSecret: null }, 'billing_portal/sessions', { customer: 'cus_1' }, ok), { url: 'https://billing.stripe.com/s' })
  assert.equal(seen[0][0], 'https://api.stripe.com/v1/billing_portal/sessions')
  assert.equal((seen[0][1].headers as Record<string, string>).authorization, 'Bearer sk_test_x')
  const failing = (async () => new Response('{"error":{"message":"secret detail"}}', { status: 402 })) as unknown as typeof fetch
  await assert.rejects(stripePost({ secretKey: 'k', teamPriceId: null, webhookSecret: null }, 'x', {}, failing), (error: unknown) => error instanceof StripeRequestError && error.status === 402 && !error.message.includes('secret detail'))
})

test('webhook signatures: valid, tampered, stale and missing', () => {
  const secret = 'whsec_test', body = '{"id":"evt_1"}', now = 1_800_000_000_000
  const t = Math.floor(now / 1000)
  const sig = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')
  assert.equal(verifyStripeSignature(body, `t=${t},v1=${sig}`, secret, now), true)
  assert.equal(verifyStripeSignature(`${body} `, `t=${t},v1=${sig}`, secret, now), false)
  assert.equal(verifyStripeSignature(body, `t=${t - 1000},v1=${sig}`, secret, now), false)
  assert.equal(verifyStripeSignature(body, null, secret, now), false)
  assert.equal(verifyStripeSignature(body, `t=${t},v1=zz`, secret, now), false)
})
