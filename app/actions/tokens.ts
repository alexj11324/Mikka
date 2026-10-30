'use server'

import { headers } from 'next/headers'
import type { ActionResult } from '@/lib/action-result'
import { auditRequestContext } from '@/lib/audit/events'
import { workspaceAction } from '@/lib/workspace-admin/action'
import { currentWorkspaceActor } from '@/lib/workspace-admin/current'
import { createPersonalAccessToken, listPersonalAccessTokens, revokePersonalAccessToken, type CreatedPersonalAccessToken, type PersonalAccessTokenView } from '@/lib/tokens/store'

/** 设置 › 个人访问令牌: creates a token. `token` in the result is the plaintext, returned this once only. */
export async function createAccessToken(input: { name: string; expiresAt?: string | null }, workspaceId?: string): Promise<ActionResult<CreatedPersonalAccessToken>> {
  return workspaceAction(async () => {
    const actor = await currentWorkspaceActor(workspaceId)
    return createPersonalAccessToken(actor.userId, actor.workspaceId, input, new Date(), { actorName: actor.name, ...auditRequestContext(await headers()) })
  })
}

/** The signed-in person's unrevoked tokens in the current workspace. */
export async function listAccessTokens(workspaceId?: string): Promise<ActionResult<PersonalAccessTokenView[]>> {
  return workspaceAction(async () => {
    const actor = await currentWorkspaceActor(workspaceId)
    return listPersonalAccessTokens(actor.userId, actor.workspaceId)
  })
}

export async function revokeAccessToken(input: { id: string }, workspaceId?: string): Promise<ActionResult<{ id: string }>> {
  return workspaceAction(async () => {
    const actor = await currentWorkspaceActor(workspaceId)
    return revokePersonalAccessToken(actor.userId, actor.workspaceId, input, new Date(), { actorName: actor.name, ...auditRequestContext(await headers()) })
  })
}
