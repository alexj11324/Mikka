import 'server-only'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { looksLikeSecretValue } from '@/lib/audit/events'
import { organizationAuditEvents } from '@/lib/db/governance-schema'
import type { WorkspaceTransaction } from '@/lib/workspace-access'

export const organizationAuditActionSchema = z.enum([
  'organization.created', 'organization.member_changed', 'organization.workspace_attached', 'organization.workspace_detached',
  'entitlement.changed', 'scim.user_created', 'scim.user_updated', 'scim.user_suspended', 'scim.user_deleted', 'scim.group_changed',
  'sso.configured', 'sso.domain_verified', 'sso.policy_changed',
  'organization.policy_changed', 'organization.resource_requested', 'organization.resource_decided', 'organization.audit_exported', 'organization.retention_applied',
])
const scalar = z.union([z.string().max(200), z.number().finite(), z.boolean(), z.null()])
const metadataSchema = z.object({ providerId: scalar, memberId: scalar, workspaceId: scalar, role: scalar, status: scalar, enabled: scalar, count: scalar, revision: scalar, reason: scalar, digest: scalar, retentionDays: scalar }).partial().strict()

/** This audit is committed with the organization mutation, without any APP DB locks. */
export async function enqueueOrganizationAudit(tx: Pick<WorkspaceTransaction, 'insert'>, input: {
  organizationId: string; actorId: string; action: z.infer<typeof organizationAuditActionSchema>; targetId?: string; metadata?: Record<string, string | number | boolean | null>
}) {
  const metadata = metadataSchema.parse(input.metadata ?? {})
  if (Object.values(metadata).some(value => typeof value === 'string' && looksLikeSecretValue(value))) throw new Error('governance_audit_secret')
  await tx.insert(organizationAuditEvents).values({
    id: randomUUID(), organizationId: z.uuid().parse(input.organizationId), actorId: z.string().min(1).max(200).parse(input.actorId),
    action: organizationAuditActionSchema.parse(input.action), targetId: input.targetId ? z.string().max(200).parse(input.targetId) : null, metadata,
  })
}
