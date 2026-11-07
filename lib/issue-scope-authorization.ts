import { ActionFailureError } from './action-error'

/** Recheck the exact authorized tenant and publication generation after locking.
 * Creator identity and the legacy scope label never bypass the entry ACL. */
export function requireLockedIssueScope<T extends { workspaceId: string | null; scopeVersion: number }>(row: T | undefined, _userId: string, observedScopeVersion: number, observedWorkspaceId: string | null): asserts row is T {
  if (!row || !observedWorkspaceId || row.workspaceId !== observedWorkspaceId || row.scopeVersion !== observedScopeVersion) throw new ActionFailureError('issueNotFound')
}
