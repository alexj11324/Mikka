'use client'

import { useState } from 'react'
import { Maximize2 } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { ThreadAvatar } from '@/components/nav/bot-avatar'
import { useComputer } from '@/hooks/use-computer'
import type { ComputerThread } from './computer-agents'
import { ComputerScreen } from './computer-screen'
import { ComputerStatusBadge, computerStatus } from './computer-status'
import { ComputerViewer } from './computer-viewer'

/**
 * A thread in the 详情 tab (Figma 103:64, 188:3115): the thread's "#" avatar
 * and name, then its bot's screen with 屏幕 and the computer's state.
 * 打开 opens the full-window viewer.
 */
export function AgentComputer({ thread }: { thread: ComputerThread }) {
  const t = useTranslations('Computer')
  const { data: state } = useComputer(thread.botId)
  const [viewing, setViewing] = useState(false)
  const status = computerStatus(state)
  return <div className="flex flex-col items-center gap-3 pt-6">
    <ThreadAvatar />
    <h2 className="max-w-full truncate pb-3 text-xl font-semibold">{thread.name}</h2>
    <ComputerScreen botId={thread.botId} name={thread.botName}>
      <Button size="sm" className="h-9 rounded-full bg-screen/80 px-3.5 text-screen-foreground backdrop-blur-sm hover:bg-screen/90" onClick={() => setViewing(true)}><Maximize2 data-icon="inline-start" />{t('open')}</Button>
    </ComputerScreen>
    <p className="flex items-center gap-2 text-xs text-muted-foreground">{t('screen')}{status && <ComputerStatusBadge status={status} />}</p>
    {viewing && <ComputerViewer botId={thread.botId} name={thread.botName} open={viewing} onOpenChange={setViewing} />}
  </div>
}
