import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { dbUrl, seedUser, seedWorkspace } from './support/workspace-admin-db'

test('Stripe purchased points ledger', { skip: !dbUrl }, async t => {
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: dbUrl, max: 3 })
  const { pool: appPool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  const { applyStripeEvent } = await import('../lib/billing/service')
  t.after(async () => { await Promise.all([pool.end(), appPool.end(), workspacePool.end()]) })
  const owner = await seedUser(pool, 'points-owner')
  const workspace = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }])
  const env = { STRIPE_SECRET_KEY: 'sk_test_fixture' }
  const id = (prefix: string) => `${prefix}_${randomUUID().replaceAll('-', '')}`
  const session = () => ({ id: id('cs'), mode: 'payment', payment_status: 'paid', payment_intent: id('pi'), amount_total: 1000, currency: 'usd', metadata: { workspaceId: workspace.id, points: '1000', purpose: 'points_purchase' } })
  const event = (type: string, object: unknown) => ({ id: id('evt'), type, data: { object } })
  const fake = (value: unknown) => (async () => Response.json(value)) as typeof fetch
  const payment = { latest_charge: { receipt_url: 'https://pay.stripe.com/receipts/fixture', balance_transaction: { fee: 59, currency: 'usd' } } }
  const options = { env, fetchImpl: fake(payment) }
  const rows = async (paymentId: string) => (await pool.query('SELECT * FROM workspace_credit_grants WHERE "stripePaymentIntentId"=$1 ORDER BY points DESC', [paymentId])).rows
  const charge = (purchase: ReturnType<typeof session>, refunds: Array<{ id: string; amount: number; currency: string; status: string }>) => ({ id: id('ch'), payment_intent: purchase.payment_intent, currency: 'usd', metadata: purchase.metadata, refunds: { data: refunds, has_more: false } })
  const refund = (amount: number) => ({ id: id('re'), amount, currency: 'usd', status: 'succeeded' })

  await t.test('paid sessions credit once across event IDs and concurrent delivery; receipt and fee persist', async () => {
    const purchase = session(), paid = event('checkout.session.completed', purchase)
    assert.equal(await applyStripeEvent(paid, options), true)
    assert.equal(await applyStripeEvent(paid, options), false)
    await Promise.all([applyStripeEvent(event('checkout.session.completed', purchase), options), applyStripeEvent(event('checkout.session.async_payment_succeeded', purchase), options)])
    const grants = await rows(purchase.payment_intent)
    assert.equal(grants.length, 1)
    assert.deepEqual([grants[0].points, grants[0].amountCents, grants[0].externalId, grants[0].reason, grants[0].receiptUrl, grants[0].stripeFeeCents], [1000, 1000, purchase.id, 'purchase', payment.latest_charge.receipt_url, 59])
  })

  await t.test('unpaid and async pending sessions do not credit; async paid credits once', async () => {
    const purchase = session()
    await applyStripeEvent(event('checkout.session.completed', { ...purchase, payment_status: 'unpaid' }), options)
    await applyStripeEvent(event('checkout.session.async_payment_succeeded', { ...purchase, payment_status: 'unpaid' }), options)
    assert.equal((await rows(purchase.payment_intent)).length, 0)
    await applyStripeEvent(event('checkout.session.async_payment_succeeded', purchase), options)
    assert.equal((await rows(purchase.payment_intent))[0].points, 1000)
  })

  await t.test('payment metadata cannot grant a different amount or unsupported denomination', async () => {
    for (const purchase of [{ ...session(), amount_total: 999 }, { ...session(), amount_total: 1200, metadata: { ...session().metadata, points: '1200' } }]) {
      const invalid = event('checkout.session.completed', purchase)
      await assert.rejects(applyStripeEvent(invalid, options), /Invalid points purchase amount/)
      assert.equal((await rows(purchase.payment_intent)).length, 0)
      assert.equal((await pool.query('SELECT id FROM stripe_webhook_events WHERE id=$1', [invalid.id])).rowCount, 0)
    }
    const otherProduct = { ...session(), metadata: {} }
    await applyStripeEvent(event('checkout.session.completed', otherProduct), options)
    assert.equal((await rows(otherProduct.payment_intent)).length, 0)
  })

  await t.test('partial refunds debit once per refund ID including repeated charge snapshots', async () => {
    const purchase = session(), first = refund(250), second = refund(750)
    await applyStripeEvent(event('checkout.session.completed', purchase), options)
    const partial = event('charge.refunded', charge(purchase, [first]))
    await applyStripeEvent(partial, options)
    await applyStripeEvent(partial, options)
    await Promise.all([applyStripeEvent(event('charge.refunded', charge(purchase, [second, first])), options), applyStripeEvent(event('charge.refunded', charge(purchase, [first])), options)])
    const grants = await rows(purchase.payment_intent)
    assert.equal(grants.length, 3)
    assert.equal(grants.reduce((sum, row) => sum + row.points, 0), 0)
    assert.deepEqual(grants.filter(row => row.reason === 'refund').map(row => [row.points, row.amountCents]), [[-250, -250], [-750, -750]])
  })

  await t.test('refund delivered before its purchase stays retryable and later applies', async () => {
    const purchase = session(), refunded = event('charge.refunded', charge(purchase, [refund(100)]))
    await assert.rejects(applyStripeEvent(refunded, options), /purchase has not arrived/)
    assert.equal((await pool.query('SELECT id FROM stripe_webhook_events WHERE id=$1', [refunded.id])).rowCount, 0)
    await applyStripeEvent(event('checkout.session.completed', purchase), options)
    await applyStripeEvent(refunded, options)
    assert.equal((await rows(purchase.payment_intent)).reduce((sum, row) => sum + row.points, 0), 900)
  })

  await t.test('all refund pages are read and pending/oversized refunds roll back', async () => {
    const purchase = session(), first = refund(100), second = refund(150)
    await applyStripeEvent(event('checkout.session.completed', purchase), options)
    const object = charge(purchase, [first])
    object.refunds.has_more = true
    const seen: string[] = []
    await applyStripeEvent(event('charge.refunded', object), { env, fetchImpl: (async (url: string | URL | Request) => { seen.push(String(url)); return Response.json({ data: [second], has_more: false }) }) as typeof fetch })
    assert.equal(seen.length, 1)
    assert.match(seen[0], new RegExp(`starting_after=${first.id}$`))
    for (const item of [{ ...refund(100), status: 'pending' }, refund(751)]) {
      const refused = event('charge.refunded', charge(purchase, [item]))
      await assert.rejects(applyStripeEvent(refused, { env, fetchImpl: fake(item) }), /retry refund|exceeds purchased points/)
      assert.equal((await pool.query('SELECT id FROM stripe_webhook_events WHERE id=$1', [refused.id])).rowCount, 0)
    }
    assert.equal((await rows(purchase.payment_intent)).reduce((sum, row) => sum + row.points, 0), 750)
  })

  await t.test('replayed pending refund reads current Stripe state before applying the debit', async () => {
    const purchase = session(), pending = { ...refund(100), status: 'pending' }
    await applyStripeEvent(event('checkout.session.completed', purchase), options)
    const original = event('charge.refunded', charge(purchase, [pending]))
    await assert.rejects(applyStripeEvent(original, { env, fetchImpl: fake(pending) }), /refund is pending/)
    const seen: string[] = []
    await applyStripeEvent(original, { env, fetchImpl: (async (url: string | URL | Request) => { seen.push(String(url)); return Response.json({ ...pending, status: 'succeeded' }) }) as typeof fetch })
    assert.deepEqual(seen, [`https://api.stripe.com/v1/refunds/${pending.id}`])
    assert.equal((await rows(purchase.payment_intent)).reduce((sum, row) => sum + row.points, 0), 900)
  })

  await t.test('refund.updated settles a long-pending refund once across both event types', async () => {
    const purchase = session(), item = refund(100)
    await applyStripeEvent(event('checkout.session.completed', purchase), options)
    const updated = { ...item, charge: id('ch'), payment_intent: purchase.payment_intent }
    await applyStripeEvent(event('refund.updated', { ...updated, status: 'pending' }), options)
    assert.equal((await rows(purchase.payment_intent)).length, 1)
    const succeeded = event('refund.updated', updated)
    await applyStripeEvent(succeeded, options)
    assert.equal(await applyStripeEvent(succeeded, options), false)
    await applyStripeEvent(event('refund.updated', updated), options)
    await applyStripeEvent(event('charge.refunded', charge(purchase, [item])), options)
    assert.equal((await rows(purchase.payment_intent)).length, 2)
    assert.equal((await rows(purchase.payment_intent)).reduce((sum, row) => sum + row.points, 0), 900)
  })

  await t.test('refund.updated arriving before the purchase keeps the event retryable', async () => {
    const purchase = session(), item = { ...refund(100), charge: id('ch'), payment_intent: purchase.payment_intent }
    const succeeded = event('refund.updated', item)
    const metadataOptions = { env, fetchImpl: fake({ metadata: purchase.metadata }) }
    await assert.rejects(applyStripeEvent(succeeded, metadataOptions), /purchase has not arrived/)
    assert.equal((await pool.query('SELECT id FROM stripe_webhook_events WHERE id=$1', [succeeded.id])).rowCount, 0)
    await applyStripeEvent(event('checkout.session.completed', purchase), options)
    await applyStripeEvent(succeeded, options)
    assert.equal((await rows(purchase.payment_intent)).reduce((sum, row) => sum + row.points, 0), 900)
  })
})
