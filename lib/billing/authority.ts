import 'server-only'
import { AsyncLocalStorage } from 'node:async_hooks'
import { eq } from 'drizzle-orm'
import { workspaceDb } from '@/lib/workspace-db'
import { requireWorkspace, WorkspaceError } from '@/lib/workspace-access'
import { organizationBillingAccounts, organizations, organizationWorkspaces } from '@/lib/db/governance-schema'
import { requireOrganizationAdmin } from '@/lib/governance/organizations'
import type { EnterprisePrincipal } from '@/lib/enterprise/principal'

type Options = { organizationId?: string; ownPlatformAccount?: boolean; principal?: EnterprisePrincipal }
type Lease = { actorId: string; workspaceId: string; organizationId?: string; active: boolean; ownPlatformAccount: boolean }
const authority = new AsyncLocalStorage<Lease>()

/** Holds fresh Workspace → Organization authority through the provider request.
 * Nested billing services reuse this lease; no nested Workspace pool acquisition.
 * APP writes occur after these locks, and no APP transaction waits for this lease.
 */
export async function withBillingAuthority<T>(actorId: string, workspaceId: string, work: () => Promise<T>, options: Options = {}): Promise<T> {
  const current = authority.getStore()
  if (current?.active && current.actorId === actorId && current.workspaceId === workspaceId
    && (!options.organizationId || current.organizationId === options.organizationId)
    && (!options.ownPlatformAccount || current.ownPlatformAccount)) return work()
  if (current?.active) throw new WorkspaceError('billingPolicyChanged')
  return workspaceDb.transaction(async tx => {
    await requireWorkspace(tx, workspaceId, actorId, true, options.principal)
    const [link] = await tx.select().from(organizationWorkspaces).where(eq(organizationWorkspaces.workspaceId, workspaceId)).limit(1)
    if (options.organizationId && link?.organizationId !== options.organizationId) throw new WorkspaceError('billingPolicyChanged')
    if (link) {
      // Same Workspace → Organization lock order used by account designation and membership changes.
      const [org] = await tx.select().from(organizations).where(eq(organizations.id, link.organizationId)).for('update').limit(1)
      if (!org || org.archivedAt) throw new WorkspaceError('workspaceAccessDenied')
      if (options.organizationId) await requireOrganizationAdmin(tx, options.organizationId, actorId)
      const [account] = await tx.select().from(organizationBillingAccounts).where(eq(organizationBillingAccounts.organizationId, link.organizationId)).limit(1)
      if (options.organizationId && account?.workspaceId !== workspaceId) throw new WorkspaceError('billingPolicyChanged')
      if (options.ownPlatformAccount && account && account.workspaceId !== workspaceId) throw new WorkspaceError('billingPolicyChanged')
    }
    const lease: Lease = { actorId, workspaceId, organizationId: options.organizationId, ownPlatformAccount: options.ownPlatformAccount ?? false, active: true }
    try { return await authority.run(lease, work) }
    finally { lease.active = false }
  })
}
