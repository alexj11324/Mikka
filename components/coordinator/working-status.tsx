'use client'

import { useEffect, useMemo, useState } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { fetchAgentHistory } from '@/hooks/use-agent-history'
import type { AgentHistory } from '@/lib/agent-history'
import { agentIsWorking, workersKey, workingAvatars, workingLabel, type Worker } from '@/lib/working-status'
import { Avatar, AvatarFallback, AvatarGroup, AvatarGroupCount, AvatarImage } from '@/components/ui/avatar'
import { ActionSwapRollText } from '@/components/motion/action-swap-roll'
import { TextShimmer } from '@/components/motion/text-shimmer'

const COALESCE_MS = 300

/** Waits until the value has held still for `delay`, so bursts only show their last state. */
function useSettled<T>(value: T, delay: number) {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay)
    return () => clearTimeout(timer)
  }, [value, delay])
  return settled
}

/** "Who is working" row above the Coordinator composer. Hidden when nobody is working. */
export function WorkingStatus({ coordinatorWorking }: { coordinatorWorking: boolean }) {
  const t = useTranslations('Coordinator.workingStatus')
  const { data: history } = useSWR<AgentHistory>(['/api/agent/sessions', 'working-status'], ([url]: [string, string]) => fetchAgentHistory(url), {
    refreshInterval: latest => agentIsWorking(latest) ? 2000 : 10000, revalidateOnFocus: false,
  })
  const agentWorking = agentIsWorking(history)
  const workers = useMemo<Worker[]>(() => [
    ...(coordinatorWorking ? [{ id: 'coordinator', name: t('coordinator') }] : []),
    ...(agentWorking ? [{ id: 'agent', name: t('agent') }] : []),
  ], [coordinatorWorking, agentWorking, t])
  const key = useSettled(workersKey(workers), COALESCE_MS)
  const settled = useMemo(() => workers.filter(worker => key.split('|').includes(worker.id)), [workers, key])
  const label = workingLabel(settled.map(worker => worker.name))
  if (!label) return null
  const { shown, overflow } = workingAvatars(settled)
  const text = label.key === 'many' ? t('many', label.values) : t(label.key, label.values)

  return <div className="flex h-7 min-w-0 items-center overflow-hidden">
    <ActionSwapRollText value={key} className="min-w-0">
      <span className="flex min-w-0 items-center gap-2">
        <AvatarGroup className="-space-x-1.5">
          {shown.map(worker => <Avatar key={worker.id} className="size-5">
            {worker.image && <AvatarImage src={worker.image} alt="" />}
            <AvatarFallback className="text-xs">{worker.name.slice(0, 1)}</AvatarFallback>
          </Avatar>)}
          {overflow > 0 && <AvatarGroupCount className="size-5 text-xs">+{overflow}</AvatarGroupCount>}
        </AvatarGroup>
        <span aria-live="polite" className="min-w-0 truncate text-sm leading-5 text-muted-foreground">
          <TextShimmer duration={2}>{text}</TextShimmer>
        </span>
      </span>
    </ActionSwapRollText>
  </div>
}
