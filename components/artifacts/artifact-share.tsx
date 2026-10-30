'use client'

import { useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Copy, Link2 } from 'lucide-react'
import { toast } from 'sonner'
import { getArtifact, shareArtifact, stopSharingArtifact } from '@/app/actions/artifacts'
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
 * A failed request is not proof that nothing happened: the server may have
 * stopped sharing and lost the response. Those states say what is known and
 * offer to read the real state back, never claim success.
 */
type ShareMode = 'idle' | 'create-failed' | 'copy-failed' | 'stop-unconfirmed' | 'stopped'

/**
 * 分享 in the reader's header. A link opens the latest version for anyone,
 * signed in or not. Tokens are stored hashed, so a link shows only right after
 * it is made; later the popover offers a fresh one or stopping every link.
 */
export function ArtifactShare({ artifactId, shared, onChange }: { artifactId: string; shared: boolean; onChange: () => void }) {
  const t = useTranslations('Artifact')
  const actionError = useActionError()
  const [open, setOpen] = useState(false)
  const [link, setLink] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [mode, setMode] = useState<ShareMode>('idle')
  const inputRef = useRef<HTMLInputElement>(null)

  function reset() {
    setLink(null)
    setMode('idle')
  }

  async function create() {
    setBusy(true)
    setMode('idle')
    try {
      const result = await shareArtifact(artifactId)
      if (result.error) { toast.error(actionError(result.error)); return }
      const next = linkFor(result.token)
      setLink(next)
      onChange()
      const copied = await copy(next)
      setMode(copied ? 'idle' : 'copy-failed')
      if (copied) toast.success(t('linkCopied'))
    } catch {
      setMode('create-failed')
    } finally {
      setBusy(false)
    }
  }

  async function stop() {
    setBusy(true)
    setMode('idle')
    try {
      const result = await stopSharingArtifact(artifactId)
      if (result.error) { toast.error(actionError(result.error)); return }
      setLink(null)
      setMode('stopped')
      toast.success(t('shareStopped'))
      onChange()
    } catch {
      setMode('stop-unconfirmed')
    } finally {
      setBusy(false)
    }
  }

  async function recheck() {
    setBusy(true)
    try {
      const detail = await getArtifact(artifactId)
      if (!detail) { toast.error(t('loadError')); return }
      if (detail.shared) { setLink(null); setMode('idle'); onChange(); return }
      setLink(null)
      setMode('stopped')
      toast.success(t('shareStopped'))
      onChange()
    } catch {
      // Still unknown. Keep the unconfirmed state so nobody reads this as stopped.
    } finally {
      setBusy(false)
    }
  }

  function selectLink() {
    inputRef.current?.focus()
    inputRef.current?.select()
  }

  async function copyAgain() {
    if (!link) return
    const copied = await copy(link)
    setMode(copied ? 'idle' : 'copy-failed')
    if (copied) toast.success(t('linkCopied'))
  }

  const description = mode === 'create-failed' ? t('createFailed')
    : mode === 'copy-failed' ? t('copyFailed')
    : mode === 'stop-unconfirmed' ? t('stopUnconfirmed')
    : mode === 'stopped' ? t('shareStopped')
    : link || !shared ? t('shareHint') : t('sharingOn')

  const showLink = Boolean(link) && mode !== 'stop-unconfirmed' && mode !== 'stopped' && mode !== 'create-failed'

  return <Popover open={open} onOpenChange={next => { setOpen(next); if (!next) reset() }}>
    <PopoverTrigger render={<Button variant="ghost" size="sm" />}><Link2 data-icon="inline-start" />{t('share')}</PopoverTrigger>
    <PopoverContent align="end" className="w-80 gap-3 p-3">
      <div className="flex flex-col gap-1">
        <PopoverTitle>{t('share')}</PopoverTitle>
        <PopoverDescription className="text-xs">{description}</PopoverDescription>
      </div>
      {mode === 'stop-unconfirmed' && <p className="text-xs text-muted-foreground">{t('shareStateUnknown')}</p>}
      {showLink && <InputGroup>
        <InputGroupInput ref={inputRef} readOnly value={link ?? ''} aria-label={t('shareLink')} onFocus={event => event.currentTarget.select()} />
        <InputGroupAddon align="inline-end"><InputGroupButton size="icon-xs" aria-label={t('copyLink')} onClick={() => { void copyAgain() }}><Copy /></InputGroupButton></InputGroupAddon>
      </InputGroup>}
      {mode === 'copy-failed' && <p className="text-xs text-muted-foreground">{t('copyFailedHint')}</p>}
      <div className="flex items-center justify-end gap-2">
        {mode === 'create-failed' && <>
          <Button variant="ghost" size="sm" onClick={() => { reset(); setOpen(false) }}>{t('close')}</Button>
          <Button size="sm" disabled={busy} onClick={() => { void create() }}>{busy && <Spinner data-icon="inline-start" />}{t('retry')}</Button>
        </>}
        {mode === 'copy-failed' && <>
          <Button variant="ghost" size="sm" onClick={selectLink}>{t('selectLink')}</Button>
          <Button size="sm" onClick={() => { void copyAgain() }}>{t('retryCopy')}</Button>
        </>}
        {mode === 'stop-unconfirmed' && <>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => { void recheck() }}>{t('recheck')}</Button>
          <Button size="sm" disabled={busy} onClick={() => { void stop() }}>{busy && <Spinner data-icon="inline-start" />}{t('retryStop')}</Button>
        </>}
        {mode === 'stopped' && <Button size="sm" disabled={busy} onClick={() => { void create() }}>{busy && <Spinner data-icon="inline-start" />}{t('createLink')}</Button>}
        {mode === 'idle' && <>
          {(shared || link) && <Button variant="ghost" size="sm" disabled={busy} onClick={() => { void stop() }}>{t('stopSharing')}</Button>}
          {!link && <Button size="sm" disabled={busy} onClick={() => { void create() }}>{busy && <Spinner data-icon="inline-start" />}{shared ? t('newLink') : t('createLink')}</Button>}
        </>}
      </div>
    </PopoverContent>
  </Popover>
}
