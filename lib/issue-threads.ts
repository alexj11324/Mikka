import { runSummaryText } from './issue-run-conversation'

/**
 * A thread is one agent run on an issue. Current collaborators see that it exists;
 * on a workspace issue they also read and join it (R-26, R-62). A collaborator on a
 * personal issue sees only another owner's status, never its prompt, agent or output.
 */
export interface IssueThread {
  id: string
  status: string
  createdAt: Date
  finishedAt: Date | null
  ownedByCurrentUser: boolean
  detail: { name: string; agentName: string; harness: string; summary: string | null } | null
}

export const ISSUE_THREAD_LIMIT = 20

export interface IssueThreadRow {
  id: string; issueId: string | null; userId: string; status: string; prompt: string
  report: unknown; error: string | null; createdAt: Date; finishedAt: Date | null
  agentName: string; harness: string
}

/** The thread's name: the first line of what it was asked to do. */
export function threadName(prompt: string, fallback: string) {
  const line = prompt.split('\n').map(part => part.trim()).find(Boolean)
  if (!line) return fallback
  return Array.from(line).length > 60 ? `${Array.from(line).slice(0, 59).join('')}…` : line
}

/** The viewer may read a thread when both are current collaborators and it is theirs or the issue is shared. */
export function canReadThread(ownerId: string, viewerId: string, memberIds: ReadonlySet<string>, shared: boolean) {
  return memberIds.has(viewerId) && memberIds.has(ownerId) && (ownerId === viewerId || shared)
}

export function projectIssueThreads(rows: readonly IssueThreadRow[], issueId: string, viewerId: string, memberIds: ReadonlySet<string>, shared: boolean): IssueThread[] {
  if (!memberIds.has(viewerId)) return []
  return rows.filter(row => row.issueId === issueId && memberIds.has(row.userId))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))
    .slice(0, ISSUE_THREAD_LIMIT)
    .map(row => ({
      id: row.id, status: row.status, createdAt: row.createdAt, finishedAt: row.finishedAt, ownedByCurrentUser: row.userId === viewerId,
      detail: canReadThread(row.userId, viewerId, memberIds, shared)
        ? { name: threadName(row.prompt, row.agentName), agentName: row.agentName, harness: row.harness, summary: runSummaryText({ report: row.report, error: row.error }) }
        : null,
    }))
}
