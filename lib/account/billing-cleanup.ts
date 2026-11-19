import 'server-only'
import type { Pool } from 'pg'
import { z } from 'zod'
import { StripeRequestError, stripeConfig, stripeGet, type StripeConfig } from '@/lib/billing/stripe'
import type { AccountCleanupReport } from './cleanup-result'

/**
 * Cancel the paid plan of a workspace the account deletion removes.
 *
 * Stripe is the only party that can stop a recurring charge, and the Customer
 * Portal (the self-service way to cancel) dies with the account. 删除工作区
 * refuses a live plan for exactly this reason (lib/workspace-admin/general.ts);
 * account deletion cannot refuse, so it cancels first. This runs at the external
 * cleanup stage, before any local row is removed: a provider failure keeps the
 * job retryable instead of leaving a subscription that bills a deleted user.
 */

const stripeId = z.string().regex(/^[a-z]+_[A-Za-z0-9_]+$/)
const customerId = z.string().regex(/^cus_[A-Za-z0-9_]+$/)
/** Same terminal set as lib/billing/plan-checkout.ts: these can never bill again. */
const TERMINAL = new Set(['canceled', 'incomplete_expired'])
const subscriptions = z.object({ has_more: z.boolean(),
  data: z.array(z.object({ id: stripeId, customer: z.union([customerId, z.object({ id: customerId }).loose()]), status: z.string() }).loose()) }).loose()
const canceledSubscription = z.object({ id: stripeId, status: z.string() }).loose()

export interface BillingCleanupDeps {
  /** The workspaces this deletion removes (Plan.solo). A shared workspace keeps its team's plan. */
  soloWorkspaceIds: readonly string[]
  fetchImpl?: typeof fetch
  env?: Readonly<Record<string, string | undefined>>
}

/**
 * The shared client speaks POST and GET only, and cancelling a subscription is
 * a DELETE (stripe.com/docs/api/subscriptions/cancel). Same origin, same
 * timeout, and the key never reaches a log or an error message.
 */
async function cancelSubscription(config: StripeConfig, id: string, fetchImpl: typeof fetch) {
  const response = await fetchImpl(`https://api.stripe.com/v1/subscriptions/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${config.secretKey}`, 'idempotency-key': `account-deletion-cancel:${id}` },
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new StripeRequestError(response.status)
  // The account is about to disappear: anything but a confirmed cancel still
  // bills the card, so it must hold the deletion rather than report success.
  const canceled = canceledSubscription.parse(await response.json())
  if (canceled.id !== id || canceled.status !== 'canceled') throw new Error('billing_subscription_cancel_unconfirmed')
}

/** Every subscription of this customer that can still bill, oldest first. */
async function billableSubscriptions(config: StripeConfig, customer: string, fetchImpl: typeof fetch): Promise<string[]> {
  const found: string[] = []
  let cursor: string | undefined
  for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
    const page = subscriptions.parse(await stripeGet<unknown>(config,
      `subscriptions?customer=${encodeURIComponent(customer)}&status=all&limit=100${cursor ? `&starting_after=${encodeURIComponent(cursor)}` : ''}`, fetchImpl))
    // The customer was read from our own row; a foreign one means the provider answered for someone else.
    if (page.data.some(row => (typeof row.customer === 'string' ? row.customer : row.customer.id) !== customer)) throw new Error('billing_customer_scope_mismatch')
    found.push(...page.data.filter(row => !TERMINAL.has(row.status)).map(row => row.id))
    if (!page.has_more) return found
    const next = page.data.at(-1)?.id
    if (!next || next === cursor) throw new Error('billing_subscription_page_stuck')
    cursor = next
  }
  throw new Error('billing_subscription_page_limit')
}

export async function cleanupAccountBilling(database: Pick<Pool, 'query'>, deps: BillingCleanupDeps): Promise<AccountCleanupReport> {
  const workspaceIds = [...new Set(deps.soloWorkspaceIds)]
  if (!workspaceIds.length) return { blockedReasons: [], warnings: [] }
  const { rows } = await database.query<{ customer: string }>(`SELECT DISTINCT "stripeCustomerId" AS customer
    FROM workspace_billing WHERE "workspaceId" = ANY($1::uuid[]) AND "stripeCustomerId" IS NOT NULL`, [workspaceIds])
  // No customer means nothing can be charged: this path never calls the provider.
  if (!rows.length) return { blockedReasons: [], warnings: [] }
  const config = stripeConfig(deps.env ?? process.env)
  // Same rule as composio_not_configured: hold the account, keep the data, and
  // retry once the provider that can stop the charge is configured again.
  if (!config) return { blockedReasons: ['billing_provider_not_configured'], warnings: [] }
  const fetchImpl = deps.fetchImpl ?? fetch
  const blockedReasons = new Set<string>(), warnings = new Set<string>()
  for (const { customer } of rows) {
    // A customer id we cannot address is one we cannot prove cancelled either.
    if (!customerId.safeParse(customer).success) { blockedReasons.add('billing_subscription_cancel_failed'); continue }
    let ids: string[]
    try { ids = await billableSubscriptions(config, customer, fetchImpl) }
    catch (error) {
      // A customer Stripe no longer knows holds nothing that can bill again.
      if (!(error instanceof StripeRequestError && error.status === 404)) blockedReasons.add('billing_subscription_cancel_failed')
      continue
    }
    for (const id of ids) {
      try { await cancelSubscription(config, id, fetchImpl) }
      catch (error) {
        if (error instanceof StripeRequestError && error.status === 404) warnings.add('billing_subscription_cancel_already_gone')
        else blockedReasons.add('billing_subscription_cancel_failed')
      }
    }
  }
  return { blockedReasons: [...blockedReasons], warnings: [...warnings] }
}
