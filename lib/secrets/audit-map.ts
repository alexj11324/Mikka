// Maps the secrets store's audit hook events onto the 审计日志 catalogue
// (lib/audit/events.ts). Pure, so it is unit-tested without a database.
import type { AuditEvent } from '@/lib/audit/events'
import type { SecretAuditEvent } from './store'
import { z } from 'zod'

const scope = (value: unknown) => value === 'repository' ? 'repo' as const
  : value === 'workspace' || value === 'project' || value === 'thread' ? value : undefined
const delivery = (value: unknown) => value === 'protected' || value === 'direct' ? value : undefined
const resourceId = (value: unknown) => { const parsed = z.uuid().safeParse(value); return parsed.success ? parsed.data : undefined }

/**
 * The audit event for one store event, or null when the catalogue has no such
 * action (denied replaces and skipped injections stay out of the admin log).
 * Only allowlisted metadata is carried: no values; private resources use opaque ids.
 */
export function secretAuditEvent(event: SecretAuditEvent, actor: { id: string; name: string }): AuditEvent | null {
  const base = { workspaceId: event.workspaceId, actor: { type: 'user' as const, id: actor.id, name: actor.name }, target: { type: event.target.type, id: event.target.id, label: event.target.label || null } }
  const meta = event.metadata ?? {}
  const compact = <T extends Record<string, unknown>>(value: T) => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined))
  const custody = { scope: scope(meta.scope), resourceId: resourceId(meta.resourceId), previousScope: scope(meta.previousScope), previousResourceId: resourceId(meta.previousResourceId) }
  switch (event.action) {
    case 'secret.created': case 'secret.replaced':
      return { ...base, action: event.action, metadata: compact({ ...custody, delivery: delivery(meta.delivery), previousDelivery: delivery(meta.previousDelivery) }) }
    case 'secret.deleted':
    case 'env.created': case 'env.updated': case 'env.deleted':
      return { ...base, action: event.action, metadata: compact(custody) }
    default:
      return null
  }
}
