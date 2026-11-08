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

/**
 * A task is one conversation (Alex 2026-11-08). Runs with the same Agent in a row (follow-ups, waiting for a reply,
 * the factory's review, verify and fix) are one stretch of it; a new stretch starts only when the task switched to
 * another Agent (Claude Code ↔ Codex ↔ Cursor). Oldest first.
 */
export type AgentRun = { harness: string; attempts: Attempt[] }
export function agentRuns(activity: readonly TaskActivity[]): AgentRun[] {
  const runs: AgentRun[] = []
  for (const attempt of activity.filter((item): item is Attempt => item.kind === 'attempt').sort((a, b) => a.n - b.n)) {
    const last = runs.at(-1)
    if (last && last.harness === attempt.harness) last.attempts.push(attempt)
    else runs.push({ harness: attempt.harness, attempts: [attempt] })
  }
  return runs
}

/** A factory stage's start, marked inline in the conversation; implementing is the conversation itself. */
const STAGE_MARK: Partial<Record<NonNullable<Attempt['stage']>, string>> = { review: '独立审查', verify: '验证', fix: '修复' }

/**
 * What sits between two runs of the task's conversation. 「尝试」 appears only where the Agent changed: 「换 Claude Code
 * 继续」, or 「第 1 次尝试失败 · 换 Claude Code 再试」 when the run before failed, counting Agent switches only. With the
 * same Agent nothing divides them; where a factory stage starts (`stage`, when the server sends it) a small marker
 * says which. No stage, no marker.
 */
export type Boundary = { kind: 'switch'; text: string } | { kind: 'stage'; text: string } | null
export function boundary(activity: readonly TaskActivity[], previous: Attempt, next: Attempt): Boundary {
  if (next.harness !== previous.harness) {
    const run = agentRuns(activity).findIndex(item => item.attempts.some(attempt => attempt.runId === previous.runId)) + 1
    const failed = attemptState(previous) === 'failed'
    return { kind: 'switch', text: failed ? `第 ${run} 次尝试失败 · 换 ${agent(next.harness)} 再试` : `换 ${agent(next.harness)} 继续` }
  }
  const mark = next.stage ? STAGE_MARK[next.stage] : undefined
  return mark ? { kind: 'stage', text: mark } : null
}

/** 活动 on the task's page: its creation and replaced threads, and one row per Agent's stretch, oldest first. */
export type ActivityEntry = Exclude<TaskActivity, Attempt> | { kind: 'agent'; run: AgentRun; switched: boolean }
export function activityEntries(activity: readonly TaskActivity[]): ActivityEntry[] {
  // The server sends 活动 newest first.
  const oldestFirst = [...activity].reverse()
  const entries: ActivityEntry[] = []
  let runs = 0
  for (const item of oldestFirst) {
    if (item.kind !== 'attempt') { entries.push(item); continue }
    const last = entries.at(-1)
    if (last?.kind === 'agent' && last.run.harness === item.harness) last.run.attempts.push(item)
    else entries.push({ kind: 'agent', run: { harness: item.harness, attempts: [item] }, switched: runs++ > 0 })
  }
  return entries
}

/** An Agent's row in 活动: 「Codex」, or 「换 Claude Code」 where the task switched to it. */
export const agentRunTitle = (entry: Extract<ActivityEntry, { kind: 'agent' }>) => entry.switched ? `换 ${agent(entry.run.harness)}` : agent(entry.run.harness)

/** The Agent of the newest attempt, under the task's title. */
export const currentAgent = (segments: readonly Segment[]) => segments.length ? agent(segments[segments.length - 1]!.attempt.harness) : null
