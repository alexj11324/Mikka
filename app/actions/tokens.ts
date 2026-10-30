'use server'

import type { ActionResult } from '@/lib/action-result'
import { workspaceAction } from '@/lib/workspace-admin/action'
import { currentWorkspaceActor } from '@/lib/workspace-admin/current'
import { createPersonalAccessToken, listPersonalAccessTokens, revokePersonalAccessToken, type CreatedPersonalAccessToken, type PersonalAccessTokenView } from '@/lib/tokens/store'

/** 设置 › 个人访问令牌: creates a token. `token` in the result is the plaintext, returned this once only. */
export async function createAccessToken(input: { name: string; expiresAt?: string | null }): Promise<ActionResult<CreatedPersonalAccessToken>> {
  return workspaceAction(async () => {
    const actor = await currentWorkspaceActor()
    return createPersonalAccessToken(actor.userId, actor.workspaceId, input)
  })
}

/** The signed-in person's unrevoked tokens in the current workspace. */
export async function listAccessTokens(): Promise<ActionResult<PersonalAccessTokenView[]>> {
  return workspaceAction(async () => {
    const actor = await currentWorkspaceActor()
    return listPersonalAccessTokens(actor.userId, actor.workspaceId)
  })
}

export async function revokeAccessToken(input: { id: string }): Promise<ActionResult<{ id: string }>> {
  return workspaceAction(async () => {
    const actor = await currentWorkspaceActor()
    return revokePersonalAccessToken(actor.userId, actor.workspaceId, input)
  })
}
