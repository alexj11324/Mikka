'use client'

import { useState, type ReactNode } from 'react'
import { Maximize2 } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { BotAvatar, colorFor } from '@/components/nav/bot-avatar'
import { useComputer } from '@/hooks/use-computer'
import { ComputerScreen } from './computer-screen'
import { ComputerStatusBadge, computerStatus } from './computer-status'
import { ComputerViewer } from './computer-viewer'

/**
 * A bot's computer in the 详情 tab (Figma 103:64, 188:3115): a head (the
 * thread's "#" and name, or the bot itself), then the bot's screen with 屏幕
 * and the computer's state. 打开 opens the full-window viewer.
 */
export function AgentComputer({ botId, name, head, caption }: { botId: string; name: string; head?: { avatar: ReactNode; title: string }; caption?: string }) {
  const t = useTranslations('Computer')
  const { data: state } = useComputer(botId)
  const [viewing, setViewing] = useState(false)
  const status = computerStatus(state)
  return <div className="flex flex-col items-center gap-3 pt-6">
    {head?.avatar ?? <BotAvatar color={colorFor(name)} size="profile" />}
    <h2 className="max-w-full truncate pb-3 text-xl font-semibold">{head?.title ?? name}</h2>
    <ComputerScreen botId={botId} name={name}>
      <Button size="sm" className="h-9 rounded-full bg-screen/80 px-3.5 text-screen-foreground backdrop-blur-sm hover:bg-screen/90" onClick={() => setViewing(true)}><Maximize2 data-icon="inline-start" />{t('open')}</Button>
    </ComputerScreen>
    <p className="flex items-center gap-2 text-xs text-muted-foreground">{caption ?? t('screen')}{status && <ComputerStatusBadge status={status} />}</p>
    {viewing && <ComputerViewer botId={botId} name={name} open={viewing} onOpenChange={setViewing} />}
  </div>
}
