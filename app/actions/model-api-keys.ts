'use server'

import { and, eq, inArray } from 'drizzle-orm'
import { pool } from '@/lib/db'
import { workspaceMembers } from '@/lib/db/workspace-schema'
import { requireUser } from '@/lib/issue-access'
import type { ApiKeyView } from '@/lib/model-api-key-providers'
import { addApiKey, listApiKeys, removeApiKey, setApiKeyAfterQuota, setApiKeyShare, usableApiKeys, type ApiKeysPage, type UsableApiKey } from '@/lib/model-api-keys'
import { loadWorkspaceContext } from '@/lib/workspace-access'
import { workspaceDb } from '@/lib/workspace-db'
import { settingsWorkspaceAction, type SettingsActionResult } from '@/lib/workspace-admin/settings-action'

// 设置 › API 与订阅: the signed-in person's own API keys and custom providers.
// Keys are write-only; every read carries the last four characters only.
// `workspaceId` is the workspace the settings page shows; 分享给团队成员 applies there.

async function actor(workspaceId?: string) {
  const user = await requireUser()
  const context = await loadWorkspaceContext(workspaceId || undefined, user)
  return { userId: user.id, workspace: context.workspace }
}

export async function getApiKeys(workspaceId?: string): Promise<SettingsActionResult<ApiKeysPage>> {
  return settingsWorkspaceAction(async () => {
    const { userId, workspace } = await actor(workspaceId)
    return listApiKeys(pool, userId, workspace)
  })
}

export async function createApiKey(input: unknown, workspaceId?: string): Promise<SettingsActionResult<ApiKeyView>> {
  return settingsWorkspaceAction(async () => {
    const { userId } = await actor(workspaceId)
    return addApiKey(pool, userId, input)
  })
}

export async function deleteApiKey(id: string, workspaceId?: string): Promise<SettingsActionResult<{ removed: boolean }>> {
  return settingsWorkspaceAction(async () => {
    const { userId } = await actor(workspaceId)
    return removeApiKey(pool, userId, id)
  })
}

export async function updateApiKeyShare(input: { id: string; shared: boolean }, workspaceId?: string): Promise<SettingsActionResult<ApiKeysPage>> {
  return settingsWorkspaceAction(async () => {
    const { userId, workspace } = await actor(workspaceId)
    await setApiKeyShare(pool, userId, workspace, input.id, input.shared)
    return listApiKeys(pool, userId, workspace)
  })
}

export async function updateApiKeyAfterQuota(on: boolean, workspaceId?: string): Promise<SettingsActionResult<ApiKeysPage>> {
  return settingsWorkspaceAction(async () => {
    const { userId, workspace } = await actor(workspaceId)
    await setApiKeyAfterQuota(pool, userId, on)
    return listApiKeys(pool, userId, workspace)
  })
}

/**
 * The model picker's 「API Key」 group: the keys the signed-in person's bots
 * may use in this workspace, their own first, then teammates' keys shared
 * with 分享给团队成员 (with the teammate's name). Never the key itself.
 */
export async function listUsableApiKeys(workspaceId?: string): Promise<SettingsActionResult<{ keys: (UsableApiKey & { ownerName: string | null })[] }>> {
  return settingsWorkspaceAction(async () => {
    const { userId, workspace } = await actor(workspaceId)
    const keys = await usableApiKeys(pool, userId, workspace.id)
    const owners = [...new Set(keys.filter(key => !key.mine).map(key => key.ownerId))]
    const members = owners.length ? await workspaceDb.select({ userId: workspaceMembers.userId, name: workspaceMembers.name }).from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspace.id), inArray(workspaceMembers.userId, owners), eq(workspaceMembers.status, 'active'))) : []
    const names = new Map(members.map(member => [member.userId, member.name]))
    // A teammate who is no longer an active member here does not lend a key.
    return { keys: keys.filter(key => key.mine || names.has(key.ownerId)).map(key => ({ ...key, ownerName: key.mine ? null : names.get(key.ownerId)! })) }
  })
}
