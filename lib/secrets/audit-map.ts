// Maps the secrets store's audit hook events onto the 审计日志 catalogue
// (lib/audit/events.ts). Pure, so it is unit-tested without a database.
import type { AuditEvent } from '@/lib/audit/events'
import type { SecretAuditEvent } from './store'

const scope = (value: unknown) => value === 'repository' ? 'repo' as const : value === 'workspace' ? 'workspace' as const : undefined
const environment = (value: unknown) => typeof value === 'string' && value ? value : undefined
const egressMode = (value: unknown) => value === 'none' ? 'blocked' as const : value === 'allowlist' ? 'allowlist' as const : value === 'open' ? 'open' as const : undefined

/**
 * The audit event for one store event, or null when the catalogue has no such
 * action (denied replaces and skipped injections stay out of the admin log).
 * Only allowlisted metadata is carried: never a value, only names.
 */
export function secretAuditEvent(event: SecretAuditEvent, actor: { id: string; name: string }): AuditEvent | null {
  const base = { workspaceId: event.workspaceId, actor: { type: 'user' as const, id: actor.id, name: actor.name }, target: { type: event.target.type, id: event.target.id, label: event.target.label || null } }
  const meta = event.metadata ?? {}
  const compact = <T extends Record<string, unknown>>(value: T) => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined))
  switch (event.action) {
    case 'secret.created': case 'secret.replaced': case 'secret.deleted':
      return { ...base, action: event.action, metadata: compact({ scope: scope(meta.scope) }) }
    case 'env.created': case 'env.updated': case 'env.deleted':
      return { ...base, action: event.action, metadata: compact({ scope: scope(meta.scope), environment: environment(meta.environment) }) }
    case 'network.updated':
      return { ...base, action: 'network_policy.updated', metadata: compact({ mode: egressMode(meta.mode) }) }
    default:
      return null
  }
}
