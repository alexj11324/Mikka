'use client'

import { Circle, CircleAlert, CircleCheck, CircleSlash2 } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { Spinner } from '@/components/ui/spinner'
import { threadGroup, type ThreadGroup, type ThreadOutcome } from '@/lib/thread-groups'

/**
 * A thread's status as an icon and colour, the phone's set (mobile.md): 进行中
 * spins, 受阻 a red alert, 等待你 a hollow circle, 空闲 a slashed circle,
 * 已解决 a green check. It follows the thread's group (R-52), never the run's raw
 * status, so a run that finished blocked never shows the check. Shared by the
 * thread list and the thread chip.
 */
export function ThreadStatusIcon({ group }: { group: ThreadGroup }) {
  const t = useTranslations('Shell.threads.state')
  const label = t(group)
  if (group === 'running') return <Spinner role="img" aria-label={label} className="size-3.5 shrink-0 text-muted-foreground" />
  return <span role="img" aria-label={label} className="inline-flex">
    {group === 'blocked' ? <CircleAlert aria-hidden="true" className="size-3.5 shrink-0 text-destructive" />
      : group === 'resolved' ? <CircleCheck aria-hidden="true" className="size-3.5 shrink-0 text-success-foreground" />
        : group === 'idle' ? <CircleSlash2 aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
          : <Circle aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />}
  </span>
}

/** The group of one run seen alone (a chip, with no task or PR at hand): an unjudged failed run is 受阻, never 已解决. */
export function threadGroupOfRun(status: string, outcome?: ThreadOutcome | null): ThreadGroup {
  return threadGroup({ id: '', status, issueId: null, createdAt: '', outcome: outcome ?? null }, undefined)
}
