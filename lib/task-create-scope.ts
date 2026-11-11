import 'server-only'
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
