// The only way the abuse-protection UI talks to the server: the #531 server
// actions (docs/backend/hosted-abuse-controls.md) with the UI's types.
//   startCardVerification(workspaceId?) → { clientSecret, paymentElementOptions? }
//   getHostedUsage(workspaceId?)        → { state, balance, recent }

import { getHostedUsage as hostedUsageAction, startCardVerification as cardSetupAction } from '@/app/actions/billing'
import type { ActionResult } from '@/lib/action-result'
import type { CardSetup, HostedUsage } from './hosted-usage'

export * from './hosted-usage'

/** Admin-only. Fails with `billingNotConfigured` while Stripe is not set up. */
export function startCardVerification(workspaceId?: string): Promise<ActionResult<CardSetup>> {
  return cardSetupAction(workspaceId) as Promise<ActionResult<CardSetup>>
}

/** Balance and state for any member; recent calls for admins only. */
export function getHostedUsage(workspaceId?: string): Promise<ActionResult<HostedUsage>> {
  return hostedUsageAction(workspaceId) as Promise<ActionResult<HostedUsage>>
}
