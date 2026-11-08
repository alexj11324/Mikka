'use server'

import { pool } from '@/lib/db'
import { requireUser } from '@/lib/issue-access'
import { loadWorkspaceContext } from '@/lib/workspace-access'
import { ownerSettingsChanged } from '@/lib/live/lists'
import { settingsWorkspaceAction } from '@/lib/workspace-admin/settings-action'
import { changeEnabledModels, readEnabledModels, type ModelSettingsChange } from '@/lib/enabled-models'

async function scope(workspaceId: string) {
  const user = await requireUser()
  const context = await loadWorkspaceContext(workspaceId, user)
  return { ownerId: user.id, workspaceId: context.workspace.id }
}
export async function getEnabledModels(workspaceId: string) {
  return settingsWorkspaceAction(async () => readEnabledModels(pool, await scope(workspaceId)))
}
async function change(workspaceId: string, sourceId: string, input: ModelSettingsChange) {
  return settingsWorkspaceAction(async () => {
    const target = await scope(workspaceId)
    const result = await changeEnabledModels(pool, target, sourceId, input)
    await ownerSettingsChanged(pool, target.ownerId)
    return result
  })
}
export async function setModelEnabled(workspaceId: string, sourceId: string, modelId: string, enabled: boolean) {
  return change(workspaceId, sourceId, { kind: 'model', modelId, enabled })
}
export async function setAllModelsEnabled(workspaceId: string, sourceId: string, enabled: boolean) {
  return change(workspaceId, sourceId, { kind: 'all', enabled })
}
export async function setAutoEnable(workspaceId: string, sourceId: string, enabled: boolean) {
  return change(workspaceId, sourceId, { kind: 'auto', enabled })
}
export async function markModelsSeen(workspaceId: string, sourceId: string) {
  return change(workspaceId, sourceId, { kind: 'seen' })
}
