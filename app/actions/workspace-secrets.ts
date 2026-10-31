'use server'

import { headers } from 'next/headers'
import { auditRequestContext } from '@/lib/audit/events'
import { secretAuditHook } from '@/lib/secrets/audit'
import type { SettingsActionResult } from '@/lib/workspace-admin/settings-action'
import { getE2BKeyCapabilityForUser, getE2BKeyStatus, removeE2BKey, setE2BKey, type E2BKeyStatus } from '@/lib/secrets/e2b'
import { createWorkspaceSecret, deleteWorkspaceSecret, listWorkspaceSecrets, replaceWorkspaceSecret, type SavedSecretView, type SecretAuditHook, type WorkspaceSecretView } from '@/lib/secrets/store'
import { settingsWorkspaceAction } from '@/lib/workspace-admin/settings-action'
import { currentWorkspaceActor } from '@/lib/workspace-admin/current'

// 设置 › 密钥与环境. Permission tiers: lib/secrets/permissions.ts (members: repo-scoped entries; admins: everything). All values (secret and env) are write-only: responses carry name/kind/scope only.
// Writes are audited inside their transaction (lib/secrets/audit.ts). `workspaceId` is the workspace the settings page shows.

const withActor = <T>(fn: (userId: string, workspaceId: string, audit: SecretAuditHook) => Promise<T>, workspaceId?: string) => settingsWorkspaceAction(async () => {
  const actor = await currentWorkspaceActor(workspaceId)
  return fn(actor.userId, actor.workspaceId, secretAuditHook({ id: actor.userId, name: actor.name }, auditRequestContext(await headers())))
})

export async function listSecrets(workspaceId?: string): Promise<SettingsActionResult<{ secrets: WorkspaceSecretView[] }>> {
  return withActor(async (u, w) => ({ secrets: await listWorkspaceSecrets(u, w) }), workspaceId)
}
export async function createSecret(input: { name: string; kind: 'secret' | 'env'; value: string; scope?: { type: 'workspace' } | { type: 'repository'; repository: string } }, workspaceId?: string): Promise<SettingsActionResult<SavedSecretView>> {
  return withActor((u, w, audit) => createWorkspaceSecret(u, w, input, audit), workspaceId)
}
export async function replaceSecret(input: { id: string; value: string; scope?: { type: 'workspace' } | { type: 'repository'; repository: string } }, workspaceId?: string): Promise<SettingsActionResult<SavedSecretView>> {
  return withActor((u, w, audit) => replaceWorkspaceSecret(u, w, input, audit), workspaceId)
}
export async function deleteSecret(input: { id: string }, workspaceId?: string): Promise<SettingsActionResult<{ id: string }>> {
  return withActor((u, w, audit) => deleteWorkspaceSecret(u, w, input, audit), workspaceId)
}
export async function getE2BKey(workspaceId?: string): Promise<SettingsActionResult<E2BKeyStatus>> {
  return withActor((u, w) => getE2BKeyStatus(u, w), workspaceId)
}
export async function saveE2BKey(input: { apiKey: string }, workspaceId?: string): Promise<SettingsActionResult<E2BKeyStatus>> {
  return withActor(async (u, w, audit) => {
    const status = await setE2BKey(u, w, input, { audit })
    // Tasks in this workspace that waited for a machine try the cloud again.
    const [{ pool }, { wakeMachineWaits }] = await Promise.all([import('@/lib/db'), import('@/lib/machine-waits')])
    await wakeMachineWaits(pool, null, { workspaceId: w }).catch(() => undefined)
    return status
  }, workspaceId)
}
export async function deleteE2BKey(workspaceId?: string): Promise<SettingsActionResult<{ removed: boolean }>> {
  return withActor((u, w, audit) => removeE2BKey(u, w, audit), workspaceId)
}

/** Shared by settings and the first-run guide. */
export async function getE2BKeyCapability(workspaceId?: string) {
  return settingsWorkspaceAction(async () => {
    const actor = await currentWorkspaceActor(workspaceId)
    return getE2BKeyCapabilityForUser(actor.userId, actor.workspaceId)
  })
}
