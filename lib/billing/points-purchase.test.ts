import assert from 'node:assert/strict'
import { before, beforeEach, mock, test } from 'node:test'
import { BASE_PATH } from '../base-path'

const workspaceId = '11111111-1111-4111-8111-111111111111'
const env = { MIKKA_EDITION: 'cloud', STRIPE_SECRET_KEY: 'sk_test_fixture', STRIPE_WEBHOOK_SECRET: 'whsec_fixture', BETTER_AUTH_URL: 'https://app.example' }
let admin = true
let existingCustomer: string | undefined
let providerStatus = 200
let checkoutUrl = 'https://checkout.stripe.com/c/pay/fixture'
const authorizations: unknown[][] = []
const requests: Array<{ url: string; body: URLSearchParams; idempotencyKey: string | undefined }> = []
const queries: Array<{ sql: string; values: unknown[] }> = []
class WorkspaceError extends Error { constructor(readonly code: string) { super(code) } }

mock.module(new URL('../db/index.ts', import.meta.url).href, { namedExports: { pool: {
  query: async (sql: string, values: unknown[]) => {
    queries.push({ sql, values })
    if (sql.includes('INSERT INTO')) {
      existingCustomer ??= values[1] as string
      return { rows: [{ id: existingCustomer }] }
    }
    return { rows: existingCustomer ? [{ id: existingCustomer }] : [] }
  },
} } })
mock.module(new URL('../workspace-db.ts', import.meta.url).href, { namedExports: { workspaceDb: { transaction: async (fn: (tx: unknown) => Promise<void>) => fn({}) } } })
mock.module(new URL('../workspace-access.ts', import.meta.url).href, { namedExports: {
  WorkspaceError,
  requireWorkspace: async (...args: unknown[]) => {
    authorizations.push(args.slice(1))
    if (!admin) throw new WorkspaceError('workspaceAccessDenied')
  },
} })

let pointsPurchaseUrl: typeof import('./points-purchase')['pointsPurchaseUrl']
let pointsPurchase: typeof import('./points-purchase')['pointsPurchase']
before(async () => { ({ pointsPurchaseUrl, pointsPurchase } = await import('./points-purchase')) })
beforeEach(() => {
  admin = true
  existingCustomer = 'cus_existing'
  providerStatus = 200
  checkoutUrl = 'https://checkout.stripe.com/c/pay/fixture'
  requests.length = 0
  queries.length = 0
  authorizations.length = 0
})
const fake = (async (url: string, init?: RequestInit) => {
  requests.push({ url, body: new URLSearchParams(String(init?.body)), idempotencyKey: (init?.headers as Record<string, string> | undefined)?.['idempotency-key'] })
  const body = new URLSearchParams(String(init?.body))
  return Response.json(url.endsWith('/customers') ? { id: 'cus_new' } : body.get('ui_mode') ? { client_secret: 'cs_fixture_secret' } : { url: checkoutUrl }, { status: providerStatus })
}) as typeof fetch

test('each fixed USD amount creates a payment session with server-owned pricing and matching payment metadata', async () => {
  for (const amount of [10, 25, 50]) {
    assert.deepEqual(await pointsPurchaseUrl('actor', workspaceId, amount, 'zh-CN', fake, env), { url: checkoutUrl })
    const { body } = requests.at(-1)!
    assert.equal(body.get('mode'), 'payment')
    assert.equal(body.get('managed_payments[enabled]'), 'true')
    assert.equal(body.get('customer'), 'cus_existing')
    assert.equal(body.get('client_reference_id'), workspaceId)
    assert.equal(body.get('line_items[0][price_data][currency]'), 'usd')
    assert.equal(body.get('line_items[0][price_data][unit_amount]'), String(amount * 100))
    assert.equal(body.get('line_items[0][quantity]'), '1')
    // Managed Payments (on by default for the account) refuses a product without an eligible tax code.
    assert.equal(body.get('line_items[0][price_data][product_data][tax_code]'), 'txcd_10105002')
    for (const prefix of ['metadata', 'payment_intent_data[metadata]']) {
      assert.equal(body.get(`${prefix}[workspaceId]`), workspaceId)
      assert.equal(body.get(`${prefix}[points]`), String(amount * 100))
      assert.equal(body.get(`${prefix}[purpose]`), 'points_purchase')
    }
    const success = body.get('success_url')!
    assert.ok(success.endsWith('&session_id={CHECKOUT_SESSION_ID}'))
    assert.equal(new URL(success).origin, env.BETTER_AUTH_URL)
    assert.equal(new URL(success).pathname, `${BASE_PATH}/settings`)
    assert.equal(new URL(success).searchParams.get('section'), 'billing')
    assert.equal(new URL(success).searchParams.get('workspace'), workspaceId)
    assert.equal(new URL(success).searchParams.get('topup'), 'success')
    const cancel = new URL(body.get('cancel_url')!)
    assert.equal(cancel.searchParams.get('topup'), 'cancelled')
    assert.equal(cancel.searchParams.has('session_id'), false)
  }
  assert.deepEqual(authorizations, Array(3).fill([workspaceId, 'actor', true]))
  assert.ok(queries.every(query => query.values[0] === workspaceId))
})

test('English returns to the localized billing section and Preview keeps its isolated origin', async () => {
  await pointsPurchaseUrl('actor', workspaceId, 10, 'en', fake, { ...env, BETTER_AUTH_URL: undefined, VERCEL_ENV: 'preview', VERCEL_URL: 'preview.example' })
  const back = new URL(requests[0].body.get('success_url')!)
  assert.equal(back.origin, 'https://preview.example')
  assert.equal(back.pathname, `${BASE_PATH}/en/settings`)
})

test('non-admins and client-supplied values outside the fixed list cannot create customers or sessions', async () => {
  admin = false
  await assert.rejects(pointsPurchaseUrl('member', workspaceId, 10, 'en', fake, env), /workspaceAccessDenied/)
  admin = true
  for (const amount of [0, 9, 10.01, 1000, NaN, Infinity, '10']) {
    await assert.rejects(pointsPurchaseUrl('actor', workspaceId, amount as number, 'en', fake, env))
  }
  assert.equal(requests.length, 0)
  assert.equal(queries.length, 0)
})

test('unconfigured payment fulfillment is unavailable before any Stripe request', async () => {
  for (const config of [{}, { ...env, STRIPE_SECRET_KEY: undefined }, { ...env, STRIPE_WEBHOOK_SECRET: undefined }, { ...env, BETTER_AUTH_URL: undefined }]) {
    await assert.rejects(pointsPurchaseUrl('actor', workspaceId, 10, 'en', fake, config), /billingNotConfigured/)
  }
  assert.equal(requests.length, 0)
  assert.equal(queries.length, 0)
})

test('first purchase creates one workspace customer and persists it for the next session', async () => {
  existingCustomer = undefined
  await pointsPurchaseUrl('actor', workspaceId, 25, 'en', fake, env)
  await pointsPurchaseUrl('actor', workspaceId, 50, 'en', fake, env)
  assert.equal(requests.filter(request => request.url.endsWith('/customers')).length, 1)
  assert.equal(requests[0].idempotencyKey, `points-customer:${workspaceId}`)
  assert.equal(requests[1].body.get('customer'), 'cus_new')
  assert.equal(requests[2].body.get('customer'), 'cus_new')
})

test('provider failures and unsafe Checkout URLs fail without leaking provider response details', async () => {
  providerStatus = 500
  await assert.rejects(pointsPurchaseUrl('actor', workspaceId, 10, 'en', fake, env), /billingProviderFailed/)
  providerStatus = 200
  for (const url of ['http://checkout.stripe.com/c/pay/x', 'https://attacker.example/c/pay/x']) {
    checkoutUrl = url
    await assert.rejects(pointsPurchaseUrl('actor', workspaceId, 10, 'en', fake, env), /billingProviderFailed/)
  }
})

test('from a chat: a dialog session with a publishable key, else a hosted page; both come back to that chat', async () => {
  const bot = '22222222-2222-4222-8222-222222222222'
  // No publishable key: the hosted page, coming back to the bot's chat (decision 2026-11-02-1450).
  assert.deepEqual(await pointsPurchase('actor', workspaceId, 10, 'zh-CN', { chat: { botId: bot } }, fake, env), { url: checkoutUrl })
  let back = new URL(requests.at(-1)!.body.get('success_url')!)
  assert.deepEqual([back.pathname, back.searchParams.get('bot'), back.searchParams.get('topup'), back.searchParams.has('section')], [`${BASE_PATH}/`, bot, 'success', false])
  assert.equal(new URL(requests.at(-1)!.body.get('cancel_url')!).searchParams.get('bot'), bot)
  // The Coordinator's chat is the bare address.
  await pointsPurchase('actor', workspaceId, 10, 'en', { chat: { botId: null } }, fake, env)
  back = new URL(requests.at(-1)!.body.get('success_url')!)
  assert.deepEqual([back.pathname, back.searchParams.has('bot')], [`${BASE_PATH}/en/`, false])
  // With the key: an embedded session for the dialog; Stripe returns to the chat only when a payment method must leave the page.
  assert.deepEqual(await pointsPurchase('actor', workspaceId, 25, 'zh-CN', { chat: { botId: bot } }, fake, { ...env, NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_test_fixture' }), { clientSecret: 'cs_fixture_secret' })
  const { body } = requests.at(-1)!
  assert.deepEqual([body.get('ui_mode'), body.has('success_url'), body.has('cancel_url'), new URL(body.get('return_url')!).searchParams.get('bot')], ['embedded_page', false, false, bot])
  assert.equal(body.get('metadata[points]'), '2500')
  assert.equal(body.get('line_items[0][price_data][product_data][tax_code]'), 'txcd_10105002')
  // A native chat requests the same hosted fallback even when web Checkout is
  // embedded. Amount, workspace permission and chat return remain identical.
  assert.deepEqual(await pointsPurchase('actor', workspaceId, 25, 'en', { chat: { botId: bot }, hosted: true }, fake, { ...env, NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_test_fixture' }), { url: checkoutUrl })
  const native = requests.at(-1)!.body
  assert.equal(native.has('ui_mode'), false)
  assert.equal(native.has('return_url'), false)
  assert.equal(new URL(native.get('success_url')!).searchParams.get('bot'), bot)
  assert.equal(new URL(native.get('cancel_url')!).searchParams.get('workspace'), workspaceId)
  assert.equal(native.get('metadata[points]'), '2500')
  // 计费 keeps its hosted page even with the key; a bot id that is not one is refused before Stripe.
  assert.deepEqual(await pointsPurchaseUrl('actor', workspaceId, 10, 'zh-CN', fake, { ...env, NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_test_fixture' }), { url: checkoutUrl })
  const count = requests.length
  await assert.rejects(pointsPurchase('actor', workspaceId, 10, 'en', { chat: { botId: 'https://evil.example/' } }, fake, env))
  assert.equal(requests.length, count)
})
