'use client'

import { useState } from 'react'
import { Cloud, Monitor } from '@/components/icons'
import { useTranslations } from '@/lib/intl/i18n-client'
import { Button } from '@/components/ui/button'
import { useComputer } from '@/hooks/use-computer'
import { isMockedComputer } from '@/lib/computer/client'
import { useCloudComputer } from '@/hooks/use-feature-availability'
import type { ComputerTask } from '@/lib/computer/types'
import { cn } from '@/lib/utils'
import { useComputerBotName, useRegisterComputerThread, useThreadName } from './computer-agents'
import { ComputerScreen } from './computer-screen'
import { ComputerStatusBadge, taskStatus } from './computer-status'
import { ComputerViewer } from './computer-viewer'

/**
 * The 电脑 card in a conversation (Figma 115:1265): one per computer task,
 * with the task sentence, the state and the live screen. Approval happens
 * here. While the computer is asleep or waking it shrinks to a chip.
 */
type ComputerCardProps = Omit<ComputerTask, 'state'> & { state?: ComputerTask['state']; botName?: string; thread?: string }

/** Hidden behind the `cloud-computer` flag until the backend is live; the demo bots always show it. */
export function ComputerCard(props: ComputerCardProps) {
  const enabled = useCloudComputer()
  return enabled || isMockedComputer(props.botId) ? <ComputerTaskCard {...props} /> : null
}

function ComputerTaskCard({ botId, botName, runId, task, thread, state = 'working' }: ComputerCardProps) {
  const t = useTranslations('Computer')
  const name = useComputerBotName(botId, botName)
  const threadName = useThreadName(botId, runId, thread, task)
  useRegisterComputerThread({ botId, botName: name, runId, name: threadName })
  const { data: computer } = useComputer(botId)
  const [viewing, setViewing] = useState(false)
  const status = taskStatus(state, computer)
  if (status === 'sleeping' || status === 'waking') return <span className="inline-flex w-fit max-w-full items-center gap-2 rounded-lg border bg-card py-1 pr-1 pl-2.5 text-sm">
    <Cloud aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
    <span className="truncate">{t('cloud')}</span>
    <ComputerStatusBadge status={status} />
  </span>
  return <section aria-label={t('card')} className={cn('flex w-full min-w-0 flex-col gap-3 rounded-xl border p-3 bg-card')}>
    <div className="flex items-center gap-2">
      <Monitor aria-hidden="true" className="size-4 shrink-0" />
      <h3 className="text-sm font-medium">{t('cardTitle')}</h3>
      <ComputerStatusBadge status={status} end />
    </div>
    <p className="text-sm">{task}</p>
    <Button variant="ghost" aria-label={t('openScreen', { name })} className="h-auto w-full rounded-lg p-0 hover:bg-transparent" onClick={() => setViewing(true)}>
      <ComputerScreen botId={botId} name={name} showTarget={status !== 'done' && status !== 'failed'} />
    </Button>
    {viewing && <ComputerViewer botId={botId} name={name} open={viewing} onOpenChange={setViewing} />}
  </section>
}
