/** The only run fields shared with current collaborators. Never spread private RunView data. */
export interface IssueRunSummary {
  id: string
  status: string
  createdAt: Date
  updatedAt: Date
  ownedByCurrentUser: boolean
}
export const ISSUE_RUN_SUMMARY_LIMIT = 20
export function projectIssueRunSummaries(
  rows: readonly { id: string; issueId: string | null; userId: string; status: string; createdAt: Date; updatedAt: Date }[],
  issueId: string,
  viewerId: string,
  currentMemberIds: ReadonlySet<string>,
): IssueRunSummary[] {
  if (!currentMemberIds.has(viewerId)) return []
  return rows.filter(row => row.issueId === issueId && currentMemberIds.has(row.userId))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))
    .slice(0, ISSUE_RUN_SUMMARY_LIMIT)
    .map(row => ({ id: row.id, status: row.status, createdAt: row.createdAt, updatedAt: row.updatedAt, ownedByCurrentUser: row.userId === viewerId }))
}
