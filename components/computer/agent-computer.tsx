'use client'

import { useState } from 'react'
import { Maximize2 } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { BotAvatar, colorFor } from '@/components/nav/bot-avatar'
import useSWR from 'swr'
import { listBots } from '@/app/actions/bots'
import { ComputerScreen } from './computer-screen'
import { ComputerViewer } from './computer-viewer'

/**
 * A bot's computer in the 详情 tab (Figma 103:64, 188:3115), Grok style: the
 * bot's blob and name, exactly as in the left list (never a thread's), then the bot's screen captioned
 * 「<Bot> 的屏幕」 and nothing else. 打开 opens the full-window viewer.
 */
export function AgentComputer({ botId, name }: { botId: string; name: string }) {
  const { data: bots } = useSWR('bots', listBots)
  const bot = bots?.find(item => item.id === botId)
  const t = useTranslations('Computer')
  const [viewing, setViewing] = useState(false)
  return <div className="flex flex-col items-center gap-3 pt-6">
    <BotAvatar color={bot?.color ?? colorFor(name)} shape={bot?.shape} size="profile" />
    <h2 className="max-w-full truncate pb-3 text-xl font-semibold">{bot?.name ?? name}</h2>
    <ComputerScreen botId={botId} name={name}>
      <Button size="sm" className="h-9 rounded-full bg-screen/80 px-3.5 text-screen-foreground backdrop-blur-sm hover:bg-screen/90" onClick={() => setViewing(true)}><Maximize2 data-icon="inline-start" />{t('open')}</Button>
    </ComputerScreen>
    <p className="max-w-full truncate text-xs text-muted-foreground">{t('screenOf', { name })}</p>
    {viewing && <ComputerViewer botId={botId} name={name} open={viewing} onOpenChange={setViewing} />}
  </div>
}
