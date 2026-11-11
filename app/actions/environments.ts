'use server'

import { and, eq, sql } from 'drizzle-orm'
import { requireUser } from '@/lib/issue-access'
import { loadWorkspaceContext } from '@/lib/workspace-access'
import { accessibleProjects } from '@/lib/project-access'
import { projectDb } from '@/lib/db/projects'
import { workspaceMembers } from '@/lib/db/workspace-schema'
import { withTaskWorkspace } from '@/lib/task-workspace'
import { listProjectResources } from '@/lib/project-resources/store'
import type { EnvironmentConfiguration } from '@/lib/project-resources/contracts'

export type EnvironmentView = { id: string; name: string; revision: number; configuration: EnvironmentConfiguration; archived: boolean }
export type EnvironmentProject = { id: string; name: string; revision: number; environmentId: string | null }
export type EnvironmentsView = { environments: EnvironmentView[]; projects: EnvironmentProject[]; canManage: boolean }

/** The editor and admission use the same Workspace environments and Project bindings. */
export async function listEnvironments(workspaceId?: string): Promise<EnvironmentsView> {
  const user = await requireUser()
  const context = await loadWorkspaceContext(workspaceId, user)
  return withTaskWorkspace(user, context.workspace.id, async (_workspace, tx) => {
    const [resources, projects] = await Promise.all([
      listProjectResources(user, context.workspace.id),
      accessibleProjects(user, projectDb, context.workspace.id),
    ])
    const ids = projects.filter(project => !project.archivedAt).map(project => project.id)
    const bindings = ids.length ? await projectDb.execute<{ projectId: string; environmentId: string }>(sql`
      select "projectId","environmentId" from workspace_project_environments
      where "workspaceId"=${context.workspace.id} and "projectId" in (${sql.join(ids.map(id => sql`${id}::uuid`), sql`,`)}) and "isDefault"`) : { rows: [] }
    const defaults = new Map(bindings.rows.map(row => [row.projectId, row.environmentId]))
    // The context can predate a role change. Membership is now locked; expose
    // management only from the role that remains authoritative for this read.
    const [member] = await tx.select({ role: workspaceMembers.role }).from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, context.workspace.id), eq(workspaceMembers.userId, user.id), eq(workspaceMembers.status, 'active')))
    return {
      environments: resources.environments.map(({ id, name, revision, configuration, archivedAt }) => ({ id, name, revision, configuration, archived: Boolean(archivedAt) })),
      projects: projects.filter(project => !project.archivedAt).map(({ id, name, revision }) => ({ id, name, revision, environmentId: defaults.get(id) ?? null })),
      canManage: member?.role === 'admin',
    }
  })
}
