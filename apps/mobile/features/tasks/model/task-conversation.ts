import { HARNESS } from '@/lib/harness'
import type { TaskActivity, ThreadItem } from '@/lib/types'
import { attemptState } from './task-groups'

export type Attempt = Extract<TaskActivity, { kind: 'attempt' }>
/** One attempt's part of the task's conversation, and the raw error it ended with (2026-11-05-0330: inside the attempt). */
export type Segment = { attempt: Attempt; items: ThreadItem[]; error: string | null }

/**
 * A task's one conversation (Alex 2026-11-07: 「第二次尝试明显应该在第一次之后」): each attempt's thread, oldest at the
 * top. A thread read from an earlier run also holds the runs after it (R-81), so each attempt keeps only what no
 * newer attempt already shows.
 */
export function conversationSegments(activity: readonly TaskActivity[], threads: ReadonlyMap<string, { items: readonly ThreadItem[]; error: string | null }>): Segment[] {
  const attempts = activity.filter((item): item is Attempt => item.kind === 'attempt').sort((a, b) => a.n - b.n)
  const seen = new Set<string>()
  const segments: Segment[] = []
  for (const attempt of [...attempts].reverse()) {
    const thread = threads.get(attempt.runId)
    const items = (thread?.items ?? []).filter(item => !seen.has(item.id))
    for (const item of items) seen.add(item.id)
    segments.unshift({ attempt, items, error: thread?.error ?? null })
  }
  return segments
}

const agent = (harness: string) => HARNESS[harness] ?? harness

/** Between two attempts: 「第 1 次尝试失败 · 换 Claude Code 再试」, or 「· 再试」 with the same Agent. */
export function dividerText(previous: Attempt, next: Attempt): string {
  const result = attemptState(previous)
  const word = result === 'failed' ? '失败' : result === 'blocked' ? '受阻' : '结束'
  return `第 ${previous.n} 次尝试${word} · ${next.harness === previous.harness ? '再试' : `换 ${agent(next.harness)} 再试`}`
}

/** The Agent of the newest attempt, under the task's title. */
export const currentAgent = (segments: readonly Segment[]) => segments.length ? agent(segments[segments.length - 1]!.attempt.harness) : null
