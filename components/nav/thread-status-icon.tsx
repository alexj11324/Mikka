'use client'

import { Circle, CircleAlert, CircleCheck, CircleSlash2 } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { Spinner } from '@/components/ui/spinner'
import { statusIconTints } from '@/lib/status-appearance'
import { threadGroup, type ThreadGroup, type ThreadOutcome } from '@/lib/thread-groups'
import { cn } from '@/lib/utils'

/**
 * A thread's status as an icon and colour, the phone's set (mobile.md): 进行中
 * spins, 受阻 a red alert, 等待你 a hollow circle, 空闲 a slashed circle,
 * 已解决 a green check. It follows the thread's group (R-52), never the run's raw
 * status, so a run that finished blocked never shows the check. Shared by the
 * thread list and the thread chip.
 */
export function ThreadStatusIcon({ group, className }: { group: ThreadGroup; className?: string }) {
  const t = useTranslations('Shell.threads.state')
  const label = t(group)
  const icon = cn('size-3.5 shrink-0', className)
  if (group === 'running') return <Spinner role="img" aria-label={label} className={cn(icon, statusIconTints.neutral)} />
  const Icon = group === 'blocked' ? CircleAlert : group === 'resolved' ? CircleCheck : group === 'idle' ? CircleSlash2 : Circle
  const tint = group === 'blocked' ? statusIconTints.destructive : group === 'resolved' ? statusIconTints.success : statusIconTints.neutral
  return <span role="img" aria-label={label} className="inline-flex"><Icon aria-hidden="true" className={cn(icon, tint)} /></span>
}

/** The group of one run seen alone (a chip, with no task or PR at hand): an unjudged failed run is 受阻, never 已解决. */
export function threadGroupOfRun(status: string, outcome?: ThreadOutcome | null): ThreadGroup {
  return threadGroup({ id: '', status, issueId: null, createdAt: '', outcome: outcome ?? null }, undefined)
}
