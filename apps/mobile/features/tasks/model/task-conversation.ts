import { taskFactoryLabel, type TaskFactoryEvent } from '../../../../../lib/task-factory-events'
import { chronologicalActivity, taskHistoryLabel, type TaskActivityFact } from '../../../../../lib/task-activity-timeline'
import { HARNESS } from '@/lib/harness'
import { mobileMessages } from '@/lib/messages'
import type { TaskActivity, TaskDetail, ThreadItem } from '@/lib/types'

export type Attempt = Extract<TaskActivity, { kind: 'attempt' }>
/** One attempt's part of the task's conversation, and the raw error it ended with (2026-11-05-0330: inside the attempt). */
export type Segment = { attempt: Attempt; items: ThreadItem[]; error: string | null }

/**
 * A task's one conversation (Alex 2026-11-07: the second run comes after the first): each attempt's thread, oldest at the
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

/** Older servers sent numbered attempts but no explicit reply target. Keep their readable
 * conversation working and exclude any independently marked review or verification. */
export function conversationReplyRun(task: Pick<TaskDetail['task'], 'replyRunId'>, activity: readonly TaskActivity[]): string | null {
  if (task.replyRunId !== undefined) return task.replyRunId
  let latest: Attempt | undefined
  for (const item of activity) {
    if (item.kind === 'attempt' && item.stage !== 'verify' && item.stage !== 'review' && (!latest || item.n > latest.n)) latest = item
  }
  return latest?.runId ?? null
}

const agent = (harness: string) => HARNESS[harness] ?? harness

/**
 * A task is one conversation (Alex 2026-11-08). Runs with the same Agent in a row (follow-ups, waiting for a reply,
 * the factory's review, verify and fix) are one stretch of it; a new stretch starts only when the task switched to
 * another Agent (Claude Code ↔ Codex ↔ Cursor).
 */
export type AgentRun = { harness: string; attempts: Attempt[] }

/**
 * A factory stage's start, marked inline in the conversation (2026-11-04-2200). Implementing is the conversation
 * itself, and verification belongs to it, so neither is marked; 审阅 is its own result card (reviewRun), not a marker.
 */
const STAGE_MARK: Partial<Record<NonNullable<Attempt['stage']>, string>> = { fix: mobileMessages.MobileCore.conversation.fix }

/** The factory's review: one run per task, drawn as a 审阅 result card that opens to its transcript. */
export const reviewRun = (attempt: Pick<Attempt, 'stage'>) => attempt.stage === 'review'

/**
 * What sits between two runs of the task's conversation (Alex 2026-11-09: no 「尝试」, no numbering and, as Warp shows
 * it, no switch verb). Only where the Agent changed: the next Agent itself, its glyph and name. With the same Agent
 * nothing divides them; where the factory goes back to fix (`stage`, when the server sends it) a small marker says so.
 * No stage, no marker; the review is its own card.
 */
export type Boundary = { kind: 'agent'; harness: string } | { kind: 'stage'; text: string } | null
export function boundary(previous: Attempt, next: Attempt): Boundary {
  if (next.harness !== previous.harness) return { kind: 'agent', harness: next.harness }
  const mark = next.stage ? STAGE_MARK[next.stage] : undefined
  return mark ? { kind: 'stage', text: mark } : null
}

/** 活动 on the task's page: its creation and replaced threads, and one row per Agent's stretch, oldest first. */
export type ActivityEntry = Exclude<TaskActivity, Attempt> | TaskActivityFact | TaskFactoryEvent | { kind: 'agent'; run: AgentRun }

export function nativeActivityLabel(item: TaskActivityFact | TaskFactoryEvent) {
  if (item.kind === 'factory_gate' || item.kind === 'evidence') return taskFactoryLabel(item, {
    ...mobileMessages.GroupTask, ...mobileMessages.FactoryAcceptance.kind, pullRequest: mobileMessages.FactoryAcceptance.pullRequest,
  })
  if (item.kind !== 'history') return [item.author, item.body].filter(Boolean).join(' · ')
  const { Workspace, Issue } = mobileMessages
  const lookup = (map: Record<string, string>, key: string) => map[key] ?? key
  const description = taskHistoryLabel(item.event, {
    created: Workspace.detail.createdTask,
    activity: (key, values = {}) => Workspace.activity[key].replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole),
    status: value => lookup(Issue.status, value),
    priority: value => lookup(Issue.priority, value),
  })
  return [item.event.actor?.name, description].filter(Boolean).join(' · ')
}

export function activityEntryId(item: ActivityEntry) {
  if ('id' in item) return item.id
  if (item.kind === 'agent') return `run:${item.run.attempts[0]!.runId}`
  if (item.kind === 'replaced') return `replaced:${item.runId}`
  return 'created'
}
export function activityEntries(activity: readonly TaskActivity[], facts: readonly (TaskActivityFact | TaskFactoryEvent)[] = []): ActivityEntry[] {
  // The server sends 活动 newest first.
  const hasCreation = facts.some(item => item.kind === 'history' && item.event.kind === 'created')
  const oldestFirst = chronologicalActivity([
    ...activity.filter(item => !(hasCreation && item.kind === 'created')).map(item => ({
      id: item.kind === 'attempt' ? `run:${item.runId}` : item.kind === 'replaced' ? `replaced:${item.runId}` : 'created', at: item.createdAt, item,
    })),
    ...facts.map(item => ({ id: item.id, at: item.at, item })),
  ]).map(row => row.item)
  const entries: ActivityEntry[] = []
  for (const item of oldestFirst) {
    if (item.kind !== 'attempt') { entries.push(item); continue }
    const last = entries.at(-1)
    if (last?.kind === 'agent' && last.run.harness === item.harness) last.run.attempts.push(item)
    else entries.push({ kind: 'agent', run: { harness: item.harness, attempts: [item] } })
  }
  return entries
}


/** The Agent of the newest attempt, under the task's title. */
export const currentAgent = (segments: readonly Segment[]) => segments.length ? agent(segments[segments.length - 1]!.attempt.harness) : null
