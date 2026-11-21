import 'server-only'
import { sql } from 'drizzle-orm'
import type { z } from 'zod'
import { ActionFailureError } from '@/lib/action-error'
import { GitHubAccessError, recentRepositoryPullAuthors } from '@/lib/github/user-access'
import { withReadableProject } from '@/lib/project-access'
import { withTaskWorkspace } from '@/lib/task-workspace'
import type { projectPullAuthorInput } from './contracts'
import { resourceLock } from './store'

/** Both the selected trigger repository and the selected Project are explicit.
 * Check local admission again after the upstream read without holding a DB
 * transaction open during the network request. */
export async function projectPullAuthors(reader: { id: string }, input: z.infer<typeof projectPullAuthorInput>) {
  if (input.readerId !== reader.id) throw new ActionFailureError('workspaceAccessDenied')
  const { workspaceId, projectId, repository, query } = input
  const admitted = () => withTaskWorkspace(reader, workspaceId, async (_workspace, tx) => {
    await resourceLock(tx, workspaceId, false)
    return withReadableProject(reader, workspaceId, projectId, async () => {
      const result = await tx.execute(sql`SELECT 1 FROM workspace_project_repositories r
        LEFT JOIN workspace_repository_policies p ON p."workspaceId"=r."workspaceId"
        WHERE r."workspaceId"=${workspaceId} AND r."projectId"=${projectId} AND r."repositoryKey"=${repository}
          AND (p.mode IS DISTINCT FROM 'restricted' OR p."repositoryKeys" ? ${repository})`)
      return !!result.rowCount
    })
  })
  if (!(await admitted())) return []
  try {
    const names = await recentRepositoryPullAuthors(reader.id, repository, query, { deadline: Date.now() + 20_000 })
    return await admitted() ? names : []
  } catch (cause) {
    if (cause instanceof GitHubAccessError) throw new ActionFailureError('projectDependencyReaderUnavailable', undefined, undefined, { cause })
    throw cause
  }
}
