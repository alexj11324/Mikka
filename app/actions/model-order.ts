'use server'

import { pool } from '@/lib/db'
import { requireUser } from '@/lib/issue-access'
import { changeOrder, orderView, type OrderChange, type OrderView } from '@/lib/model-order'
import { loadWorkspaceContext } from '@/lib/workspace-access'
import { settingsWorkspaceAction, type SettingsActionResult } from '@/lib/workspace-admin/settings-action'

// 设置 › 模型与订阅 › 允许使用的模型 and 运行位置 (decision 2026-11-02-1400): the
// signed-in person's own list in the workspace the page shows.

async function scope(workspaceId?: string) {
  const user = await requireUser()
  const context = await loadWorkspaceContext(workspaceId || undefined, user)
  return { ownerId: user.id, workspaceId: context.workspace.id }
}

export async function getModelOrder(workspaceId?: string): Promise<SettingsActionResult<OrderView>> {
  return settingsWorkspaceAction(async () => orderView(pool, await scope(workspaceId)))
}

/** One change (add, remove, reorder, 运行位置); the page gets the list back as saved. */
export async function changeModelOrder(change: OrderChange, workspaceId?: string): Promise<SettingsActionResult<OrderView>> {
  return settingsWorkspaceAction(async () => {
    const target = await scope(workspaceId)
    await changeOrder(pool, target, change)
    return orderView(pool, target)
  })
}
