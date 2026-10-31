import 'server-only'
// 计费 (V15). No embedded card or tax forms: plans and payment methods go
// through Stripe Checkout and the Customer Portal; a webhook records state.
import { and, desc, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import { stripeWebhookEvents, workspaceBilling, workspaceCreditGrants } from '@/lib/db/schema'
import { workspaceMembers } from '@/lib/db/workspace-schema'
import { BILLING_LIVE_STATUSES } from '@/lib/workspace-admin/general'
import { requireWorkspace, WorkspaceError } from '@/lib/workspace-access'
import { workspaceDb } from '@/lib/workspace-db'
import { stripeConfig, stripePost, StripeRequestError, type StripeConfig } from './stripe'
import { applyPointsEvent, type PointsWebhookOptions } from './points-webhook'

type Env = Readonly<Record<string, string | undefined>>

export interface BillingView {
  configured: boolean
  plan: string | null
  status: string | null
  /** True while the subscription still bills (active, trialing, past_due…). */
  live: boolean
  seats: number
  members: number
  currentPeriodEnd: string | null
  hasCustomer: boolean
  planPoints: number | null
  purchasedPoints: number
}

async function requireAdmin(actorId: string, workspaceId: string) {
  await workspaceDb.transaction(tx => requireWorkspace(tx, workspaceId, actorId, true))
}

async function activeMembers(workspaceId: string) {
  const [row] = await workspaceDb.select({ n: sql<number>`count(*)::int` }).from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.status, 'active')))
  return row?.n ?? 0
}

/** Admins only. */
export async function workspaceBillingView(actorId: string, workspaceId: string, env: Env = process.env): Promise<BillingView> {
  await requireAdmin(actorId, workspaceId)
  const [billing] = await db.select().from(workspaceBilling).where(eq(workspaceBilling.workspaceId, workspaceId)).limit(1)
  const [plan] = await db.select({ points: workspaceCreditGrants.points }).from(workspaceCreditGrants)
    .where(and(eq(workspaceCreditGrants.workspaceId, workspaceId), eq(workspaceCreditGrants.bucket, 'plan'))).orderBy(desc(workspaceCreditGrants.createdAt)).limit(1)
  const [purchased] = await db.select({ n: sql<number>`coalesce(sum(${workspaceCreditGrants.points}), 0)::int` }).from(workspaceCreditGrants)
    .where(and(eq(workspaceCreditGrants.workspaceId, workspaceId), eq(workspaceCreditGrants.bucket, 'purchased')))
  const status = billing?.status ?? null
  return {
    configured: Boolean(stripeConfig(env)),
    plan: billing?.plan ?? null, status,
    live: Boolean(status && (BILLING_LIVE_STATUSES as readonly string[]).includes(status)),
    seats: billing?.seats ?? 0, members: await activeMembers(workspaceId),
    currentPeriodEnd: billing?.currentPeriodEnd?.toISOString() ?? null,
    hasCustomer: Boolean(billing?.stripeCustomerId),
    planPoints: plan?.points ?? null, purchasedPoints: purchased?.n ?? 0,
  }
}

const returnUrl = z.url().refine(url => /^https?:\/\//.test(url))

function provider<T>(work: () => Promise<T>): Promise<T> {
  return work().catch(error => {
    if (error instanceof StripeRequestError || (error as Error)?.name === 'TimeoutError' || error instanceof TypeError) {
      console.error('[billing] stripe request failed', { name: (error as Error).name, status: error instanceof StripeRequestError ? error.status : null })
      throw new WorkspaceError('billingProviderFailed')
    }
    throw error
  })
}

function requireConfig(env: Env): StripeConfig {
  const config = stripeConfig(env)
  if (!config) throw new WorkspaceError('billingNotConfigured')
  return config
}

/** 管理付款方式 / 更改方案 / 发票: a Customer Portal session URL. Admins only. */
export async function billingPortalUrl(actorId: string, workspaceId: string, back: string, fetchImpl: typeof fetch = fetch, env: Env = process.env): Promise<{ url: string }> {
  const config = requireConfig(env)
  await requireAdmin(actorId, workspaceId)
  const [billing] = await db.select({ customer: workspaceBilling.stripeCustomerId }).from(workspaceBilling).where(eq(workspaceBilling.workspaceId, workspaceId)).limit(1)
  if (!billing?.customer) throw new WorkspaceError('billingNoSubscription')
  const session = await provider(() => stripePost<{ url: string }>(config, 'billing_portal/sessions', { customer: billing.customer, return_url: returnUrl.parse(back) }, fetchImpl))
  return { url: z.url().parse(session.url) }
}

/** 订阅 Team: a Checkout session for one seat per active member. Admins only. */
export async function planCheckoutUrl(actorId: string, workspaceId: string, back: string, fetchImpl: typeof fetch = fetch, env: Env = process.env): Promise<{ url: string }> {
  const config = requireConfig(env)
  if (!config.teamPriceId) throw new WorkspaceError('billingNotConfigured')
  await requireAdmin(actorId, workspaceId)
  const [billing] = await db.select({ status: workspaceBilling.status, customer: workspaceBilling.stripeCustomerId }).from(workspaceBilling).where(eq(workspaceBilling.workspaceId, workspaceId)).limit(1)
  if (billing?.status && (BILLING_LIVE_STATUSES as readonly string[]).includes(billing.status)) throw new WorkspaceError('billingPlanInvalid')
  const back_ = returnUrl.parse(back)
  const seats = Math.max(1, await activeMembers(workspaceId))
  const session = await provider(() => stripePost<{ url: string }>(config, 'checkout/sessions', {
    mode: 'subscription',
    line_items: [{ price: config.teamPriceId, quantity: seats }],
    client_reference_id: workspaceId,
    ...(billing?.customer ? { customer: billing.customer } : {}),
    subscription_data: { metadata: { workspaceId } },
    metadata: { workspaceId },
    success_url: back_, cancel_url: back_,
  }, fetchImpl))
  return { url: z.url().parse(session.url) }
}

const subscriptionEvent = z.object({
  id: z.string(),
  type: z.string(),
  data: z.object({ object: z.record(z.string(), z.unknown()) }),
})

const subscription = z.object({
  id: z.string(), customer: z.string(), status: z.string(),
  metadata: z.object({ workspaceId: z.uuid() }).loose(),
  current_period_end: z.number().optional(),
  items: z.object({ data: z.array(z.object({ quantity: z.number().int().optional(), current_period_end: z.number().optional(), price: z.object({ nickname: z.string().nullish(), lookup_key: z.string().nullish() }).loose() }).loose()) }).loose(),
}).loose()

/**
 * Applies one verified webhook event. Idempotent by event id. Only
 * subscription and points events change state; the workspace comes from the metadata
 * Checkout put on the subscription. Returns false for an event already seen.
 */
export async function applyStripeEvent(raw: unknown, options: PointsWebhookOptions = {}): Promise<boolean> {
  const event = subscriptionEvent.parse(raw)
  return db.transaction(async tx => {
    const inserted = await tx.insert(stripeWebhookEvents).values({ id: event.id, type: event.type }).onConflictDoNothing().returning({ id: stripeWebhookEvents.id })
    if (!inserted.length) return false
    await applyPointsEvent(tx, event.type, event.data.object, options)
    if (!['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted'].includes(event.type)) return true
    const sub = subscription.parse(event.data.object)
    const item = sub.items.data[0]
    const periodEnd = sub.current_period_end ?? item?.current_period_end
    const values = {
      stripeCustomerId: sub.customer, stripeSubscriptionId: sub.id,
      status: event.type === 'customer.subscription.deleted' ? 'canceled' : sub.status,
      plan: item?.price.nickname ?? item?.price.lookup_key ?? 'Team',
      seats: item?.quantity ?? 0,
      currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000) : null,
      updatedAt: new Date(),
    }
    await tx.insert(workspaceBilling).values({ workspaceId: sub.metadata.workspaceId, ...values })
      .onConflictDoUpdate({ target: workspaceBilling.workspaceId, set: values })
    return true
  })
}
