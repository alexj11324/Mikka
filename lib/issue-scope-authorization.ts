import { ActionFailureError } from './action-error'
import type { IssueReader } from './issue-visibility'
import type { TaskWorkspace } from './task-workspace'
import type { ResourceAction } from './resource-access/contract'

/** Recheck the exact authorized tenant and publication generation after locking.
 * Pair reads with requireCurrentIssueWorkspace and writes with an outer
 * withIssueWorkspace lease. This structural check alone is not a fresh ACL. */
export function requireLockedIssueScope<T extends { workspaceId: string | null; scopeVersion: number }>(row: T | undefined, _userId: string, observedScopeVersion: number, observedWorkspaceId: string | null): asserts row is T {
  if (!row || !observedWorkspaceId || row.workspaceId !== observedWorkspaceId || row.scopeVersion !== observedScopeVersion) throw new ActionFailureError('issueNotFound')
}

/** An APP row lock may have waited while membership was revoked. Read the WS
 * authority again without locking: taking a member lock here reverses the
 * WS -> APP write order. Carry the authenticated principal for Org/PAT gates. */
export async function requireCurrentIssueWorkspace(reader: IssueReader, workspaceId: string | null, issueId: string) {
  const { activeTaskWorkspaces } = await import('./task-workspace')
  if (!workspaceId || !(await activeTaskWorkspaces(reader, workspaceId)).some(workspace => workspace.id === workspaceId)) throw new ActionFailureError('issueNotFound')
  const { db } = await import('./db')
  const { taskReaderScope } = await import('./task-workspace')
  const { resourceActionAllowed } = await import('./resource-access/store')
  if (!await resourceActionAllowed(db, taskReaderScope(reader).userId, { kind: 'task', id: issueId, workspaceId }, 'canReadContent')) throw new ActionFailureError('issueNotFound')
}

/** Hold membership before entering the APP transaction and through its commit.
 * An existing task's authorization failure has the same unavailable response
 * as its entry ACL, including for the creator. New-task admission stays separate. */
export async function withIssueWorkspace<T>(reader: IssueReader, workspaceId: string | null,
  access: { issueId: string; action: ResourceAction; relatedIssueIds?: readonly string[] },
  work: (workspace: TaskWorkspace, tx: Parameters<Parameters<typeof import('./db').db.transaction>[0]>[0]) => Promise<T>): Promise<T> {
  if (!workspaceId) throw new ActionFailureError('issueNotFound')
  const { withTaskWorkspace, taskReaderScope } = await import('./task-workspace')
  const { db, withDatabaseTransaction } = await import('./db')
  const { lockResourcesAccess } = await import('./resource-access/store')
  try { return await withTaskWorkspace(reader, workspaceId, workspace => db.transaction(tx => withDatabaseTransaction(tx, async () => {
    await lockResourcesAccess(tx, taskReaderScope(reader).userId,
      [...new Set([access.issueId, ...access.relatedIssueIds ?? []])].map(id => ({ reference: { kind: 'task' as const, id, workspaceId }, action: access.action })), false, false)
    return work(workspace, tx)
  }))) }
  catch (error) {
    if (error instanceof ActionFailureError && error.code === 'workspaceAccessDenied') throw Object.assign(new ActionFailureError('issueNotFound'), { cause: error })
    throw error
  }
}
