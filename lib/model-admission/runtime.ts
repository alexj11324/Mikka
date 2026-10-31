import 'server-only'
import { pool } from '@/lib/db'
import { ModelAdmissionStore } from './store'

export const modelAdmission = new ModelAdmissionStore(pool)

/** Existing native/Decision transports do not attest an exact controlled
 * provider route. A configured organization rule cannot silently bypass it.
 * This does not disable ordinary unmanaged model use. */
export async function assertUnmanagedModelTransport(scope: { workspaceId: string; ownerId?: string }, model: string,
  signal?: AbortSignal) {
  await modelAdmission.gateway(scope, model, 'unsupported-model-transport', { signal })
}
