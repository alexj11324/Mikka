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
  const env = { MIKKA_EDITION: 'cloud', STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_WEBHOOK_SECRET: 'whsec_synthetic',
    BETTER_AUTH_URL: 'https://mikka.example', STRIPE_TEAM_PRICE_ID: 'price_legacy', STRIPE_TEAM_RESOURCE_PRICE_ID: 'price_resource' }
  const price = { id: 'price_resource', active: true, currency: 'usd', type: 'recurring', billing_scheme: 'per_unit', unit_amount: 2000,
    recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' },
    metadata: { mikka_billing_model: 'resource_v1', mikka_plan: 'pro', mikka_monthly_points: '1000' } }
  const requests: Array<{ url: string; body: string; method: string; key: string | null }> = []
  const subscriptions = new Map<string, Record<string, unknown>>(), invoices = new Map<string, Record<string, unknown>>()
  const customers = new Map<string, string>(), checkoutKeys = new Map<string, string>(), sessions = new Map<string, Record<string, unknown>>()
  let loseCheckoutResponse = false
  const payments = new Map<string, { id: string; amount_received: number; currency: string; metadata: Record<string, string> }>()
  const invoicePayments = new Map<string, Array<{ id: string; amount_paid: number; currency: string; invoice: string; status: string; payment: { type: string; payment_intent: string } }>>()
  const fake = (async (input: string, init: RequestInit = {}) => {
    const url = new URL(input), body = new URLSearchParams(String(init.body ?? '')), key = new Headers(init.headers).get('idempotency-key')
    requests.push({ url: input, body: body.toString(), method: init.method ?? 'GET', key })
    let result: unknown
    if (url.pathname === '/v1/prices/price_resource') result = price
    else if (url.pathname === '/v1/customers') {
      const target = body.get('metadata[workspaceId]')!
      if (!customers.has(target)) customers.set(target, target === ws.id ? customer : id('cus'))
      result = { id: customers.get(target) }
    }
    else if (url.pathname === '/v1/subscriptions') result = { has_more: false,
      data: [...subscriptions.values()].filter(row => row.customer === url.searchParams.get('customer')) }
    else if (url.pathname.startsWith('/v1/subscriptions/')) result = subscriptions.get(url.pathname.split('/').at(-1)!)
    else if (url.pathname.startsWith('/v1/invoices/')) result = invoices.get(url.pathname.split('/').at(-1)!)
    else if (url.pathname.startsWith('/v1/payment_intents/')) result = payments.get(url.pathname.split('/').at(-1)!)
    else if (url.pathname === '/v1/invoice_payments') result = { has_more: false, data: invoicePayments.get(url.searchParams.get('invoice')!) ?? [] }
    else if (url.pathname === '/v1/checkout/sessions' && init.method === 'POST') {
      assert.ok(key)
      assert.ok(key.startsWith('resource-checkout:'))
      let sid = checkoutKeys.get(key)
      if (!sid) {
        sid = id('cs'); checkoutKeys.set(key, sid)
        sessions.set(sid, { id: sid, mode: 'subscription', status: 'open', customer: body.get('customer'), subscription: null,
          client_reference_id: body.get('client_reference_id'), expires_at: Number(body.get('expires_at')), created: Math.floor(Date.now() / 1000),
          metadata: { workspaceId: body.get('metadata[workspaceId]'), billingModel: body.get('metadata[billingModel]'), checkoutRequestId: body.get('metadata[checkoutRequestId]') },
          url: 'https://checkout.stripe.com/c/pay_synthetic' })
      }
      result = sessions.get(sid)
      if (loseCheckoutResponse) { loseCheckoutResponse = false; throw new TypeError('synthetic_checkout_response_lost') }
    }
    else if (url.pathname === '/v1/checkout/sessions') result = { has_more: false,
      data: [...sessions.values()].filter(row => row.customer === url.searchParams.get('customer')) }
    else if (url.pathname.startsWith('/v1/checkout/sessions/')) result = sessions.get(url.pathname.split('/').at(-1)!)
    else if (url.pathname === '/v1/billing_portal/sessions') result = { url: 'https://billing.stripe.com/p/session_synthetic' }
    return new Response(JSON.stringify(result ?? { error: 'unknown_synthetic_route' }), { status: result ? 200 : 404 })
  }) as typeof fetch
  const options = { env, fetchImpl: fake }
  const admin = await seedUser(pool, 'billing-admin'), member = await seedUser(pool, 'billing-member')
  const ws = await seedWorkspace(pool, admin, [{ userId: admin, role: 'admin' }, { userId: member, role: 'member' }])
  const back = 'https://mikka.example/settings?section=billing'
  const start = Math.floor(Date.now() / 1000) - 86400, end = start + 30 * 86400
  const subId = id('sub'), customer = id('cus'), invoiceId = id('in'), paymentId = id('pi')
  payments.set(paymentId, { id: paymentId, amount_received: 2000, currency: 'usd', metadata: {} })
  const invoice = { id: invoiceId, customer, subscription: subId, payment_intent: paymentId, status: 'paid', amount_paid: 2000, currency: 'usd', billing_reason: 'subscription_create',
    hosted_invoice_url: 'https://invoice.stripe.com/i/synthetic', lines: { has_more: false, data: [{ price: { id: price.id }, quantity: 1, proration: false, period: { start, end } }] } }
  invoices.set(invoiceId, invoice)
  const sub = { id: subId, customer, status: 'active', metadata: { workspaceId: ws.id, billingModel: 'resource_v1' },
    latest_invoice: invoice, items: { data: [{ quantity: 1, current_period_end: end, price: { id: price.id, nickname: 'Team resources' } }] } }
  const event = (type = 'customer.subscription.updated', object: Record<string, unknown> = sub) => ({ id: id('evt'), type, data: { object } })

  await t.test('only admins may buy a separately configured resource plan; legacy prices cannot be sold as resources', async () => {
    assert.equal((await billing.workspaceBillingView(admin, ws.id, {})).configured, false)
    await rejects(billing.planCheckoutUrl(admin, ws.id, back, fake, {}), 'billingNotConfigured')
    await rejects(billing.workspaceBillingView(member, ws.id, env), 'workspaceAccessDenied')
    await rejects(billing.planCheckoutUrl(member, ws.id, back, fake, env), 'workspaceAccessDenied')
    await rejects(billing.planCheckoutUrl(admin, ws.id, back, fake, { ...env, STRIPE_WEBHOOK_SECRET: '' }), 'billingNotConfigured')
    await rejects(billing.planCheckoutUrl(admin, ws.id, 'https://attacker.invalid/return', fake, env), 'billingPlanInvalid')
    await rejects(billing.planCheckoutUrl(admin, ws.id, back, fake, { ...env, STRIPE_TEAM_RESOURCE_PRICE_ID: '' }), 'billingResourcePlanUnavailable')
    requests.length = 0
    assert.deepEqual(await billing.planCheckoutUrl(admin, ws.id, back, fake, env), { url: 'https://checkout.stripe.com/c/pay_synthetic' })
    const request = requests.find(row => row.url.endsWith('/checkout/sessions'))!, body = new URLSearchParams(request.body)
    assert.deepEqual([body.get('mode'), body.get('line_items[0][price]'), body.get('line_items[0][quantity]'), body.get('subscription_data[metadata][workspaceId]'), body.get('subscription_data[metadata][billingModel]')], ['subscription', 'price_resource', '1', ws.id, 'resource_v1'])
    assert.equal(body.get('managed_payments[enabled]'), 'true')
    const audit = (await pool.query(`select metadata from workspace_audit_events where "workspaceId"=$1 and action='billing.checkout_started'`, [ws.id])).rows
    assert.equal(audit.length, 1)
    assert.deepEqual(audit[0].metadata, { amountCents: 2000, currency: 'USD' })
    price.active = false
    await rejects(billing.planCheckoutUrl(admin, ws.id, back, fake, env), 'billingResourcePlanUnavailable')
    price.active = true
  })

  await t.test('paid webhook grants credits and entitlements once, without replacing operator grants', async () => {
    subscriptions.set(subId, sub)
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

  await t.test('concurrent Checkout clicks reuse one durable request and one provider Session', async () => {
    const target = await seedWorkspace(pool, admin, [{ userId: admin, role: 'admin' }]), before = sessions.size
    const urls = await Promise.all(Array.from({ length: 3 }, () => billing.planCheckoutUrl(admin, target.id, back, fake, env)))
    assert.deepEqual(urls, Array(3).fill({ url: 'https://checkout.stripe.com/c/pay_synthetic' }))
    assert.equal(sessions.size, before + 1)
    const receipts = (await pool.query('select id,"sessionId" from billing_checkout_requests where "workspaceId"=$1', [target.id])).rows
    assert.equal(receipts.length, 1)
    assert.ok(receipts[0].sessionId)
    const posts = requests.filter(row => row.method === 'POST' && new URLSearchParams(row.body).get('client_reference_id') === target.id)
    assert.ok(posts.length > 0)
    assert.equal(new Set(posts.map(row => row.key)).size, 1)
    assert.equal(new Set(posts.map(row => row.body)).size, 1)
    assert.equal((await pool.query(`select count(*)::int n from workspace_audit_events where "workspaceId"=$1 and action='billing.checkout_started'`, [target.id])).rows[0].n, 1)
  })

  await t.test('lost Checkout response keeps its idempotency key, fixed return URL and original provider Session', async () => {
    const target = await seedWorkspace(pool, admin, [{ userId: admin, role: 'admin' }]), before = sessions.size
    loseCheckoutResponse = true
    await rejects(billing.planCheckoutUrl(admin, target.id, back, fake, env), 'billingProviderFailed')
    const prior = (await pool.query('select id,"sessionId" from billing_checkout_requests where "workspaceId"=$1', [target.id])).rows[0]
    assert.equal(prior.sessionId, null)
    await billing.planCheckoutUrl(admin, target.id, `${back}&retried=true`, fake, env)
    assert.equal(sessions.size, before + 1)
    const posts = requests.filter(row => row.method === 'POST' && new URLSearchParams(row.body).get('client_reference_id') === target.id)
    assert.equal(posts.length, 2)
    assert.equal(posts[0].key, posts[1].key)
    assert.equal(posts[0].body, posts[1].body)
    assert.ok((await pool.query('select "sessionId" from billing_checkout_requests where id=$1', [prior.id])).rows[0].sessionId)
  })

  await t.test('canonical subscription blocks another Checkout before its webhook; expired lost responses recover without replaying a pruned key', async () => {
    const target = await seedWorkspace(pool, admin, [{ userId: admin, role: 'admin' }])
    loseCheckoutResponse = true
    await rejects(billing.planCheckoutUrl(admin, target.id, back, fake, env), 'billingProviderFailed')
    const prior = (await pool.query('select * from billing_checkout_requests where "workspaceId"=$1', [target.id])).rows[0]
    const session = sessions.get(checkoutKeys.get(`resource-checkout:${prior.id}`)!)!
    const sid = id('sub')
    session.status = 'complete'; session.subscription = sid; session.url = null
    subscriptions.set(sid, { id: sid, customer: prior.customerId, status: 'active' })
    const count = sessions.size
    await rejects(billing.planCheckoutUrl(admin, target.id, back, fake, env), 'billingPlanInvalid')
    assert.equal(sessions.size, count)
    assert.equal((await pool.query('select status from workspace_billing where "workspaceId"=$1', [target.id])).rows[0].status, null)
    // Age the synthetic request beyond Stripe's retention and close its real
    // provider object. The retry must list/retrieve that object before replacing it.
    subscriptions.set(sid, { id: sid, customer: prior.customerId, status: 'canceled' })
    const createdAt = new Date(Date.now() - 27 * 3600_000), expiresAt = new Date(Math.floor((createdAt.getTime() + 2 * 3600_000) / 1000) * 1000)
    await pool.query(`update billing_checkout_requests set "createdAt"=$2,"expiresAt"=$3,params=jsonb_set(params,'{expires_at}',to_jsonb($4::bigint)) where id=$1`,
      [prior.id, createdAt, expiresAt, Math.floor(expiresAt.getTime() / 1000)])
    session.created = Math.floor(createdAt.getTime() / 1000); session.expires_at = Math.floor(expiresAt.getTime() / 1000)
    await billing.planCheckoutUrl(admin, target.id, back, fake, env)
    assert.equal(sessions.size, count + 1)
    assert.equal(requests.filter(row => row.method === 'POST' && row.key === `resource-checkout:${prior.id}`).length, 1)
    assert.equal((await pool.query('select count(*)::int n from billing_checkout_requests where "workspaceId"=$1 and "closedAt" is null', [target.id])).rows[0].n, 1)
    assert.ok((await pool.query('select "sessionId","closedAt" from billing_checkout_requests where id=$1', [prior.id])).rows[0].closedAt)
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
    const legacy = await seedWorkspace(pool, admin, [{ userId: admin, role: 'admin' }]), legacySubId = id('sub'), legacyInvoice = { ...invoice, id: id('in'), customer: id('cus'), subscription: legacySubId,
      lines: { has_more: false, data: [{ price: { id: 'price_legacy' }, quantity: 7, proration: false, period: { start, end } }] } }
    const old = { ...sub, id: legacySubId, customer: legacyInvoice.customer, metadata: { workspaceId: legacy.id }, latest_invoice: legacyInvoice,
      items: { data: [{ quantity: 7, current_period_end: end, price: { id: 'price_legacy', nickname: 'Legacy seats' } }] } }
    subscriptions.set(legacySubId, old)
    await billing.applyStripeEvent(event('customer.subscription.updated', old), options)
    const view = await billing.workspaceBillingView(admin, legacy.id, env)
    assert.deepEqual([view.billingModel, view.entitlementPlan, view.seats], ['legacy_seat', 'pro', 7])
    assert.equal((await pool.query('select count(*)::int n from workspace_credit_grants where "workspaceId"=$1', [legacy.id])).rows[0].n, 0, 'a historical price does not invent new monthly credits')
  })

  await t.test('auto-recharge limits and revocation require the owner, serialize revisions and never bypass Managed Payments', async () => {
    const { saveAutoRechargePolicy } = await import('../lib/billing/auto-recharge')
    const target = await seedWorkspace(pool, admin, [{ userId: admin, role: 'admin' }, { userId: member, role: 'admin' }])
    const value = { enabled: false, thresholdPoints: 100, amountPoints: 1000, monthlyCapPoints: 3000, expectedRevision: 0 }
    const requestsBefore = requests.length
    await rejects(saveAutoRechargePolicy(member, target.id, value), 'workspaceAccessDenied')
    const saved = await saveAutoRechargePolicy(admin, target.id, value)
    assert.deepEqual([saved.state, saved.enabled, saved.monthlyCapPoints, saved.revision], ['provider_unsupported', false, 3000, 1])
    await rejects(saveAutoRechargePolicy(admin, target.id, value), 'billingPolicyChanged')
    await assert.rejects(saveAutoRechargePolicy(admin, target.id, { ...value, expectedRevision: 1, monthlyCapPoints: 500 }))
    await assert.rejects(saveAutoRechargePolicy(admin, target.id, { ...value, expectedRevision: 1, enabled: true }))
    await rejects(saveAutoRechargePolicy(admin, target.id, { ...value, expectedRevision: 1, enabled: true, consent: true }), 'billingAutoRechargeUnavailable')
    assert.equal(requests.length, requestsBefore, 'saving or refusing a policy never issues a real or synthetic payment request')
    assert.equal((await pool.query(`select count(*)::int n from workspace_audit_events where "workspaceId"=$1 and action='billing.auto_recharge_changed'`, [target.id])).rows[0].n, 1)
    assert.equal((await pool.query('select "autoRechargeEnabled" from workspace_billing where "workspaceId"=$1', [target.id])).rows[0].autoRechargeEnabled, false)
    const organizationId = randomUUID()
    await pool.query(`insert into mikka_organizations(id,name,"createdBy") values($1,'Synthetic payment authority',$2)`, [organizationId, admin])
    await pool.query(`insert into mikka_organization_members("organizationId","userId",name,email,role) values($1,$2,'Owner','owner@example.invalid','owner'),($1,$3,'Admin','admin@example.invalid','admin')`, [organizationId, admin, member])
    await pool.query('insert into mikka_organization_workspaces("organizationId","workspaceId") values($1,$2)', [organizationId, target.id])
    await organizationBilling.setOrganizationBillingAccount(admin, organizationId, target.id)
    await rejects(saveAutoRechargePolicy(member, target.id, { ...value, expectedRevision: 1 }), 'workspaceAccessDenied')
    assert.equal((await saveAutoRechargePolicy(admin, target.id, { ...value, expectedRevision: 1, monthlyCapPoints: 2000 })).revision, 2)
  })

  await t.test('partial and full plan refunds append immutable receipts, revoke unused credits and cannot revive paid entitlements on replay', async () => {
    const store = new HostedUsageStore(pool), before = (await store.balance(ws.id)).plan, chargeId = id('ch')
    const first = { id: id('re'), amount: 1000, currency: 'usd', status: 'succeeded' }
    const second = { ...first, id: id('re') }
    const refunded = (items: typeof first[]) => event('charge.refunded', { id: chargeId, payment_intent: paymentId, currency: 'usd', refunds: { data: items, has_more: false } })
    const partial = refunded([first])
    await billing.applyStripeEvent(partial, options)
    assert.equal((await store.balance(ws.id)).plan, before - 5_000_000)
    assert.equal((await billing.workspaceBillingView(admin, ws.id, env)).entitlementPlan, 'pro')
    await Promise.all([billing.applyStripeEvent(refunded([first, second]), options), billing.applyStripeEvent(partial, options)])
    await billing.applyStripeEvent(event('invoice.paid', invoice), options)
    assert.equal((await store.balance(ws.id)).plan, 0)
    assert.equal((await store.balance(ws.id)).purchased, 0, 'a plan refund never invents a personal purchased-credit debt')
    assert.equal((await billing.workspaceBillingView(admin, ws.id, env)).entitlementPlan, 'free')
    const receipts = (await pool.query('select points,"amountCents",reason from workspace_credit_grants where "workspaceId"=$1 order by "createdAt",id', [ws.id])).rows
    assert.equal(receipts.find(row => row.reason === 'subscription').points, 1000)
    assert.equal(receipts.reduce((sum, row) => sum + row.points, 0), 0)
    assert.equal(receipts.reduce((sum, row) => sum + row.amountCents, 0), 0)
    const authority = (await pool.query('select plan,"billingPlan" from mikka_workspace_entitlements where "workspaceId"=$1', [ws.id])).rows[0]
    assert.deepEqual(authority, { plan: 'enterprise', billingPlan: 'free' }, 'operator grants retain their independent signed authority')
  })

  await t.test('a refund before its invoice and a concurrent invoice/refund both reconcile without a lost debit', async () => {
    for (const concurrent of [false, true]) {
      const target = await seedWorkspace(pool, admin, [{ userId: admin, role: 'admin' }]), sid = id('sub'), iid = id('in'), pid = id('pi')
      payments.set(pid, { id: pid, amount_received: 2000, currency: 'usd', metadata: {} })
      const paid = { ...invoice, id: iid, customer: id('cus'), subscription: sid, payment_intent: pid }
      invoices.set(iid, paid)
      const active = { ...sub, id: sid, customer: paid.customer, metadata: { workspaceId: target.id, billingModel: 'resource_v1' }, latest_invoice: paid }
      subscriptions.set(sid, active)
      const returned = event('charge.refunded', { id: id('ch'), payment_intent: pid, currency: 'usd', refunds: { has_more: false, data: [{ id: id('re'), amount: 2000, currency: 'usd', status: 'succeeded' }] } })
      const granted = event('invoice.paid', paid)
      if (concurrent) await Promise.all([billing.applyStripeEvent(returned, options), billing.applyStripeEvent(granted, options)])
      else {
        await billing.applyStripeEvent(returned, options)
        assert.equal((await pool.query('select count(*)::int n from workspace_credit_grants where "workspaceId"=$1', [target.id])).rows[0].n, 0)
        await billing.applyStripeEvent(granted, options)
      }
      assert.equal((await new HostedUsageStore(pool).balance(target.id)).plan, 0)
      assert.equal((await billing.workspaceBillingView(admin, target.id, env)).entitlementPlan, 'free')
      assert.equal((await pool.query('select sum(points)::int n from workspace_credit_grants where "workspaceId"=$1', [target.id])).rows[0].n, 0)
      assert.equal((await pool.query('select count(*)::int n from billing_refund_receipts where "paymentIntentId"=$1 and "reconciledAt" is null', [pid])).rows[0].n, 0)
    }
  })

  await t.test('current Stripe invoice payments apportion multiple paid sources and retain their cumulative refund ceiling', async () => {
    const target = await seedWorkspace(pool, admin, [{ userId: admin, role: 'admin' }]), sid = id('sub'), iid = id('in'), pids = [id('pi'), id('pi')]
    for (const pid of pids) payments.set(pid, { id: pid, amount_received: 1000, currency: 'usd', metadata: {} })
    invoicePayments.set(iid, pids.map(pid => ({ id: id('inpay'), amount_paid: 1000, currency: 'usd', invoice: iid, status: 'paid', payment: { type: 'payment_intent', payment_intent: pid } })))
    const paid = { ...invoice, id: iid, customer: id('cus'), subscription: sid, payment_intent: null }
    invoices.set(iid, paid)
    const active = { ...sub, id: sid, customer: paid.customer, metadata: { workspaceId: target.id, billingModel: 'resource_v1' }, latest_invoice: paid }
    subscriptions.set(sid, active)
    await billing.applyStripeEvent(event('invoice.paid', paid), options)
    const store = new HostedUsageStore(pool)
    assert.equal((await store.balance(target.id)).plan, 10_000_000)
    const excessive = event('charge.refunded', { id: id('ch'), payment_intent: pids[0], currency: 'usd', refunds: { has_more: false,
      data: [{ id: id('re'), amount: 1001, currency: 'usd', status: 'succeeded' }] } })
    await assert.rejects(billing.applyStripeEvent(excessive, options), /billing_refund_exceeds_payment/)
    assert.equal((await pool.query('select count(*)::int n from stripe_webhook_events where id=$1', [excessive.id])).rows[0].n, 0)
    assert.equal((await store.balance(target.id)).plan, 10_000_000)
    for (const [index, pid] of pids.entries()) {
      await billing.applyStripeEvent(event('charge.refunded', { id: id('ch'), payment_intent: pid, currency: 'usd', refunds: { has_more: false, data: [{ id: id('re'), amount: 1000, currency: 'usd', status: 'succeeded' }] } }), options)
      assert.equal((await store.balance(target.id)).plan, index === 0 ? 5_000_000 : 0)
      assert.equal((await billing.workspaceBillingView(admin, target.id, env)).entitlementPlan, index === 0 ? 'pro' : 'free')
    }
  })
})
