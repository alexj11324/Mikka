'use server'

import type { ActionResult } from '@/lib/action-result'
import { billingPortalUrl, planCheckoutUrl, workspaceBillingView, type BillingView } from '@/lib/billing/service'
import { workspaceAction } from '@/lib/workspace-admin/action'
import { currentWorkspaceActor } from '@/lib/workspace-admin/current'

/** 设置 › 计费. Admins only. */
export async function getBilling(workspaceId?: string): Promise<ActionResult<BillingView>> {
  return workspaceAction(async () => {
    const actor = await currentWorkspaceActor(workspaceId)
    return workspaceBillingView(actor.userId, actor.workspaceId)
  })
}

/** Customer Portal: payment method, plan changes, cancel, invoices. `returnUrl` is this settings page. */
export async function openBillingPortal(returnUrl: string, workspaceId?: string): Promise<ActionResult<{ url: string }>> {
  return workspaceAction(async () => {
    const actor = await currentWorkspaceActor(workspaceId)
    return billingPortalUrl(actor.userId, actor.workspaceId, returnUrl)
  })
}

/** Stripe Checkout for the Team plan. */
export async function startPlanCheckout(returnUrl: string, workspaceId?: string): Promise<ActionResult<{ url: string }>> {
  return workspaceAction(async () => {
    const actor = await currentWorkspaceActor(workspaceId)
    return planCheckoutUrl(actor.userId, actor.workspaceId, returnUrl)
  })
}
