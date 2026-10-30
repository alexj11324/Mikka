'use server'

import type { ActionResult } from '@/lib/action-result'
import { currentMonth, usageMonth } from '@/lib/usage/month'
import { workspaceUsage, type WorkspaceUsage } from '@/lib/usage/read'
import { workspaceAction } from '@/lib/workspace-admin/action'
import { currentWorkspaceActor } from '@/lib/workspace-admin/current'

/** 设置 › 用量 for one month (YYYY-MM, UTC). Admins see the workspace; members their own bots. */
export async function getUsage(month?: string, workspaceId?: string): Promise<ActionResult<WorkspaceUsage>> {
  return workspaceAction(async () => {
    const actor = await currentWorkspaceActor(workspaceId)
    return workspaceUsage(actor.userId, actor.workspaceId, usageMonth.parse(month ?? currentMonth()))
  })
}
