import 'server-only'
import { and, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import { userPreferences } from '@/lib/db/schema'
import { organizationMembers, organizationResourcePolicies, organizationWorkspaces } from '@/lib/db/governance-schema'
import { workspaceDb } from '@/lib/workspace-db'
import { ActionFailureError } from '@/lib/action-error'
import { requireOrganizationAdmin } from '@/lib/governance/organizations'
import { enqueueOrganizationAudit } from '@/lib/governance/audit'
import type { IssueReader } from '@/lib/issue-visibility'
import { requireTaskWorkspace, taskReaderScope, withTaskWorkspace } from '@/lib/task-workspace'

/** Defaults choose the initial ACL. They never modify a resource already made,
 * relax a private ancestor, or grant access to a credential or machine. */
export async function resourceCreationDefaults(reader: IssueReader, workspaceId: string) {
  const workspace = await requireTaskWorkspace(reader, workspaceId)
  const { userId } = taskReaderScope(reader)
  const [[personal], [organization]] = await Promise.all([
    db.select({ privateByDefault: userPreferences.privateByDefault }).from(userPreferences).where(eq(userPreferences.userId, userId)).limit(1),
    workspaceDb.select({ id: organizationWorkspaces.organizationId, privateByDefault: organizationResourcePolicies.privateByDefault,
      revision: organizationResourcePolicies.revision, role: organizationMembers.role }).from(organizationWorkspaces)
      .leftJoin(organizationResourcePolicies, eq(organizationResourcePolicies.organizationId, organizationWorkspaces.organizationId))
      .leftJoin(organizationMembers, and(eq(organizationMembers.organizationId, organizationWorkspaces.organizationId),
        eq(organizationMembers.userId, userId), eq(organizationMembers.status, 'active')))
      .where(eq(organizationWorkspaces.workspaceId, workspaceId)).limit(1),
  ])
  const privateByDefault = personal?.privateByDefault === true || organization?.privateByDefault === true || workspace.kind === 'personal'
  return {
    workspaceId, kind: workspace.kind, visibility: privateByDefault ? 'private' as const : 'shared' as const,
    personalPrivateByDefault: personal?.privateByDefault ?? false,
    organization: workspace.kind === 'team' && organization ? { id: organization.id, privateByDefault: organization.privateByDefault ?? false,
      revision: organization.revision ?? 0, canManage: organization.role === 'owner' || organization.role === 'admin' } : null,
  }
}

export type ResourceCreationDefaults = Awaited<ReturnType<typeof resourceCreationDefaults>>

export async function newResourceVisibility(reader: IssueReader, workspaceId: string, explicit?: 'shared' | 'private') {
  const defaults = await resourceCreationDefaults(reader, workspaceId)
  return defaults.kind === 'personal' ? 'private' as const : explicit ?? defaults.visibility
}

export const organizationCreationDefaultsInput = z.object({ privateByDefault: z.boolean(), expectedRevision: z.number().int().nonnegative() }).strict()

/** Workspace admin alone is insufficient; Organization ownership is checked
 * under the existing Workspace -> Organization lock order and SSO boundary. */
export async function setOrganizationCreationDefaults(reader: IssueReader, workspaceId: string, input: unknown) {
  const value = organizationCreationDefaultsInput.parse(input)
  const actorId = taskReaderScope(reader).userId
  await withTaskWorkspace(reader, workspaceId, async (workspace, tx) => {
    if (workspace.kind !== 'team') throw new ActionFailureError('workspaceAccessDenied')
    const [link] = await tx.select().from(organizationWorkspaces).where(eq(organizationWorkspaces.workspaceId, workspaceId)).limit(1)
    if (!link) throw new ActionFailureError('workspaceAccessDenied')
    await requireOrganizationAdmin(tx, link.organizationId, actorId)
    const [previous] = await tx.select().from(organizationResourcePolicies).where(eq(organizationResourcePolicies.organizationId, link.organizationId)).limit(1)
    if ((previous?.revision ?? 0) !== value.expectedRevision) throw new ActionFailureError('issueOutdated')
    const revision = value.expectedRevision + 1
    await tx.insert(organizationResourcePolicies).values({ organizationId: link.organizationId, privateByDefault: value.privateByDefault, revision })
      .onConflictDoUpdate({ target: organizationResourcePolicies.organizationId, set: { privateByDefault: value.privateByDefault, revision, updatedAt: new Date() } })
    await enqueueOrganizationAudit(tx, { organizationId: link.organizationId, actorId, action: 'organization.policy_changed',
      metadata: { revision, reason: 'resource_creation_default', enabled: value.privateByDefault } })
  })
  return resourceCreationDefaults(reader, workspaceId)
}

/** A transaction-local, tenant-bound choice consumed by the INSERT trigger.
 * Continuations inherit their source policy instead of adopting new defaults. */
export async function prepareNewThreadVisibility(executor: { query: (query: string, values?: unknown[]) => Promise<unknown> }, reader: IssueReader, workspaceId: string) {
  const visibility = await newResourceVisibility(reader, workspaceId)
  await executor.query("SELECT set_config('mikka.acl_new_thread', $1, true)", [JSON.stringify({ ownerId: taskReaderScope(reader).userId, workspaceId, visibility })])
  return visibility
}

/** Narrow before the creation transaction becomes visible. */
export async function applyNewTaskVisibility(executor: { execute: typeof db.execute }, userId: string, taskId: string, visibility: 'private' | 'shared') {
  await executor.execute(sql`select set_config('mikka.acl_actor',${userId},true),set_config('mikka.acl_source','task_created',true)`)
  await executor.execute(sql`update resource_access_policies set visibility=${visibility} where kind='task' and id=${taskId}::uuid and "ownerId"=${userId}`)
}
