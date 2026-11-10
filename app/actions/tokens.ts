'use server'

import { withFreshSession } from '@/lib/fresh-session'
import { headers } from 'next/headers'
import type { SettingsActionResult } from '@/lib/workspace-admin/settings-action'
import { auditRequestContext } from '@/lib/audit/events'
import { settingsWorkspaceAction } from '@/lib/workspace-admin/settings-action'
import { currentWorkspaceActor } from '@/lib/workspace-admin/current'
import { createPersonalAccessToken, listPersonalAccessTokens, revokePersonalAccessToken, type CreatedPersonalAccessToken, type PersonalAccessTokenView } from '@/lib/tokens/store'
import { DEFAULT_API_SCOPES, type ApiScope } from '@/lib/tokens/format'

/** 设置 › 个人访问令牌: creates a token. `token` in the result is the plaintext, returned this once only.
 * The settings page creates `/api/v1` tokens, so scopes default to the full public set. */
async function createAccessTokenBody(input: { name: string; expiresAt?: string | null; scopes?: ApiScope[] }, workspaceId?: string): Promise<SettingsActionResult<CreatedPersonalAccessToken>> {
  return settingsWorkspaceAction(async () => {
    const actor = await currentWorkspaceActor(workspaceId)
    return createPersonalAccessToken(actor.userId, actor.workspaceId, { ...input, scopes: input.scopes ?? DEFAULT_API_SCOPES }, new Date(), { actorName: actor.name, ...auditRequestContext(await headers()) })
  })
}

/** The signed-in person's unrevoked tokens in the current workspace. */
export async function listAccessTokens(workspaceId?: string): Promise<SettingsActionResult<PersonalAccessTokenView[]>> {
  return settingsWorkspaceAction(async () => {
    const actor = await currentWorkspaceActor(workspaceId)
    return listPersonalAccessTokens(actor.userId, actor.workspaceId)
  })
}

async function revokeAccessTokenBody(input: { id: string }, workspaceId?: string): Promise<SettingsActionResult<{ id: string }>> {
  return settingsWorkspaceAction(async () => {
    const actor = await currentWorkspaceActor(workspaceId)
    return revokePersonalAccessToken(actor.userId, actor.workspaceId, input, new Date(), { actorName: actor.name, ...auditRequestContext(await headers()) })
  })
}

// Money, permissions, credentials and deletion: the session is read from the database, not the cookie cache.
export async function createAccessToken(...args: Parameters<typeof createAccessTokenBody>) { return withFreshSession(() => createAccessTokenBody(...args)) }
export async function revokeAccessToken(...args: Parameters<typeof revokeAccessTokenBody>) { return withFreshSession(() => revokeAccessTokenBody(...args)) }
