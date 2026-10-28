'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Copy, Link2 } from 'lucide-react'
import { toast } from 'sonner'
import { shareArtifact, stopSharingArtifact } from '@/app/actions/artifacts'
import { Button } from '@/components/ui/button'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group'
import { Popover, PopoverContent, PopoverDescription, PopoverTitle, PopoverTrigger } from '@/components/ui/popover'
import { Spinner } from '@/components/ui/spinner'
import { withBasePath } from '@/lib/base-path'
import { useActionError } from '@/lib/use-action-error'

const linkFor = (token: string) => `${window.location.origin}${withBasePath(`/a/${token}`)}`

async function copy(text: string) {
  try { await navigator.clipboard.writeText(text); return true } catch { return false }
}

/**
 * 分享 in the reader's header. A link opens the latest version for anyone,
 * signed in or not. Tokens are stored hashed, so a link shows only right after
 * it is made; later the popover offers a fresh one or stopping every link.
 */
export function ArtifactShare({ artifactId, shared, onChange }: { artifactId: string; shared: boolean; onChange: () => void }) {
  const t = useTranslations('Artifact')
  const actionError = useActionError()
  const [link, setLink] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function create() {
    setBusy(true)
    try {
      const result = await shareArtifact(artifactId)
      if (result.error) { toast.error(actionError(result.error)); return }
      const next = linkFor(result.token)
      setLink(next)
      if (await copy(next)) toast.success(t('linkCopied'))
      onChange()
    } finally { setBusy(false) }
  }
  async function stop() {
    setBusy(true)
    try {
      const result = await stopSharingArtifact(artifactId)
      if (result.error) { toast.error(actionError(result.error)); return }
      setLink(null)
      toast.success(t('shareStopped'))
      onChange()
    } finally { setBusy(false) }
  }

  return <Popover onOpenChange={open => { if (!open) setLink(null) }}>
    <PopoverTrigger render={<Button variant="ghost" size="sm" />}><Link2 data-icon="inline-start" />{t('share')}</PopoverTrigger>
    <PopoverContent align="end" className="w-80 gap-3 p-3">
      <div className="flex flex-col gap-1">
        <PopoverTitle>{t('share')}</PopoverTitle>
        <PopoverDescription className="text-xs">{link || !shared ? t('shareHint') : t('sharingOn')}</PopoverDescription>
      </div>
      {link && <InputGroup>
        <InputGroupInput readOnly value={link} aria-label={t('shareLink')} onFocus={event => event.currentTarget.select()} />
        <InputGroupAddon align="inline-end"><InputGroupButton size="icon-xs" aria-label={t('copyLink')} onClick={() => { void copy(link).then(done => { if (done) toast.success(t('linkCopied')) }) }}><Copy /></InputGroupButton></InputGroupAddon>
      </InputGroup>}
      <div className="flex items-center justify-end gap-2">
        {shared && <Button variant="ghost" size="sm" disabled={busy} onClick={() => { void stop() }}>{t('stopSharing')}</Button>}
        {!link && <Button size="sm" disabled={busy} onClick={() => { void create() }}>{busy && <Spinner data-icon="inline-start" />}{shared ? t('newLink') : t('createLink')}</Button>}
      </div>
    </PopoverContent>
  </Popover>
}
