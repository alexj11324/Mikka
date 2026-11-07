import 'server-only'
import { organizationAuditEvents } from '@/lib/db/governance-schema'
import type { WorkspaceTransaction } from '@/lib/workspace-access'
import { organizationAuditRow, type OrganizationAuditInput } from './audit-events'
export { organizationAuditActionSchema, organizationAuditRow, type OrganizationAuditInput } from './audit-events'

/** This audit is committed with the organization mutation, without any APP DB locks. */
export async function enqueueOrganizationAudit(tx: Pick<WorkspaceTransaction, 'insert'>, input: OrganizationAuditInput) {
  const inserted = await tx.insert(organizationAuditEvents).values(organizationAuditRow(input)).onConflictDoNothing({ target: organizationAuditEvents.id }).returning({ id: organizationAuditEvents.id })
  return inserted.length > 0
}
