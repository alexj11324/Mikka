'use server'

import type { SettingsActionResult } from '@/lib/workspace-admin/settings-action'
import { getE2BKeyStatus, removeE2BKey, setE2BKey, type E2BKeyStatus } from '@/lib/secrets/e2b'
import { createWorkspaceSecret, deleteWorkspaceSecret, listWorkspaceSecrets, replaceWorkspaceSecret, type WorkspaceSecretView } from '@/lib/secrets/store'
import { settingsWorkspaceAction } from '@/lib/workspace-admin/settings-action'
import { currentWorkspaceActor } from '@/lib/workspace-admin/current'

// 设置 › 密钥与环境. Permission tiers: lib/secrets/permissions.ts (members: repo-scoped entries; admins: everything). All values (secret and env) are write-only: responses carry name/kind/scope only.
// TODO(audit): pass a recordAudit-backed hook (with actor name + request context) once #432 lands.

const withActor = <T>(fn: (userId: string, workspaceId: string) => Promise<T>) => settingsWorkspaceAction(async () => {
  const actor = await currentWorkspaceActor()
  return fn(actor.userId, actor.workspaceId)
})

export async function listSecrets(): Promise<SettingsActionResult<{ secrets: WorkspaceSecretView[] }>> {
  return withActor(async (u, w) => ({ secrets: await listWorkspaceSecrets(u, w) }))
}
export async function createSecret(input: { name: string; kind: 'secret' | 'env'; value: string; scope?: { type: 'workspace' } | { type: 'repository'; repository: string } }): Promise<SettingsActionResult<WorkspaceSecretView>> {
  return withActor((u, w) => createWorkspaceSecret(u, w, input))
}
export async function replaceSecret(input: { id: string; value: string; scope?: { type: 'workspace' } | { type: 'repository'; repository: string } }): Promise<SettingsActionResult<WorkspaceSecretView>> {
  return withActor((u, w) => replaceWorkspaceSecret(u, w, input))
}
export async function deleteSecret(input: { id: string }): Promise<SettingsActionResult<{ id: string }>> {
  return withActor((u, w) => deleteWorkspaceSecret(u, w, input))
}
export async function getE2BKey(): Promise<SettingsActionResult<E2BKeyStatus>> {
  return withActor((u, w) => getE2BKeyStatus(u, w))
}
export async function saveE2BKey(input: { apiKey: string }): Promise<SettingsActionResult<E2BKeyStatus>> {
  return withActor((u, w) => setE2BKey(u, w, input))
}
export async function deleteE2BKey(): Promise<SettingsActionResult<{ removed: boolean }>> {
  return withActor((u, w) => removeE2BKey(u, w))
}
