'use client'

import { useState } from 'react'
import { Plus, TerminalSquare } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useSWRConfig } from 'swr'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { CodeBlock, CodeBlockCopyButton, CodeBlockHeader, CodeBlockTitle } from '@/components/reui/code-block/code-block'
import { IconTile } from '@/components/reui/icon-tile'
import { BASE_PATH } from '@/lib/base-path'
import { daemonCommands } from '@/lib/daemon-commands'

/** The public name is confirmed with the release; no workspace checkout is needed. */
const packageName = process.env.NEXT_PUBLIC_MIKKA_DAEMON_PACKAGE_NAME ?? '@mikka/daemon'

export function ConnectDeviceDialog() {
  const t = useTranslations('Devices.connect')
  const commonT = useTranslations('Common')
  const { mutate } = useSWRConfig()
  const [open, setOpen] = useState(false)
  const [commands, setCommands] = useState<ReturnType<typeof daemonCommands> | null>(null)

  function changeOpen(next: boolean) {
    if (next) {
      try { setCommands(daemonCommands({ origin: window.location.origin, basePath: BASE_PATH, packageName })) }
      catch { setCommands(null) }
    } else {
      void mutate('devices')
    }
    setOpen(next)
  }

  return <Dialog open={open} onOpenChange={changeOpen}>
    <DialogTrigger render={<Button size="sm" />}>
      <Plus data-icon="inline-start" />
      {t('trigger')}
    </DialogTrigger>
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
      </div> : <p role="alert" className="text-sm text-destructive">{t('configurationFailed')}</p>}
      <DialogFooter>
        <Button size="sm" className="bg-sidebar-primary text-sidebar-primary-foreground hover:bg-sidebar-primary/90" onClick={() => changeOpen(false)}>{t('done')}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
}
