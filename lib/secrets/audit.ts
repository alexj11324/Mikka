import 'server-only'
import { recordAudit } from '@/lib/audit/record'
import { secretAuditEvent } from './audit-map'
import type { SecretAuditHook } from './store'

/** recordAudit inside the secrets write transaction: an audit failure rolls the write back. */
export function secretAuditHook(actor: { id: string; name: string }, request: { ip?: string | null; geoCity?: string | null; geoCountry?: string | null; geoRegion?: string | null } = {}): SecretAuditHook {
  return async (tx, event) => {
    const mapped = secretAuditEvent(event, actor)
    if (mapped) await recordAudit(tx, { ...mapped, ...request })
  }
}
