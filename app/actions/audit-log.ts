'use server'

import type { ActionResult } from '@/lib/action-result'
import type { AuditFilter } from '@/lib/audit/cursor'
import { listWorkspaceAudit, type AuditPage } from '@/lib/audit/query'
import { workspaceAction } from '@/lib/workspace-admin/action'
import { currentWorkspaceActor } from '@/lib/workspace-admin/current'

/** 设置 › 审计日志: one page, newest first. Admins only. */
export async function listAuditLog(input: { filter?: AuditFilter; cursor?: string | null } = {}, workspaceId?: string): Promise<ActionResult<AuditPage>> {
  return workspaceAction(async () => {
    const actor = await currentWorkspaceActor(workspaceId)
    return listWorkspaceAudit(actor.userId, actor.workspaceId, input)
  })
}
