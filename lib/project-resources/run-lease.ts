import 'server-only'
import type { PoolClient } from 'pg'
import { ActionFailureError } from '@/lib/action-error'
import type { agentRuns } from '@/lib/db/schema'
import type { ProjectExecutionSnapshot } from './contracts'
import { assertFrozenProjectExecution, requireProjectResourceLease, withProjectExecution, withProjectResourceLease, type ProjectExecutionInput } from './store'

type ResourceRun = Pick<typeof agentRuns.$inferSelect, 'userId' | 'workspaceId' | 'issueId' | 'deviceId' | 'deviceRepoId' | 'agentId' | 'baseBranch' | 'agentDefinition'>

export type ProjectExecutionRefusal = 'projectRepositoryDenied' | 'projectEnvironmentUnavailable' | 'projectArchived'
export function isProjectExecutionRefusal(error: unknown): error is ActionFailureError & { code: ProjectExecutionRefusal } {
  return error instanceof ActionFailureError && ['projectRepositoryDenied', 'projectEnvironmentUnavailable', 'projectArchived'].includes(error.code)
}

/** A continuation keeps its source's configuration, including the absence of
 * a snapshot on an old Run. Apply this before committing a replacement Run. */
export function assertRunProjectExecution(input: Pick<ProjectExecutionInput, 'baseBranch'>, frozen: ProjectExecutionSnapshot | undefined, admitted: ProjectExecutionSnapshot) {
  if (frozen) assertFrozenProjectExecution(frozen, admitted)
  else {
    if (admitted.environment) throw new ActionFailureError('projectEnvironmentUnavailable')
    if (admitted.baseBranch !== input.baseBranch) throw new ActionFailureError('projectRepositoryDenied')
  }
}

/** Queue authorization is not permission to start after an administrator has
 * revoked a repository or environment. Hold the live policy lease until the
 * claim response is built, while preserving the originally frozen definition. */
export async function withRunProjectExecution<T>(input: ProjectExecutionInput, frozen: ProjectExecutionSnapshot | undefined, operation: () => Promise<T>) {
  // Factory checks execute an independently verified candidate SHA in
  // Run.baseBranch. The resource snapshot still names the Project checkout
  // target; current Project bindings may override and revoke that target.
  return withProjectExecution({ ...input, baseBranch: frozen ? frozen.baseBranch : input.baseBranch }, async admitted => {
    assertRunProjectExecution(input, frozen, admitted)
    return operation()
  })
}

/** A queued receipt may outlive its resource authorization. Hold the same
 * Workspace/resource lease across handoff and actual VM create/resume, before
 * either operation opens its APP transaction. Nested startup borrows it. */
export async function withRunProjectResources<T>(query: Pick<PoolClient, 'query'>, run: ResourceRun, operation: () => Promise<T>) {
  if (!run.workspaceId || !run.issueId) throw new ActionFailureError('projectEnvironmentUnavailable')
  return withProjectResourceLease(run.userId, run.workspaceId, async () => {
    await assertRunProjectResources(query, run)
    return operation()
  })
}

/** Direct continuation writers already own their WS/resource lease before
 * entering APP. Read the persisted placement on their executor; no APP -> WS
 * lock acquisition or inferred Environment is allowed at this inner boundary. */
export async function assertRunProjectResources(query: Pick<PoolClient, 'query'>, run: ResourceRun) {
  if (!run.workspaceId || !run.issueId) throw new ActionFailureError('projectEnvironmentUnavailable')
  requireProjectResourceLease(run.userId, run.workspaceId)
  const { rows: [target] } = await query.query<{ repoPath: string; remoteUrl: string | null; kind: 'local' | 'cloud'; harness: string }>(
    `SELECT repo."repoPath",repo."remoteUrl",device.kind,agent.harness FROM device_repos repo
      JOIN devices device ON device.id=repo."deviceId" AND device."ownerId"=repo."userId"
      JOIN agents agent ON agent.id=$4 AND agent."userId"=repo."userId"
      WHERE repo.id=$1 AND repo."userId"=$2 AND repo."deviceId"=$3 FOR SHARE OF repo,device,agent`,
    [run.deviceRepoId, run.userId, run.deviceId, run.agentId])
  if (!target || !['local', 'cloud'].includes(target.kind)) throw new ActionFailureError('projectRepositoryDenied')
  await withRunProjectExecution({ userId: run.userId, workspaceId: run.workspaceId, issueId: run.issueId,
    repositoryKey: target.remoteUrl ? target.repoPath : null, baseBranch: run.baseBranch,
    runtime: target.kind, harness: run.agentDefinition?.harness ?? target.harness }, run.agentDefinition?.projectExecution, async () => undefined)
}
