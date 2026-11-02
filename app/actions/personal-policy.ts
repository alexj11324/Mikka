'use server'

import { headers } from 'next/headers'
import type { ActionResult } from '@/lib/action-result'
import { auditRequestContext } from '@/lib/audit/events'
import { getMemberSubscriptionPolicy, getSubscriptionShare as readShare, setMemberSubscriptionPolicy, setOwnSubscriptionShare, type MemberSubscriptionPolicy, type SubscriptionShareView } from '@/lib/personal-policy-server'
import { designateOwnCard, paymentDesignation, releasePaymentDesignation, type PaymentDesignationView } from '@/lib/payment-designation'
import { workspaceAction } from '@/lib/workspace-admin/action'
import { currentWorkspaceActor } from '@/lib/workspace-admin/current'

/** 团队权限 › 订阅与 API Key: may members share theirs with teammates here. Every member reads; `canEdit` for admins. */
export async function getSharePolicy(workspaceId?: string): Promise<ActionResult<MemberSubscriptionPolicy>> {
  return workspaceAction(async () => {
    const actor = await currentWorkspaceActor(workspaceId)
    return getMemberSubscriptionPolicy(actor.userId, actor.workspaceId)
  })
}

/** Admins of a team workspace only; audited. 禁止 stops only teammates' runs on shared credentials (decision 2026-11-01-2240). */
export async function updateSharePolicy(allowed: boolean, workspaceId?: string): Promise<ActionResult<MemberSubscriptionPolicy>> {
  return workspaceAction(async () => {
    const actor = await currentWorkspaceActor(workspaceId)
    return setMemberSubscriptionPolicy({ id: actor.userId, name: actor.name }, actor.workspaceId, allowed, auditRequestContext(await headers()))
  })
}

/** 模型与额度 › 在这里使用我的订阅, for the signed-in member only. */
export async function getSubscriptionShare(workspaceId?: string): Promise<ActionResult<SubscriptionShareView>> {
  return workspaceAction(async () => {
    const actor = await currentWorkspaceActor(workspaceId)
    return readShare(actor.userId, actor.workspaceId)
  })
}

export async function updateSubscriptionShare(input: { shared: boolean; allowOthers?: boolean }, workspaceId?: string): Promise<ActionResult<SubscriptionShareView>> {
  return workspaceAction(async () => {
    const actor = await currentWorkspaceActor(workspaceId)
    return setOwnSubscriptionShare(actor.userId, actor.workspaceId, input)
  })
}

/** 我的点数也可用于这个团队 (decision 2026-10-31-2300 item 4). */
export async function getCreditShare(workspaceId?: string): Promise<ActionResult<import('@/lib/credit-shares').CreditShareView>> {
  return workspaceAction(async () => {
    const actor = await currentWorkspaceActor(workspaceId)
    return (await import('@/lib/credit-shares')).creditShareView(actor.userId, actor.workspaceId)
  })
}

export async function updateCreditShare(shared: boolean, workspaceId?: string): Promise<ActionResult<import('@/lib/credit-shares').CreditShareView>> {
  return workspaceAction(async () => {
    const actor = await currentWorkspaceActor(workspaceId)
    return (await import('@/lib/credit-shares')).setOwnCreditShare(actor.userId, actor.workspaceId, Boolean(shared))
  })
}

/** 由我的卡支付这个团队 (decision 2026-10-31-2225); which Stripe customer is charged changes in a follow-up. */
export async function getPaymentDesignation(workspaceId?: string): Promise<ActionResult<PaymentDesignationView>> {
  return workspaceAction(async () => {
    const actor = await currentWorkspaceActor(workspaceId)
    return paymentDesignation(actor.userId, actor.workspaceId)
  })
}

export async function updatePaymentDesignation(designated: boolean, workspaceId?: string): Promise<ActionResult<PaymentDesignationView>> {
  return workspaceAction(async () => {
    const actor = await currentWorkspaceActor(workspaceId)
    if (designated) return designateOwnCard({ id: actor.userId, name: actor.name }, actor.workspaceId)
    await releasePaymentDesignation(actor.workspaceId, actor.userId, { id: actor.userId, name: actor.name })
    return paymentDesignation(actor.userId, actor.workspaceId)
  })
}
