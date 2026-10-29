export type FactoryIssueScope = { userId: string; scope: string; scopeVersion: number }

/** The task owner keeps their own issue authority. A teammate's frozen grant
 * never revives after retirement/re-promotion, including unknown legacy pins.
 * Current membership, deletion and source checks still apply independently. */
export function factoryScopeAllows(task: { userId: string; scopeVersion?: number | null }, issue: FactoryIssueScope | undefined) {
  return Boolean(issue && (issue.userId === task.userId || (
    issue.scope === 'workspace' && task.scopeVersion != null && task.scopeVersion === issue.scopeVersion
  )))
}
