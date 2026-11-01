'use server'

import { headers } from 'next/headers'
import type { ActionResult } from '@/lib/action-result'
import { auditRequestContext } from '@/lib/audit/events'
import { getMemberSubscriptionPolicy as readPolicy, getSubscriptionShare as readShare, setMemberSubscriptionPolicy, setOwnSubscriptionShare, type MemberSubscriptionPolicy, type SubscriptionShareView } from '@/lib/personal-policy-server'
import { designateOwnCard, paymentDesignation, releasePaymentDesignation, type PaymentDesignationView } from '@/lib/payment-designation'
import { workspaceAction } from '@/lib/workspace-admin/action'
import { currentWorkspaceActor } from '@/lib/workspace-admin/current'

/** 团队权限 › 允许成员使用个人订阅: every member reads, `canEdit` for admins. */
export async function getPersonalPolicy(workspaceId?: string): Promise<ActionResult<MemberSubscriptionPolicy>> {
  return workspaceAction(async () => {
    const actor = await currentWorkspaceActor(workspaceId)
    return readPolicy(actor.userId, actor.workspaceId)
  })
}

/** Admins of a team workspace only; audited as integration.permission_changed. */
export async function updatePersonalPolicy(allowed: boolean, workspaceId?: string): Promise<ActionResult<MemberSubscriptionPolicy>> {
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
