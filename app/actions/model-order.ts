'use server'

import { pool } from '@/lib/db'
import { ExecutionSettings } from '@/lib/execution-settings'
import { requireUser } from '@/lib/issue-access'
import { changeOrder, checkOrderQuota, orderView, type OrderChange, type OrderView } from '@/lib/model-order'
import { loadWorkspaceContext } from '@/lib/workspace-access'
import { ownerSettingsChanged } from '@/lib/live/lists'
import { settingsWorkspaceAction, type SettingsActionResult } from '@/lib/workspace-admin/settings-action'

// 设置 › 模型与订阅 › 优先使用的模型 and 运行位置 (decision 2026-11-02-1400): the
// signed-in person's own list in the workspace the page shows.

async function scope(workspaceId?: string) {
  const user = await requireUser()
  const context = await loadWorkspaceContext(workspaceId || undefined, user)
  return { ownerId: user.id, workspaceId: context.workspace.id }
}

export async function getModelOrder(workspaceId?: string): Promise<SettingsActionResult<OrderView>> {
  return settingsWorkspaceAction(async () => {
    const target = await scope(workspaceId)
    // A subscription never asked for its models has no candidates yet: ask it before reading the list.
    await new ExecutionSettings(pool).ensureCatalogues(target)
    return orderView(pool, target)
  })
}

/** Checks a currently allowed subscription; its owner is derived server-side. */
export async function checkModelOrderQuota(connectionId: string, workspaceId?: string): Promise<SettingsActionResult<OrderView>> {
  return settingsWorkspaceAction(async () => {
    const target = await scope(workspaceId)
    const view = await checkOrderQuota(pool, target, connectionId)
    // Other open pages (another tab, a teammate's shared list) show the new allowance too.
    await ownerSettingsChanged(pool, target.ownerId)
    return view
  })
}

/**
 * 刷新模型: asks one of the person's own connected subscriptions for its models again. A model it no longer reports
 * stays in 优先使用的模型, marked unavailable (modelGone); the page gets the list back and how many models it reported.
 */
export async function refreshSubscriptionModels(connectionId: string, workspaceId?: string): Promise<SettingsActionResult<{ view: OrderView; models: number }>> {
  return settingsWorkspaceAction(async () => {
    const target = await scope(workspaceId)
    const models = await new ExecutionSettings(pool).refreshBotModels(target, connectionId)
    await ownerSettingsChanged(pool, target.ownerId)
    return { view: await orderView(pool, target), models: new Set(models.map(model => model.modelId)).size }
  })
}

/** One change (add, remove, reorder, 运行位置); the page gets the list back as saved. */
export async function changeModelOrder(change: OrderChange, workspaceId?: string): Promise<SettingsActionResult<OrderView>> {
  return settingsWorkspaceAction(async () => {
    const target = await scope(workspaceId)
    await changeOrder(pool, target, change)
    await ownerSettingsChanged(pool, target.ownerId)
    return orderView(pool, target)
  })
}
