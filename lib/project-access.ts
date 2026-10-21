import 'server-only'
import { and, eq, isNull, or } from 'drizzle-orm'
import { projectDb, projects } from '@/lib/db/projects'
import { teamProjects } from '@/lib/db/team-schema'
import { workspaceMembers } from '@/lib/db/workspace-schema'

export type ProjectTransaction = Parameters<Parameters<typeof projectDb.transaction>[0]>[0]
export async function accessibleProjects(userId: string, tx: ProjectTransaction | typeof projectDb = projectDb) {
  const rows = await tx.selectDistinct({ project: projects }).from(projects)
    .leftJoin(teamProjects, eq(teamProjects.projectId, projects.id))
    .leftJoin(workspaceMembers, and(eq(workspaceMembers.workspaceId, teamProjects.workspaceId), eq(workspaceMembers.userId, userId), eq(workspaceMembers.status, 'active')))
    .where(or(and(eq(projects.userId, userId), isNull(teamProjects.projectId)), eq(workspaceMembers.userId, userId)))
  return rows.map(row => row.project)
}
