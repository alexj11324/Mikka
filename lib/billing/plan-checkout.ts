import 'server-only'
import { randomUUID } from 'node:crypto'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import { billingCheckoutRequests, workspaceBilling } from '@/lib/db/schema'
import { recordAudit } from '@/lib/audit/write'
import { WorkspaceError } from '@/lib/workspace-access'
import { stripeGet, stripePost, type StripeConfig } from './stripe'
import { ensureBillingCustomer } from './customer'
import type { resourcePrice } from './resource-plan'

type Request = typeof billingCheckoutRequests.$inferSelect
type Price = ReturnType<typeof resourcePrice>
const id = z.string().regex(/^[a-z]+_[A-Za-z0-9_]+$/)
const expandableId = z.union([id, z.object({ id })]).transform(value => typeof value === 'string' ? value : value.id)
const sessionSchema = z.object({ id, mode: z.string(), status: z.enum(['open', 'complete', 'expired']),
  customer: expandableId, subscription: expandableId.nullish(), client_reference_id: z.string().nullable(),
  metadata: z.record(z.string(), z.string()).nullable(), expires_at: z.number().int().positive(), url: z.url().nullish() }).loose()
const terminal = new Set(['canceled', 'incomplete_expired'])
const pending = () => new WorkspaceError('billingCheckoutPending')

/** A canonical list catches a completed Checkout whose subscription webhook has not arrived yet. */
async function requireNoSubscription(customer: string, get: (path: string) => Promise<unknown>) {
  let cursor: string | undefined
  for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
    const page = z.object({ has_more: z.boolean(), data: z.array(z.object({ id, customer: expandableId, status: z.string() })) })
      .parse(await get(`subscriptions?customer=${customer}&status=all&limit=100${cursor ? `&starting_after=${cursor}` : ''}`))
    if (page.data.some(row => row.customer !== customer)) throw new Error('billing_customer_scope_mismatch')
    // Paused or unknown future states must be resolved through the existing subscription.
    if (page.data.some(row => !terminal.has(row.status))) throw new WorkspaceError('billingPlanInvalid')
    if (!page.has_more) return
    const next = page.data.at(-1)?.id
    if (!next || next === cursor) throw pending()
    cursor = next
  }
  throw pending()
}

function validateSession(raw: unknown, request: Request) {
  const session = sessionSchema.parse(raw)
  if (session.mode !== 'subscription' || session.customer !== request.customerId
    || session.client_reference_id !== request.workspaceId || session.metadata?.checkoutRequestId !== request.id
    || session.metadata?.workspaceId !== request.workspaceId || session.metadata?.billingModel !== 'resource_v1'
    || session.expires_at !== Math.floor(request.expiresAt.getTime() / 1000)
    || (request.sessionId && session.id !== request.sessionId)) throw new Error('billing_checkout_scope_mismatch')
  if (session.url && new URL(session.url).origin !== 'https://checkout.stripe.com') throw new WorkspaceError('billingProviderFailed')
  return session
}

async function rememberSession(request: Request, raw: unknown) {
  const session = validateSession(raw, request)
  const saved = await db.update(billingCheckoutRequests).set({ sessionId: session.id })
    .where(and(eq(billingCheckoutRequests.id, request.id), isNull(billingCheckoutRequests.sessionId))).returning({ id: billingCheckoutRequests.id })
  if (!saved.length) {
    const [current] = await db.select().from(billingCheckoutRequests).where(eq(billingCheckoutRequests.id, request.id)).limit(1)
    if (current?.sessionId !== session.id) throw new Error('billing_checkout_session_changed')
  }
  return session
}

/** Past Stripe's idempotency retention, recover the original Session; never blindly replay POST. */
async function recoverSession(request: Request, get: (path: string) => Promise<unknown>) {
  let cursor: string | undefined
  let found: string | undefined
  for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
    const params = new URLSearchParams({ customer: request.customerId, limit: '100',
      'created[gte]': String(Math.floor(request.createdAt.getTime() / 1000) - 60),
      'created[lte]': String(Math.floor(request.expiresAt.getTime() / 1000) + 60), ...(cursor ? { starting_after: cursor } : {}) })
    const page = z.object({ has_more: z.boolean(), data: z.array(z.object({ id,
      metadata: z.record(z.string(), z.string()).nullish() }).loose()) }).parse(await get(`checkout/sessions?${params}`))
    const matches = page.data.filter(row => row.metadata?.checkoutRequestId === request.id)
    if (matches.length > 1 || (matches.length && found)) throw new Error('billing_checkout_session_ambiguous')
    if (matches.length) found = matches[0].id
    if (!page.has_more) return found ? rememberSession(request, await get(`checkout/sessions/${found}`)) : null
    const next = page.data.at(-1)?.id
    if (!next || next === cursor) throw pending()
    cursor = next
  }
  throw pending()
}

/**
 * Persist the request before provider I/O. The same request keeps identical POST
 * parameters and one Stripe idempotency key through concurrent clicks and lost
 * responses. A later request is admitted only after canonical expiry/completion.
 */
export async function resourcePlanCheckout(actorId: string, workspaceId: string, back: string, price: Price,
  config: StripeConfig, fetchImpl: typeof fetch) {
  const customerId = await ensureBillingCustomer(workspaceId, config, fetchImpl)
  const get = (path: string) => stripeGet<unknown>(config, path, fetchImpl)
  for (let attempt = 0; attempt < 3; attempt++) {
    const request = await db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`billing:${workspaceId}`},0))`)
      const [billing] = await tx.select().from(workspaceBilling).where(eq(workspaceBilling.workspaceId, workspaceId)).for('update').limit(1)
      if (billing?.stripeCustomerId !== customerId) throw new Error('billing_customer_scope_mismatch')
      if (billing.status && !terminal.has(billing.status)) throw new WorkspaceError('billingPlanInvalid')
      const [prior] = await tx.select().from(billingCheckoutRequests)
        .where(and(eq(billingCheckoutRequests.workspaceId, workspaceId), isNull(billingCheckoutRequests.closedAt))).limit(1)
      if (prior) return prior
      const requestId = randomUUID(), now = new Date(), expiresAt = new Date((Math.floor(now.getTime() / 1000) + 7200) * 1000)
      const metadata = { workspaceId, billingModel: price.version, checkoutRequestId: requestId }
      const params = { mode: 'subscription', managed_payments: { enabled: true }, customer: customerId,
        line_items: [{ price: price.id, quantity: 1 }], client_reference_id: workspaceId,
        subscription_data: { metadata: { ...metadata, plan: price.plan } }, metadata,
        success_url: back, cancel_url: back, expires_at: Math.floor(expiresAt.getTime() / 1000) }
      const [created] = await tx.insert(billingCheckoutRequests).values({ id: requestId, workspaceId, actorId, customerId,
        priceId: price.id, params, createdAt: now, expiresAt }).returning()
      await recordAudit(tx, { workspaceId, actor: { type: 'user', id: actorId, name: actorId },
        action: 'billing.checkout_started', target: { type: 'billing_checkout', id: requestId },
        metadata: { amountCents: price.amountCents, currency: price.currency } })
      return created
    })
    if (request.customerId !== customerId) throw new Error('billing_customer_scope_mismatch')
    await requireNoSubscription(customerId, get)
    let session = request.sessionId ? validateSession(await get(`checkout/sessions/${request.sessionId}`), request) : null
    if (!session && request.priceId === price.id && request.expiresAt.getTime() - Date.now() >= 31 * 60_000) {
      // expires_at must still be at least 30 minutes away. Its fixed value also
      // prevents a pruned Stripe idempotency key from ever creating a late Session.
      session = await rememberSession(request, await stripePost<unknown>(config, 'checkout/sessions', request.params,
        fetchImpl, `resource-checkout:${request.id}`))
    } else if (!session) session = await recoverSession(request, get)
    if (session?.status === 'open') {
      if (request.priceId !== price.id || !session.url || session.expires_at * 1000 <= Date.now()) throw pending()
      return { url: session.url }
    }
    if (!session && request.expiresAt.getTime() + 60_000 > Date.now()) throw pending()
    // An expired Session is closed by Stripe. A completed one is reusable only
    // after the canonical customer list confirms no subscription can still bill.
    if (session?.status === 'complete') {
      if (!session.subscription) throw pending()
      const sub = z.object({ id, customer: expandableId, status: z.string() }).parse(await get(`subscriptions/${session.subscription}`))
      if (sub.id !== session.subscription || sub.customer !== customerId) throw new Error('billing_checkout_subscription_mismatch')
      if (!terminal.has(sub.status)) throw new WorkspaceError('billingPlanInvalid')
    }
    await db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`billing:${workspaceId}`},0))`)
      await tx.update(billingCheckoutRequests).set({ closedAt: new Date() })
        .where(and(eq(billingCheckoutRequests.id, request.id), isNull(billingCheckoutRequests.closedAt)))
    })
  }
  throw pending()
}
