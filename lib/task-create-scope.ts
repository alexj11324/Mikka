import 'server-only'
import { and, eq, sql } from 'drizzle-orm'
import { actAs } from './acting-user'
import { issues } from './db/schema'
import { projectDb, projectTasks } from './db/projects'
import { db, withDatabaseTransaction } from './db'
import { ActionFailureError } from './action-error'
import { createIssueForUserInTransaction } from './issue-create'
import { createTeamIssueForUser } from './team-issue-create'
import type { ActivityActor } from './activity-actor'
import type { CreateOnlyCommand } from './task-create-command'

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
type Fields = Pick<CreateOnlyCommand, 'title' | 'content' | 'status' | 'priority'>

/** Explicit creation never derives a paid short title. Team assignment uses
 * the same verified relation, lock ordering and split-database recovery as
 * creating from the Team. No provider sync target is inferred. */
export async function insertExplicitTask(tx: Transaction, userId: string, workspaceId: string, requestId: string,
  fields: Fields, actor: ActivityActor, teamId?: string) {
  if (teamId) {
    const result = await withDatabaseTransaction(tx, () => createTeamIssueForUser(userId, { ...fields, requestId, teamId }, actor, { workspaceId }))
    if ('error' in result && result.error) throw new ActionFailureError(result.error)
    if (!('issue' in result) || !result.issue?.identifier) throw new ActionFailureError('issueCreateFailed')
    return { taskId: result.issue.id, identifier: result.issue.identifier }
  }
  const issue = await createIssueForUserInTransaction(tx, userId, fields, actor, { workspaceId, deriveShortTitle: false })
  if (!issue?.identifier) throw new ActionFailureError('issueCreateFailed')
  return { taskId: issue.id, identifier: issue.identifier }
}

/** Use the normal Project relation writer, its resource ACL locks and its
 * audience-change confirmation. A refusal aborts the outer Task insert. */
export async function attachInitialProject(tx: Transaction, userId: string, workspaceId: string, taskId: string,
  projectId: string, actor: ActivityActor, confirmAccess: boolean) {
  const [task] = await tx.select({ revision: issues.revision }).from(issues).where(and(eq(issues.id, taskId), eq(issues.workspaceId, workspaceId)))
  if (!task) throw new ActionFailureError('issueNotFound')
  const { moveIssueToProject } = await import('../app/actions/projects')
  const result = await withDatabaseTransaction(tx, () => actAs(userId, () => moveIssueToProject({ workspaceId, issueId: taskId, revision: task.revision, projectId, confirmAccess }), actor))
  if ('issue' in result && result.issue) return
  if ('confirmable' in result && result.confirmable) throw new ActionFailureError('accessChangeConfirmationRequired', result.params, true)
  throw new ActionFailureError('projectMoveFailed')
}

/** In split-DB deployments the APP commit can win while the Workspace commit
 * is lost. Restore that one missing relation only while the ACL still records
 * this Project. A later intentional move or detach remains authoritative. */
export async function reconcileInitialProject(tx: Transaction, userId: string, workspaceId: string, taskId: string,
  projectId: string, actor: ActivityActor, confirmAccess: boolean) {
  const [current] = await projectDb.select({ projectId: projectTasks.projectId }).from(projectTasks).where(and(eq(projectTasks.issueId, taskId), eq(projectTasks.workspaceId, workspaceId)))
  if (current) return
  const policy = await tx.execute(sql`select 1 from resource_access_policies where kind='task' and id=${taskId}
    and "workspaceId"=${workspaceId} and "parentKind"='project' and "parentId"=${projectId}`)
  if (policy.rowCount) await attachInitialProject(tx, userId, workspaceId, taskId, projectId, actor, confirmAccess)
}
