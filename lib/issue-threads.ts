import { runIsActive, runSummaryText } from './issue-run-conversation'

/**
 * A thread is one agent run on an issue, and its content is its owner's alone (R-62):
 * current collaborators see whose thread it is, its status and time, never its prompt,
 * agent, output or messages, and cannot open or join it.
 */
export interface IssueThread {
  id: string
  status: string
  /** A requested stop is status metadata, including for teammates. */
  stopping: boolean
  createdAt: Date
  finishedAt: Date | null
  ownedByCurrentUser: boolean
  /** Whose thread it is, shown on a teammate's thread instead of its content. */
  ownerName: string | null
  detail: { name: string; agentName: string; harness: string; summary: string | null } | null
  /** 等你回复 (Figma 382:6469): the owner's ended run asked a Factory question; `resuming` once answered. */
  question: ThreadQuestion
  /**
   * The run that resumes this thread after its question was answered. The backend queues
   * it as a separate agent_run (lib/factory/questions/store.ts answer → dispatch); it is the
   * same conversation, so it is folded into its origin's row instead of listed on its own.
   */
  continuation: { id: string; status: string; stopping: boolean } | null
}

export type ThreadQuestion = 'waiting' | 'resuming' | null

/**
 * The one place the list row, header and composer read a question from. An answered
 * question shows as the run it is about to continue: the same running state, nothing new.
 */
export function threadQuestionView(thread: { id: string; status: string; stopping?: boolean; question: ThreadQuestion; continuation?: IssueThread['continuation'] }) {
  const next = thread.continuation ?? null
  // The resumed run has started: it is the live run again, to message and to stop.
  if (next && next.status !== 'queued') return { question: null, waiting: false, status: next.status, runId: next.id, stopping: runIsActive(next.status) && next.stopping }
  // Answered, continuation not started yet: still running, nothing to send or stop.
  if (next) return { question: 'resuming' as const, waiting: false, status: 'running', runId: thread.id, stopping: false }
  const question = runIsActive(thread.status) ? null : thread.question
  return { question, waiting: question === 'waiting', status: question === 'resuming' ? 'running' : thread.status, runId: thread.id, stopping: !!thread.stopping }
}

/** When the row last changed, never after `now`: clock skew with the server must not read as 「1秒钟后」. */
export function threadTime(thread: { createdAt: Date; finishedAt: Date | null }, now: Date) {
  return new Date(Math.min(now.getTime(), new Date(thread.finishedAt ?? thread.createdAt).getTime()))
}

export const ISSUE_THREAD_LIMIT = 20

export interface IssueThreadRow {
  id: string; issueId: string | null; userId: string; status: string; prompt: string
  report: unknown; error: string | null; createdAt: Date; finishedAt: Date | null
  agentName: string; harness: string; ownerName?: string | null
  stopRequestedAt?: Date | null
  questionContinuation?: { originRunId: string } | null
}

/** Markdown syntax a prompt may open with ("# Title", "- item", "**bold**"): never part of a name. */
function plainLine(line: string) {
  return line.replace(/^(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)+/, '').replace(/(\*\*|__|`|~~)/g, '').trim()
}

/** The thread's name: the first line of what it was asked to do, as plain text. */
export function threadName(prompt: string, fallback: string) {
  const line = prompt.split('\n').map(part => plainLine(part.trim())).find(Boolean)
  if (!line) return fallback
  return Array.from(line).length > 60 ? `${Array.from(line).slice(0, 59).join('')}…` : line
}

/** Only a thread's owner, while still a collaborator, reads or joins it. */
export function canReadThread(ownerId: string, viewerId: string, memberIds: ReadonlySet<string>) {
  return memberIds.has(viewerId) && ownerId === viewerId
}

export function projectIssueThreads(rows: readonly IssueThreadRow[], issueId: string, viewerId: string, memberIds: ReadonlySet<string>): IssueThread[] {
  if (!memberIds.has(viewerId)) return []
  const visible = rows.filter(row => row.issueId === issueId && memberIds.has(row.userId))
  const ids = new Set(visible.map(row => row.id))
  // A continuation joins its origin's row; one whose origin is not here stays, named plainly.
  const folded = new Map<string, IssueThreadRow>()
  for (const row of visible) {
    const origin = row.questionContinuation?.originRunId
    if (origin && ids.has(origin)) {
      const current = folded.get(origin)
      if (!current || row.createdAt.getTime() > current.createdAt.getTime()) folded.set(origin, row)
    }
  }
  const foldedIds = new Set([...folded.values()].map(row => row.id))
  return visible.filter(row => !foldedIds.has(row.id))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))
    .slice(0, ISSUE_THREAD_LIMIT)
    .map(row => ({
      id: row.id, status: row.status, createdAt: row.createdAt, finishedAt: row.finishedAt, ownedByCurrentUser: row.userId === viewerId,
      stopping: runIsActive(row.status) && !!row.stopRequestedAt,
      ownerName: row.userId === viewerId ? null : row.ownerName ?? null,
      detail: canReadThread(row.userId, viewerId, memberIds)
        ? { name: threadName(row.prompt, row.agentName), agentName: row.agentName, harness: row.harness, summary: runSummaryText({ report: row.report, error: row.error }) }
        : null,
      question: null,
      continuation: (next => next ? { id: next.id, status: next.status, stopping: runIsActive(next.status) && !!next.stopRequestedAt } : null)(folded.get(row.id)),
    }))
}
