// One vocabulary and one renderer for every state mark (R-52, decision 2026-11-19-1600): a mark is a shape name
// and a tone name. This module holds the vocabulary, the six domains' tables and their resolvers, as plain data
// and functions, so a dot, a badge and a chip all read the same row and no two surfaces can disagree about what a
// status looks like. `components/workspace/state-mark.tsx` draws them; nothing here imports React.
import { ISSUE_PRIORITY_CODES, ISSUE_STATUS_CODES, type IssuePriority, type IssueStatus } from './issue-meta'
import type { StatusTone } from './status-appearance'
import type { RunIndicator } from './task-state'
import type { ThreadGroup } from './thread-groups'

/**
 * The closed shape vocabulary. The renderer's `Record<MarkShape, …>` is typed against this list, so a name
 * without a drawing is a compile error and a drawing without a name is too.
 */
export const MARK_SHAPE_NAMES = ['dashed', 'empty', 'half', 'progress', 'check', 'x', 'slash', 'hand', 'question', 'alert', 'urgent', 'bars-1', 'bars-2', 'bars-3'] as const
export type MarkShape = (typeof MARK_SHAPE_NAMES)[number]

/** The closed tone vocabulary: a colour word, and the semantic text token it draws in. */
export const MARK_TONE_NAMES = ['gray', 'yellow', 'green', 'blue', 'purple', 'red'] as const
export type MarkTone = (typeof MARK_TONE_NAMES)[number]
export type MarkSpec = { shape: MarkShape; tone: MarkTone }
/** `sm` is a row's or a chip's 14px, `md` 16, `lg` 18. */
export type MarkSize = 'sm' | 'md' | 'lg'

/**
 * A mark is one colour: the token of its tone, taken as `currentColor`. `blue` is the label palette's blue and
 * `purple` is `--info`, which this product draws violet (`app/globals.css`: `--info: var(--color-violet-500)`),
 * so the two names are the product's blue and its violet rather than two names for one colour.
 */
export const markToneClass: Record<MarkTone, string> = {
  gray: 'text-muted-foreground',
  yellow: 'text-warning-foreground',
  green: 'text-success-foreground',
  blue: 'text-label-blue',
  purple: 'text-info-foreground',
  red: 'text-destructive-foreground',
}

/**
 * The badge-or-dot tint of a mark, so a chip, a dot and a badge showing one mark are one colour: a dot beside a
 * chip reads the same row as the chip. `blue` and `purple` are both `info` because the tint set has no blue of
 * its own; a shape still tells them apart.
 */
export const MARK_TONE_STATUS: Record<MarkTone, StatusTone> = {
  gray: 'neutral',
  yellow: 'warning',
  green: 'success',
  blue: 'info',
  purple: 'info',
  red: 'destructive',
}

/**
 * The one way to get a colour out of a mark. Everything that paints a state — the mark itself, a status dot, a
 * badge variant — takes it from here, so the amber chip with a green dot beside it cannot be written again.
 */
export function stateMarkTone(mark: MarkSpec): StatusTone {
  return MARK_TONE_STATUS[mark.tone]
}

const isStatus = (value: string) => ISSUE_STATUS_CODES.some(code => code === value)
const isPriority = (value: string) => ISSUE_PRIORITY_CODES.some(code => code === value)

/**
 * The issue statuses' colours. Reading Capy 0.9.2 live settled them: 评审中 is
 * their `text-success` (oklch hue 143, green) and 完成 is the one violet state,
 * their `text-complete` (`oklch(60% .19 300)`), which is Linear's order too.
 * This table used to have those two swapped, so a finished issue read as review.
 * `doing` is yellow and the rest are grey, as Capy draws them.
 * The `Record<IssueStatus, …>` makes a status the enum adds but this table
 * forgets a compile error.
 */
export const ISSUE_STATUS_MARKS: Record<IssueStatus, MarkSpec> = {
  backlog: { shape: 'dashed', tone: 'gray' },
  todo: { shape: 'empty', tone: 'gray' },
  doing: { shape: 'half', tone: 'yellow' },
  review: { shape: 'progress', tone: 'green' },
  done: { shape: 'check', tone: 'purple' },
  canceled: { shape: 'x', tone: 'gray' },
  duplicate: { shape: 'slash', tone: 'gray' },
}

/** 紧急 is the one amber priority; the others are grey bars, as Linear draws them. */
export const ISSUE_PRIORITY_MARKS: Record<IssuePriority, MarkSpec> = {
  urgent: { shape: 'urgent', tone: 'yellow' },
  high: { shape: 'bars-3', tone: 'gray' },
  normal: { shape: 'bars-2', tone: 'gray' },
  low: { shape: 'bars-1', tone: 'gray' },
}

/**
 * A thread's group (`lib/thread-groups.ts`), from the same shapes a task's status uses: 进行中 is the half ring,
 * 等待你 the hand, 受阻 the cross, 空闲 the open ring, 已解决 the check. A thread is no longer its own glyph
 * (decision 2026-11-19-1630, which replaces the bubble of 2026-11-04-2330).
 */
export const THREAD_MARKS: Record<ThreadGroup, MarkSpec> = {
  running: { shape: 'half', tone: 'yellow' },
  waiting: { shape: 'hand', tone: 'blue' },
  blocked: { shape: 'x', tone: 'red' },
  idle: { shape: 'empty', tone: 'gray' },
  resolved: { shape: 'check', tone: 'green' },
}

/** What an Agent is doing on one conversation: the Agent mark of R-52 (a turning ring, the hand, a triangle). */
export const RUN_MARKS: Record<RunIndicator, MarkSpec> = {
  working: { shape: 'progress', tone: 'yellow' },
  waiting: { shape: 'hand', tone: 'blue' },
  error: { shape: 'alert', tone: 'red' },
}

export type PullRequestState = 'open' | 'draft' | 'merged' | 'closed'

/** A pull request's state, for the surfaces that draw it as a state rather than as GitHub's own glyph. */
export const PULL_REQUEST_MARKS: Record<PullRequestState, MarkSpec> = {
  open: { shape: 'progress', tone: 'green' },
  draft: { shape: 'empty', tone: 'gray' },
  merged: { shape: 'check', tone: 'purple' },
  closed: { shape: 'x', tone: 'red' },
}

const STATUS_ELSE = ISSUE_STATUS_MARKS.backlog
const PRIORITY_ELSE = ISSUE_PRIORITY_MARKS.low

/** A status key in, its mark out. A string, because the API's status is one; an unknown one draws 待整理's. */
export function statusMarkOf(status: string): MarkSpec {
  return isStatus(status) ? ISSUE_STATUS_MARKS[status as IssueStatus] : STATUS_ELSE
}

/** A priority key in, its mark out; an unknown one draws the lowest bars. */
export function priorityMarkOf(priority: string): MarkSpec {
  return isPriority(priority) ? ISSUE_PRIORITY_MARKS[priority as IssuePriority] : PRIORITY_ELSE
}

export function threadMarkOf(group: ThreadGroup): MarkSpec {
  return THREAD_MARKS[group]
}

export function runMarkOf(indicator: RunIndicator): MarkSpec {
  return RUN_MARKS[indicator]
}

export function pullRequestMarkOf(state: PullRequestState): MarkSpec {
  return PULL_REQUEST_MARKS[state]
}

/** The run and thread words older call sites hand a dot (`StatusDot`, a machine's state) instead of a status. */
const ROW_WORDS: Record<string, MarkSpec> = {
  running: THREAD_MARKS.running,
  working: RUN_MARKS.working,
  queued: RUN_MARKS.working,
  waiting: THREAD_MARKS.waiting,
  failed: RUN_MARKS.error,
  error: RUN_MARKS.error,
}

/**
 * A value a row carries — an issue status, or one of the run/thread words a dot is given — as its mark. Unknown
 * words draw the open ring, grey.
 */
export function markOfValue(value: string): MarkSpec {
  return isStatus(value) ? ISSUE_STATUS_MARKS[value as IssueStatus] : ROW_WORDS[value] ?? THREAD_MARKS.idle
}

/**
 * 等待你 is not a status (R-52: what needs the person is 收件箱, and no status is added for it), so no status
 * draws this. A surface that needs the hand draws it from here. Making it a status is a change in
 * `lib/issue-meta.ts` (`ISSUE_STATUS_CODES`), `issue-properties.ts` (`ISSUE_STATUSES`) and this file's table —
 * not in a component.
 */
export const NEEDS_YOU_MARK: MarkSpec = { shape: 'hand', tone: 'blue' }
