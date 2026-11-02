'use client'

import { useTranslations } from 'next-intl'
import { CircleAlert, CircleCheck, CircleSlash2, Hand, LoaderCircle } from 'lucide-react'
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
 * A thread is identified by its state, never by the dispatching Bot's avatar.
 * One icon set everywhere a thread shows status (the right column's rows, thread
 * cards, chips, the task's 线程 tab, the phone): it follows the thread's group
 * (R-52), never the run's raw status, so a run that finished blocked never shows
 * the check. 进行中 spins, 受阻 a red alert, 等待你 a raised hand, 空闲 a slashed
 * circle, 已解决 a green check. Pass the list's `group`, or the run's `status`
 * with its judged `outcome`. `small` is the 14px size of rows and chips.
 */
export function ThreadStatusIcon({ status = '', outcome, waiting = false, group, small = false }: {
  status?: string
  outcome?: ThreadOutcome | string | null
  /** 等你回复 (Figma 382:6469): the thread waits on a question. */
  waiting?: boolean
  group?: ThreadGroup
  small?: boolean
}) {
  const t = useTranslations('Shell.threads.state')
  const shown = group ?? threadGroupOfRun(status, outcome, waiting)
  return <span role="img" aria-label={t(shown)} data-group={shown} className="pointer-events-none relative inline-flex shrink-0">
    {small ? <SmallIcon group={shown} /> : <LargeIcon group={shown} />}
  </span>
}

function SmallIcon({ group }: { group: ThreadGroup }) {
  if (group === 'running') return <LoaderCircle aria-hidden="true" className="size-3.5 text-muted-foreground motion-safe:animate-spin" />
  if (group === 'blocked') return <CircleAlert aria-hidden="true" className="size-3.5 text-destructive" />
  if (group === 'resolved') return <CircleCheck aria-hidden="true" className="size-3.5 text-success" />
  if (group === 'idle') return <CircleSlash2 aria-hidden="true" className="size-3.5 text-muted-foreground" />
  return <Hand aria-hidden="true" className="size-3.5 text-muted-foreground" />
}

function LargeIcon({ group }: { group: ThreadGroup }) {
  if (group === 'running') return <LoaderCircle aria-hidden="true" className="size-5 text-muted-foreground motion-safe:animate-spin" />
  if (group === 'blocked') return <CircleAlert aria-hidden="true" className="size-5 text-destructive" />
  if (group === 'resolved') return <CircleCheck aria-hidden="true" className="size-5 text-success" />
  if (group === 'idle') return <CircleSlash2 aria-hidden="true" className="size-5 text-muted-foreground" />
  return <Hand aria-hidden="true" className="size-5 text-muted-foreground" />
}
