'use client'

import { useTranslations } from 'next-intl'
import { localTaskState, type TaskReason } from '@/hooks/use-bot-tasks'

/**
 * How one run came out, in the one set of words for it (glossary: Run result). The task page's 活动 rows, the right
 * column's 活动 rows and the task conversation's run lines all read it; iOS uses the same words (MobileCore.attempts).
 * It is the run's own runtime result, never the task's status (#1687: task status, Factory stage, run status and
 * blocked/needs-you are four things).
 */
export type RunResult = 'running' | 'queued' | 'waiting' | 'done' | 'failed' | 'blocked' | 'idle' | 'ended'

/** An open task with no PRs: the run alone decides, as on a card that does not carry its task. */
const OPEN_TASK = { status: 'doing', metadata: { pullRequests: [] } }

/**
 * A run by its own result, without its task's board status or PRs. `latest` is the task's current run: an earlier
 * one that was left waiting on the person has ended, since the conversation went on past it. Every other earlier run
 * keeps its own result (完成, 失败, 受阻).
 */
export function runResult(run: { status: string; outcome?: string | null }, latest: boolean): { result: RunResult; reason: TaskReason | null } {
  const { state, reason } = localTaskState(OPEN_TASK, run)
  const result: RunResult = state === 'canceled' || state === 'duplicate' ? 'done' : state === 'todo' ? 'idle' : state
  if (!latest && result === 'waiting') return { result: 'ended', reason: null }
  // A blocked Run already says 受阻; the reason slot is for what it waits on.
  return { result, reason: reason === 'blocked' ? null : reason }
}

/** A run result's words: what it waits on (等你回复, 等你确认, 待审阅, 额度用完) when it says, else the result's name. */
export function useRunResultLabel() {
  const t = useTranslations('Shell.panel.task')
  return (result: RunResult, reason: TaskReason | null) => reason ? t(`reason.${reason}`) : t(`result.${result}`)
}
