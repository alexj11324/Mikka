/** How the right column groups threads and a bot's PRs. Pure, so it can be tested without a database. */

/** How much of a thread's last reply the server sends: one row's worth, cut on screen. */
export const LAST_REPLY_CHARS = 240

/** A reply's opening on one line: every run of whitespace, line breaks included, becomes one space. */
export function replyLine(text: string | null | undefined): string | null {
  const line = text?.replace(/\s+/g, ' ').trim()
  return line || null
}

export type ThreadGroup = 'waiting' | 'running' | 'idle' | 'resolved'
/** The order everywhere: 等待回复 → 进行中 → 空闲 → 已解决. */
export const THREAD_GROUPS: readonly ThreadGroup[] = ['waiting', 'running', 'idle', 'resolved']

const ACTIVE = new Set(['queued', 'preparing', 'running', 'finishing'])
const IDLE = new Set(['stopped', 'cancelled'])
const CLOSED_ISSUE = new Set(['done', 'canceled', 'duplicate'])

type GroupedThread = { id: string; status: string; issueId: string | null }

export function threadIsActive(thread: { status: string }) {
  return ACTIVE.has(thread.status)
}

/**
 * Threads by group, each kept in the order given (newest first). A thread
 * waiting for input, a failed one, and the newest finished thread on a task
 * that is still open all wait for the person (等待回复). A stopped or
 * cancelled thread is idle. Any other finished thread is resolved.
 */
export function groupThreads<T extends GroupedThread>(threads: readonly T[], issueStatus: (issueId: string) => string | undefined): Record<ThreadGroup, T[]> {
  const groups: Record<ThreadGroup, T[]> = { waiting: [], running: [], idle: [], resolved: [] }
  const seenIssues = new Set<string>()
  for (const thread of threads) {
    const newestOnIssue = !!thread.issueId && !seenIssues.has(thread.issueId)
    if (thread.issueId) seenIssues.add(thread.issueId)
    if (thread.status === 'waiting_input' || thread.status === 'failed') groups.waiting.push(thread)
    else if (ACTIVE.has(thread.status)) groups.running.push(thread)
    else if (IDLE.has(thread.status)) groups.idle.push(thread)
    else {
      const status = thread.issueId ? issueStatus(thread.issueId) : undefined
      groups[newestOnIssue && status && !CLOSED_ISSUE.has(status) ? 'waiting' : 'resolved'].push(thread)
    }
  }
  return groups
}

export type PrGroup = 'review' | 'running' | 'merged'
export const PR_GROUPS: readonly PrGroup[] = ['review', 'running', 'merged']

export type PullRequestRow = { url: string; number: number; issueId: string; group: PrGroup }
type PrIssue = { id: string; metadata: { pullRequests: readonly { url: string; state: 'open' | 'merged' | 'closed' }[] } }

/**
 * A bot's PRs: the pull requests linked to the tasks its threads worked on,
 * newest thread first. An open PR whose task still has one of these threads
 * running is 进行中, any other open PR waits for review, a merged one is
 * 已合并, and a closed one is left out.
 */
export function pullRequestsOf(threads: readonly GroupedThread[], issues: readonly PrIssue[]): PullRequestRow[] {
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
