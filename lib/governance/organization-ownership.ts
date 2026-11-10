import 'server-only'
import { and, asc, eq, isNull, ne, sql } from 'drizzle-orm'
import { organizationMembers, organizations } from '@/lib/db/governance-schema'
import type { WorkspaceTransaction } from '@/lib/workspace-access'
import { GovernanceError } from './errors'

type OwnershipTransaction = Pick<WorkspaceTransaction, 'select' | 'execute'>

/** Uses the canonical Workspace store's existing account barrier, before any
 * Organization row lock. A deleting account cannot acquire new ownership. */
export async function assertOrganizationAccountWritable(tx: Pick<WorkspaceTransaction, 'execute'>, userId: string) {
  await tx.execute(sql`select mikka_account_assert_writable(${userId})`)
}

/** Caller holds the Organization row. A durable deletion guard means an owner
 * is leaving, even while its membership still exists during the two-store job. */
export async function assertOtherActiveOrganizationOwner(tx: OwnershipTransaction, organizationId: string, userId: string) {
  const [owner] = await tx.select({ userId: organizationMembers.userId }).from(organizationMembers)
    .where(and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.role, 'owner'),
      eq(organizationMembers.status, 'active'), ne(organizationMembers.userId, userId),
      sql`not exists (select 1 from account_deletion_guards g where g."subjectId"=${organizationMembers.userId})`)).limit(1)
  if (!owner) throw new GovernanceError('last_owner')
}

/** Called after any Workspace locks, with this user's canonical deletion guard
 * in the same transaction. The Organization lock serializes concurrent owners'
 * requests; a refused, unstarted request removes its own guards before returning. */
export async function lockAccountOrganizationOwnership(tx: OwnershipTransaction, userId: string) {
  const memberships = await tx.select({ id: organizations.id, role: organizationMembers.role }).from(organizations)
    .innerJoin(organizationMembers, eq(organizationMembers.organizationId, organizations.id))
    .where(and(eq(organizationMembers.userId, userId), isNull(organizations.archivedAt)))
    .orderBy(asc(organizations.id)).for('update', { of: organizations })
  for (const membership of memberships) if (membership.role === 'owner') {
    await assertOtherActiveOrganizationOwner(tx, membership.id, userId)
  }
}
