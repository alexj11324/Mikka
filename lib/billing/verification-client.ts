// The only way the 计费 / 用量 / composer UI talks to the server about card
// verification, the hosted allowance and points (#531, #558, #559).
//
// #531 is on main: getHostedUsage is the real action.
// #558 (Stripe Checkout setup mode) and #559 (points purchase, PR #562) are not:
// until they merge, the functions named after their actions answer from #531's
// data or as 暂不可用. When each merges, replace its fallback with the action.

import { getHostedUsage as hostedUsageAction, startCardVerification as cardSetupAction } from '@/app/actions/billing'
import type { ActionResult } from '@/lib/action-result'
import { balancePoints, type CardVerificationStatus, type CreditBillingView, type HostedUsage } from './hosted-usage'

export * from './hosted-usage'

/** Balance and state for any member; recent calls for admins only (#531). */
export function getHostedUsage(workspaceId?: string): Promise<ActionResult<HostedUsage>> {
  return hostedUsageAction(workspaceId) as Promise<ActionResult<HostedUsage>>
}

/**
 * #558: a Stripe Checkout (setup mode) URL; Checkout returns to 计费 with
 * `?verify=success&session_id=…` or `?verify=cancelled`. Admin-only.
 * Until #558 merges, #531's action returns a SetupIntent secret instead of a
 * URL, which this UI no longer uses: that answers billingNotConfigured.
 */
export async function startCardVerification(workspaceId: string): Promise<ActionResult<{ url: string }>> {
  const result = await cardSetupAction(workspaceId) as ActionResult<{ url?: unknown }>
  if (result.error) return result
  return typeof result.url === 'string' ? { url: result.url } : { error: 'billingNotConfigured' }
}

/**
 * #558 `cardVerificationStatus`. Until it merges: verified from #531's hosted
 * usage, otherwise unavailable, since there is no Checkout to start yet.
 */
export async function cardVerificationStatus(workspaceId: string): Promise<ActionResult<CardVerificationStatus>> {
  const usage = await getHostedUsage(workspaceId)
  if (usage.error) return usage
  return { status: usage.balance.verified ? 'verified' : 'unavailable' }
}

/** #559 `getCreditBilling`. Until it merges: #531's allowance and purchased points as one balance, no history. */
export async function getCreditBilling(workspaceId: string): Promise<ActionResult<CreditBillingView>> {
  const usage = await getHostedUsage(workspaceId)
  if (usage.error) return usage
  return { balancePoints: balancePoints(usage.balance), transactions: [] }
}

/** #559 `startPointsPurchase`: a Stripe Checkout (payment mode) URL for $10, $25 or $50. Until it merges: 暂不可用. */
export async function startPointsPurchase(_workspaceId: string, _amount: number): Promise<ActionResult<{ url: string }>> {
  return { error: 'billingNotConfigured' }
}
