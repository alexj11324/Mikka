export const ISSUE_STATUS_CODES = ['backlog', 'todo', 'doing', 'review', 'done', 'canceled', 'duplicate'] as const
export type IssueStatus = (typeof ISSUE_STATUS_CODES)[number]

export const ISSUE_PRIORITY_CODES = ['urgent', 'high', 'normal', 'low'] as const
export type IssuePriority = (typeof ISSUE_PRIORITY_CODES)[number]
