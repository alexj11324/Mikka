'use server'

import { headers } from 'next/headers'
import type { ActionResult } from '@/lib/action-result'
import type { AppAccess, PolicyApp } from '@/lib/app-policy/apps'
import { getAppPolicies, setAppPolicy, type AppPolicyView } from '@/lib/app-policy/store'
import { auditRequestContext } from '@/lib/audit/events'
import { workspaceAction } from '@/lib/workspace-admin/action'
import { currentWorkspaceActor } from '@/lib/workspace-admin/current'

/** 团队权限 › 允许使用的应用: every member reads, `canEdit` for admins. */
export async function getAppPolicy(workspaceId?: string): Promise<ActionResult<AppPolicyView>> {
  return workspaceAction(async () => {
    const actor = await currentWorkspaceActor(workspaceId)
    return getAppPolicies(actor.userId, actor.workspaceId)
  })
}

/** Admins only; audited as integration.permission_changed. */
export async function updateAppPolicy(input: { app: PolicyApp; access: AppAccess }, workspaceId?: string): Promise<ActionResult<AppPolicyView>> {
  return workspaceAction(async () => {
    const actor = await currentWorkspaceActor(workspaceId)
    return setAppPolicy({ id: actor.userId, name: actor.name }, actor.workspaceId, input, auditRequestContext(await headers()))
  })
}
