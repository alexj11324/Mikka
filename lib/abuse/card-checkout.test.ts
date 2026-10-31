import assert from 'node:assert/strict'
import { before, beforeEach, mock, test } from 'node:test'
import { BASE_PATH } from '../base-path'

const workspaceId = '11111111-1111-4111-8111-111111111111'
const env = { STRIPE_SECRET_KEY: 'sk_test_fixture', STRIPE_WEBHOOK_SECRET: 'whsec_fixture', BETTER_AUTH_URL: 'https://app.example' }
let admin = true
let customerId: string | undefined
let providerStatus = 200
let sessionUrl = 'https://checkout.stripe.com/c/pay/fixture'
const authorizations: unknown[][] = []
const queries: Array<{ sql: string; values: string[] }> = []
const requests: Array<{ url: string; body: URLSearchParams; idempotencyKey: string | undefined }> = []
class WorkspaceError extends Error { constructor(readonly code: string) { super(code) } }

mock.module(new URL('../db/index.ts', import.meta.url).href, { namedExports: { pool: {
  query: async (sql: string, values: string[]) => {
    queries.push({ sql, values })
    if (sql.includes('INSERT INTO workspace_billing')) customerId ??= values[1]
    return { rows: customerId ? [{ id: customerId }] : [] }
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
let createCardSetup: typeof import('./card-checkout')['createCardSetup']
before(async () => { ({ createCardSetup } = await import('./card-checkout')) })
beforeEach(() => {
  admin = true
  customerId = 'cus_existing'
  providerStatus = 200
  sessionUrl = 'https://checkout.stripe.com/c/pay/fixture'
  authorizations.length = 0
  queries.length = 0
  requests.length = 0
})
const fake = (async (url: string, init?: RequestInit) => {
  requests.push({ url, body: new URLSearchParams(String(init?.body)), idempotencyKey: (init?.headers as Record<string, string> | undefined)?.['idempotency-key'] })
  return Response.json(url.endsWith('/customers') ? { id: 'cus_new' } : { id: `cs_fixture_${requests.length}`, url: sessionUrl }, { status: providerStatus })
}) as typeof fetch

test('admin receives hosted setup Checkout with workspace metadata, no charge or Payment Element data', async () => {
  assert.deepEqual(await createCardSetup('actor', workspaceId, fake, 'zh-CN', env), { url: sessionUrl })
  assert.deepEqual(authorizations, [[workspaceId, 'actor', true]])
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, 'https://api.stripe.com/v1/checkout/sessions')
  const body = requests[0].body
  assert.equal(body.get('mode'), 'setup')
  assert.equal(body.get('currency'), 'usd')
  assert.equal(body.get('customer'), 'cus_existing')
  assert.equal(body.get('client_reference_id'), workspaceId)
  assert.equal(body.get('allowed_payment_method_types[0]'), 'card')
  assert.equal(body.has('allowed_payment_method_types[1]'), false)
  assert.equal(body.get('metadata[workspaceId]'), workspaceId)
  assert.equal(body.get('setup_intent_data[metadata][workspaceId]'), workspaceId)
  for (const key of ['amount', 'line_items', 'payment_method_types[0]', 'client_secret', 'customer_email', 'email']) assert.equal(body.has(key), false)
  const success = body.get('success_url')!
  assert.ok(success.endsWith('&session_id={CHECKOUT_SESSION_ID}'))
  const back = new URL(success)
  assert.equal(back.origin, env.BETTER_AUTH_URL)
  assert.equal(back.pathname, `${BASE_PATH}/settings`)
  assert.equal(back.searchParams.get('section'), 'billing')
  assert.equal(back.searchParams.get('workspace'), workspaceId)
  assert.equal(back.searchParams.get('verify'), 'success')
  const cancel = new URL(body.get('cancel_url')!)
  assert.equal(cancel.searchParams.get('verify'), 'cancelled')
  assert.equal(cancel.searchParams.has('session_id'), false)
  assert.deepEqual(queries.at(-1)?.values, ['cs_fixture_1', workspaceId, 'cus_existing'])
})

test('members cannot create a Stripe customer or a verification session', async () => {
  admin = false
  await assert.rejects(createCardSetup('member', workspaceId, fake, 'en', env), /workspaceAccessDenied/)
  assert.equal(requests.length, 0)
  assert.equal(queries.length, 0)
})

test('a missing Stripe key, fulfillment secret or configured origin makes verification unavailable', async () => {
  for (const config of [{}, { ...env, STRIPE_SECRET_KEY: undefined }, { ...env, STRIPE_WEBHOOK_SECRET: undefined }, { ...env, BETTER_AUTH_URL: undefined }]) {
    await assert.rejects(createCardSetup('actor', workspaceId, fake, 'en', config), /billingNotConfigured/)
  }
  assert.equal(requests.length, 0)
  assert.equal(queries.length, 0)
})

test('customer creation is shared with points purchases and each verification session gets its own local binding', async () => {
  customerId = undefined
  await createCardSetup('actor', workspaceId, fake, 'en', env)
  await createCardSetup('actor', workspaceId, fake, 'en', env)
  assert.equal(requests.filter(request => request.url.endsWith('/customers')).length, 1)
  assert.equal(requests[0].idempotencyKey, `points-customer:${workspaceId}`)
  assert.equal(requests[0].body.has('email'), false)
  assert.equal(requests[1].body.get('customer'), 'cus_new')
  assert.equal(requests[2].body.get('customer'), 'cus_new')
  assert.deepEqual(queries.filter(query => query.sql.includes('INSERT INTO hosted_setup_intents')).map(query => query.values), [
    ['cs_fixture_2', workspaceId, 'cus_new'], ['cs_fixture_3', workspaceId, 'cus_new'],
  ])
})

test('English Preview returns to the same configured deployment and billing section', async () => {
  await createCardSetup('actor', workspaceId, fake, 'en', { ...env, BETTER_AUTH_URL: undefined, VERCEL_ENV: 'preview', VERCEL_URL: 'preview.example' })
  const back = new URL(requests[0].body.get('success_url')!)
  assert.equal(back.origin, 'https://preview.example')
  assert.equal(back.pathname, `${BASE_PATH}/en/settings`)
})

test('provider failure or a non-Stripe Checkout URL cannot return a redirect or create a session binding', async () => {
  providerStatus = 500
  await assert.rejects(createCardSetup('actor', workspaceId, fake, 'en', env), /billingProviderFailed/)
  providerStatus = 200
  for (const url of ['https://attacker.example/checkout', 'http://checkout.stripe.com/checkout']) {
    sessionUrl = url
    await assert.rejects(createCardSetup('actor', workspaceId, fake, 'en', env), /billingProviderFailed/)
  }
  assert.equal(queries.some(query => query.sql.includes('INSERT INTO hosted_setup_intents')), false)
})
