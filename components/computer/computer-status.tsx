'use client'

import { Hand, Moon } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { Badge } from '@/components/reui/badge'
import { Spinner } from '@/components/ui/spinner'
import type { ComputerState, ComputerTaskState } from '@/lib/computer/types'
import { cn } from '@/lib/utils'

export type ComputerStatus = 'working' | 'approval' | 'done' | 'failed' | 'sleeping' | 'waking' | 'running' | 'user'

/** What the details page caption says about a bot's computer right now. */
export function computerStatus(state: ComputerState | undefined): ComputerStatus | null {
  if (!state) return null
  if (state.machine === 'sleeping') return 'sleeping'
  if (state.machine === 'waking') return 'waking'
  if (state.machine === 'error') return 'failed'
  if (state.control === 'user') return 'user'
  if (state.pendingApproval) return 'approval'
  return state.control === 'agent' ? 'working' : 'running'
}

/** The chat card's status: the task's own state, with a live approval winning. */
export function taskStatus(task: ComputerTaskState, state: ComputerState | undefined, runId: string): ComputerStatus {
  if (task === 'done' || task === 'failed') return task
  if (state?.machine === 'sleeping' || state?.machine === 'waking') return state.machine
  if (state?.pendingApproval?.runId === runId || task === 'approval') return 'approval'
  if (state?.control === 'user') return 'user'
  return 'working'
}

/** The pill beside a computer: Agent 操作中 / 等你审批 / 完成 and the machine states (Figma 115:1265, 110:735). */
export function ComputerStatusBadge({ status, end = false }: { status: ComputerStatus; end?: boolean }) {
  const t = useTranslations('Computer.status')
  const icon = status === 'sleeping' ? <Moon aria-hidden="true" /> : status === 'waking' ? <Spinner aria-hidden="true" /> : status === 'user' ? <Hand aria-hidden="true" /> : <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-current" />
  return <Badge radius="full" size="lg" variant="outline" className={cn('shrink-0 border-transparent px-2 font-normal', end && 'ml-auto',
    (status === 'working' || status === 'waking') && 'bg-sidebar-primary/10 text-sidebar-primary',
    (status === 'approval' || status === 'user') && 'bg-attention/10 text-attention-foreground',
    (status === 'done' || status === 'running') && 'bg-success/10 text-success-foreground',
    status === 'failed' && 'bg-destructive/10 text-destructive',
    status === 'sleeping' && 'bg-muted text-muted-foreground')}>
    {icon}{t(status)}
  </Badge>
}
