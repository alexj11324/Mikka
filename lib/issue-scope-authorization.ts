import { ActionFailureError } from './action-error'

/** Recheck after locking, in addition to the entry ACL. An old workspace
 * authorization cannot grant the owner’s private data or a later publication. */
export function requireLockedIssueScope<T extends { userId: string; scope: string; scopeVersion: number }>(row: T | undefined, userId: string, observedScopeVersion: number): asserts row is T {
  if (!row || (row.userId !== userId && (row.scope !== 'workspace' || row.scopeVersion !== observedScopeVersion))) throw new ActionFailureError('issueNotFound')
}
