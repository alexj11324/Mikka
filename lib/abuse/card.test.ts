import assert from 'node:assert/strict'
import { after, before, beforeEach, mock, test } from 'node:test'
let admin = true
const bindings = new Map<string, { id: string; workspaceId: string; customerId: string }>()
const verified: unknown[][] = []
const requests: string[] = []
let statusRow: Record<string, unknown> | undefined
const saved = { secret: process.env.STRIPE_SECRET_KEY, webhook: process.env.STRIPE_WEBHOOK_SECRET }
mock.module(new URL('../db/index.ts', import.meta.url).href, {
  namedExports: { pool: { query: async (sql: string, values: string[]) => {
    if (sql.includes('FROM hosted_verifications')) return { rows: statusRow ? [statusRow] : [] }
    if (sql.includes('WHERE id=')) return { rows: bindings.has(values[0]) ? [bindings.get(values[0])] : [] }
    return { rows: [...bindings.values()].filter(row => row.workspaceId === values[0]).slice(-1) }
  } } },
})
mock.module(new URL('../workspace-db.ts', import.meta.url).href, {
  namedExports: { workspaceDb: { transaction: async (fn: (tx: unknown) => Promise<void>) => fn({}) } },
})
mock.module(new URL('../workspace-access.ts', import.meta.url).href, {
  namedExports: { WorkspaceError: class extends Error {}, requireWorkspace: async () => { if (!admin) throw Error('workspaceAccessDenied') } },
})
mock.module(new URL('./runtime.ts', import.meta.url).href, { namedExports: { hostedUsage: { verify: async (...args: unknown[]) => { verified.push(args) } } } })
let card: typeof import('./card')
before(async () => { card = await import('./card') })
after(() => {
  if (saved.secret === undefined) delete process.env.STRIPE_SECRET_KEY
  else process.env.STRIPE_SECRET_KEY = saved.secret
  if (saved.webhook === undefined) delete process.env.STRIPE_WEBHOOK_SECRET
  else process.env.STRIPE_WEBHOOK_SECRET = saved.webhook
})
beforeEach(() => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_fixture'
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_fixture'
  bindings.clear(); requests.length = 0; verified.length = 0; statusRow = undefined; admin = true
})
const intent = { id: 'seti_fixture', status: 'succeeded', customer: 'cus_fixture', payment_method: 'pm_fixture' }
const session = { id: 'cs_fixture', mode: 'setup', status: 'complete', customer: 'cus_fixture', setup_intent: intent.id, metadata: { workspaceId: 'attacker' } }
const fake = (async (url: string) => {
  requests.push(url)
  return Response.json(url.includes('/setup_intents/') ? intent : { type: 'card', customer: 'cus_fixture', card: { fingerprint: 'fixture_card', last4: '4242', wallet: { type: 'link' } } })
}) as typeof fetch
const bind = (id: string) => bindings.set(id, { id, workspaceId: 'workspace', customerId: 'cus_fixture' })

test('legacy webhook trusts locally stored intent/customer and retrieves the card fingerprint and last4', async () => {
  bind(intent.id)
  await card.applyCardSetup({ ...intent, id: 'seti_foreign' }, fake)
  await card.applyCardSetup({ ...intent, customer: 'cus_other' }, fake)
  await card.applyCardSetup({ ...intent, status: 'processing' }, fake)
  assert.equal(verified.length, 0)
  await card.applyCardSetup({ ...intent, metadata: { workspaceId: 'attacker' } }, fake)
  assert.deepEqual(verified, [['workspace', 'cus_fixture', 'fixture_card', '4242']])
})

test('Checkout setup completion retrieves its intent and verifies through the local session/customer binding', async () => {
  bind(session.id)
  for (const ignored of [{ ...session, id: 'cs_foreign' }, { ...session, customer: 'cus_other' }, { ...session, mode: 'payment' }, { ...session, status: 'open' }]) await card.applyCardCheckout(ignored, fake)
  assert.equal(requests.length, 0)
  await card.applyCardCheckout(session, fake)
  assert.deepEqual(requests, ['https://api.stripe.com/v1/setup_intents/seti_fixture', 'https://api.stripe.com/v1/payment_methods/pm_fixture'])
  assert.deepEqual(verified, [['workspace', 'cus_fixture', 'fixture_card', '4242']])
})

test('foreign intent/customer, non-card methods and missing fingerprint never verify', async () => {
  bind(session.id)
  for (const value of [{ ...intent, id: 'seti_other' }, { ...intent, customer: 'cus_other' }]) await card.applyCardCheckout(session, (async () => Response.json(value)) as typeof fetch)
  bind(intent.id)
  for (const method of [{ type: 'card', customer: 'cus_other', card: { fingerprint: 'foreign' } }, { type: 'link', customer: 'cus_fixture' }, { type: 'card', customer: 'cus_fixture', card: {} }]) await card.applyCardSetup(intent, (async () => Response.json(method)) as typeof fetch)
  assert.equal(verified.length, 0)
})

test('status is admin-only, unavailable when unconfigured, and unverified before any setup', async () => {
  admin = false
  await assert.rejects(card.cardVerificationStatus('actor', 'workspace', fake), /workspaceAccessDenied/)
  admin = true
  delete process.env.STRIPE_SECRET_KEY
  assert.equal((await card.cardVerificationStatus('actor', 'workspace', fake)).status, 'unavailable')
  process.env.STRIPE_SECRET_KEY = 'sk_test_fixture'
  assert.deepEqual(await card.cardVerificationStatus('actor', 'workspace', fake), { status: 'unverified', last4: null, allowance: null, remainingAllowanceMicroUsd: 0, remainingAllowancePoints: 0 })
  assert.equal(requests.length, 0)
})

test('status reads current session: open or complete is pending, expired or foreign customer is unverified', async () => {
  bind(session.id)
  for (const status of ['open', 'complete', 'expired']) {
    const result = await card.cardVerificationStatus('actor', 'workspace', (async () => Response.json({ customer: 'cus_fixture', status })) as typeof fetch)
    assert.equal(result.status, status === 'expired' ? 'unverified' : 'pending')
  }
  assert.equal((await card.cardVerificationStatus('actor', 'workspace', (async () => Response.json({ customer: 'cus_other', status: 'open' })) as typeof fetch)).status, 'unverified')
  assert.equal(verified.length, 0)
})

test('verified status preserves granted after allowance is spent and never returns a fingerprint', async () => {
  statusRow = { last4: '4242', hasCard: true, granted: true, remaining: 500_000, alreadyClaimed: false }
  assert.deepEqual(await card.cardVerificationStatus('actor', 'workspace', fake), { status: 'verified', last4: '4242', allowance: 'granted', remainingAllowanceMicroUsd: 500_000, remainingAllowancePoints: 50 })
  statusRow.remaining = 0
  assert.equal((await card.cardVerificationStatus('actor', 'workspace', fake)).allowance, 'granted')
  statusRow = { last4: '4242', hasCard: true, granted: false, remaining: 0, alreadyClaimed: true }
  assert.equal((await card.cardVerificationStatus('actor', 'workspace', fake)).allowance, 'claimed_elsewhere')
  statusRow = { last4: null, hasCard: false, granted: true, remaining: 1_000_000, alreadyClaimed: false }
  assert.equal((await card.cardVerificationStatus('actor', 'workspace', fake)).last4, null)
  assert.equal(requests.length, 0)
})
