'use server'

import { cookies } from 'next/headers'
import type { ActionResult } from '@/lib/action-result'
import { workspaceAction } from '@/lib/workspace-admin/action'
import { currentWorkspaceActor } from '@/lib/workspace-admin/current'
import { deleteWorkspaceData, updateWorkspaceGeneral, type UpdateWorkspaceInput, type WorkspaceDeletion, type WorkspaceGeneral } from '@/lib/workspace-admin/general'
import { removeMember, type MemberRemoval } from '@/lib/workspace-admin/members'

const COOKIE = 'mikka-workspace'

/** 设置 › 工作区 › 常规: name, URL slug (the old one keeps redirecting) and icon. Admins only. */
export async function updateWorkspace(input: UpdateWorkspaceInput): Promise<ActionResult<WorkspaceGeneral>> {
  return workspaceAction(async () => {
    const actor = await currentWorkspaceActor()
    return updateWorkspaceGeneral(actor.userId, actor.workspaceId, input)
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
    return removeMember(actor.userId, actor.workspaceId, memberId, options.transferTo)
  })
}
