/**
 * 受阻 on the board (2026-11-06): a group a task falls into, not a status. A task
 * keeps its own status (待办, 进行中…) and is shown in the 受阻 column while
 * something stops it; once that clears it is back in its own column, because its
 * status never moved. As Jira's flag and Linear's "blocked by", beside the status.
 *
 * What blocks it, first match:
 * - its newest thread asks the person a question (等你回答);
 * - that thread is 受阻 (R-52): quota ran out, judged blocked, or failed;
 * - a task it is blocked by (`blockedByIds`) is still open;
 * - the person flagged it (`block.blocked`).
 * The person can also clear it: `block: { blocked: false, runId }` hides what
 * that newest thread (or, with `runId: null`, no thread) says, until a newer
 * thread runs. A closed task is never blocked. Pure, so it is tested without a database.
 */
import { threadGroup, type ThreadOutcome } from './thread-groups'

export type BlockReason = 'question' | 'quota' | 'run' | 'failed' | 'dependency' | 'flagged'
export const BLOCK_REASONS: readonly BlockReason[] = ['question', 'quota', 'run', 'failed', 'dependency', 'flagged']

/** The person's own say, kept in the task's metadata (`lib/issue-metadata.ts`). */
export type BlockFlag = { blocked: boolean; runId: string | null }

/** The task's newest thread as far as 受阻 needs it (`listTaskRuns`). */
export type BlockRun = { runId: string; status: string; outcome: ThreadOutcome | null }

export type BlockIssue = {
  status: string
  metadata: { pullRequests: readonly { url: string; state: 'open' | 'draft' | 'merged' | 'closed' }[]; blockedByIds?: readonly string[]; block?: BlockFlag | null }
}

/** `blockerIdentifier` is the blocking task's MIK-12, filled in where the list knows it. */
export type TaskBlock = { reason: BlockReason; blockerId?: string; blockerIdentifier?: string | null }

const CLOSED = new Set(['done', 'canceled', 'duplicate'])

/** What its newest thread says, if anything stops the task. */
function runReason(issue: BlockIssue, run: BlockRun | undefined): BlockReason | null {
  if (!run) return null
  if (run.status === 'waiting_input') return 'question'
  const group = threadGroup({ id: run.runId, status: run.status, issueId: null, createdAt: '', outcome: run.outcome }, issue)
  if (group === 'blocked') return run.status === 'paused' ? 'quota' : run.outcome === 'blocked' ? 'run' : 'failed'
  // 等待你 also holds a task whose PR waits for review; only a question blocks it.
  if (group === 'waiting' && run.outcome === 'needs_input') return 'question'
  return null
}

/**
 * Why the task is 受阻, or null. `isOpen` says whether a task it is blocked by is
 * still open; a blocker it cannot see counts as open only when it says so.
 */
export function taskBlock(issue: BlockIssue, run: BlockRun | undefined, isOpen: (issueId: string) => boolean): TaskBlock | null {
  if (CLOSED.has(issue.status)) return null
  const flag = issue.metadata.block ?? null
  const cleared = flag?.blocked === false && flag.runId === (run?.runId ?? null)
  if (!cleared) {
    const reason = runReason(issue, run)
    if (reason) return { reason }
    const blockerId = (issue.metadata.blockedByIds ?? []).find(isOpen)
    if (blockerId) return { reason: 'dependency', blockerId }
  }
  return flag?.blocked ? { reason: 'flagged' } : null
}

/** The flag that moves a task out of 受阻 now: what its newest thread says is set aside until a newer one runs. */
export function clearedBlock(run: Pick<BlockRun, 'runId'> | undefined): BlockFlag {
  return { blocked: false, runId: run?.runId ?? null }
}

/** The flag that moves a task into 受阻 by hand. */
export const FLAGGED_BLOCK: BlockFlag = { blocked: true, runId: null }
