'use server'

import type { ActionResult } from '@/lib/action-result'
import { billingPortalUrl, planCheckoutUrl, workspaceBillingView, type BillingView } from '@/lib/billing/service'
import { workspaceAction } from '@/lib/workspace-admin/action'
import { currentWorkspaceActor } from '@/lib/workspace-admin/current'
import { getLocale } from 'next-intl/server'
import { pointsPurchaseUrl } from '@/lib/billing/points-purchase'
import { workspaceCreditBillingView, type CreditBillingView } from '@/lib/billing/history'

/** 设置 › 计费. Admins only. */
export async function getBilling(workspaceId?: string): Promise<ActionResult<BillingView>> {
  return workspaceAction(async () => {
    const actor = await currentWorkspaceActor(workspaceId)
    return workspaceBillingView(actor.userId, actor.workspaceId)
  })
}

export async function getCreditBilling(workspaceId?: string): Promise<ActionResult<CreditBillingView>> {
  return workspaceAction(async () => {
    const actor = await currentWorkspaceActor(workspaceId)
    return workspaceCreditBillingView(actor.userId, actor.workspaceId)
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

/** One-time points purchase. Amount is USD: 10, 25 or 50. */
export async function startPointsPurchase(workspaceId: string, amount: number): Promise<ActionResult<{ url: string }>> {
  return workspaceAction(async () => {
    const actor = await currentWorkspaceActor(workspaceId)
    return pointsPurchaseUrl(actor.userId, actor.workspaceId, amount, await getLocale())
  })
}

/** Stripe hosts card verification and returns to this workspace's billing settings. */
export async function startCardVerification(workspaceId?: string) {
  return workspaceAction(async () => {
    const actor = await currentWorkspaceActor(workspaceId)
    return (await import('@/lib/abuse/card')).createCardSetup(actor.userId,actor.workspaceId,undefined,await getLocale())
  })
}

export async function cardVerificationStatus(workspaceId?: string) {
  return workspaceAction(async () => {
    const actor = await currentWorkspaceActor(workspaceId)
    const { cardVerificationStatus: readCardVerificationStatus } = await import('@/lib/abuse/card')
    return readCardVerificationStatus(actor.userId, actor.workspaceId)
  })
}
export async function getHostedUsage(workspaceId?: string) {
  return workspaceAction(async () => {
    const actor = await currentWorkspaceActor(workspaceId)
    const { hostedUsage, ensureLegacyVerification } = await import('@/lib/abuse/runtime')
    await ensureLegacyVerification(actor.workspaceId)
    const { workspacePool } = await import('@/lib/workspace-db')
    // Card verification is the person's and lands on their personal workspace (C19): only there does 验证银行卡 help.
    const personal = (await workspacePool.query<{ kind: string }>('SELECT kind FROM mikka_workspaces WHERE id=$1', [actor.workspaceId])).rows[0]?.kind === 'personal'
    return { ...await hostedUsage.status(actor.workspaceId), personal, recent:actor.role === 'admin' ? await hostedUsage.recent(actor.workspaceId) : [] }
  })
}
