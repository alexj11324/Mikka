// Real isolated PostgreSQL; every Stripe request uses synthetic provider responses.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { dbUrl, seedUser, seedWorkspace, seedPersonalWorkspace } from './support/workspace-admin-db'

test('workspace and organization resource billing', { skip: !dbUrl }, async t => {
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: dbUrl, max: 2 })
  const { pool: appPool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  const { WorkspaceError } = await import('../lib/workspace-access')
  const { HostedUsageStore } = await import('../lib/abuse/store')
  const billing = await import('../lib/billing/service')
  const organizationBilling = await import('../lib/billing/organization-account')
  t.after(async () => { await Promise.all([pool.end(), appPool.end(), workspacePool.end()]) })
  const rejects = (promise: Promise<unknown>, code: string) => assert.rejects(promise, (error: unknown) => error instanceof WorkspaceError && error.code === code)
  const id = (prefix: string) => `${prefix}_${randomUUID().replaceAll('-', '')}`
  const env = { MIKKA_EDITION: 'cloud', STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_TEAM_PRICE_ID: 'price_legacy', STRIPE_TEAM_RESOURCE_PRICE_ID: 'price_resource' }
  const price = { id: 'price_resource', active: true, currency: 'usd', type: 'recurring', billing_scheme: 'per_unit', unit_amount: 2000,
    recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' },
    metadata: { mikka_billing_model: 'resource_v1', mikka_plan: 'pro', mikka_monthly_points: '1000' } }
  const requests: Array<{ url: string; body: string }> = []
  const subscriptions = new Map<string, Record<string, unknown>>(), invoices = new Map<string, Record<string, unknown>>()
  const fake = (async (input: string, init: RequestInit = {}) => {
    const url = new URL(input); requests.push({ url: input, body: String(init.body ?? '') })
    let result: unknown
    if (url.pathname === '/v1/prices/price_resource') result = price
    else if (url.pathname.startsWith('/v1/subscriptions/')) result = subscriptions.get(url.pathname.split('/').at(-1)!)
    else if (url.pathname.startsWith('/v1/invoices/')) result = invoices.get(url.pathname.split('/').at(-1)!)
    else if (url.pathname === '/v1/checkout/sessions') result = { url: 'https://checkout.stripe.com/c/pay_synthetic' }
    else if (url.pathname === '/v1/billing_portal/sessions') result = { url: 'https://billing.stripe.com/p/session_synthetic' }
    return new Response(JSON.stringify(result ?? { error: 'unknown_synthetic_route' }), { status: result ? 200 : 404 })
  }) as typeof fetch
  const options = { env, fetchImpl: fake }
  const admin = await seedUser(pool, 'billing-admin'), member = await seedUser(pool, 'billing-member')
  const ws = await seedWorkspace(pool, admin, [{ userId: admin, role: 'admin' }, { userId: member, role: 'member' }])
  const back = 'https://mikka.example/settings?section=billing'
  const start = Math.floor(Date.now() / 1000) - 86400, end = start + 30 * 86400
  const subId = id('sub'), customer = id('cus'), invoiceId = id('in')
  const invoice = { id: invoiceId, subscription: subId, status: 'paid', amount_paid: 2000, currency: 'usd', billing_reason: 'subscription_create',
    hosted_invoice_url: 'https://invoice.stripe.com/i/synthetic', lines: { has_more: false, data: [{ price: { id: price.id }, quantity: 1, proration: false, period: { start, end } }] } }
  invoices.set(invoiceId, invoice)
  const sub = { id: subId, customer, status: 'active', metadata: { workspaceId: ws.id, billingModel: 'resource_v1' },
    latest_invoice: invoice, items: { data: [{ quantity: 1, current_period_end: end, price: { id: price.id, nickname: 'Team resources' } }] } }
  subscriptions.set(subId, sub)
  const event = (type = 'customer.subscription.updated', object: Record<string, unknown> = sub) => ({ id: id('evt'), type, data: { object } })

  await t.test('only admins may buy a separately configured resource plan; legacy prices cannot be sold as resources', async () => {
    assert.equal((await billing.workspaceBillingView(admin, ws.id, {})).configured, false)
    await rejects(billing.planCheckoutUrl(admin, ws.id, back, fake, {}), 'billingNotConfigured')
    await rejects(billing.workspaceBillingView(member, ws.id, env), 'workspaceAccessDenied')
    await rejects(billing.planCheckoutUrl(member, ws.id, back, fake, env), 'workspaceAccessDenied')
    await rejects(billing.planCheckoutUrl(admin, ws.id, back, fake, { ...env, STRIPE_TEAM_RESOURCE_PRICE_ID: '' }), 'billingResourcePlanUnavailable')
    requests.length = 0
    assert.deepEqual(await billing.planCheckoutUrl(admin, ws.id, back, fake, env), { url: 'https://checkout.stripe.com/c/pay_synthetic' })
    const request = requests.find(row => row.url.endsWith('/checkout/sessions'))!, body = new URLSearchParams(request.body)
    assert.deepEqual([body.get('mode'), body.get('line_items[0][price]'), body.get('line_items[0][quantity]'), body.get('subscription_data[metadata][workspaceId]'), body.get('subscription_data[metadata][billingModel]')], ['subscription', 'price_resource', '1', ws.id, 'resource_v1'])
    price.active = false
    await rejects(billing.planCheckoutUrl(admin, ws.id, back, fake, env), 'billingResourcePlanUnavailable')
    price.active = true
  })

  await t.test('paid webhook grants credits and entitlements once, without replacing operator grants', async () => {
    await pool.query(`insert into mikka_workspace_entitlements ("workspaceId",plan,source,"seatLimit") values($1,'enterprise','cloud',20)`, [ws.id])
    const created = event('customer.subscription.created')
    assert.equal(await billing.applyStripeEvent(created, options), true)
    assert.equal(await billing.applyStripeEvent(created, options), false)
    await billing.applyStripeEvent(event('invoice.paid', invoice), options)
    const view = await billing.workspaceBillingView(admin, ws.id, env)
    assert.deepEqual([view.live, view.billingModel, view.entitlementPlan, view.seats], [true, 'resource_v1', 'pro', 1])
    const grant = (await pool.query('select plan,"seatLimit","billingPlan","billingExpiresAt" from mikka_workspace_entitlements where "workspaceId"=$1', [ws.id])).rows[0]
    assert.deepEqual([grant.plan, grant.seatLimit, grant.billingPlan], ['enterprise', 20, 'pro'])
    assert.equal(grant.billingExpiresAt.getTime(), end * 1000)
    assert.equal((await pool.query('select count(*)::int n from workspace_credit_grants where "workspaceId"=$1', [ws.id])).rows[0].n, 1)
    const store = new HostedUsageStore(pool), call = id('call')
    assert.deepEqual(await store.balance(ws.id), { verified: true, free: 0, plan: 10_000_000, purchased: 0 })
    await store.reserve(ws.id, 'synthetic/model', call)
    await Promise.all([store.settle(call, 100_000), store.settle(call, 100_000)])
    assert.equal((await store.balance(ws.id)).plan, 9_900_000)
    assert.equal((await pool.query('select "purchasedMicroUsd"::int p,"planMicroUsd"::int c from hosted_usage where id=$1', [call])).rows[0].p, 0)
    await rejects(billing.planCheckoutUrl(admin, ws.id, back, fake, env), 'billingPlanInvalid')
    assert.equal((await billing.billingPortalUrl(admin, ws.id, back, fake, env)).url, 'https://billing.stripe.com/p/session_synthetic')
  })

  await t.test('out-of-order active snapshots do not revive a canonically canceled subscription', async () => {
    subscriptions.set(subId, { ...sub, status: 'canceled' })
    await billing.applyStripeEvent(event('customer.subscription.deleted'), options)
    await billing.applyStripeEvent(event('customer.subscription.updated'), options)
    const view = await billing.workspaceBillingView(admin, ws.id, env)
    assert.deepEqual([view.live, view.entitlementPlan], [false, 'free'])
    const grant = (await pool.query('select plan,"billingPlan" from mikka_workspace_entitlements where "workspaceId"=$1', [ws.id])).rows[0]
    assert.deepEqual(grant, { plan: 'enterprise', billingPlan: 'free' })
  })

  await t.test('a Workspace delivery failure survives APP commit and the same webhook repairs it', async () => {
    subscriptions.set(subId, sub)
    const trigger = `synthetic_billing_${randomUUID().replaceAll('-', '')}`
    await pool.query(`create function ${trigger}() returns trigger language plpgsql as $$ begin if NEW."workspaceId"='${ws.id}'::uuid then raise exception 'synthetic_workspace_outage'; end if; return NEW; end $$;
      create trigger ${trigger} before insert or update on mikka_workspace_entitlements for each row execute function ${trigger}()`)
    const pending = event()
    try {
      await assert.rejects(billing.applyStripeEvent(pending, options), (error: Error & { cause?: Error }) => /synthetic_workspace_outage/.test(`${error.message} ${error.cause?.message ?? ''}`))
      assert.equal((await pool.query('select count(*)::int n from billing_entitlement_outbox where "eventId"=$1 and "deliveredAt" is null', [pending.id])).rows[0].n, 1)
    } finally { await pool.query(`drop trigger ${trigger} on mikka_workspace_entitlements; drop function ${trigger}()`) }
    assert.equal(await billing.applyStripeEvent(pending, options), false)
    assert.equal((await pool.query('select count(*)::int n from billing_entitlement_outbox where "eventId"=$1 and "deliveredAt" is not null', [pending.id])).rows[0].n, 1)
  })

  await t.test('organization account designation is explicit, shared-only and preserves every account balance', async () => {
    const organizationId = randomUUID(), linked = await seedWorkspace(pool, admin, [{ userId: admin, role: 'admin' }])
    await pool.query('insert into mikka_organizations(id,name,"createdBy") values($1,$2,$3)', [organizationId, 'Billing organization', admin])
    await pool.query(`insert into mikka_organization_members("organizationId","userId",name,email,role) values($1,$2,'Billing owner','owner@example.invalid','owner')`, [organizationId, admin])
    await pool.query('insert into mikka_organization_workspaces("organizationId","workspaceId") values($1,$2),($1,$3)', [organizationId, ws.id, linked.id])
    assert.deepEqual(await organizationBilling.resolvePlatformBillingAccount(linked.id), { organizationId: null, accountWorkspaceId: linked.id })
    await assert.rejects(organizationBilling.setOrganizationBillingAccount(member, organizationId, ws.id))
    const personal = await seedPersonalWorkspace(pool, admin)
    await assert.rejects(organizationBilling.setOrganizationBillingAccount(admin, organizationId, personal), /personal_workspace/)
    await organizationBilling.setOrganizationBillingAccount(admin, organizationId, ws.id)
    assert.deepEqual(await organizationBilling.resolvePlatformBillingAccount(linked.id), { organizationId, accountWorkspaceId: ws.id })
    assert.equal((await pool.query('select "billingPlan" from mikka_organization_entitlements where "organizationId"=$1', [organizationId])).rows[0].billingPlan, 'pro')
    const { withSharedCredits } = await import('../lib/credit-shares'), store = new HostedUsageStore(pool), call = id('call')
    await withSharedCredits(linked.id, payer => store.reserve(payer, 'synthetic/organization', call))
    await store.settle(call, 100_000)
    const receipt = (await pool.query('select "workspaceId","usageWorkspaceId","billingOrganizationId" from hosted_usage where id=$1', [call])).rows[0]
    assert.deepEqual(receipt, { workspaceId: ws.id, usageWorkspaceId: linked.id, billingOrganizationId: organizationId })
    assert.equal((await pool.query('select count(*)::int n from workspace_credit_grants where "workspaceId"=$1', [linked.id])).rows[0].n, 0)
    await assert.rejects(pool.query('delete from mikka_organization_workspaces where "workspaceId"=$1', [ws.id]), /billing account/)
    await organizationBilling.setOrganizationBillingAccount(admin, organizationId, null)
    assert.deepEqual(await organizationBilling.resolvePlatformBillingAccount(linked.id), { organizationId: null, accountWorkspaceId: linked.id })
  })

  await t.test('legacy seat subscriptions keep their quantity and paid history but cannot cap members', async () => {
    const legacy = await seedWorkspace(pool, admin, [{ userId: admin, role: 'admin' }]), legacySubId = id('sub'), legacyInvoice = { ...invoice, id: id('in'), subscription: legacySubId,
      lines: { has_more: false, data: [{ price: { id: 'price_legacy' }, quantity: 7, proration: false, period: { start, end } }] } }
    const old = { ...sub, id: legacySubId, customer: id('cus'), metadata: { workspaceId: legacy.id }, latest_invoice: legacyInvoice,
      items: { data: [{ quantity: 7, current_period_end: end, price: { id: 'price_legacy', nickname: 'Legacy seats' } }] } }
    subscriptions.set(legacySubId, old)
    await billing.applyStripeEvent(event('customer.subscription.updated', old), options)
    const view = await billing.workspaceBillingView(admin, legacy.id, env)
    assert.deepEqual([view.billingModel, view.entitlementPlan, view.seats], ['legacy_seat', 'pro', 7])
    assert.equal((await pool.query('select count(*)::int n from workspace_credit_grants where "workspaceId"=$1', [legacy.id])).rows[0].n, 0, 'a historical price does not invent new monthly credits')
  })
})
