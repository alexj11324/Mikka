// Pure Organization audit contract, shared by server writes and the operator CLI.
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { looksLikeSecretValue } from '@/lib/audit/events'

export const organizationAuditActionSchema = z.enum([
  'organization.created', 'organization.renamed', 'organization.archived', 'organization.member_changed', 'organization.member_removed', 'organization.workspace_attached', 'organization.workspace_detached',
  'entitlement.changed', 'scim.user_created', 'scim.user_updated', 'scim.user_suspended', 'scim.user_deleted', 'scim.group_changed',
  'sso.configured', 'sso.domain_verified', 'sso.policy_changed', 'sso.signed_in', 'sso.sign_in_failed', 'sso.signed_out', 'sso.logout_failed',
  'organization.policy_changed', 'organization.resource_requested', 'organization.resource_decided', 'organization.audit_exported', 'organization.retention_applied', 'organization.billing_account_changed',
])
const scalar = z.union([z.string().max(200), z.number().finite(), z.boolean(), z.null()])
const metadataSchema = z.object({ providerId: scalar, memberId: scalar, workspaceId: scalar, role: scalar, status: scalar, enabled: scalar, count: scalar, revision: scalar, reason: scalar, digest: scalar, retentionDays: scalar,
  fromPlan: scalar, toPlan: scalar, source: scalar, seatLimit: scalar, expiresAt: scalar,
}).partial().strict()

export type OrganizationAuditInput = {
  organizationId: string; actorId: string; action: z.infer<typeof organizationAuditActionSchema>; targetId?: string; metadata?: Record<string, string | number | boolean | null>; eventId?: string;
  result?: 'success' | 'denied' | 'failure'; correlationId?: string; occurredAt?: Date
}
export function organizationAuditRow(input: OrganizationAuditInput) {
  const metadata = metadataSchema.parse(input.metadata ?? {})
  if (Object.values(metadata).some(value => typeof value === 'string' && looksLikeSecretValue(value))) throw new Error('governance_audit_secret')
  const id = input.eventId ? z.uuid().parse(input.eventId) : randomUUID()
  return {
    id, organizationId: z.uuid().parse(input.organizationId), actorId: z.string().min(1).max(200).parse(input.actorId),
    result: z.enum(['success', 'denied', 'failure']).parse(input.result ?? 'success'), correlationId: input.correlationId ? z.uuid().parse(input.correlationId) : id,
    action: organizationAuditActionSchema.parse(input.action), targetId: input.targetId ? z.string().max(200).parse(input.targetId) : null, metadata,
    createdAt: input.occurredAt ? z.date().parse(input.occurredAt) : new Date(),
  }
}
