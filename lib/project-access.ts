import 'server-only'
import { cache } from 'react'
import { and, eq, isNull, or } from 'drizzle-orm'
import { projectDb, projects } from '@/lib/db/projects'
import { teamProjects } from '@/lib/db/team-schema'
import { workspaceMembers } from '@/lib/db/workspace-schema'

export type ProjectTransaction = Parameters<Parameters<typeof projectDb.transaction>[0]>[0]

async function queryAccessibleProjects(userId: string, tx: ProjectTransaction | typeof projectDb, workspaceId?: string) {
  const rows = await tx.selectDistinct({ project: projects }).from(projects)
    .leftJoin(teamProjects, eq(teamProjects.projectId, projects.id))
    .leftJoin(workspaceMembers, and(eq(workspaceMembers.workspaceId, teamProjects.workspaceId), eq(workspaceMembers.userId, userId), eq(workspaceMembers.status, 'active')))
    .where(or(and(eq(projects.userId, userId), isNull(teamProjects.projectId)), and(eq(workspaceMembers.userId, userId), workspaceId ? eq(teamProjects.workspaceId, workspaceId) : undefined)))
  return rows.map(row => row.project)
}

const cachedAccessibleProjects = cache(async (userId: string, workspaceId: string) => queryAccessibleProjects(userId, projectDb, workspaceId || undefined))

export async function accessibleProjects(userId: string, tx: ProjectTransaction | typeof projectDb = projectDb, workspaceId?: string) {
  if (tx === projectDb) return cachedAccessibleProjects(userId, workspaceId ?? '')
  return queryAccessibleProjects(userId, tx, workspaceId)
}
