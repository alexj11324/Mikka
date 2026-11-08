import { CodedError } from '@mikka/protocol/coded-error'
import { TASK_SECRET_MAX_CAPABILITIES, TASK_SECRET_MAX_ASSIGNMENT_BYTES, taskSecretAccessSchema, type TaskSecretAccess } from '@mikka/protocol/task-secrets'
import { issueEgressCapability, type EgressCapabilityBinding } from './egress-capability'
import type { TaskSecretInjection } from './runtime'

/** Pure response construction. The caller holds the run authorization fence;
 * protected plaintext is never copied into a response, prompt or environment. */
export function issueTaskSecretAccess(input: {
  binding: EgressCapabilityBinding
  injection: TaskSecretInjection
  endpoint: string
  leaseExpiresAt: string | Date
}, nowMs = Date.now(), env: Record<string, string | undefined> = process.env): TaskSecretAccess | undefined {
  if (!input.injection.protectedSecrets.length && !input.injection.unavailable.length) return undefined
  const grants: TaskSecretAccess['grants'] = []
  const unavailable = new Set(input.injection.unavailable)
  const allNames = [...new Set([...unavailable, ...input.injection.protectedSecrets.map(secret => secret.name)])]
  const framing = JSON.stringify({ version: 1, endpoint: input.endpoint, grants: [], unavailable: allNames }).length
  let bytes = 0
  for (const secret of input.injection.protectedSecrets) {
    if (!secret.id || !secret.revision || secret.delivery?.mode !== 'protected' || !secret.delivery.http
      || grants.length >= TASK_SECRET_MAX_CAPABILITIES) { unavailable.add(secret.name); continue }
    try {
      const grant = issueEgressCapability({ ...input.binding, name: secret.name, secret: secret.value,
        secretId: secret.id, revision: secret.revision, http: secret.delivery.http, leaseExpiresAt: input.leaseExpiresAt }, nowMs, env)
      // Leave room for framing, names and the endpoint in the bounded assignment.
      const grantBytes = JSON.stringify(grant).length + 1
      if (bytes + grantBytes > TASK_SECRET_MAX_ASSIGNMENT_BYTES - framing) { unavailable.add(secret.name); continue }
      bytes += grantBytes
      grants.push(grant)
    } catch (error) {
      if (!(error instanceof CodedError) || error.code !== 'task_secret_unavailable') throw error
      // Unsupported key formats/policies stay protected and require owner action.
      // Never fall back to a plaintext value, even for an existing SDK.
      unavailable.add(secret.name)
    }
  }
  const parsed = taskSecretAccessSchema.safeParse({ version: 1, endpoint: input.endpoint, grants, unavailable: [...unavailable] })
  if (!parsed.success) throw new CodedError('task_secret_unavailable', { detail: 'limit_exceeded' })
  return parsed.data
}
