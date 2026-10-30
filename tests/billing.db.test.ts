// 计费 (lib/billing/service.ts) against a real PostgreSQL. Stripe is never called: every request goes to a fake fetch.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { dbUrl, seedUser, seedWorkspace } from './support/workspace-admin-db'

test('workspace billing', { skip: !dbUrl }, async t => {
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: dbUrl, max: 2 })
  const { pool: appPool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  const { WorkspaceError } = await import('../lib/workspace-access')
  const billing = await import('../lib/billing/service')
  t.after(async () => { await Promise.all([pool.end(), appPool.end(), workspacePool.end()]) })
  const rejects = (promise: Promise<unknown>, code: string) => assert.rejects(promise, (error: unknown) => error instanceof WorkspaceError && error.code === code)
  const env = { STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_TEAM_PRICE_ID: 'price_team' }
  const requests: Array<{ url: string; body: string }> = []
  const fake = (response: unknown, status = 200) => (async (url: string, init: RequestInit) => { requests.push({ url, body: String(init.body) }); return new Response(JSON.stringify(response), { status }) }) as unknown as typeof fetch

  const admin = await seedUser(pool, 'admin'), member = await seedUser(pool, 'member')
  const ws = await seedWorkspace(pool, admin, [{ userId: admin, role: 'admin' }, { userId: member, role: 'member' }])
  const back = 'https://mikka.example/settings?section=billing'

  await t.test('not configured, no subscription, admin only', async () => {
    assert.equal((await billing.workspaceBillingView(admin, ws.id, {})).configured, false)
    await rejects(billing.planCheckoutUrl(admin, ws.id, back, fake({}), {}), 'billingNotConfigured')
    await rejects(billing.workspaceBillingView(member, ws.id, env), 'workspaceAccessDenied')
    await rejects(billing.planCheckoutUrl(member, ws.id, back, fake({}), env), 'workspaceAccessDenied')
    await rejects(billing.billingPortalUrl(admin, ws.id, back, fake({}), env), 'billingNoSubscription')
    const view = await billing.workspaceBillingView(admin, ws.id, env)
    assert.deepEqual([view.configured, view.live, view.hasCustomer, view.members], [true, false, false, 2])
  })

  await t.test('Checkout asks for one seat per active member and tags the workspace', async () => {
    requests.length = 0
    assert.deepEqual(await billing.planCheckoutUrl(admin, ws.id, back, fake({ url: 'https://checkout.stripe.com/c/pay_1' }), env), { url: 'https://checkout.stripe.com/c/pay_1' })
    const body = new URLSearchParams(requests[0].body)
    assert.equal(requests[0].url, 'https://api.stripe.com/v1/checkout/sessions')
    assert.deepEqual([body.get('mode'), body.get('line_items[0][price]'), body.get('line_items[0][quantity]'), body.get('subscription_data[metadata][workspaceId]'), body.get('client_reference_id')], ['subscription', 'price_team', '2', ws.id, ws.id])
    await rejects(billing.planCheckoutUrl(admin, ws.id, back, fake({ error: {} }, 500), env), 'billingProviderFailed')
  })

  await t.test('webhook events record the subscription once; the portal then opens', async () => {
    const event = { id: `evt_${randomUUID()}`, type: 'customer.subscription.created', data: { object: { id: 'sub_1', customer: `cus_${randomUUID()}`, status: 'active', metadata: { workspaceId: ws.id }, items: { data: [{ quantity: 3, current_period_end: 1_793_491_200, price: { nickname: 'Team' } }] } } } }
    assert.equal(await billing.applyStripeEvent(event), true)
    assert.equal(await billing.applyStripeEvent(event), false, 'a replayed event is ignored')
    const view = await billing.workspaceBillingView(admin, ws.id, env)
    assert.deepEqual([view.live, view.plan, view.seats, view.hasCustomer, view.currentPeriodEnd], [true, 'Team', 3, true, new Date(1_793_491_200_000).toISOString()])
    await rejects(billing.planCheckoutUrl(admin, ws.id, back, fake({}), env), 'billingPlanInvalid')
    requests.length = 0
    assert.deepEqual(await billing.billingPortalUrl(admin, ws.id, back, fake({ url: 'https://billing.stripe.com/p/session_1' }), env), { url: 'https://billing.stripe.com/p/session_1' })
    assert.equal(new URLSearchParams(requests[0].body).get('customer'), event.data.object.customer)
    await billing.applyStripeEvent({ ...event, id: `evt_${randomUUID()}`, type: 'customer.subscription.deleted' })
    assert.equal((await billing.workspaceBillingView(admin, ws.id, env)).live, false)
    await assert.rejects(billing.applyStripeEvent({ id: `evt_${randomUUID()}`, type: 'customer.subscription.updated', data: { object: { id: 'sub_1' } } }))
  })
})
