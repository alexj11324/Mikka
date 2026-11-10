import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'

/** Configure actual canonical Project/Environment rows through the production
 * resource writers. Fixtures still queue and continue through real admission. */
export async function seedRunProjectResources(pool: Pool, input: {
  ownerId: string; workspaceId: string; issueId: string; repositoryKey: string;
  runtime: 'local' | 'cloud'; harness: 'codex' | 'claude_code'; environment?: boolean; baseBranch?: string | null;
}) {
  const resources = await import('../../lib/project-resources/store')
  const projectId = randomUUID()
  await pool.query(`INSERT INTO workspace_projects(id,"userId","workspaceId",name,summary,description,status,priority,lead,team,"startDate","targetDate","issueIds",revision)
    VALUES($1,$2,$3,'Run resource fixture','','','planned','none','','','','','[]',1)`, [projectId, input.ownerId, input.workspaceId])
  // Project archive and other ACL-guarded project writers require the same
  // policy row that the production creation transaction registers.
  const { registerProjectAccess } = await import('../../lib/resource-access/projects')
  await registerProjectAccess(input.ownerId, projectId, input.workspaceId)
  const linked = await pool.query(`INSERT INTO workspace_project_tasks("issueId","projectId","workspaceId")
    SELECT id,$1,"workspaceId" FROM issues WHERE id=$2 AND "workspaceId"=$3 AND "ownershipState"='bound'`,
  [projectId, input.issueId, input.workspaceId])
  if (linked.rowCount !== 1) throw new Error('Run resource fixture needs a bound Task in its canonical Workspace')
  const configuration = { runtime: input.runtime, harness: input.harness, repositoryKeys: [input.repositoryKey],
    variables: { RESOURCE_FIXTURE: 'original' }, setup: { command: 'node --version', copyFiles: [], approved: true } }
  const environment = input.environment === false ? null : await resources.saveEnvironment(input.ownerId, {
    workspaceId: input.workspaceId, name: 'Frozen Run environment', configuration,
  })
  await resources.saveProjectResources(input.ownerId, { workspaceId: input.workspaceId, projectId, revision: 1,
    repositories: [{ repositoryKey: input.repositoryKey, isPrimary: true, baseBranch: input.baseBranch ?? 'main' }],
    environmentIds: environment ? [environment.id] : [], defaultEnvironmentId: environment?.id ?? null })
  return { projectId, environment,
    async refuse(kind: 'repository' | 'environment-revision' | 'environment-archive' | 'project-archive' | 'branch') {
      if (kind === 'repository') return resources.saveWorkspaceRepositoryPolicy(input.ownerId, {
        workspaceId: input.workspaceId, revision: 0, mode: 'restricted', repositoryKeys: [],
      })
      if (kind === 'project-archive') return (await import('../../lib/project-lifecycle')).setProjectArchive(input.ownerId, input.workspaceId, {
        id: projectId, archived: true, message: 'Fixture archives the Project before continuation',
      })
      if (kind === 'branch') return resources.saveProjectResources(input.ownerId, { workspaceId: input.workspaceId, projectId, revision: 2,
        repositories: [{ repositoryKey: input.repositoryKey, isPrimary: true, baseBranch: 'changed-after-start' }],
        environmentIds: environment ? [environment.id] : [], defaultEnvironmentId: environment?.id ?? null })
      if (!environment) throw new Error('This fixture has no Environment to change')
      return resources.saveEnvironment(input.ownerId, { workspaceId: input.workspaceId, id: environment.id, revision: 1,
        name: 'Changed after start', configuration: { ...configuration, variables: { RESOURCE_FIXTURE: 'changed' } },
        ...(kind === 'environment-archive' ? { archived: true } : {}) })
    },
  }
}
