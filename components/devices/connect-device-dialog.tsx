'use client'

import { useEffect, useState } from 'react'
import { Plus, TerminalSquare } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useSWRConfig } from 'swr'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { CodeBlock, CodeBlockCopyButton, CodeBlockHeader, CodeBlockTitle } from '@/components/reui/code-block/code-block'
import { IconTile } from '@/components/reui/icon-tile'
import { BASE_PATH } from '@/lib/base-path'
import { daemonCommands } from '@/lib/daemon-commands'
import { FieldError } from '@/components/ui/field'

/** The public name is confirmed with the release; no workspace checkout is needed. */
const packageName = process.env.NEXT_PUBLIC_MIKKA_DAEMON_PACKAGE_NAME ?? '@aspectlylabs/mikka'

export function ConnectDeviceDialog({ open: controlledOpen, onOpenChange, hideTrigger = false }: {
  open?: boolean
  onOpenChange?: (open: boolean) => void
  hideTrigger?: boolean
} = {}) {
  const t = useTranslations('Devices.connect')
  const commonT = useTranslations('Common')
  const { mutate } = useSWRConfig()
  const [localOpen, setLocalOpen] = useState(false)
  const open = controlledOpen ?? localOpen
  const [commands, setCommands] = useState<ReturnType<typeof daemonCommands> | null>(null)

  useEffect(() => {
    if (!open) return
    try { setCommands(daemonCommands({ origin: window.location.origin, basePath: BASE_PATH, packageName })) }
    catch { setCommands(null) }
  }, [open])

  function changeOpen(next: boolean) {
    if (!next) void mutate('devices')
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
          {t('title')}
        </DialogTitle>
      </DialogHeader>
      {commands ? <div className="flex min-w-0 flex-col gap-4">
        {(['install', 'login', 'start'] as const).map(key => <CodeBlock key={key} code={commands[key]} language="bash" defaultWrap>
          <CodeBlockHeader>
            <CodeBlockTitle>{t(`commands.${key}`)}</CodeBlockTitle>
            <CodeBlockCopyButton className="ml-auto" labels={{ copy: t('copyCommand'), copied: t('copied') }} />
          </CodeBlockHeader>
        </CodeBlock>)}
        <p className="text-xs text-muted-foreground">{t('requirements')}</p>
      </div> : <FieldError>{t('configurationFailed')}</FieldError>}
      <DialogFooter>
        <Button size="sm" className="bg-sidebar-primary text-sidebar-primary-foreground hover:bg-sidebar-primary/90" onClick={() => changeOpen(false)}>{t('done')}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
}
