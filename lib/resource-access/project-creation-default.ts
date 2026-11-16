import 'server-only'
import { and, eq, isNull } from 'drizzle-orm'
import type { ProjectTransaction } from '../project-access'
import type { ProjectVisibilityDefault } from '../project-input'
import type { TaskWorkspace } from '../task-workspace'
import { organizationMemberProjectDefaults, organizationMembers, organizations, organizationWorkspaces } from '../db/governance-schema'

/** Called under the existing workspace and member locks. Lock the organization
 * membership before consulting or replacing a possibly absent preference. */
export async function memberProjectOrganization(tx: ProjectTransaction, workspace: TaskWorkspace, userId: string, writing = false) {
  if (workspace.kind === 'personal') return null
  const [member] = await tx.select({ organizationId: organizationMembers.organizationId }).from(organizationWorkspaces)
    .innerJoin(organizations, eq(organizations.id, organizationWorkspaces.organizationId))
    .innerJoin(organizationMembers, eq(organizationMembers.organizationId, organizations.id))
    .where(and(eq(organizationWorkspaces.workspaceId, workspace.id), eq(organizationMembers.userId, userId),
      isNull(organizations.archivedAt), eq(organizationMembers.status, 'active')))
    .for(writing ? 'update' : 'share', { of: organizationMembers })
  return member?.organizationId ?? null
}

export async function resolveProjectVisibilityDefault(tx: ProjectTransaction, workspace: TaskWorkspace, userId: string,
  writing = false): Promise<ProjectVisibilityDefault> {
  const organizationId = await memberProjectOrganization(tx, workspace, userId, writing)
  if (!organizationId) return { organizationId: null, visibility: workspace.kind === 'personal' ? 'private' : 'shared' }
  const [saved] = await tx.select({ visibility: organizationMemberProjectDefaults.visibility }).from(organizationMemberProjectDefaults)
    .where(and(eq(organizationMemberProjectDefaults.organizationId, organizationId), eq(organizationMemberProjectDefaults.userId, userId)))
  return { organizationId, visibility: saved?.visibility ?? 'shared' }
}
