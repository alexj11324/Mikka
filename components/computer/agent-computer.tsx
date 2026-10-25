'use client'

import { useState } from 'react'
import { Maximize2 } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { BotAvatar, colorFor } from '@/components/nav/bot-avatar'
import type { ComputerThread } from './computer-agents'
import { ComputerScreen } from './computer-screen'
import { ComputerViewer } from './computer-viewer'

/**
 * The selected bot in the 详情 tab, Grok Bot style (Figma 103:64, 188:3115):
 * its avatar and name, exactly as in the left list, then its screen captioned
 * 「<bot> 的屏幕」. Thread names only appear in the thread list.
 * 打开 opens the full-window viewer.
 */
export function AgentComputer({ thread }: { thread: ComputerThread }) {
  const t = useTranslations('Computer')
  const [viewing, setViewing] = useState(false)
  return <div className="flex flex-col items-center gap-3 pt-6">
    <BotAvatar color={colorFor(thread.botName)} size="profile" />
    <h2 className="max-w-full truncate pb-3 text-xl font-semibold">{thread.botName}</h2>
    <ComputerScreen botId={thread.botId} name={thread.botName}>
      <Button size="sm" className="h-9 rounded-full bg-screen/80 px-3.5 text-screen-foreground backdrop-blur-sm hover:bg-screen/90" onClick={() => setViewing(true)}><Maximize2 data-icon="inline-start" />{t('open')}</Button>
    </ComputerScreen>
    <p className="max-w-full truncate text-xs text-muted-foreground">{t('screenOf', { name: thread.botName })}</p>
    {viewing && <ComputerViewer botId={thread.botId} name={thread.botName} open={viewing} onOpenChange={setViewing} />}
  </div>
}
