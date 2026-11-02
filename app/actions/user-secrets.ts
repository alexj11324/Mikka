'use server'

import { createUserSecret, deleteUserSecret, importUserSecrets, listUserSecrets, replaceUserSecret, type SavedUserSecretView, type UserImportResult, type UserSecretView } from '@/lib/secrets/user-store'
import { currentWorkspaceActor } from '@/lib/workspace-admin/current'
import { settingsWorkspaceAction, type SettingsActionResult } from '@/lib/workspace-admin/settings-action'

// 设置 › 密钥与登录 › 我的: the signed-in person's own secrets (lib/secrets/user-store.ts). The user is
// always the session's; `workspaceId` is only the page's workspace, whose secret names a new
// personal name is checked against (membership is verified by currentWorkspaceActor).

export async function listMySecrets(workspaceId?: string): Promise<SettingsActionResult<{ secrets: UserSecretView[] }>> {
  return settingsWorkspaceAction(async () => ({ secrets: await listUserSecrets((await currentWorkspaceActor(workspaceId)).userId) }))
}
export async function createMySecret(input: { name: string; kind: 'secret' | 'env'; value: string; note?: string; overrideWorkspace?: boolean }, workspaceId?: string): Promise<SettingsActionResult<SavedUserSecretView>> {
  return settingsWorkspaceAction(async () => { const actor = await currentWorkspaceActor(workspaceId); return createUserSecret(actor.userId, input, { workspaceId: actor.workspaceId }) })
}
export async function replaceMySecret(input: { id: string; value?: string; note?: string }, workspaceId?: string): Promise<SettingsActionResult<SavedUserSecretView>> {
  return settingsWorkspaceAction(async () => replaceUserSecret((await currentWorkspaceActor(workspaceId)).userId, input))
}
export async function deleteMySecret(input: { id: string }, workspaceId?: string): Promise<SettingsActionResult<{ id: string }>> {
  return settingsWorkspaceAction(async () => deleteUserSecret((await currentWorkspaceActor(workspaceId)).userId, input))
}
export async function importMySecrets(input: { text: string; masked: boolean; onConflict: 'replace' | 'skip'; overrideWorkspace?: boolean }, workspaceId?: string): Promise<SettingsActionResult<UserImportResult>> {
  return settingsWorkspaceAction(async () => { const actor = await currentWorkspaceActor(workspaceId); return importUserSecrets(actor.userId, input, { workspaceId: actor.workspaceId }) })
}
