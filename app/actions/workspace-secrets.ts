'use server'

import { ActionFailureError } from '@/lib/action-error'
import type { ActionResult } from '@/lib/action-result'
import { getE2BKeyStatus, removeE2BKey, setE2BKey, type E2BKeyStatus } from '@/lib/secrets/e2b'
import { createWorkspaceSecret, deleteWorkspaceSecret, EgressDomainError, getNetworkPolicy, listWorkspaceSecrets, replaceWorkspaceSecret, updateNetworkPolicy, type NetworkPolicyView, type WorkspaceSecretView } from '@/lib/secrets/store'
import { workspaceAction } from '@/lib/workspace-admin/action'
import { currentWorkspaceActor } from '@/lib/workspace-admin/current'

// 设置 › 密钥与环境. All admin only. Secret values are write-only; env values are readable.
// TODO(audit): pass a recordAudit-backed hook (with actor name + request context) once #432 lands.

const withActor = <T>(fn: (userId: string, workspaceId: string) => Promise<T>) => workspaceAction(async () => {
  const actor = await currentWorkspaceActor()
  return fn(actor.userId, actor.workspaceId)
})

export async function listSecrets(): Promise<ActionResult<{ secrets: WorkspaceSecretView[] }>> {
  return withActor(async (u, w) => ({ secrets: await listWorkspaceSecrets(u, w) }))
}
export async function createSecret(input: { name: string; kind: 'secret' | 'env'; value: string; scope?: { type: 'workspace' } | { type: 'repository'; repository: string } }): Promise<ActionResult<WorkspaceSecretView>> {
  return withActor((u, w) => createWorkspaceSecret(u, w, input))
}
export async function replaceSecret(input: { id: string; value: string }): Promise<ActionResult<WorkspaceSecretView>> {
  return withActor((u, w) => replaceWorkspaceSecret(u, w, input))
}
export async function deleteSecret(input: { id: string }): Promise<ActionResult<{ id: string }>> {
  return withActor((u, w) => deleteWorkspaceSecret(u, w, input))
}
export async function getEgressPolicy(): Promise<ActionResult<NetworkPolicyView>> {
  return withActor((u, w) => getNetworkPolicy(u, w))
}
/** Invalid lines come back as { error: 'egressDomainInvalid', params: { lines: '0,3' } } (0-based). */
export async function updateEgressPolicy(input: { mode: 'open' | 'allowlist' | 'none'; allowedDomains: string[] }): Promise<ActionResult<NetworkPolicyView>> {
  return withActor(async (u, w) => {
    try { return await updateNetworkPolicy(u, w, input) } catch (error) {
      if (error instanceof EgressDomainError) throw new ActionFailureError('egressDomainInvalid', { lines: error.lines.join(',') })
      throw error
    }
  })
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
