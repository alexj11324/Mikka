import assert from 'node:assert/strict'
import { after, before, beforeEach, mock, test } from 'node:test'
import { withBasePath } from '@/lib/base-path'
import type { ActionResult } from '@/lib/action-result'
import type { CreditBillingView } from './hosted-usage'

const calls: unknown[][] = []
let billing: ActionResult<CreditBillingView>
mock.module(new URL('../../app/actions/billing.ts', import.meta.url).href, {
  namedExports: {
    getHostedUsage: async (...args: unknown[]) => { calls.push(['usage', ...args]); return { state: 'ready', balance: { verified: true, free: 0, purchased: 100_000 } } },
    startCardVerification: async (...args: unknown[]) => { calls.push(['verify', ...args]); return { url: 'https://checkout.stripe.com/c/setup' } },
    cardVerificationStatus: async (...args: unknown[]) => { calls.push(['status', ...args]); return { status: 'unavailable', last4: null, allowance: null } },
    getCreditBilling: async () => { throw new Error('Billing reads must use the settings GET endpoint') },
    startPointsPurchase: async (...args: unknown[]) => { calls.push(['purchase', ...args]); return { url: 'https://checkout.stripe.com/c/payment' } },
  },
})
let client: typeof import('./verification-client')
const originalFetch = globalThis.fetch
before(async () => {
  globalThis.fetch = async (input, init) => {
    calls.push(['billing', String(input), init])
    return Response.json(billing)
  }
  client = await import('./verification-client')
})
after(() => { globalThis.fetch = originalFetch })
beforeEach(() => { calls.length = 0; billing = { balancePoints: 273.49, transactions: [] } })

test('forwards each real action with the selected workspace and purchase amount', async () => {
  assert.equal((await client.getHostedUsage('workspace')).error, undefined)
  assert.deepEqual(await client.startCardVerification('workspace'), { url: 'https://checkout.stripe.com/c/setup' })
  assert.deepEqual(await client.cardVerificationStatus('workspace'), { status: 'unavailable', last4: null, allowance: null })
  assert.deepEqual(await client.startPointsPurchase('workspace', 25), { url: 'https://checkout.stripe.com/c/payment' })
  assert.deepEqual(calls, [['usage', 'workspace'], ['verify', 'workspace'], ['status', 'workspace'], ['purchase', 'workspace', 25]])
})

test('keeps the whole-point display and every transaction from the settings GET read', async () => {
  const transactions: CreditBillingView['transactions'] = [{ id: 'purchase', date: '2026-10-31T00:00:00.000Z', type: 'topup', points: 1000, amountCents: 1000, currency: 'usd', stripeFeeCents: 59, status: 'succeeded', receiptUrl: 'https://pay.stripe.com/receipts/fixture' }]
  billing = { balancePoints: 273.49, transactions }
  assert.deepEqual(await client.getCreditBilling('workspace'), { balancePoints: 273, transactions })
  assert.deepEqual(calls, [['billing', withBasePath('/api/settings/credit-billing?workspace=workspace'), { cache: 'no-store', credentials: 'same-origin' }]])
})

test('preserves billing authorization failures without a fallback read', async () => {
  billing = { error: 'workspaceAccessDenied' }
  assert.deepEqual(await client.getCreditBilling('foreign'), billing)
  assert.deepEqual(calls, [['billing', withBasePath('/api/settings/credit-billing?workspace=foreign'), { cache: 'no-store', credentials: 'same-origin' }]])
})
