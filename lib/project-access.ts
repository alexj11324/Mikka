import 'server-only'
import { cache } from 'react'
import { and, eq, isNull, or } from 'drizzle-orm'
import { projectDb, projects } from '@/lib/db/projects'
import { teamProjects } from '@/lib/db/team-schema'
import { workspaceMembers } from '@/lib/db/workspace-schema'

export type ProjectTransaction = Parameters<Parameters<typeof projectDb.transaction>[0]>[0]
async function readAccessibleProjects(userId: string, tx: ProjectTransaction | typeof projectDb, workspaceId?: string) {
  const rows = await tx.selectDistinct({ project: projects }).from(projects)
    .leftJoin(teamProjects, eq(teamProjects.projectId, projects.id))
    .leftJoin(workspaceMembers, and(eq(workspaceMembers.workspaceId, teamProjects.workspaceId), eq(workspaceMembers.userId, userId), eq(workspaceMembers.status, 'active')))
    .where(or(and(eq(projects.userId, userId), isNull(teamProjects.projectId)), and(eq(workspaceMembers.userId, userId), workspaceId ? eq(teamProjects.workspaceId, workspaceId) : undefined)))
  return rows.map(row => row.project)
}

// Reads outside a transaction are shared within one server render (React cache is per request);
// transactions always read fresh rows under their own locks.
const cachedAccessibleProjects = cache((userId: string, workspaceId: string) => readAccessibleProjects(userId, projectDb, workspaceId || undefined))

export async function accessibleProjects(userId: string, tx: ProjectTransaction | typeof projectDb = projectDb, workspaceId?: string) {
  return tx === projectDb ? cachedAccessibleProjects(userId, workspaceId ?? '') : readAccessibleProjects(userId, tx, workspaceId)
}
