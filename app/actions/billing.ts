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

/** Backend contract for Claude's card-verification screen. */
export async function startCardVerification(workspaceId?: string) {
  return workspaceAction(async () => {
    const actor = await currentWorkspaceActor(workspaceId)
    return (await import('@/lib/abuse/card')).createCardSetup(actor.userId,actor.workspaceId,undefined,actor.email)
  })
}
export async function getHostedUsage(workspaceId?: string) {
  return workspaceAction(async () => {
    const actor = await currentWorkspaceActor(workspaceId)
    const { hostedUsage, ensureLegacyVerification } = await import('@/lib/abuse/runtime')
    await ensureLegacyVerification(actor.workspaceId)
    return { ...await hostedUsage.status(actor.workspaceId),recent:await hostedUsage.recent(actor.workspaceId) }
  })
}
