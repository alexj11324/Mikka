'use client'

import { useEffect, useState } from 'react'
import { Plus, TerminalSquare } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useSWRConfig } from 'swr'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { CodeBlock, CodeBlockCopyButton, CodeBlockHeader, CodeBlockTitle } from '@/components/reui/code-block/code-block'
import { IconTile } from '@/components/reui/icon-tile'
import { daemonCommands } from '@/lib/daemon-commands'
import { FieldError } from '@/components/ui/field'
import { publicServiceAddress } from '@/lib/platform/public-origin'
import { daemonPackageName } from '@/lib/platform/client-config'

export function ConnectDeviceDialog({ open: controlledOpen, onOpenChange, hideTrigger = false, reconnect = false }: {
  open?: boolean
  onOpenChange?: (open: boolean) => void
  hideTrigger?: boolean
  /** A device paired before: only the command that starts its client again, titled 重新连接 (review C11). */
  reconnect?: boolean
} = {}) {
  const t = useTranslations('Devices.connect')
  const commonT = useTranslations('Common')
  const { mutate } = useSWRConfig()
  const [localOpen, setLocalOpen] = useState(false)
  const open = controlledOpen ?? localOpen

  function changeOpen(next: boolean) {
    if (!next) { void mutate('devices'); void mutate('devices-settings') }
    setLocalOpen(next)
    onOpenChange?.(next)
  }

  return <Dialog open={open} onOpenChange={changeOpen}>
    {!hideTrigger && <DialogTrigger render={<Button size="sm" />}>
      <Plus data-icon="inline-start" />
      {t('trigger')}
    </DialogTrigger>}
    <DialogContent closeLabel={commonT('close')} className="sm:max-w-xl" aria-describedby={undefined}>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <IconTile variant="frame" aria-hidden="true"><TerminalSquare /></IconTile>
          {reconnect ? t('reconnectTitle') : t('title')}
        </DialogTitle>
      </DialogHeader>
      <DaemonCommandList open={open} reconnect={reconnect} />
      <DialogFooter>
        <Button size="sm" onClick={() => changeOpen(false)}>{t('done')}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
}

/**
 * The three commands that install the daemon, sign it in and start it on
 * a computer by hand: the web's 添加设备, and the desktop's 手动连接 fallback.
 * A device paired before needs only the start command (review C11).
 */
export function DaemonCommandList({ open = true, reconnect = false }: { open?: boolean; reconnect?: boolean }) {
  const t = useTranslations('Devices.connect')
  const [commands, setCommands] = useState<ReturnType<typeof daemonCommands> | null>(null)
  useEffect(() => {
    if (!open) return
    try { setCommands(daemonCommands({ ...publicServiceAddress(), packageName: daemonPackageName() })) }
    catch { setCommands(null) }
  }, [open])
  return commands ? <div className="flex min-w-0 flex-col gap-4">
    {/* R-39: the dialog is the only container, so each command is a grey block with no border of its own. */}
    {(reconnect ? ['start'] as const : ['install', 'login', 'start'] as const).map(key => <CodeBlock key={key} code={commands[key]} language="bash" defaultWrap className="border-0 bg-muted [--code-block-bg:var(--muted)]">
      <CodeBlockHeader className="border-b-0">
        <CodeBlockTitle>{reconnect ? t('commands.startAlone') : t(`commands.${key}`)}</CodeBlockTitle>
        <CodeBlockCopyButton className="ml-auto" labels={{ copy: t('copyCommand'), copied: t('copied') }} />
      </CodeBlockHeader>
    </CodeBlock>)}
    <p className="text-xs text-muted-foreground">{t('requirements')}</p>
  </div> : <FieldError>{t('configurationFailed')}</FieldError>
}

