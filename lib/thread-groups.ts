/** How the right column groups threads and a bot's PRs. Pure, so it can be tested without a database. */
import { markdownLine } from './agent-history'

/** How much of a thread's last reply is stored: one row's worth, cut on screen. */
export const LAST_REPLY_CHARS = 240

/** A reply's opening as one plain line: the chat's markdown stripped (as in the bot list), whitespace collapsed. */
export function replyLine(text: string | null | undefined): string | null {
  return text ? markdownLine(text) || null : null
}

/**
 * The text a batch adds to the last reply: the deltas of its last text part
 * that carries any. Null when no delta in the batch carries text. Pass only
 * the chunks stored by this request, so a re-sent chunk never counts twice.
 */
export function lastReplyUpdate(chunks: readonly Record<string, unknown>[]): { part: string; text: string } | null {
  // The last part with real text; a part opened by whitespace alone does not take over yet.
  let part: string | null = null
  let any: string | null = null
  for (const chunk of chunks) {
    if (chunk.type !== 'text-delta' || typeof chunk.id !== 'string' || typeof chunk.delta !== 'string' || !chunk.delta) continue
    any = chunk.id
    if (chunk.delta.trim()) part = chunk.id
  }
  part ??= any
  if (part === null) return null
  const text = chunks.filter(chunk => chunk.type === 'text-delta' && chunk.id === part && typeof chunk.delta === 'string').map(chunk => chunk.delta as string).join('')
  return { part, text }
}

/** The chunks of a batch starting at `fromSeq` that this request stored: a re-sent seq that was already there is left out. */
export function freshChunks<T>(chunks: readonly T[], fromSeq: number, insertedSeqs: Iterable<number>): T[] {
  const fresh = new Set(insertedSeqs)
  return chunks.filter((_, index) => fresh.has(fromSeq + index))
}

export type StoredReply = { lastReply: string | null; lastReplyPart: string | null }

/**
 * The run's next stored reply after a batch, from the stored reply and its
 * part alone (run_chunks is never read). The same part appends; another part
 * replaces. A full reply (LAST_REPLY_CHARS) keeps its text and only its time
 * moves. Null when nothing changes: no text in the batch, or a new part whose
 * text is only whitespace so far.
 */
export function nextReply(stored: StoredReply, chunks: readonly Record<string, unknown>[]): StoredReply | null {
  const update = lastReplyUpdate(chunks)
  if (!update) return null
  if (update.part === stored.lastReplyPart) {
    const current = Array.from(stored.lastReply ?? '')
    if (current.length >= LAST_REPLY_CHARS) return { ...stored }
    return { lastReply: [...current, ...Array.from(update.text)].slice(0, LAST_REPLY_CHARS).join(''), lastReplyPart: update.part }
  }
  if (!update.text.trim()) return null
  return { lastReply: Array.from(update.text).slice(0, LAST_REPLY_CHARS).join(''), lastReplyPart: update.part }
}

/** A thread's last activity, whether it was a reply or a status update. */
export function lastActivity(thread: { lastReplyAt?: string | null; updatedAt: string }) {
  return thread.lastReplyAt && thread.lastReplyAt > thread.updatedAt ? thread.lastReplyAt : thread.updatedAt
}

/** How a row says when: 刚刚 under a minute, 昨天 for the calendar day before, else a relative time. */
export function activityLabel(at: Date, now: Date): 'justNow' | 'yesterday' | 'relative' {
  if (now.getTime() - at.getTime() < 60_000) return 'justNow'
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
  return at.getFullYear() === yesterday.getFullYear() && at.getMonth() === yesterday.getMonth() && at.getDate() === yesterday.getDate() ? 'yesterday' : 'relative'
}

export type ThreadGroup = 'running' | 'blocked' | 'waiting' | 'idle' | 'resolved'
/** The order everywhere: 进行中 → 受阻 → 等待你 → 空闲 → 已解决 (R-52). */
export const THREAD_GROUPS: readonly ThreadGroup[] = ['running', 'blocked', 'waiting', 'idle', 'resolved']

const ACTIVE = new Set(['queued', 'preparing', 'running', 'finishing'])
const CLOSED_ISSUE = new Set(['done', 'canceled', 'duplicate'])

/** How an ended run came out, as the decision model judged it (lib/run-outcome.ts). */
export type ThreadOutcome = 'done' | 'blocked' | 'needs_input' | 'failed' | 'idle'
type PrLink = { url: string; state: 'open' | 'draft' | 'merged' | 'closed' }
type GroupedThread = { id: string; status: string; issueId: string | null; createdAt: string; outcome?: ThreadOutcome | null }
/** The task a thread works on, as far as grouping needs it. */
export type GroupIssue = { status: string; metadata: { pullRequests: readonly PrLink[] } }

export function threadIsActive(thread: { status: string }) {
  return ACTIVE.has(thread.status)
}

/**
 * Which group a thread is in (R-52). The run's state decides only 进行中 and
 * 等待你 for a run asking a question; for an ended run the judged outcome
 * decides, and only facts close a thread without one.
 * - 进行中: queued, preparing, running or finishing.
 * - 已解决: its task is done, cancelled or a duplicate, or its PR is merged;
 *   else only when the judged outcome is done.
 * - 受阻: paused (its quota ran out); judged blocked or failed.
 * - 等待你: waiting for input; judged needs_input; its task has a PR to review
 *   (open PR or in review) and the run was not blocked.
 * - 空闲: judged idle.
 * Not judged yet (or no judge answered): a failed run is 受阻, any other 等待你.
 * Never 已解决 without a done outcome or a closed task or merged PR.
 */
export function threadGroup(thread: GroupedThread, issue: GroupIssue | undefined): ThreadGroup {
  if (ACTIVE.has(thread.status)) return 'running'
  if (thread.status === 'waiting_input') return 'waiting'
  if (thread.status === 'paused') return 'blocked'
  if (issue && (CLOSED_ISSUE.has(issue.status) || issue.metadata.pullRequests.some(pr => pr.state === 'merged'))) return 'resolved'
  const outcome = thread.outcome ?? null
  if (outcome === 'blocked' || outcome === 'failed') return 'blocked'
  if (issue && (issue.status === 'review' || issue.metadata.pullRequests.some(pr => pr.state === 'open' || pr.state === 'draft'))) return 'waiting'
  if (outcome === 'done') return 'resolved'
  if (outcome === 'idle') return 'idle'
  if (outcome === 'needs_input') return 'waiting'
  return thread.status === 'failed' ? 'blocked' : 'waiting'
}

/** A row of the list: a task's newest thread, with how many threads that task has had (第 N 次尝试). */
export type ThreadRowOf<T> = T & { attempts: number }

/**
 * Threads by group, each kept in the order given. A task's threads fold into
 * its newest one (by creation time), which carries the task's attempt count
 * and is grouped by its own state and outcome; a thread without a task is its
 * own row.
 */
export function groupThreads<T extends GroupedThread>(threads: readonly T[], issueOf: (issueId: string) => GroupIssue | undefined): Record<ThreadGroup, ThreadRowOf<T>[]> {
  const groups: Record<ThreadGroup, ThreadRowOf<T>[]> = { running: [], blocked: [], waiting: [], idle: [], resolved: [] }
  const newest = new Map<string, T>()
  const attempts = new Map<string, number>()
  for (const thread of threads) {
    if (!thread.issueId) continue
    attempts.set(thread.issueId, (attempts.get(thread.issueId) ?? 0) + 1)
    const current = newest.get(thread.issueId)
    if (!current || thread.createdAt > current.createdAt) newest.set(thread.issueId, thread)
  }
  for (const thread of threads) {
    if (thread.issueId && newest.get(thread.issueId) !== thread) continue
    const issue = thread.issueId ? issueOf(thread.issueId) : undefined
    groups[threadGroup(thread, issue)].push({ ...thread, attempts: thread.issueId ? attempts.get(thread.issueId)! : 1 })
  }
  return groups
}

export type PrGroup = 'review' | 'running' | 'merged'
export const PR_GROUPS: readonly PrGroup[] = ['review', 'running', 'merged']

/** `state` is GitHub's, for the row's PR icon (R-34: never colour alone). */
export type PullRequestRow = { url: string; number: number; issueId: string; group: PrGroup; state: Exclude<PrLink['state'], 'closed'> }
type PrIssue = { id: string; metadata: { pullRequests: readonly PrLink[] } }

/**
 * A bot's PRs: the pull requests linked to the tasks its threads worked on
 * (a run's report names no PR, so they go by task), newest thread first. An
 * open PR whose task still has one of these threads running is 进行中, any
 * other open PR waits for review, a merged one is 已合并, and a closed one is
 * left out.
 */
export function pullRequestsOf(threads: readonly Omit<GroupedThread, 'createdAt' | 'outcome'>[], issues: readonly PrIssue[]): PullRequestRow[] {
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
      rows.push({ url: pr.url, number, issueId: issue.id, group: pr.state === 'merged' ? 'merged' : running ? 'running' : 'review', state: pr.state })
    }
  }
  return rows
}
