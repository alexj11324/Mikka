import 'server-only'
import { randomUUID } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { db } from '@/lib/db'
import { billingEntitlementOutbox, workspaceBilling, workspaceCreditGrants } from '@/lib/db/schema'
import { hostedBillingChanged } from '@/lib/live/billing'
import { stripeConfig, stripeGet } from './stripe'
import type { PointsWebhookOptions } from './points-webhook'

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
type Grant = typeof workspaceCreditGrants.$inferSelect
const id = z.string().regex(/^[a-z]+_[A-Za-z0-9_]+$/)
const expandableId = z.union([id, z.object({ id })]).transform(value => typeof value === 'string' ? value : value.id)
const refund = z.object({ id, amount: z.number().int().positive(), currency: z.literal('usd'), status: z.string() })
const refunds = z.object({ data: z.array(refund), has_more: z.boolean() })
const payment = z.object({ id, amount_paid: z.number().int().nonnegative(), currency: z.literal('usd'), invoice: expandableId,
  status: z.string(), payment: z.object({ type: z.string(), payment_intent: expandableId.optional() }).loose() })

/** Preserve each paid invoice's actual payment attribution, including partial/multiple payments. */
export async function invoicePaymentAllocations(invoice: { id: string; amount_paid: number; payment_intent?: unknown }, get: (path: string) => Promise<unknown>) {
  const allocations: Record<string, { paidCents: number; totalCents: number }> = {}
  if (invoice.amount_paid === 0) return allocations
  // Older pinned Stripe API versions expose one PaymentIntent directly.
  const legacy = expandableId.nullish().parse(invoice.payment_intent)
  let rows: z.infer<typeof payment>[] = []
  if (legacy) rows = [{ id: legacy, amount_paid: invoice.amount_paid, currency: 'usd', invoice: invoice.id,
    status: 'paid', payment: { type: 'payment_intent', payment_intent: legacy } }]
  else {
    let cursor: string | undefined
    for (;;) {
      const page = z.object({ data: z.array(payment), has_more: z.boolean() }).parse(await get(`invoice_payments?invoice=${invoice.id}&status=paid&limit=100${cursor ? `&starting_after=${cursor}` : ''}`))
      rows.push(...page.data)
      if (!page.has_more) break
      const next = page.data.at(-1)?.id
      if (!next || next === cursor) throw new Error('billing_invoice_payments_incomplete')
      cursor = next
    }
  }
  for (const row of rows) {
    if (row.invoice !== invoice.id || row.status !== 'paid') throw new Error('billing_invoice_payment_scope_mismatch')
    if (row.payment.type !== 'payment_intent' || row.amount_paid === 0) continue // Stripe balance/payment records have no card refund.
    const paymentId = id.parse(row.payment.payment_intent)
    const intent = z.object({ id, amount_received: z.number().int().positive(), currency: z.literal('usd') }).parse(await get(`payment_intents/${paymentId}`))
    if (intent.id !== paymentId || row.amount_paid > intent.amount_received) throw new Error('billing_invoice_payment_amount_invalid')
    const previous = allocations[paymentId]
    if (previous && previous.totalCents !== intent.amount_received) throw new Error('billing_invoice_payment_changed')
    allocations[paymentId] = { paidCents: (previous?.paidCents ?? 0) + row.amount_paid, totalCents: intent.amount_received }
    if (allocations[paymentId].paidCents > intent.amount_received) throw new Error('billing_invoice_payment_amount_invalid')
  }
  if (Object.values(allocations).reduce((sum, item) => sum + item.paidCents, 0) > invoice.amount_paid) throw new Error('billing_invoice_payment_amount_invalid')
  return allocations
}

export async function invoiceFullyRefunded(tx: Transaction, invoiceId: string) {
  const rows = await tx.execute(sql`select 1 from workspace_credit_grants g where g."externalId"=${`invoice:${invoiceId}`} and g."amountCents">0
    and coalesce((select -sum(r."amountCents") from workspace_credit_grants r where r."parentGrantId"=g.id),0)>=g."amountCents" limit 1`)
  return rows.rows.length > 0
}

/** Refunds append compensating rows; period dates, original grants and consumed usage never change. */
export async function reconcilePlanRefunds(tx: Transaction, eventId: string, grant: Grant) {
  if (grant.bucket !== 'plan' || grant.reason !== 'subscription' || !grant.stripeInvoiceId || !grant.amountCents || grant.amountCents <= 0) return
  let refundCents = 0n
  for (const [paymentId, allocation] of Object.entries(grant.paymentAllocations)) {
    const result = await tx.execute<{ amount: string }>(sql`select coalesce(sum("amountCents"),0)::text amount from billing_refund_receipts where "paymentIntentId"=${paymentId}`)
    const total = BigInt(result.rows[0]?.amount ?? 0)
    if (total > BigInt(allocation.totalCents)) throw new Error('billing_refund_exceeds_payment')
    refundCents += total * BigInt(allocation.paidCents) / BigInt(allocation.totalCents)
  }
  if (refundCents > BigInt(grant.amountCents)) throw new Error('billing_refund_exceeds_invoice')
  const desiredPoints = BigInt(grant.points) * refundCents / BigInt(grant.amountCents)
  const previous = await tx.execute<{ points: string; cents: string }>(sql`select coalesce(-sum(points),0)::text points,coalesce(-sum("amountCents"),0)::text cents
    from workspace_credit_grants where "parentGrantId"=${grant.id}::uuid`)
  const points = desiredPoints - BigInt(previous.rows[0]?.points ?? 0), cents = refundCents - BigInt(previous.rows[0]?.cents ?? 0)
  if (points < 0n || cents < 0n) throw new Error('billing_refund_reconciliation_regressed')
  if (points > 0n || cents > 0n) await tx.insert(workspaceCreditGrants).values({ id: randomUUID(), workspaceId: grant.workspaceId,
    bucket: 'plan', reason: 'refund', points: -Number(points), amountCents: -Number(cents), currency: 'usd',
    externalId: `plan-refund:${eventId}:${grant.id}`, parentGrantId: grant.id, stripeInvoiceId: grant.stripeInvoiceId,
    receiptUrl: grant.receiptUrl, periodStart: grant.periodStart, expiresAt: grant.expiresAt })
  if (refundCents === BigInt(grant.amountCents)) {
    const [billing] = await tx.select().from(workspaceBilling).where(eq(workspaceBilling.workspaceId, grant.workspaceId)).for('update').limit(1)
    if (billing?.billingInvoiceId === grant.stripeInvoiceId && billing.billingPlan !== 'free' && billing.stripeSubscriptionId) {
      const revision = billing.billingRevision + 1
      if (!Number.isSafeInteger(revision)) throw new Error('billing_revision_overflow')
      await tx.update(workspaceBilling).set({ billingPlan: 'free', billingExpiresAt: null, billingRevision: revision, updatedAt: new Date() }).where(eq(workspaceBilling.workspaceId, grant.workspaceId))
      const receipt = { workspaceId: grant.workspaceId, subscriptionId: billing.stripeSubscriptionId, plan: 'free' as const,
        expiresAt: null, revision, billingModel: billing.billingModel, deliveredAt: null }
      await tx.insert(billingEntitlementOutbox).values({ eventId, ...receipt }).onConflictDoUpdate({ target: billingEntitlementOutbox.eventId, set: receipt })
    }
  }
  if (points > 0n || cents > 0n) await hostedBillingChanged(tx, grant.workspaceId)
}

/** A signed refund can arrive first. Keep its bounded metadata until the corresponding invoice is granted. */
export async function applyPlanRefundEvent(tx: Transaction, event: { id: string; type: string; data: { object: Record<string, unknown> } }, options: PointsWebhookOptions) {
  const object = event.data.object
  if (!['charge.refunded', 'refund.updated'].includes(event.type) || !object.payment_intent || object.currency !== 'usd') return
  if (event.type === 'refund.updated' && object.status !== 'succeeded') return
  const config = stripeConfig(options.env)
  if (!config) throw new Error('billing_webhook_configuration_unavailable')
  const get = (path: string) => stripeGet<unknown>(config, path, options.fetchImpl)
  const paymentId = id.parse(object.payment_intent), chargeId = id.parse(event.type === 'refund.updated' ? object.charge : object.id)
  const [purchase] = await tx.select({ id: workspaceCreditGrants.id }).from(workspaceCreditGrants)
    .where(and(eq(workspaceCreditGrants.reason, 'purchase'), eq(workspaceCreditGrants.stripePaymentIntentId, paymentId))).limit(1)
  if (purchase) return // The existing purchased-points handler already reconciled this receipt.
  let page = event.type === 'refund.updated' ? { data: [refund.parse(object)], has_more: false }
    : object.refunds ? refunds.parse(object.refunds) : refunds.parse(await get(`refunds?charge=${chargeId}&limit=100`))
  let cursor: string | undefined
  for (;;) {
    for (const snapshot of page.data) {
      const item = ['pending', 'requires_action'].includes(snapshot.status) ? refund.parse(await get(`refunds/${snapshot.id}`)) : snapshot
      if (['failed', 'canceled'].includes(item.status)) continue
      if (item.status !== 'succeeded') throw new Error('billing_refund_pending')
      await tx.execute(sql`insert into billing_refund_receipts(id,"paymentIntentId","chargeId","amountCents",currency,"sourceEventId") values(${item.id},${paymentId},${chargeId},${item.amount},'usd',${event.id}) on conflict(id) do nothing`)
      const saved = await tx.execute<{ paymentIntentId: string; chargeId: string; amountCents: string }>(sql`select "paymentIntentId","chargeId","amountCents"::text from billing_refund_receipts where id=${item.id}`)
      if (saved.rows[0]?.paymentIntentId !== paymentId || saved.rows[0]?.chargeId !== chargeId || Number(saved.rows[0]?.amountCents) !== item.amount) throw new Error('billing_refund_identity_mismatch')
    }
    if (!page.has_more) break
    const next = page.data.at(-1)?.id
    if (!next || next === cursor) throw new Error('billing_refund_pagination_incomplete')
    cursor = next
    page = refunds.parse(await get(`refunds?charge=${chargeId}&limit=100&starting_after=${cursor}`))
  }
  const grants = await tx.select().from(workspaceCreditGrants).where(and(eq(workspaceCreditGrants.bucket, 'plan'),
    eq(workspaceCreditGrants.reason, 'subscription'), sql`${workspaceCreditGrants.paymentAllocations} ? ${paymentId}`))
  if (new Set(grants.map(grant => grant.workspaceId)).size > 1) throw new Error('billing_payment_scope_ambiguous')
  for (const grant of grants.sort((a, b) => a.workspaceId.localeCompare(b.workspaceId))) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`billing:${grant.workspaceId}`},0))`)
    await reconcilePlanRefunds(tx, event.id, grant)
  }
}

/** Runs after commit so a refund racing its invoice cannot be lost under READ COMMITTED. No polling worker. */
export async function drainPlanRefundReceipts() {
  const { db } = await import('@/lib/db')
  const pending = await db.execute<{ id: string; paymentIntentId: string; sourceEventId: string }>(sql`select r.id,r."paymentIntentId",r."sourceEventId"
    from billing_refund_receipts r where r."reconciledAt" is null and exists(select 1 from workspace_credit_grants g
      where g.bucket='plan' and g.reason='subscription' and g."paymentAllocations" ? r."paymentIntentId") order by r."createdAt",r.id limit 100`)
  for (const receipt of pending.rows) await db.transaction(async tx => {
    const grants = await tx.select().from(workspaceCreditGrants).where(and(eq(workspaceCreditGrants.bucket, 'plan'),
      eq(workspaceCreditGrants.reason, 'subscription'), sql`${workspaceCreditGrants.paymentAllocations} ? ${receipt.paymentIntentId}`))
    if (new Set(grants.map(grant => grant.workspaceId)).size > 1) throw new Error('billing_payment_scope_ambiguous')
    for (const grant of grants) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`billing:${grant.workspaceId}`},0))`)
      await reconcilePlanRefunds(tx, receipt.sourceEventId, grant)
    }
    await tx.execute(sql`update billing_refund_receipts set "reconciledAt"=now() where id=${receipt.id}`)
  })
  // Bounded work per delivery; Stripe retries a backlog rather than an idle service polling it.
  if (pending.rows.length === 100) throw new Error('billing_refund_delivery_backlog')
}
