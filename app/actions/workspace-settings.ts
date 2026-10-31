'use server'

import { cookies, headers } from 'next/headers'
import type { ActionResult } from '@/lib/action-result'
import { auditRequestContext } from '@/lib/audit/record'
import { workspaceAction } from '@/lib/workspace-admin/action'
import { currentWorkspaceActor } from '@/lib/workspace-admin/current'
import { deleteWorkspaceData, readWorkspaceGeneral, transferWorkspaceOwnership, updateWorkspaceGeneral, workspaceDeletionImpact, workspaceTransferTargets, type UpdateWorkspaceInput, type WorkspaceDeletion, type WorkspaceDeletionImpact, type WorkspaceGeneral, type WorkspaceTransferTarget } from '@/lib/workspace-admin/general'
import { removeMember, type MemberRemoval } from '@/lib/workspace-admin/members'

const COOKIE = 'mikka-workspace'

/** 常规 as the viewer sees it: values for everyone, `canEdit` for admins. */
export async function getWorkspaceGeneral(workspaceId?: string): Promise<ActionResult<WorkspaceGeneral & { canEdit: boolean; canTransfer: boolean }>> {
  return workspaceAction(async () => {
    const actor = await currentWorkspaceActor(workspaceId)
    return readWorkspaceGeneral(actor.userId, actor.workspaceId)
  })
}

/** S-I: what deleting the workspace removes. Admins only. */
export async function getWorkspaceDeletionImpact(workspaceId?: string): Promise<ActionResult<WorkspaceDeletionImpact>> {
  return workspaceAction(async () => {
    const actor = await currentWorkspaceActor(workspaceId)
    return workspaceDeletionImpact(actor.userId, actor.workspaceId)
  })
}

/**
 * 设置 › 工作区 › 常规: name, URL slug (the old one keeps redirecting) and icon. Admins only.
 * `workspaceId` is the workspace the settings page shows; without it the current one.
 */
export async function updateWorkspace(input: UpdateWorkspaceInput, workspaceId?: string): Promise<ActionResult<WorkspaceGeneral>> {
  return workspaceAction(async () => {
    const actor = await currentWorkspaceActor(workspaceId)
    const saved = await updateWorkspaceGeneral(actor.userId, actor.workspaceId, input, auditRequestContext(await headers()))
    return saved
  })
}

/** 转让工作区: the members who could take over. Owner only (see lib/workspace-admin/general.ts mayTransfer). */
export async function getWorkspaceTransferTargets(workspaceId?: string): Promise<ActionResult<WorkspaceTransferTarget[]>> {
  return workspaceAction(async () => {
    const actor = await currentWorkspaceActor(workspaceId)
    return workspaceTransferTargets(actor.userId, actor.workspaceId)
  })
}

/** 转让工作区 to another active member; a member is promoted to admin. */
export async function transferWorkspace(toUserId: string, workspaceId?: string): Promise<ActionResult<{ owner: WorkspaceTransferTarget }>> {
  return workspaceAction(async () => {
    const actor = await currentWorkspaceActor(workspaceId)
    const { owner } = await transferWorkspaceOwnership(actor.userId, actor.workspaceId, toUserId, auditRequestContext(await headers()))
    return { owner }
  })
}

/**
 * 删除工作区. `confirmName` must equal the workspace name. The caller's
 * current-workspace cookie moves to their next workspace (or is cleared);
 * other members fall back to their first remaining workspace on their next
 * request, because the cookie only ever selects among active memberships.
 */
export async function deleteWorkspace(id: string, confirmName: string): Promise<ActionResult<WorkspaceDeletion>> {
  return workspaceAction(async () => {
    const actor = await currentWorkspaceActor()
    const result = await deleteWorkspaceData(actor.userId, id, confirmName)
    const store = await cookies()
    if (result.nextWorkspaceId) {
      store.set(COOKIE, result.nextWorkspaceId, { httpOnly: true, sameSite: process.env.NODE_ENV === 'development' ? 'none' : 'lax', secure: true, path: '/', maxAge: 31536000 })
    } else store.delete(COOKIE)
    return result
  })
}

/**
 * 移除成员 from the current workspace. `memberId` is the member's user id.
 * `transferTo` (optional) hands their bots in this workspace to another member.
 */
export async function removeWorkspaceMember(memberId: string, options: { transferTo?: string } = {}): Promise<ActionResult<MemberRemoval>> {
  return workspaceAction(async () => {
    const actor = await currentWorkspaceActor()
    const { label: _label, ...removed } = await removeMember(actor.userId, actor.workspaceId, memberId, options.transferTo, auditRequestContext(await headers()))
    return removed
  })
}
