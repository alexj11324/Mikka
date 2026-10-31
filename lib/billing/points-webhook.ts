import 'server-only'
import { randomUUID } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { db } from '@/lib/db'
import { workspaceCreditGrants } from '@/lib/db/schema'
import { POINTS_PURCHASE_AMOUNTS } from './points'
import { stripeConfig, stripeGet } from './stripe'

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
export interface PointsWebhookOptions {
  env?: Readonly<Record<string, string | undefined>>
  fetchImpl?: typeof fetch
}
const stripeId = z.string().regex(/^[a-z]+_[A-Za-z0-9_]+$/)
const metadata = z.object({ workspaceId: z.uuid(), points: z.string().regex(/^\d+$/), purpose: z.literal('points_purchase') })
const chargeDetails = z.object({
  receipt_url: z.url().nullish(),
  balance_transaction: z.union([z.string(), z.object({ fee: z.number().int().nonnegative(), currency: z.string() })]).nullish(),
}).loose()
const refund = z.object({ id: stripeId, amount: z.number().int().positive(), currency: z.literal('usd'), status: z.string() })
const refundList = z.object({ data: z.array(refund), has_more: z.boolean() })

/** Called inside the event transaction, after raw-body signature verification. */
export async function applyPointsEvent(tx: Transaction, type: string, object: Record<string, unknown>, options: PointsWebhookOptions): Promise<void> {
  const get = async <T>(path: string): Promise<T> => {
    const config = stripeConfig(options.env)
    if (!config) throw new Error('Stripe is unavailable for webhook enrichment')
    return stripeGet<T>(config, path, options.fetchImpl)
  }
  if (type === 'checkout.session.completed' || type === 'checkout.session.async_payment_succeeded') {
    if (object.mode !== 'payment' || object.payment_status !== 'paid') return
    if ((object.metadata as Record<string, unknown> | undefined)?.purpose !== 'points_purchase') return
    const session = z.object({ id: stripeId, payment_intent: stripeId, amount_total: z.number().int(), currency: z.literal('usd'), metadata }).parse(object)
    const points = Number(session.metadata.points)
    if (!POINTS_PURCHASE_AMOUNTS.some(amount => amount * 100 === points) || session.amount_total !== points) throw new Error('Invalid points purchase amount')
    const [existing] = await tx.select({ id: workspaceCreditGrants.id }).from(workspaceCreditGrants).where(eq(workspaceCreditGrants.externalId, session.id)).limit(1)
    if (existing) return
    const payment = z.object({ latest_charge: chargeDetails.nullable() }).parse(await get(`payment_intents/${session.payment_intent}?expand%5B%5D=latest_charge.balance_transaction`))
    const charge = payment.latest_charge
    const fee = charge?.balance_transaction
    await tx.insert(workspaceCreditGrants).values({
      id: randomUUID(), workspaceId: session.metadata.workspaceId, bucket: 'purchased', points, reason: 'purchase', externalId: session.id,
      stripePaymentIntentId: session.payment_intent, amountCents: session.amount_total, currency: session.currency,
      receiptUrl: charge?.receipt_url ?? null, stripeFeeCents: typeof fee === 'object' && fee?.currency === 'usd' ? fee.fee : null,
    }).onConflictDoNothing({ target: workspaceCreditGrants.externalId })
    return
  }
  if (!object.payment_intent) return
  if (type === 'refund.updated') {
    if (object.status !== 'succeeded') return
    const item = refund.extend({ charge: stripeId, payment_intent: stripeId }).parse(object)
    object = { id: item.charge, payment_intent: item.payment_intent, currency: item.currency, refunds: { data: [item], has_more: false } }
  } else if (type !== 'charge.refunded') return
  const charge = z.object({ id: stripeId, payment_intent: stripeId, currency: z.string(), refunds: refundList.optional(), metadata: z.record(z.string(), z.string()).optional() }).parse(object)
  const [purchase] = await tx.select().from(workspaceCreditGrants).where(and(eq(workspaceCreditGrants.stripePaymentIntentId, charge.payment_intent), eq(workspaceCreditGrants.reason, 'purchase'))).limit(1).for('update')
  if (!purchase) {
    const details = charge.metadata?.purpose === 'points_purchase' ? charge : z.object({ metadata: z.record(z.string(), z.string()) }).parse(await get(`payment_intents/${charge.payment_intent}`))
    if (details.metadata?.purpose === 'points_purchase') throw new Error('Points purchase has not arrived; retry refund')
    return
  }
  if (charge.currency !== 'usd') throw new Error('Unexpected points refund currency')
  let page = charge.refunds ?? refundList.parse(await get(`refunds?charge=${charge.id}&limit=100`))
  for (;;) {
    for (const snapshot of page.data) {
      const item = snapshot.status === 'pending' || snapshot.status === 'requires_action' ? refund.parse(await get(`refunds/${snapshot.id}`)) : snapshot
      if (item.status === 'failed' || item.status === 'canceled') continue
      if (item.status !== 'succeeded') throw new Error('Points refund is pending; retry refund')
      const [existing] = await tx.select({ id: workspaceCreditGrants.id }).from(workspaceCreditGrants).where(eq(workspaceCreditGrants.externalId, item.id)).limit(1)
      if (existing) continue
      const [refunded] = await tx.select({ points: sql<number>`coalesce(-sum(${workspaceCreditGrants.points}), 0)::int` }).from(workspaceCreditGrants).where(and(eq(workspaceCreditGrants.stripePaymentIntentId, charge.payment_intent), eq(workspaceCreditGrants.reason, 'refund')))
      if ((refunded?.points ?? 0) + item.amount > purchase.points) throw new Error('Refund exceeds purchased points')
      await tx.insert(workspaceCreditGrants).values({
        id: randomUUID(), workspaceId: purchase.workspaceId, bucket: 'purchased', points: -item.amount, reason: 'refund', externalId: item.id,
        stripePaymentIntentId: charge.payment_intent, amountCents: -item.amount, currency: item.currency, receiptUrl: purchase.receiptUrl,
      }).onConflictDoNothing({ target: workspaceCreditGrants.externalId })
    }
    if (!page.has_more) break
    const cursor = page.data.at(-1)?.id
    if (!cursor) throw new Error('Stripe refund pagination is empty')
    page = refundList.parse(await get(`refunds?charge=${charge.id}&limit=100&starting_after=${cursor}`))
  }
}
