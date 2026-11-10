'use server'

import { withFreshSession } from '@/lib/fresh-session'
import { headers } from 'next/headers'
import { auditRequestContext } from '@/lib/audit/events'
import { secretAuditHook } from '@/lib/secrets/audit'
import type { SettingsActionResult } from '@/lib/workspace-admin/settings-action'
import { getE2BKeyCapabilityForUser, getE2BKeyStatus, removeE2BKey, setE2BKey, type E2BKeyStatus } from '@/lib/secrets/e2b'
import { createWorkspaceSecret, deleteWorkspaceSecret, importWorkspaceSecrets, listWorkspaceSecrets, replaceWorkspaceSecret, workspaceRole, type ImportResult, type SavedSecretView, type SecretAuditHook, type WorkspaceSecretView } from '@/lib/secrets/store'
import type { WorkspaceRole } from '@/lib/secrets/permissions'
import { settingsWorkspaceAction } from '@/lib/workspace-admin/settings-action'
import { currentWorkspaceActor } from '@/lib/workspace-admin/current'
import type { SecretDeliveryInput } from '@/lib/secrets/delivery'

// 设置 › 密钥与环境. Permission tiers: lib/secrets/permissions.ts (members: repo-scoped entries; admins: everything). All values (secret and env) are write-only: responses carry name/kind/scope only.
// Writes are audited inside their transaction (lib/secrets/audit.ts). `workspaceId` is the workspace the settings page shows.

const withActor = <T>(fn: (userId: string, workspaceId: string, audit: SecretAuditHook) => Promise<T>, workspaceId?: string) => settingsWorkspaceAction(async () => {
  const actor = await currentWorkspaceActor(workspaceId)
  return fn(actor.userId, actor.workspaceId, secretAuditHook({ id: actor.userId, name: actor.name }, auditRequestContext(await headers())))
})

/** `role` lets the page offer only what the reader may do (members: repository entries, no delete). */
export async function listSecrets(workspaceId?: string): Promise<SettingsActionResult<{ secrets: WorkspaceSecretView[]; role: WorkspaceRole }>> {
  return withActor(async (u, w) => { const [secrets, role] = await Promise.all([listWorkspaceSecrets(u, w), workspaceRole(u, w)]); return { secrets, role } }, workspaceId)
}
type ScopeInput = import('@/lib/secrets/format').SecretScope
async function createSecretBody(input: { name: string; kind: 'secret' | 'env'; value: string; note?: string; scope?: ScopeInput; delivery?: SecretDeliveryInput }, workspaceId?: string): Promise<SettingsActionResult<SavedSecretView>> {
  return withActor((u, w, audit) => createWorkspaceSecret(u, w, input, audit), workspaceId)
}
async function replaceSecretBody(input: { id: string; value?: string; note?: string; scope?: ScopeInput; delivery?: SecretDeliveryInput }, workspaceId?: string): Promise<SettingsActionResult<SavedSecretView>> {
  return withActor((u, w, audit) => replaceWorkspaceSecret(u, w, input, audit), workspaceId)
}
/** Bulk add from a .env text (≤ 2 MB), one kind and scope for all of it. Returns names and line errors, never values. */
async function importSecretsBody(input: { text: string; masked: boolean; scope: ScopeInput; onConflict: 'replace' | 'skip' }, workspaceId?: string): Promise<SettingsActionResult<ImportResult>> {
  return withActor((u, w, audit) => importWorkspaceSecrets(u, w, input, audit), workspaceId)
}
async function deleteSecretBody(input: { id: string }, workspaceId?: string): Promise<SettingsActionResult<{ id: string }>> {
  return withActor((u, w, audit) => deleteWorkspaceSecret(u, w, input, audit), workspaceId)
}
export async function getE2BKey(workspaceId?: string): Promise<SettingsActionResult<E2BKeyStatus>> {
  return withActor((u, w) => getE2BKeyStatus(u, w), workspaceId)
}
async function saveE2BKeyBody(input: { apiKey: string }, workspaceId?: string): Promise<SettingsActionResult<E2BKeyStatus>> {
  return withActor((u, w, audit) => setE2BKey(u, w, input, { audit }), workspaceId)
}
async function deleteE2BKeyBody(workspaceId?: string): Promise<SettingsActionResult<{ removed: boolean }>> {
  return withActor((u, w, audit) => removeE2BKey(u, w, audit), workspaceId)
}

/** Shared by settings and the first-run guide. */
export async function getE2BKeyCapability(workspaceId?: string) {
  return settingsWorkspaceAction(async () => {
    const actor = await currentWorkspaceActor(workspaceId)
    return getE2BKeyCapabilityForUser(actor.userId, actor.workspaceId)
  })
}

// Money, permissions, credentials and deletion: the session is read from the database, not the cookie cache.
export async function createSecret(...args: Parameters<typeof createSecretBody>) { return withFreshSession(() => createSecretBody(...args)) }
export async function replaceSecret(...args: Parameters<typeof replaceSecretBody>) { return withFreshSession(() => replaceSecretBody(...args)) }
export async function importSecrets(...args: Parameters<typeof importSecretsBody>) { return withFreshSession(() => importSecretsBody(...args)) }
export async function deleteSecret(...args: Parameters<typeof deleteSecretBody>) { return withFreshSession(() => deleteSecretBody(...args)) }
export async function saveE2BKey(...args: Parameters<typeof saveE2BKeyBody>) { return withFreshSession(() => saveE2BKeyBody(...args)) }
export async function deleteE2BKey(...args: Parameters<typeof deleteE2BKeyBody>) { return withFreshSession(() => deleteE2BKeyBody(...args)) }
