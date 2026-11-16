import 'server-only'
import { sql } from 'drizzle-orm'
import type { z } from 'zod'
import { ActionFailureError } from '@/lib/action-error'
import { withResourceAccess, requireResourceAccess, resourceActionAllowed } from '@/lib/resource-access/store'
import { taskReaderScope, withTaskWorkspace } from '@/lib/task-workspace'
import { GitHubAccessError, listRepositoriesForUser } from '@/lib/github/user-access'
import { resourceLock, resourceWriteLock } from './store'
import { projectMapChanged } from '@/lib/live/project-map'
import { listDependencyRepositoriesInput, replaceDependencyRepositoriesInput, projectRepositoryKey } from './contracts'

type Reader = Parameters<typeof withTaskWorkspace>[0]
type Scope = z.infer<typeof listDependencyRepositoriesInput>
type DependencyListing = { revision: number; selected: string[]; repositories: { id: string; name: string }[]; canReplace: boolean }

async function currentDirectory(reader: Reader, scope: Scope, write: boolean) {
  const ref = { kind: 'project' as const, id: scope.projectId, workspaceId: scope.workspaceId }
  await requireResourceAccess(reader, ref, write ? 'canSteer' : 'canReadContent')
  try {
    const listing = await listRepositoriesForUser(taskReaderScope(reader).userId)
    const repositories = new Map<string, { id: string; name: string; key: string }>()
    for (const repo of listing.repositories) {
      const key = projectRepositoryKey.safeParse('v2/github.com/' + repo.fullName)
      if (key.success) repositories.set(repo.id, { id: repo.id, name: repo.fullName, key: key.data })
    }
    return repositories
  } catch (error) {
    if (error instanceof GitHubAccessError) throw new ActionFailureError('projectDependencyReaderUnavailable', undefined, undefined, { cause: error })
    throw error
  }
}

async function projectDependencies(reader: Reader, scope: Scope, update?: z.infer<typeof replaceDependencyRepositoriesInput>): Promise<DependencyListing> {
  const available = await currentDirectory(reader, scope, !!update)
  const { projectId, workspaceId } = scope
  const actor = taskReaderScope(reader).userId
  return withTaskWorkspace(reader, workspaceId, async (_workspace, tx) => {
    if (update) await resourceWriteLock(tx, workspaceId)
    else await resourceLock(tx, workspaceId, false)
    const reference = { kind: 'project' as const, workspaceId, id: projectId }
    return withResourceAccess(reader, reference, update ? 'canSteer' : 'canReadContent', async (_policy, acl) => {
      const project = (await tx.execute<{ revision: number; archivedAt: Date | null }>(sql`select revision,"archivedAt" from workspace_projects where id=${projectId} and "workspaceId"=${workspaceId} ${update ? sql`for update` : sql``}`)).rows[0]
      if (!project) throw new ActionFailureError('projectNotFound')
      const membership = (await tx.execute<{ role: string }>(sql`select role from mikka_workspace_members where "workspaceId"=${workspaceId} and "userId"=${actor} and status='active'`)).rows[0]
      if (update && membership?.role !== 'admin') throw new ActionFailureError('workspaceAccessDenied')
      const policy = (await tx.execute<{ mode: string; repositoryKeys: string[] }>(sql`select mode,"repositoryKeys" from workspace_repository_policies where "workspaceId"=${workspaceId}`)).rows[0]
      const permittedKeys = policy?.mode === 'restricted' ? new Set(policy.repositoryKeys) : null
      const allowed = [...available.values()].filter(repo => !permittedKeys || permittedKeys.has(repo.key))
      const allowedIds = new Set(allowed.map(repo => repo.id))
      let selected = (await tx.execute<{ id: string }>(sql`select "githubRepositoryId" as id from workspace_project_dependency_repositories where "workspaceId"=${workspaceId} and "projectId"=${projectId} order by 1`)).rows.map(row => row.id)
      const complete = selected.every(id => allowedIds.has(id))
      let revision = project.revision
      if (update) {
        if (project.archivedAt) throw new ActionFailureError('projectArchived')
        if (revision !== update.revision) throw new ActionFailureError('projectResourceConflict')
        if (!complete || update.repos.some(id => !allowedIds.has(id))) throw new ActionFailureError('projectRepositoryDenied')
        const next = [...update.repos].sort()
        if (next.length !== selected.length || next.some((id, index) => id !== selected[index])) {
          await tx.execute(sql`delete from workspace_project_dependency_repositories where "workspaceId"=${workspaceId} and "projectId"=${projectId}`)
          if (next.length) await tx.execute(sql`insert into workspace_project_dependency_repositories ("workspaceId","projectId","githubRepositoryId") select ${workspaceId}::uuid,${projectId}::uuid,value from jsonb_array_elements_text(${JSON.stringify(next)}::jsonb)`)
          await tx.execute(sql`update workspace_projects set revision=revision+1,"updatedAt"=now() where id=${projectId} and "workspaceId"=${workspaceId}`)
          revision += 1
          await tx.execute(sql`insert into workspace_resource_events(id,"workspaceId","actorId",kind,"resourceId",detail) values(gen_random_uuid(),${workspaceId},${actor},'project_dependencies.changed',${projectId},${JSON.stringify({ repositoryCount: next.length, revision })}::jsonb)`)
          await projectMapChanged(tx, projectId)
          selected = next
        }
      }
      const canReplace = membership?.role === 'admin' && !project.archivedAt && complete
        && (!!update || await resourceActionAllowed(acl, actor, reference, 'canSteer'))
      const visibleIds = selected.filter(id => allowedIds.has(id))
      const visible = canReplace ? allowed : allowed.filter(repo => visibleIds.includes(repo.id))
      return { revision, selected: visibleIds, repositories: visible.map(({ id, name }) => ({ id, name })).sort((a,b) => a.name.localeCompare(b.name)), canReplace }
    })
  })
}

export function listDependencyRepositories(reader: Reader, raw: Scope) {
  return projectDependencies(reader, listDependencyRepositoriesInput.parse(raw))
}
export function replaceDependencyRepositories(reader: Reader, raw: z.infer<typeof replaceDependencyRepositoriesInput>) {
  const update = replaceDependencyRepositoriesInput.parse(raw)
  return projectDependencies(reader, update, update)
}
