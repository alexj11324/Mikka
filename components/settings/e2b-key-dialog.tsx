'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { deleteE2BKey, saveE2BKey, type getE2BKey } from '@/app/actions/workspace-secrets'
import { settingsRead } from '@/lib/settings-read'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldGroup, FieldLabel, FieldError } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { useActionError } from '@/lib/use-action-error'
import type { PresenceProps } from '@/lib/use-presence'

/**
 * The workspace's BYO E2B key state. Settings and a bot's 电脑 tab share this
 * cache entry, so saving or removing the key in either place updates both.
 */
export function useE2BKeyStatus(workspaceId: string | null | undefined) {
  return useSWR(workspaceId ? ['settings:e2b-key', workspaceId] : null, () => settingsRead<Awaited<ReturnType<typeof getE2BKey>>>('e2b-key'))
}

export function E2BKeyDialog({ configured, onClose, open = true, onOpenChangeComplete }: { configured: boolean; onClose: (changed: boolean) => void } & PresenceProps) {
  const t = useTranslations('Settings.secrets.e2b')
  const commonT = useTranslations('Common')
  const actionError = useActionError()
  const [apiKey, setApiKey] = useState('')
  const [pending, setPending] = useState<'save' | 'delete' | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function run(kind: 'save' | 'delete') {
    setPending(kind)
    setError(null)
    try {
      const result = kind === 'save' ? await saveE2BKey({ apiKey: apiKey.trim() }) : await deleteE2BKey()
      if (result.error) { setError(actionError(result.error)); return }
      onClose(true)
    } catch {
      setError(actionError())
    } finally {
      setPending(null)
    }
  }

  return <Dialog open={open} onOpenChangeComplete={onOpenChangeComplete} onOpenChange={next => { if (!next && !pending) onClose(false) }}>
    <DialogContent>
      <DialogHeader><DialogTitle>E2B API Key</DialogTitle></DialogHeader>
      <form onSubmit={event => { event.preventDefault(); if (apiKey.trim() && !pending) void run('save') }}>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="e2b-api-key">{configured ? t('newKey') : t('key')}</FieldLabel>
            <Input id="e2b-api-key" type="password" value={apiKey} autoComplete="off" placeholder="e2b_…" onChange={event => setApiKey(event.target.value)} />
          </Field>
          {error && <FieldError>{error}</FieldError>}
        </FieldGroup>
        <DialogFooter className="mt-4">
          {configured && <Button type="button" variant="destructive" className="sm:mr-auto" disabled={pending !== null} onClick={() => void run('delete')}>{pending === 'delete' ? t('removing') : t('remove')}</Button>}
          <Button type="button" variant="outline" disabled={pending !== null} onClick={() => onClose(false)}>{commonT('cancel')}</Button>
          <Button type="submit" disabled={pending !== null || !apiKey.trim()}>{pending === 'save' ? t('verifying') : commonT('save')}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
}
