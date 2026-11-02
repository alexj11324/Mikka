'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { deleteE2BKey, saveE2BKey, type getE2BKeyCapability } from '@/app/actions/workspace-secrets'
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
  // The read names the workspace and says whether this person may set the key (canEdit).
  return useSWR(workspaceId ? ['settings:e2b-key', workspaceId] : null, () => settingsRead<Awaited<ReturnType<typeof getE2BKeyCapability>>>('e2b-key', { workspace: workspaceId }))
}

/**
 * Whether the person has their own E2B key, read for the workspace they have open.
 * Keys are personal (decisions/2026-11-01-1200-own-e2b-key-is-enough-for-cloud.md), so
 * Mikka Cloud can run only with one. `undefined` while loading or when the read fails.
 */
export function useOwnE2BKey(enabled = true) {
  const swr = useSWR(enabled ? ['settings:e2b-key', 'current'] : null, () => settingsRead<Awaited<ReturnType<typeof getE2BKeyCapability>>>('e2b-key'))
  const status = swr.data && !swr.data.error ? swr.data : undefined
  return { configured: status?.configured, mutate: swr.mutate }
}

export function E2BKeyDialog({ workspaceId, configured, onClose, open = true, onOpenChangeComplete }: { workspaceId?: string; configured: boolean; onClose: (changed: boolean) => void } & PresenceProps) {
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
      const result = kind === 'save' ? await saveE2BKey({ apiKey: apiKey.trim() }, workspaceId) : await deleteE2BKey(workspaceId)
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
