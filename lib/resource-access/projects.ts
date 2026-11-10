import 'server-only'
import { sql } from 'drizzle-orm'
import { ActionFailureError } from '@/lib/action-error'
import { db, withDatabaseTransaction } from '@/lib/db'
import type { IssueReader } from '@/lib/issue-visibility'
import { taskReaderScope, withTaskWorkspace } from '@/lib/task-workspace'
import { lockResourceAccess, lockResourcesAccess, type ResourceExecutor } from './store'
import type { ResourceReference } from './contract'

/** Call from the existing Workspace Project creation transaction, after its
 * Workspace/member/source locks. An APP commit followed by a failed WS commit
 * can leave only an unreachable policy; never an unguarded content row. */
export async function registerProjectAccess(reader: IssueReader, projectId: string, workspaceId: string, visibility?: 'shared' | 'private') {
  return withTaskWorkspace(reader, workspaceId, workspace => db.transaction(tx => withDatabaseTransaction(tx, async () => {
    const ownerId = taskReaderScope(reader).userId
    await tx.execute(sql`select set_config('mikka.acl_actor',${ownerId},true),set_config('mikka.acl_source','project_created',true)`)
    await tx.execute(sql`insert into resource_access_policies(kind,id,"workspaceId","ownerId",visibility,provenance)
      values('project',${projectId}::uuid,${workspaceId}::uuid,${ownerId},${workspace.kind === 'team' ? visibility ?? 'shared' : 'private'},'created')`)
  })))
}

/** Source Project relations are locked in WS before entering this APP lease.
 * Detaching/moving a task makes its local visibility private: removing a
 * private ancestor must never publish its existing body to the Workspace.
 * Sharing can be expanded later through the explicit owner confirmation. */
export async function bindProjectTasks(executor: ResourceExecutor, reader: IssueReader, project: ResourceReference,
  previousIds: readonly string[], nextIds: readonly string[]) {
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
  await executor.execute(sql`select set_config('mikka.acl_actor',${userId},true),set_config('mikka.acl_source','project_task_relation',true)`)
  for (const policy of policies) {
    const attaching = added.includes(policy.id)
    // An initial attachment only narrows access. Changing an existing parent
    // or removing it also preserves confidentiality in the local policy.
    await executor.execute(sql`update resource_access_policies set
      visibility=case when "parentId" is not null and ("parentKind"<>'project' or "parentId"<>${project.id}::uuid) then 'private' else visibility end,
      "parentKind"=${attaching ? 'project' : null},"parentId"=${attaching ? project.id : null}::uuid
      where kind='task' and id=${policy.id}::uuid`)
  }
}
