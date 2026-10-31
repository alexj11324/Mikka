// The only way the 计费 / 用量 / composer UI talks to the server about card
// verification, the hosted allowance and points (#531, #558, #559).
import { getHostedUsage as hostedUsageAction, getCreditBilling as creditBillingAction } from '@/app/actions/billing'
import type { ActionResult } from '@/lib/action-result'
import type { CreditBillingView, HostedUsage } from './hosted-usage'

export * from './hosted-usage'
export { startCardVerification, cardVerificationStatus, startPointsPurchase } from '@/app/actions/billing'

/** Balance and state for any member; recent calls for admins only (#531). */
export function getHostedUsage(workspaceId?: string): Promise<ActionResult<HostedUsage>> {
  return hostedUsageAction(workspaceId) as Promise<ActionResult<HostedUsage>>
}

/** Keep the existing whole-point display while preserving the server's transaction history. */
export async function getCreditBilling(workspaceId: string): Promise<ActionResult<CreditBillingView>> {
  const result = await creditBillingAction(workspaceId)
  return result.error ? result : { ...result, balancePoints: Math.floor(result.balancePoints) }
}
