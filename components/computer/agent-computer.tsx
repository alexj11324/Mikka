'use client'

import { useState } from 'react'
import { Maximize2 } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { LetterAvatar } from '@/components/nav/letter-avatar'
import { useComputer } from '@/hooks/use-computer'
import { ComputerScreen } from './computer-screen'
import { ComputerStatusBadge, computerStatus } from './computer-status'
import { ComputerViewer } from './computer-viewer'

/**
 * A bot in the 详情 tab, Grok Bot style (Figma 103:64): avatar, name and
 * "X 的屏幕" with its state (the cover says it while asleep or waking).
 * 打开 opens the full-window viewer.
 */
export function AgentComputer({ agentId, name }: { agentId: string; name: string }) {
  const t = useTranslations('Computer')
  const { data: state } = useComputer(agentId)
  const [viewing, setViewing] = useState(false)
  const status = computerStatus(state)
  return <div className="flex flex-col items-center gap-3 pt-6">
    <LetterAvatar name={name} size="profile" />
    <h2 className="pb-3 text-xl font-semibold">{name}</h2>
    <ComputerScreen agentId={agentId} name={name}>
      <Button size="sm" className="h-9 rounded-full bg-screen/80 px-3.5 text-screen-foreground backdrop-blur-sm hover:bg-screen/90" onClick={() => setViewing(true)}><Maximize2 data-icon="inline-start" />{t('open')}</Button>
    </ComputerScreen>
    <p className="flex items-center gap-2 text-xs text-muted-foreground">{t('screenOf', { name })}{status && status !== 'sleeping' && status !== 'waking' && <ComputerStatusBadge status={status} />}</p>
    {viewing && <ComputerViewer agentId={agentId} name={name} open={viewing} onOpenChange={setViewing} />}
  </div>
}
