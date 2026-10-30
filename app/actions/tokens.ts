'use server'

import { headers } from 'next/headers'
import type { SettingsActionResult } from '@/lib/workspace-admin/settings-action'
import { auditRequestContext } from '@/lib/audit/events'
import { settingsWorkspaceAction } from '@/lib/workspace-admin/settings-action'
import { currentWorkspaceActor } from '@/lib/workspace-admin/current'
import { createPersonalAccessToken, listPersonalAccessTokens, revokePersonalAccessToken, type CreatedPersonalAccessToken, type PersonalAccessTokenView } from '@/lib/tokens/store'

/** 设置 › 个人访问令牌: creates a token. `token` in the result is the plaintext, returned this once only. */
export async function createAccessToken(input: { name: string; expiresAt?: string | null }, workspaceId?: string): Promise<SettingsActionResult<CreatedPersonalAccessToken>> {
  return settingsWorkspaceAction(async () => {
    const actor = await currentWorkspaceActor(workspaceId)
    return createPersonalAccessToken(actor.userId, actor.workspaceId, input, new Date(), { actorName: actor.name, ...auditRequestContext(await headers()) })
  })
}

/** The signed-in person's unrevoked tokens in the current workspace. */
export async function listAccessTokens(workspaceId?: string): Promise<SettingsActionResult<PersonalAccessTokenView[]>> {
  return settingsWorkspaceAction(async () => {
    const actor = await currentWorkspaceActor(workspaceId)
    return listPersonalAccessTokens(actor.userId, actor.workspaceId)
  })
}

export async function revokeAccessToken(input: { id: string }, workspaceId?: string): Promise<SettingsActionResult<{ id: string }>> {
  return settingsWorkspaceAction(async () => {
    const actor = await currentWorkspaceActor(workspaceId)
    return revokePersonalAccessToken(actor.userId, actor.workspaceId, input, new Date(), { actorName: actor.name, ...auditRequestContext(await headers()) })
  })
}
