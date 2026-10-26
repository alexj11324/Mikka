import { runSummaryText } from './issue-run-conversation'

/**
 * A thread is one agent run on an issue, and its content is its owner's alone (R-62):
 * current collaborators see whose thread it is, its status and time, never its prompt,
 * agent, output or messages, and cannot open or join it.
 */
export interface IssueThread {
  id: string
  status: string
  createdAt: Date
  finishedAt: Date | null
  ownedByCurrentUser: boolean
  /** Whose thread it is, shown on a teammate's thread instead of its content. */
  ownerName: string | null
  detail: { name: string; agentName: string; harness: string; summary: string | null } | null
}

export const ISSUE_THREAD_LIMIT = 20

export interface IssueThreadRow {
  id: string; issueId: string | null; userId: string; status: string; prompt: string
  report: unknown; error: string | null; createdAt: Date; finishedAt: Date | null
  agentName: string; harness: string; ownerName?: string | null
}

/** The thread's name: the first line of what it was asked to do. */
export function threadName(prompt: string, fallback: string) {
  const line = prompt.split('\n').map(part => part.trim()).find(Boolean)
  if (!line) return fallback
  return Array.from(line).length > 60 ? `${Array.from(line).slice(0, 59).join('')}…` : line
}

/** Only a thread's owner, while still a collaborator, reads or joins it. */
export function canReadThread(ownerId: string, viewerId: string, memberIds: ReadonlySet<string>) {
  return memberIds.has(viewerId) && ownerId === viewerId
}

export function projectIssueThreads(rows: readonly IssueThreadRow[], issueId: string, viewerId: string, memberIds: ReadonlySet<string>): IssueThread[] {
  if (!memberIds.has(viewerId)) return []
  return rows.filter(row => row.issueId === issueId && memberIds.has(row.userId))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))
    .slice(0, ISSUE_THREAD_LIMIT)
    .map(row => ({
      id: row.id, status: row.status, createdAt: row.createdAt, finishedAt: row.finishedAt, ownedByCurrentUser: row.userId === viewerId,
      ownerName: row.userId === viewerId ? null : row.ownerName ?? null,
      detail: canReadThread(row.userId, viewerId, memberIds)
        ? { name: threadName(row.prompt, row.agentName), agentName: row.agentName, harness: row.harness, summary: runSummaryText({ report: row.report, error: row.error }) }
        : null,
    }))
}
