import 'server-only'
import { sql } from 'drizzle-orm'
import { ActionFailureError } from '@/lib/action-error'
import { db, withDatabaseTransaction } from '@/lib/db'
import type { IssueReader } from '@/lib/issue-visibility'
import { taskReaderScope, withTaskWorkspace } from '@/lib/task-workspace'
import { lockResourceAccess, lockResourcesAccess, type ResourceExecutor } from './store'
import { observeAudienceChanges } from './confirm-access'
import { withAccessConfirmation } from './confirm-gate'
import type { ResourceReference } from './contract'

/** Call from the existing Workspace Project creation transaction, after its
 * Workspace/member/source locks. An APP commit followed by a failed WS commit
 * can leave only an unreachable policy; never an unguarded content row. */
export async function registerProjectAccess(reader: IssueReader, projectId: string, workspaceId: string) {
  return withTaskWorkspace(reader, workspaceId, workspace => db.transaction(tx => withDatabaseTransaction(tx, async () => {
    const ownerId = taskReaderScope(reader).userId
    await tx.execute(sql`select set_config('mikka.acl_actor',${ownerId},true),set_config('mikka.acl_source','project_created',true)`)
    await tx.execute(sql`insert into resource_access_policies(kind,id,"workspaceId","ownerId",visibility,provenance)
      values('project',${projectId}::uuid,${workspaceId}::uuid,${ownerId},${workspace.kind === 'team' ? 'shared' : 'private'},'created')`)
  })))
}

/**
 * Source Project relations are locked in WS before entering this APP lease.
 * Detaching/moving a task makes its local visibility private: removing a
 * private ancestor must never publish its existing body to the Workspace.
 * Sharing can be expanded later through the explicit owner confirmation.
 *
 * Attaching or detaching a task also changes who can read it, so the write is
 * refused (with `confirmable`, answered as HTTP 409) until the caller passes
 * `confirmAccess` — otherwise a shared task would be silently narrowed by
 * being filed under a private project, or a private task silently published.
 */
export async function bindProjectTasks(executor: ResourceExecutor, reader: IssueReader, project: ResourceReference,
  previousIds: readonly string[], nextIds: readonly string[], options: { confirmAccess?: boolean } = {}) {
  const userId = taskReaderScope(reader).userId
  await lockResourceAccess(executor, userId, project, 'canSteer')
  const added = nextIds.filter(id => !previousIds.includes(id))
  const removed = previousIds.filter(id => !nextIds.includes(id))
  const changes = [...new Set([...added, ...removed])].sort()
  const policies = await lockResourcesAccess(executor, userId,
    changes.map(id => ({ reference: { kind: 'task' as const, id, workspaceId: project.workspaceId }, action: 'canManageAccess' as const })), true)
  for (const policy of policies) {
    // A subtask's explicit Task parent is a stronger boundary than a grouping
    // link. Do not replace that ancestor silently with a Project.
    if (policy.parentKind && policy.parentKind !== 'project') throw new ActionFailureError('issueRelationInvalid')
    if (removed.includes(policy.id) && (policy.parentKind !== 'project' || policy.parentId !== project.id)) throw new ActionFailureError('issueOutdated')
  }
  // Each changed task would hang under this project (attaching) or under
  // nothing (detaching); compare who could read it before and after, and refuse
  // before anything is written when the audience changes.
  await withAccessConfirmation(
    () => observeAudienceChanges(executor, project.workspaceId, policies.map(policy => ({
      reference: { kind: 'task' as const, id: policy.id },
      parent: added.includes(policy.id) ? { kind: 'project', id: project.id } : null,
    }))).then(changes => changes.values()),
    options.confirmAccess === true,
    async () => {
      await executor.execute(sql`select set_config('mikka.acl_actor',${userId},true),set_config('mikka.acl_source','project_task_relation',true)`)
      for (const policy of policies) {
        const attaching = added.includes(policy.id)
        // An initial attachment only narrows access. Changing an existing parent
        // or removing it also preserves confidentiality in the local policy.
        await executor.execute(sql`update resource_access_policies set
          visibility=case when "parentId" is not null then 'private' else visibility end,
          "parentKind"=${attaching ? 'project' : null},"parentId"=${attaching ? project.id : null}::uuid
          where kind='task' and id=${policy.id}::uuid`)
      }
    })
}
