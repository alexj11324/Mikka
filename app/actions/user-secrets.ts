'use server'

import { createUserSecret, deleteUserSecret, importUserSecrets, listUserSecrets, replaceUserSecret, type SavedUserSecretView, type UserImportResult, type UserSecretView } from '@/lib/secrets/user-store'
import { withFreshSession } from '@/lib/fresh-session'
import { currentWorkspaceActor } from '@/lib/workspace-admin/current'
import { settingsWorkspaceAction, type SettingsActionResult } from '@/lib/workspace-admin/settings-action'
import type { SecretDeliveryInput } from '@/lib/secrets/delivery'

// 设置 › 密钥与登录 › 我的: the signed-in person's own secrets (lib/secrets/user-store.ts). The user is
// always the session's; `workspaceId` is only the page's workspace, whose secret names a new
// personal name is checked against (membership is verified by currentWorkspaceActor).

export async function listMySecrets(workspaceId?: string): Promise<SettingsActionResult<{ secrets: UserSecretView[] }>> {
  return settingsWorkspaceAction(async () => ({ secrets: await listUserSecrets((await currentWorkspaceActor(workspaceId)).userId) }))
}
async function createMySecretBody(input: { name: string; kind: 'secret' | 'env'; value: string; note?: string; overrideWorkspace?: boolean; delivery?: SecretDeliveryInput }, workspaceId?: string): Promise<SettingsActionResult<SavedUserSecretView>> {
  return settingsWorkspaceAction(async () => { const actor = await currentWorkspaceActor(workspaceId); return createUserSecret(actor.userId, input, { workspaceId: actor.workspaceId }) })
}
async function replaceMySecretBody(input: { id: string; value?: string; note?: string; delivery?: SecretDeliveryInput }, workspaceId?: string): Promise<SettingsActionResult<SavedUserSecretView>> {
  return settingsWorkspaceAction(async () => replaceUserSecret((await currentWorkspaceActor(workspaceId)).userId, input))
}
async function deleteMySecretBody(input: { id: string }, workspaceId?: string): Promise<SettingsActionResult<{ id: string }>> {
  return settingsWorkspaceAction(async () => deleteUserSecret((await currentWorkspaceActor(workspaceId)).userId, input))
}
async function importMySecretsBody(input: { text: string; masked: boolean; onConflict: 'replace' | 'skip'; overrideWorkspace?: boolean }, workspaceId?: string): Promise<SettingsActionResult<UserImportResult>> {
  return settingsWorkspaceAction(async () => { const actor = await currentWorkspaceActor(workspaceId); return importUserSecrets(actor.userId, input, { workspaceId: actor.workspaceId }) })
}

// Credentials: the session is read from the database, not the cookie cache.
export async function createMySecret(...args: Parameters<typeof createMySecretBody>) { return withFreshSession(() => createMySecretBody(...args)) }
export async function replaceMySecret(...args: Parameters<typeof replaceMySecretBody>) { return withFreshSession(() => replaceMySecretBody(...args)) }
export async function deleteMySecret(...args: Parameters<typeof deleteMySecretBody>) { return withFreshSession(() => deleteMySecretBody(...args)) }
export async function importMySecrets(...args: Parameters<typeof importMySecretsBody>) { return withFreshSession(() => importMySecretsBody(...args)) }
