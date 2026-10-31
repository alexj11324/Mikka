import assert from 'node:assert/strict'
import { afterEach, before, beforeEach, mock, test } from 'node:test'
import type { ActionResult } from '@/lib/action-result'
import type { CreditBillingView } from './hosted-usage'

const calls: unknown[][] = []
let billing: ActionResult<CreditBillingView>
mock.module(new URL('../../app/actions/billing.ts', import.meta.url).href, {
  namedExports: {
    getHostedUsage: async (...args: unknown[]) => { calls.push(['usage', ...args]); return { state: 'ready', balance: { verified: true, free: 0, purchased: 100_000 } } },
    startCardVerification: async (...args: unknown[]) => { calls.push(['verify', ...args]); return { url: 'https://checkout.stripe.com/c/setup' } },
    cardVerificationStatus: async (...args: unknown[]) => { calls.push(['status', ...args]); return { status: 'unavailable', last4: null, allowance: null } },
    startPointsPurchase: async (...args: unknown[]) => { calls.push(['purchase', ...args]); return { url: 'https://checkout.stripe.com/c/payment' } },
  },
})
// The billing read is a GET to /api/settings/credit-billing (so it never waits behind a save in the
// server-action queue); the route itself calls the same getCreditBilling action.
let status = 200
const read = (workspace: string) => `${process.env.MIKKA_BASE_PATH ?? ''}/api/settings/credit-billing?workspace=${workspace}`
const realFetch = globalThis.fetch
let client: typeof import('./verification-client')
before(async () => { client = await import('./verification-client') })
beforeEach(() => {
  calls.length = 0; billing = { balancePoints: 273.49, transactions: [] }; status = 200
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push(['GET', String(input), init?.method ?? 'GET'])
    return new Response(JSON.stringify(billing), { status, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
})
afterEach(() => { globalThis.fetch = realFetch })

test('forwards each real action with the selected workspace and purchase amount', async () => {
  assert.equal((await client.getHostedUsage('workspace')).error, undefined)
  assert.deepEqual(await client.startCardVerification('workspace'), { url: 'https://checkout.stripe.com/c/setup' })
  assert.deepEqual(await client.cardVerificationStatus('workspace'), { status: 'unavailable', last4: null, allowance: null })
  assert.deepEqual(await client.startPointsPurchase('workspace', 25), { url: 'https://checkout.stripe.com/c/payment' })
  assert.deepEqual(calls, [['usage', 'workspace'], ['verify', 'workspace'], ['status', 'workspace'], ['purchase', 'workspace', 25]])
})

test('keeps the whole-point display and every transaction from the billing action', async () => {
  const transactions: CreditBillingView['transactions'] = [{ id: 'purchase', date: '2026-10-31T00:00:00.000Z', type: 'topup', points: 1000, amountCents: 1000, currency: 'usd', stripeFeeCents: 59, status: 'succeeded', receiptUrl: 'https://pay.stripe.com/receipts/fixture' }]
  billing = { balancePoints: 273.49, transactions }
  assert.deepEqual(await client.getCreditBilling('workspace'), { balancePoints: 273, transactions })
  assert.deepEqual(calls, [['GET', read('workspace'), 'GET']])
})

test('preserves billing authorization failures without a fallback read', async () => {
  billing = { error: 'workspaceAccessDenied' }
  assert.deepEqual(await client.getCreditBilling('foreign'), billing)
  assert.deepEqual(calls, [['GET', read('foreign'), 'GET']])
})

test('a failed billing read rejects instead of showing an empty balance', async () => {
  status = 500
  await assert.rejects(client.getCreditBilling('workspace'))
})
