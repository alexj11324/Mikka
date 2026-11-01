'use client'

import { useState } from 'react'
import { Eye, Hand, Minimize2 } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { useSWRConfig } from 'swr'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { useComputer } from '@/hooks/use-computer'
import { authClient } from '@/lib/auth-client'
import { ComputerRequestError, computerApi } from '@/lib/computer/client'
import { ComputerScreen } from './computer-screen'

/**
 * The full-window viewer (Figma 107:416, 118:1330). It opens view-only;
 * 取得控制权 pauses the agent and hands you mouse and keyboard, 交还给 Agent
 * gives them back. Closing while you hold control hands it back too, so the
 * agent is never left waiting on a window nobody sees.
 */
export function ComputerViewer({ botId, name, open, onOpenChange }: { botId: string; name: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useTranslations('Computer.viewer')
  const { data: session } = authClient.useSession()
  const { data: state, mutate } = useComputer(open ? botId : null)
  const { mutate: mutateKey } = useSWRConfig()
  const [busy, setBusy] = useState(false)
  const mine = state?.control === 'user' && state.controlledBy?.userId === session?.user.id
  const someoneElse = state?.control === 'user' && !mine

  async function takeover() {
    if (!session) return
    setBusy(true)
    try {
      const grant = await computerApi.takeover(botId, session.user.id)
      await mutateKey(['computer-viewer', botId, 'control'], grant, { revalidate: false })
      await mutate()
      await mutateKey(['computer-viewer', botId, 'view'])
    } catch (error) {
      toast.error(error instanceof ComputerRequestError && error.status === 409 ? t('takenByOther') : t('takeoverFailed'))
    } finally { setBusy(false) }
  }
  async function handback() {
    setBusy(true)
    try {
      await computerApi.handback(botId)
      await mutateKey(['computer-viewer', botId, 'control'], undefined, { revalidate: false })
      await mutate()
      await mutateKey(['computer-viewer', botId, 'view'])
    } catch { toast.error(t('handbackFailed')) } finally { setBusy(false) }
  }

  function changeOpen(next: boolean) {
    if (!next && mine) void handback()
    onOpenChange(next)
  }

  return <Dialog open={open} onOpenChange={changeOpen}>
    <DialogContent showCloseButton={false} overlay="dim" onClick={event => { if (event.target === event.currentTarget) changeOpen(false) }} className="top-0 left-0 flex h-dvh w-screen max-w-none translate-x-0 translate-y-0 flex-col items-center justify-center gap-4 rounded-none bg-screen p-6 text-screen-foreground ring-0 sm:max-w-none sm:px-24 sm:py-12">
      <DialogTitle className="sr-only">{t('title', { name })}</DialogTitle>
      <Button variant="ghost" size="icon-sm" aria-label={t('close')} className="absolute top-3 right-3 text-screen-foreground/70 hover:bg-screen-foreground/10 hover:text-screen-foreground" onClick={() => changeOpen(false)}><Minimize2 data-icon="inline-start" /></Button>
      <div className="w-full max-w-[calc((100dvh-10rem)*1.6)] rounded-xl">
        <ComputerScreen botId={botId} name={name} mode={mine ? 'control' : 'view'} frame="viewer" showTarget={!mine} />
      </div>
      <div role="group" aria-label={t('controls')} className="flex items-center gap-1 rounded-full bg-screen-foreground/10 p-1 ring-1 ring-screen-foreground/15">
        {mine
          ? <span className="flex items-center gap-1.5 px-3 text-sm text-attention"><Hand aria-hidden="true" className="size-4" />{t('youControl')}</span>
          : <span className="flex items-center gap-1.5 px-3 text-sm text-screen-foreground/60"><Eye aria-hidden="true" className="size-4" />{someoneElse ? t('otherControls') : t('viewOnly')}</span>}
        {mine
          ? <Button size="sm" disabled={busy} className="h-8 rounded-full bg-screen-foreground px-3.5 text-screen hover:bg-screen-foreground/90" onClick={() => { void handback() }}>{t('handback')}</Button>
          : <Button size="sm" disabled={busy || someoneElse || state?.machine !== 'running'} className="h-8 rounded-full bg-screen-foreground px-3.5 text-screen hover:bg-screen-foreground/90" onClick={() => { void takeover() }}>{t('takeover')}</Button>}
      </div>
    </DialogContent>
  </Dialog>
}
