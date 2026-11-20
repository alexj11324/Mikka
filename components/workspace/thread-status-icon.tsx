'use client'

import { useTranslations } from '@/lib/intl/i18n-client'
import { Badge } from '@/components/reui/badge'
import { Mark } from '@/components/workspace/state-mark'
import { stateMarkTone, threadMarkOf, type MarkSpec } from '@/lib/state-mark'
import type { StatusTone } from '@/lib/status-appearance'
import { THREAD_GROUPS, threadGroup, type ThreadGroup, type ThreadOutcome } from '@/lib/thread-groups'

/**
 * The group of one run seen alone (a card or chip, with no task or PR at hand),
 * by R-52: running states are 进行中, a run asking a question is 等待你, a judged
 * outcome decides the rest (done is 已解决). Not judged yet: failed is 受阻, any
 * other ended run 等待你, never 已解决.
 */
export function threadGroupOfRun(status: string, outcome?: ThreadOutcome | string | null, waiting = false): ThreadGroup {
  if (waiting) return 'waiting'
  return threadGroup({ id: '', status, issueId: null, createdAt: '', outcome: (outcome ?? null) as ThreadOutcome | null }, undefined)
}

/** The badge variant of each tint, so a badge reads as its mark does. */
const BADGE_VARIANT: Record<StatusTone, 'secondary' | 'info-light' | 'warning-light' | 'destructive-light' | 'success-light'> = {
  neutral: 'secondary', warning: 'warning-light', info: 'info-light', success: 'success-light', destructive: 'destructive-light', focus: 'secondary',
}

/** The badge colour of each group, taken from the group's mark (`stateMarkTone`), never from a table of its own. */
export const GROUP_BADGES = Object.fromEntries(THREAD_GROUPS.map(group => [group, BADGE_VARIANT[stateMarkTone(threadMarkOf(group))]])) as Record<ThreadGroup, (typeof BADGE_VARIANT)[StatusTone]>

/**
 * A thread's state, drawn as the mark its group owns (`lib/state-mark.ts`): 进行中 the half ring, 等待你 the hand, 受阻
 * the cross, 空闲 the open ring, 已解决 the check — the same shapes and tones a task's status uses, so a thread is no
 * longer a second drawing language (decision 2026-11-19-1630, which replaces the bubble of 2026-11-04-2330). The
 * colour never stands alone: the icon's label names the group, and lists and cards write it beside the icon.
 * `small` is the 14px of rows and chips; `accent` draws it in a chip's accent.
 */
export function ThreadStatusIcon({ status = '', outcome, waiting = false, group, small = false, accent = false, dot = true }: {
  status?: string
  outcome?: ThreadOutcome | string | null
  /** 等你回复 (Figma 382:6469): the thread waits on a question. */
  waiting?: boolean
  group?: ThreadGroup
  small?: boolean
  /** In a chip: the mark takes the chip's accent instead of its own tone. */
  accent?: boolean
  /** Off where the state is not shown beside it (a chip that is not waiting or blocked): the shape alone, never colour without its word (R-87). */
  dot?: boolean
}) {
  const t = useTranslations('Shell.threads.state')
  const shown = group ?? threadGroupOfRun(status, outcome, waiting)
  const mark: MarkSpec = threadMarkOf(shown)
  const plain = accent || !dot
  return <span role="img" aria-label={t(shown)} data-group={shown} data-thread-mark={shown} className="pointer-events-none inline-flex shrink-0">
    <Mark shape={mark.shape} tone={plain ? undefined : mark.tone} size={small ? 'sm' : 'md'} />
  </span>
}

/**
 * A thread's state as a badge: its group's icon and word (R-52), the same as
 * the list it sits in, so a run that finished but was not judged reads 等待你,
 * never 已完成. Only a stop on its way says so instead. `icon={false}` where the
 * row already leads with the icon.
 */
export function ThreadStatus({ status, outcome, stopping = false, waiting = false, icon = true }: { status: string; outcome?: ThreadOutcome | string | null; stopping?: boolean; waiting?: boolean; icon?: boolean }) {
  const t = useTranslations('IssueThreads')
  const tState = useTranslations('Shell.threads.state')
  if (stopping) return <Badge variant="secondary" size="sm">{t('stopping')}</Badge>
  const group = threadGroupOfRun(status, outcome, waiting)
  return <Badge variant={GROUP_BADGES[group]} size="sm" data-group={group}>{icon && <ThreadStatusIcon group={group} small />}{tState(group)}</Badge>
}
