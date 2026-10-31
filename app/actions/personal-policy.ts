'use server'

import { headers } from 'next/headers'
import type { ActionResult } from '@/lib/action-result'
import { auditRequestContext } from '@/lib/audit/events'
import type { PersonalResource } from '@/lib/personal-policy'
import { getPersonalPolicy as read, setPersonalPolicy, type PersonalPolicyView } from '@/lib/personal-policy-server'
import { workspaceAction } from '@/lib/workspace-admin/action'
import { currentWorkspaceActor } from '@/lib/workspace-admin/current'

/** 团队权限 › 成员的个人账号: every member reads, `canEdit` for admins. */
export async function getPersonalPolicy(workspaceId?: string): Promise<ActionResult<PersonalPolicyView>> {
  return workspaceAction(async () => {
    const actor = await currentWorkspaceActor(workspaceId)
    return read(actor.userId, actor.workspaceId)
  })
}

/** Admins of a team workspace only; audited as integration.permission_changed. */
export async function updatePersonalPolicy(input: { resource: PersonalResource; allowed: boolean }, workspaceId?: string): Promise<ActionResult<PersonalPolicyView>> {
  return workspaceAction(async () => {
    const actor = await currentWorkspaceActor(workspaceId)
    return setPersonalPolicy({ id: actor.userId, name: actor.name }, actor.workspaceId, input, auditRequestContext(await headers()))
  })
}
