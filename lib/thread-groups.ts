/** How the right column groups threads and a bot's PRs. Pure, so it can be tested without a database. */
import { markdownLine } from './agent-history'

/** How much of a thread's last reply is stored: one row's worth, cut on screen. */
export const LAST_REPLY_CHARS = 240

/** A reply's opening as one plain line: the chat's markdown stripped (as in the bot list), whitespace collapsed. */
export function replyLine(text: string | null | undefined): string | null {
  return text ? markdownLine(text) || null : null
}

/**
 * What a batch of run chunks does to the stored last reply: the text of its
 * last text part that carries any, and whether that part starts in this batch
 * (replace) or continues one from an earlier batch (append). Null when no
 * delta in the batch carries text.
 */
export function lastReplyUpdate(chunks: readonly Record<string, unknown>[]): { part: string; text: string; replace: boolean } | null {
  let part: string | null = null
  for (const chunk of chunks) if (chunk.type === 'text-delta' && typeof chunk.id === 'string' && typeof chunk.delta === 'string' && chunk.delta) part = chunk.id
  if (part === null) return null
  const text = chunks.filter(chunk => chunk.type === 'text-delta' && chunk.id === part && typeof chunk.delta === 'string').map(chunk => chunk.delta as string).join('')
  return { part, text, replace: chunks.some(chunk => chunk.type === 'text-start' && chunk.id === part) }
}

/** A thread's last activity: when its last reply was written, else its last update. */
export function lastActivity(thread: { lastReplyAt?: string | null; updatedAt: string }) {
  return thread.lastReplyAt ?? thread.updatedAt
}

/** How a row says when: 刚刚 under a minute, 昨天 for the calendar day before, else a relative time. */
export function activityLabel(at: Date, now: Date): 'justNow' | 'yesterday' | 'relative' {
  if (now.getTime() - at.getTime() < 60_000) return 'justNow'
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
  return at.getFullYear() === yesterday.getFullYear() && at.getMonth() === yesterday.getMonth() && at.getDate() === yesterday.getDate() ? 'yesterday' : 'relative'
}

export type ThreadGroup = 'waiting' | 'running' | 'idle' | 'resolved'
/** The order everywhere: 等待回复 → 进行中 → 空闲 → 已解决. */
export const THREAD_GROUPS: readonly ThreadGroup[] = ['waiting', 'running', 'idle', 'resolved']

const ACTIVE = new Set(['queued', 'preparing', 'running', 'finishing'])
const OPEN_ISSUE = new Set(['backlog', 'todo', 'doing'])
const CLOSED_ISSUE = new Set(['done', 'canceled', 'duplicate'])

type PrLink = { url: string; state: 'open' | 'merged' | 'closed' }
type GroupedThread = { id: string; status: string; issueId: string | null; createdAt: string; superseded: boolean }
/** The task a thread works on, as far as grouping needs it. */
export type GroupIssue = { status: string; metadata: { pullRequests: readonly PrLink[] } }

export function threadIsActive(thread: { status: string }) {
  return ACTIVE.has(thread.status)
}

/**
 * Which group a thread is in.
 * - 等待回复: waiting for input; a failed thread nothing replaced (no retry of
 *   it, and the newest on its task or without one); a finished thread whose
 *   task has an open PR or is in review.
 * - 进行中: queued, preparing, running or finishing.
 * - 空闲: the newest thread on a task still open (backlog, todo, doing),
 *   finished or stopped, with no PR waiting; also a stopped thread without a task.
 * - 已解决: cancelled; its task is done, cancelled or a duplicate; its PR is
 *   merged; a newer thread on its task replaced it; finished without a task.
 * A stopped thread whose task has an open PR waits like a finished one.
 */
export function threadGroup(thread: GroupedThread, issue: GroupIssue | undefined, newestOnIssue: boolean): ThreadGroup {
  if (thread.status === 'waiting_input') return 'waiting'
  if (ACTIVE.has(thread.status)) return 'running'
  if (thread.status === 'cancelled') return 'resolved'
  if (issue && CLOSED_ISSUE.has(issue.status)) return 'resolved'
  if (thread.status === 'failed') return !thread.superseded && (!issue || newestOnIssue) ? 'waiting' : 'resolved'
  if (!issue) return thread.status === 'stopped' ? 'idle' : 'resolved'
  if (!newestOnIssue) return 'resolved'
  if (issue.status === 'review' || issue.metadata.pullRequests.some(pr => pr.state === 'open')) return 'waiting'
  if (issue.metadata.pullRequests.some(pr => pr.state === 'merged')) return 'resolved'
  return OPEN_ISSUE.has(issue.status) ? 'idle' : 'resolved'
}

/** Threads by group, each kept in the order given. "Newest on its task" compares creation times. */
export function groupThreads<T extends GroupedThread>(threads: readonly T[], issueOf: (issueId: string) => GroupIssue | undefined): Record<ThreadGroup, T[]> {
  const groups: Record<ThreadGroup, T[]> = { waiting: [], running: [], idle: [], resolved: [] }
  const newest = new Map<string, T>()
  for (const thread of threads) {
    if (!thread.issueId) continue
    const current = newest.get(thread.issueId)
    if (!current || thread.createdAt > current.createdAt) newest.set(thread.issueId, thread)
  }
  for (const thread of threads) {
    const issue = thread.issueId ? issueOf(thread.issueId) : undefined
    groups[threadGroup(thread, issue, !!thread.issueId && newest.get(thread.issueId) === thread)].push(thread)
  }
  return groups
}

export type PrGroup = 'review' | 'running' | 'merged'
export const PR_GROUPS: readonly PrGroup[] = ['review', 'running', 'merged']

export type PullRequestRow = { url: string; number: number; issueId: string; group: PrGroup }
type PrIssue = { id: string; metadata: { pullRequests: readonly PrLink[] } }

/**
 * A bot's PRs: the pull requests linked to the tasks its threads worked on
 * (a run's report names no PR, so they go by task), newest thread first. An
 * open PR whose task still has one of these threads running is 进行中, any
 * other open PR waits for review, a merged one is 已合并, and a closed one is
 * left out.
 */
export function pullRequestsOf(threads: readonly Omit<GroupedThread, 'createdAt' | 'superseded'>[], issues: readonly PrIssue[]): PullRequestRow[] {
  const rows: PullRequestRow[] = []
  const seen = new Set<string>()
  for (const thread of threads) {
    if (!thread.issueId || seen.has(thread.issueId)) continue
    seen.add(thread.issueId)
    const issue = issues.find(item => item.id === thread.issueId)
    if (!issue) continue
    const running = threads.some(item => item.issueId === issue.id && ACTIVE.has(item.status))
    for (const pr of issue.metadata.pullRequests) {
      const number = Number(/\/pull\/(\d+)\/?$/.exec(pr.url)?.[1])
      if (pr.state === 'closed' || !number || rows.some(row => row.url === pr.url)) continue
      rows.push({ url: pr.url, number, issueId: issue.id, group: pr.state === 'merged' ? 'merged' : running ? 'running' : 'review' })
    }
  }
  return rows
}
