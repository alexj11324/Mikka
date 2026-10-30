import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import test from 'node:test'
import { stripeConfig, stripeForm, stripePost, StripeRequestError, verifyStripeSignature } from './stripe'

test('config is null without a key; form encoding nests the way Stripe expects', () => {
  assert.equal(stripeConfig({}), null)
  assert.deepEqual(stripeConfig({ STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_TEAM_PRICE_ID: 'price_1' }), { secretKey: 'sk_test_x', teamPriceId: 'price_1', webhookSecret: null })
  assert.deepEqual(stripeForm({ mode: 'subscription', line_items: [{ price: 'p', quantity: 2 }], metadata: { workspaceId: 'w' }, skip: undefined }),
    ['mode=subscription', 'line_items%5B0%5D%5Bprice%5D=p', 'line_items%5B0%5D%5Bquantity%5D=2', 'metadata%5BworkspaceId%5D=w'])
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
