'use server'

import { withFreshSession } from '@/lib/fresh-session'
import type { ActionResult } from '@/lib/action-result'
import { billingPortalUrl, planCheckoutUrl, workspaceBillingView, type BillingView } from '@/lib/billing/service'
import { workspaceAction } from '@/lib/workspace-admin/action'
import { currentWorkspaceActor } from '@/lib/workspace-admin/current'
import { getLocale } from 'next-intl/server'
import { pointsPurchase, pointsPurchaseUrl } from '@/lib/billing/points-purchase'
import { workspaceCreditBillingView, type CreditBillingView } from '@/lib/billing/history'
import { currentDesktopSession } from '@/lib/desktop-rpc/session'

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
async function openBillingPortalBody(returnUrl: string, workspaceId?: string): Promise<ActionResult<{ url: string }>> {
  return workspaceAction(async () => {
    const actor = await currentWorkspaceActor(workspaceId)
    return billingPortalUrl(actor.userId, actor.workspaceId, returnUrl)
  })
}

/** Stripe Checkout for the Team plan. */
async function startPlanCheckoutBody(returnUrl: string, workspaceId?: string): Promise<ActionResult<{ url: string }>> {
  return workspaceAction(async () => {
    const actor = await currentWorkspaceActor(workspaceId)
    return planCheckoutUrl(actor.userId, actor.workspaceId, returnUrl)
  })
}

/** One-time points purchase. Amount is USD: 10, 25 or 50. */
async function startPointsPurchaseBody(workspaceId: string, amount: number): Promise<ActionResult<{ url: string }>> {
  return workspaceAction(async () => {
    const actor = await currentWorkspaceActor(workspaceId)
    return pointsPurchaseUrl(actor.userId, actor.workspaceId, amount, await getLocale())
  })
}

/**
 * 充值 from a chat whose Mikka 默认 turn ran out of points (decision
 * 2026-11-02-1450): an embedded Checkout for a dialog there, or a hosted one
 * that comes back to that chat. Amount is USD: 10, 25 or 50.
 */
async function startChatPointsPurchaseBody(amount: number, botId: string | null): Promise<ActionResult<{ url: string } | { clientSecret: string }>> {
  return workspaceAction(async () => {
    const actor = await currentWorkspaceActor()
    return pointsPurchase(actor.userId, actor.workspaceId, amount, await getLocale(), { chat: { botId }, hosted: Boolean(currentDesktopSession()) })
  })
}

/** Stripe hosts card verification and returns to this workspace's billing settings. */
async function startCardVerificationBody(workspaceId?: string) {
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
    // The person's own subscription serves them in every workspace (#838): with one connected, 连接订阅 is no way on.
    const { pool } = await import('@/lib/db')
    const subscribed = (await pool.query(`SELECT 1 FROM byos_connections WHERE "ownerId"=$1 AND state='connected' AND "removedAt" IS NULL LIMIT 1`, [actor.userId])).rowCount !== 0
    const account = await (await import('@/lib/billing/organization-account')).resolvePlatformBillingAccount(actor.workspaceId)
    const { hostedBillingScope } = await import('@/lib/abuse/context')
    const status = await hostedBillingScope.run({ workspaceId: actor.workspaceId, ownerId: actor.userId, actorId: actor.userId,
      billingAccountWorkspaceId: account.accountWorkspaceId, billingOrganizationId: account.organizationId }, () => hostedUsage.status(account.accountWorkspaceId))
    return { ...status, workspaceId: actor.workspaceId, billingAccount: account, personal, subscribed,
      recent: actor.role === 'admin' ? await hostedUsage.recent(account.accountWorkspaceId, actor.workspaceId) : [] }
  })
}

// Money, permissions, credentials and deletion: the session is read from the database, not the cookie cache.
export async function openBillingPortal(...args: Parameters<typeof openBillingPortalBody>) { return withFreshSession(() => openBillingPortalBody(...args)) }
export async function startPlanCheckout(...args: Parameters<typeof startPlanCheckoutBody>) { return withFreshSession(() => startPlanCheckoutBody(...args)) }
export async function startPointsPurchase(...args: Parameters<typeof startPointsPurchaseBody>) { return withFreshSession(() => startPointsPurchaseBody(...args)) }
export async function startChatPointsPurchase(...args: Parameters<typeof startChatPointsPurchaseBody>) { return withFreshSession(() => startChatPointsPurchaseBody(...args)) }
export async function startCardVerification(...args: Parameters<typeof startCardVerificationBody>) { return withFreshSession(() => startCardVerificationBody(...args)) }
