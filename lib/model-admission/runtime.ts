import 'server-only'
import { pool } from '@/lib/db'
import { ModelAdmissionStore } from './store'

export const modelAdmission = new ModelAdmissionStore(pool)

/** Scope and route come from the existing owner-bound subscription binding. */
export async function assertSubscriptionModelTransport(scope: { workspaceId: string; ownerId: string; runId?: string }, model: string, route: string,
  signal?: AbortSignal, auditAllowed = true) {
  const workspaces = new Set([scope.workspaceId])
  if (scope.runId) {
    const { readCliRunPolicy } = await import('@/lib/agent-tool-approval/policy-store')
    const current = await readCliRunPolicy(pool, scope.runId, scope.ownerId)
    for (const id of current.workspaceIds) workspaces.add(id)
  }
  for (const workspaceId of workspaces)
    await modelAdmission.subscription({ workspaceId, ownerId: scope.ownerId }, model, route, { signal, auditAllowed })
}

/** Existing native/Decision transports do not attest an exact controlled
 * provider route. A configured organization rule cannot silently bypass it.
 * This does not disable ordinary unmanaged model use. */
export async function assertUnmanagedModelTransport(scope: { workspaceId: string; ownerId?: string; workspaceIds?: string[] }, model: string,
  signal?: AbortSignal) {
  for (const workspaceId of new Set([scope.workspaceId,...scope.workspaceIds??[]]))
    await modelAdmission.gateway({ workspaceId, ownerId:scope.ownerId }, model, 'unsupported-model-transport', { signal })
}
