'use server'

import { headers } from 'next/headers'
import { auditRequestContext } from '@/lib/audit/events'
import { secretAuditHook } from '@/lib/secrets/audit'
import type { ActionResult } from '@/lib/action-result'
import { getE2BKeyStatus, removeE2BKey, setE2BKey, type E2BKeyStatus } from '@/lib/secrets/e2b'
import { createWorkspaceSecret, deleteWorkspaceSecret, listWorkspaceSecrets, replaceWorkspaceSecret, type SavedSecretView, type SecretAuditHook, type WorkspaceSecretView } from '@/lib/secrets/store'
import { workspaceAction } from '@/lib/workspace-admin/action'
import { currentWorkspaceActor } from '@/lib/workspace-admin/current'

// 设置 › 密钥与环境. Permission tiers: lib/secrets/permissions.ts (members: repo-scoped entries; admins: everything). All values (secret and env) are write-only: responses carry name/kind/scope only.
// Writes are audited inside their transaction (lib/secrets/audit.ts). `workspaceId` is the workspace the settings page shows.

const withActor = <T>(fn: (userId: string, workspaceId: string, audit: SecretAuditHook) => Promise<T>, workspaceId?: string) => workspaceAction(async () => {
  const actor = await currentWorkspaceActor(workspaceId)
  return fn(actor.userId, actor.workspaceId, secretAuditHook({ id: actor.userId, name: actor.name }, auditRequestContext(await headers())))
})

export async function listSecrets(workspaceId?: string): Promise<ActionResult<{ secrets: WorkspaceSecretView[] }>> {
  return withActor(async (u, w) => ({ secrets: await listWorkspaceSecrets(u, w) }), workspaceId)
}
export async function createSecret(input: { name: string; kind: 'secret' | 'env'; value: string; scope?: { type: 'workspace' } | { type: 'repository'; repository: string } }, workspaceId?: string): Promise<ActionResult<SavedSecretView>> {
  return withActor((u, w, audit) => createWorkspaceSecret(u, w, input, audit), workspaceId)
}
export async function replaceSecret(input: { id: string; value: string; scope?: { type: 'workspace' } | { type: 'repository'; repository: string } }, workspaceId?: string): Promise<ActionResult<SavedSecretView>> {
  return withActor((u, w, audit) => replaceWorkspaceSecret(u, w, input, audit), workspaceId)
}
export async function deleteSecret(input: { id: string }, workspaceId?: string): Promise<ActionResult<{ id: string }>> {
  return withActor((u, w, audit) => deleteWorkspaceSecret(u, w, input, audit), workspaceId)
}
export async function getE2BKey(): Promise<ActionResult<E2BKeyStatus>> {
  return withActor((u, w) => getE2BKeyStatus(u, w))
}
export async function saveE2BKey(input: { apiKey: string }): Promise<ActionResult<E2BKeyStatus>> {
  return withActor((u, w) => setE2BKey(u, w, input))
}
export async function deleteE2BKey(): Promise<ActionResult<{ removed: boolean }>> {
  return withActor((u, w) => removeE2BKey(u, w))
}
