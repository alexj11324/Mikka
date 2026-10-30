'use server'

import { cookies, headers } from 'next/headers'
import type { ActionResult } from '@/lib/action-result'
import { auditRequestContext, recordAuditSafe } from '@/lib/audit/record'
import { workspaceAction } from '@/lib/workspace-admin/action'
import { currentWorkspaceActor } from '@/lib/workspace-admin/current'
import { deleteWorkspaceData, readWorkspaceGeneral, updateWorkspaceGeneral, workspaceDeletionImpact, type UpdateWorkspaceInput, type WorkspaceDeletion, type WorkspaceDeletionImpact, type WorkspaceGeneral } from '@/lib/workspace-admin/general'
import { removeMember, type MemberRemoval } from '@/lib/workspace-admin/members'

const COOKIE = 'mikka-workspace'

/** 常规 as the viewer sees it: values for everyone, `canEdit` for admins. */
export async function getWorkspaceGeneral(workspaceId?: string): Promise<ActionResult<WorkspaceGeneral & { canEdit: boolean }>> {
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
    const before = input.slug === undefined ? null : await readWorkspaceGeneral(actor.userId, actor.workspaceId)
    const saved = await updateWorkspaceGeneral(actor.userId, actor.workspaceId, input)
    // Workspace rows live in DATABASE_URL, so the audit row is written after the change commits.
    if (before?.slug && saved.slug && before.slug !== saved.slug) {
      await recordAuditSafe({ workspaceId: actor.workspaceId, actor: { type: 'user', id: actor.userId, name: actor.name }, action: 'workspace.slug_changed', target: { type: 'workspace', id: actor.workspaceId, label: saved.name }, metadata: { from: before.slug, to: saved.slug }, ...auditRequestContext(await headers()) })
    }
    return saved
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
    const { label, ...removed } = await removeMember(actor.userId, actor.workspaceId, memberId, options.transferTo)
    await recordAuditSafe({ workspaceId: actor.workspaceId, actor: { type: 'user', id: actor.userId, name: actor.name }, action: 'member.removed', target: { type: 'member', id: memberId, label: label ?? memberId }, ...auditRequestContext(await headers()) })
    return removed
  })
}
