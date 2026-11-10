import 'server-only'
// 计费 (V15). No embedded card or tax forms: plans and payment methods go
// through Stripe Checkout and the Customer Portal; a webhook records state.
import { and, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db, pool } from '@/lib/db'
import { stripeWebhookEvents, workspaceBilling } from '@/lib/db/schema'
import { HostedUsageStore } from '@/lib/abuse/store'
import { MICRO_USD_PER_POINT } from '@/lib/abuse/policy'
import { workspaceMembers } from '@/lib/db/workspace-schema'
import { BILLING_LIVE_STATUSES } from '@/lib/workspace-admin/general'
import { requireWorkspace, WorkspaceError } from '@/lib/workspace-access'
import { workspaceDb } from '@/lib/workspace-db'
import { stripeConfig, stripeGet, stripePost, StripeRequestError, type StripeConfig } from './stripe'
import { applyPointsEvent, type PointsWebhookOptions } from './points-webhook'
import { resourcePrice } from './resource-plan'
import { applySubscriptionEvent } from './subscription-webhook'
import { drainBillingEntitlements } from './entitlement-outbox'
import { organizationBillingAccounts, organizationMembers } from '@/lib/db/governance-schema'
import { requireOrganizationAdmin } from '@/lib/governance/organizations'

type Env = Readonly<Record<string, string | undefined>>

export interface BillingView {
  configured: boolean
  /** A resource price must be configured separately from the historical seat price. */
  resourceCheckoutAvailable: boolean
  billingModel: 'legacy_seat' | 'resource_v1' | null
  entitlementPlan: 'free' | 'pro' | 'enterprise'
  entitlementExpiresAt: string | null
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
  return readBillingAccount(workspaceId, env)
}

/** Organization admins receive billing metadata without acquiring private workspace content access. */
export async function organizationBillingView(actorId: string, organizationId: string, env: Env = process.env) {
  const account = await workspaceDb.transaction(async tx => {
    await requireOrganizationAdmin(tx, organizationId, actorId)
    const [row] = await tx.select().from(organizationBillingAccounts).where(eq(organizationBillingAccounts.organizationId, organizationId)).limit(1)
    const [members] = await tx.select({ count: sql<number>`count(*)::int` }).from(organizationMembers)
      .where(and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.status, 'active')))
    return { workspaceId: row?.workspaceId ?? null, members: members?.count ?? 0 }
  })
  return { organizationId, accountWorkspaceId: account.workspaceId,
    billing: account.workspaceId ? { ...await readBillingAccount(account.workspaceId, env), members: account.members } : null }
}

async function readBillingAccount(workspaceId: string, env: Env): Promise<BillingView> {
  const [billing] = await db.select().from(workspaceBilling).where(eq(workspaceBilling.workspaceId, workspaceId)).limit(1)
  const balance = await new HostedUsageStore(pool).balance(workspaceId)
  const status = billing?.status ?? null
  return {
    configured: Boolean(stripeConfig(env)),
    resourceCheckoutAvailable: Boolean(stripeConfig(env)?.resourcePriceId),
    billingModel: billing?.billingModel ?? null,
    entitlementPlan: billing?.billingExpiresAt && billing.billingExpiresAt > new Date() ? billing.billingPlan : 'free',
    entitlementExpiresAt: billing?.billingExpiresAt?.toISOString() ?? null,
    plan: billing?.plan ?? null, status,
    live: Boolean(status && (BILLING_LIVE_STATUSES as readonly string[]).includes(status)),
    seats: billing?.seats ?? 0, members: await activeMembers(workspaceId),
    currentPeriodEnd: billing?.currentPeriodEnd?.toISOString() ?? null,
    hasCustomer: Boolean(billing?.stripeCustomerId),
    planPoints: billing?.billingModel === 'resource_v1' || balance.plan > 0 ? balance.plan / MICRO_USD_PER_POINT : null,
    purchasedPoints: balance.purchased / MICRO_USD_PER_POINT,
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

/** A capacity plan is one verified resource price, regardless of human membership. */
export async function planCheckoutUrl(actorId: string, workspaceId: string, back: string, fetchImpl: typeof fetch = fetch, env: Env = process.env): Promise<{ url: string }> {
  const config = requireConfig(env)
  await requireAdmin(actorId, workspaceId)
  if (!config.resourcePriceId) throw new WorkspaceError('billingResourcePlanUnavailable')
  const [billing] = await db.select({ status: workspaceBilling.status, customer: workspaceBilling.stripeCustomerId }).from(workspaceBilling).where(eq(workspaceBilling.workspaceId, workspaceId)).limit(1)
  if (billing?.status && (BILLING_LIVE_STATUSES as readonly string[]).includes(billing.status)) throw new WorkspaceError('billingPlanInvalid')
  const back_ = returnUrl.parse(back)
  let price: ReturnType<typeof resourcePrice>
  const configuredPrice = await provider(() => stripeGet<unknown>(config, `prices/${config.resourcePriceId}`, fetchImpl))
  try { price = resourcePrice(configuredPrice, config.resourcePriceId) }
  catch (error) { throw new WorkspaceError('billingResourcePlanUnavailable', { cause: error }) }
  const session = await provider(() => stripePost<{ url: string }>(config, 'checkout/sessions', {
    mode: 'subscription',
    line_items: [{ price: price.id, quantity: 1 }],
    client_reference_id: workspaceId,
    ...(billing?.customer ? { customer: billing.customer } : {}),
    subscription_data: { metadata: { workspaceId, billingModel: price.version, plan: price.plan } },
    metadata: { workspaceId, billingModel: price.version },
    success_url: back_, cancel_url: back_,
  }, fetchImpl))
  return { url: z.url().parse(session.url) }
}

const subscriptionEvent = z.object({
  id: z.string(),
  type: z.string(),
  data: z.object({ object: z.record(z.string(), z.unknown()) }),
})

/**
 * Applies one verified webhook event. Idempotent by event id. Only
 * subscription and points events change state; the workspace comes from the metadata
 * Checkout put on the subscription. Returns false for an event already seen.
 */
export async function applyStripeEvent(raw: unknown, options: PointsWebhookOptions = {}): Promise<boolean> {
  const event = subscriptionEvent.parse(raw)
  const inserted = await db.transaction(async tx => {
    const inserted = await tx.insert(stripeWebhookEvents).values({ id: event.id, type: event.type }).onConflictDoNothing().returning({ id: stripeWebhookEvents.id })
    if (!inserted.length) return false
    await applyPointsEvent(tx, event.type, event.data.object, options)
    await applySubscriptionEvent(tx, event, options)
    return true
  })
  // Replays also drain: APP may have committed just before a Workspace outage.
  // A non-2xx response asks Stripe to retry; success means both stores agree.
  await drainBillingEntitlements(event.id)
  return inserted
}
