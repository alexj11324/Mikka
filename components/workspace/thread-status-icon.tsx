'use client'

import { useTranslations } from 'next-intl'
import { MessageCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/reui/badge'
import { threadGroup, type ThreadGroup, type ThreadOutcome } from '@/lib/thread-groups'

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

/**
 * A thread is drawn as a speech bubble, everywhere it shows (the right column's rows, thread cards, chips, the task's
 * 线程 tab, the phone), and its state is a dot on the bubble's corner. A task is always a circle (its board status),
 * so the two never look alike: a circle is a task, a bubble is a thread (decision 2026-11-04-2330). The dot follows the
 * thread's group (R-52), never the run's raw status, so a run that finished blocked never shows green: 进行中 a
 * pulsing grey dot, 等待你 amber, 受阻 red, 已解决 green, 空闲 a hollow ring. The colour never stands alone: the icon's
 * label names the group, and lists and cards write it beside the icon. `small` is the 14px size of rows and chips;
 * `accent` draws the bubble in a chip's accent.
 */
/** The badge colour of each group, so a badge reads as its group's dot does (R-52). */
export const GROUP_BADGES: Record<ThreadGroup, 'secondary' | 'warning-light' | 'destructive-light' | 'success-light'> = {
  running: 'secondary', waiting: 'warning-light', blocked: 'destructive-light', idle: 'secondary', resolved: 'success-light',
}


export function ThreadStatusIcon({ status = '', outcome, waiting = false, group, small = false, accent = false, dot = true }: {
  status?: string
  outcome?: ThreadOutcome | string | null
  /** 等你回复 (Figma 382:6469): the thread waits on a question. */
  waiting?: boolean
  group?: ThreadGroup
  small?: boolean
  /** In a chip: the bubble takes the chip's accent instead of the muted grey. */
  accent?: boolean
  /** Off where the state is not shown beside it (a chip that is not waiting or blocked): the bubble alone, never colour without its word (R-87). */
  dot?: boolean
}) {
  const t = useTranslations('Shell.threads.state')
  const shown = group ?? threadGroupOfRun(status, outcome, waiting)
  return <span role="img" aria-label={t(shown)} data-group={shown} className={cn('pointer-events-none relative inline-flex shrink-0', accent ? 'text-object-chip-foreground' : 'text-muted-foreground')}>
    <MessageCircle aria-hidden="true" className={cn(small ? 'size-3.5' : 'size-5')} />
    {dot && <span aria-hidden="true" data-thread-dot={shown} className={cn('absolute -top-0.5 -right-0.5 rounded-full ring-2 ring-background', small ? 'size-1.5' : 'size-2',
      shown === 'running' && 'bg-muted-foreground motion-safe:animate-pulse', shown === 'waiting' && 'bg-warning', shown === 'blocked' && 'bg-destructive',
      shown === 'resolved' && 'bg-success', shown === 'idle' && 'border border-muted-foreground bg-background')} />}
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
