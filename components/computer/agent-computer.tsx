'use client'

import { useState } from 'react'
import { KeyRound, Maximize2 } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { BotAvatar, colorFor } from '@/components/nav/bot-avatar'
import { E2BKeyDialog, useE2BKeyStatus } from '@/components/settings/e2b-key-dialog'
import useSWR from 'swr'
import { listBots } from '@/app/actions/bots'
import { isMockedComputer } from '@/lib/computer/client'
import { usePresence } from '@/lib/use-presence'
import { cn } from '@/lib/utils'
import { ComputerScreen } from './computer-screen'
import { ComputerViewer } from './computer-viewer'

/**
 * A bot's computer in the 详情 tab (Figma 103:64, 188:3115), Grok style: the
 * bot's blob and name, exactly as in the left list (never a thread's), then the bot's screen captioned
 * 「<Bot> 的屏幕」 and nothing else. 打开 opens the full-window viewer. Without
 * `header` (the right column's 电脑 tab, under the bot's own header) it starts at the screen.
 * Mikka Cloud runs on the workspace's own E2B key (decisions 2026-10-30): with no
 * key in `workspaceId` the screen offers 添加 E2B API Key instead.
 */
export function AgentComputer({ botId, name, header = true, workspaceId }: { botId: string; name: string; header?: boolean; workspaceId: string | undefined }) {
  const { data: bots } = useSWR('bots', listBots)
  const bot = bots?.find(item => item.id === botId)
  const t = useTranslations('Computer')
  const e2b = useTranslations('Settings.secrets.e2b')
  const [viewing, setViewing] = useState(false)
  const [adding, setAdding] = useState(false)
  const keyDialog = usePresence(adding)
  const status = useE2BKeyStatus(isMockedComputer(botId) ? null : workspaceId)
  const key = status.data && !status.data.error ? status.data : null
  // Only a read that answered "no key" gates the screen; a failed read leaves it to the server.
  const loading = !isMockedComputer(botId) && !status.data && !status.error
  const missing = key?.configured === false
  return <div className={cn('flex flex-col items-center gap-3', header && 'pt-6')}>
    {header && <>
      <BotAvatar color={bot?.color ?? colorFor(name)} shape={bot?.shape} size="profile" />
      <h2 className="max-w-full truncate pb-3 text-xl font-semibold">{bot?.name ?? name}</h2>
    </>}
    {loading ? <Skeleton className="aspect-[16/10] w-full rounded-lg" />
      : missing ? <div className="flex aspect-[16/10] w-full items-center justify-center rounded-lg bg-screen text-screen-foreground">
        <Button size="sm" className="h-9 rounded-full bg-screen-foreground/15 px-3.5 text-screen-foreground hover:bg-screen-foreground/25" onClick={() => setAdding(true)}><KeyRound data-icon="inline-start" />{t('addE2BKey')}</Button>
      </div>
      : <ComputerScreen botId={botId} name={name}>
        <Button size="sm" className="h-9 rounded-full bg-screen/80 px-3.5 text-screen-foreground backdrop-blur-sm hover:bg-screen/90" onClick={() => setViewing(true)}><Maximize2 data-icon="inline-start" />{t('open')}</Button>
      </ComputerScreen>}
    <p className="max-w-full truncate text-xs text-muted-foreground">{missing ? `E2B API Key ${e2b('missing')}` : t('screenOf', { name })}</p>
    {viewing && <ComputerViewer botId={botId} name={name} open={viewing} onOpenChange={setViewing} />}
    {keyDialog.value && <E2BKeyDialog workspaceId={workspaceId} open={keyDialog.open} onOpenChangeComplete={keyDialog.onOpenChangeComplete} configured={false} onClose={changed => { setAdding(false); if (changed) void status.mutate() }} />}
  </div>
}
