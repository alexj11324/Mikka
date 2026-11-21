'use client'

import { useState } from 'react'
import { useTranslations } from '@/lib/intl/i18n-client'
import { toast } from 'sonner'
import { cancelAutomationBatch, flushAutomationBatch } from '@/app/actions/automations'
import { InlineLoadError } from '@/components/load-error'
import { SettingsSection } from '@/components/settings/primitives'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useWebhookBatches } from '@/hooks/use-automations'
import type { AutomationView } from '@/lib/schedules/automation-view'
import { useActionError } from '@/lib/use-action-error'
import { useNextRunLabel } from './automation-summary'

export function WebhookBatches({ workspaceId, automation }: { workspaceId: string; automation: AutomationView }) {
  const t = useTranslations('Automations.editor.batches')
  const run = useTranslations('Automations.run')
  const all = useTranslations('Automations')
  const common = useTranslations('Common')
  const actionError = useActionError()
  const when = useNextRunLabel()
  const pages = useWebhookBatches(workspaceId, automation.id)
  const [confirm, setConfirm] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const batches = pages.error ? [] : [...new Map((pages.data ?? []).flatMap(page => page.batches).map(batch => [batch.id, batch])).values()]

  async function close(batchId: string, action: typeof flushAutomationBatch) {
    if (busy) return
    setBusy(true)
    try {
      const result = await action({ scheduleId: automation.id, batchId, version: automation.version }, workspaceId)
      if ('error' in result && result.error) toast.error(actionError(result.error))
      setConfirm(null)
    } catch {
      toast.error(actionError('generic'))
    } finally {
      try { await pages.mutate() } finally { setBusy(false) }
    }
  }

  return <SettingsSection id="automation-webhook-batches" title={t('title')}>
    {!pages.data && !pages.error && <div className="p-4"><Skeleton className="h-10 w-full" /></div>}
    {pages.data && !batches.length && !pages.error && <p className="px-5 py-4 text-sm text-muted-foreground">{t('empty')}</p>}
    {batches.map(batch => <div key={batch.id} className="flex flex-wrap items-center gap-2 px-5 py-3 text-sm">
      <time className="text-muted-foreground" dateTime={new Date(batch.created_at).toISOString()}>{when(batch.created_at, automation.definition.timezone)}</time>
      <span>{t('requests', { count: batch.requestCount })}</span>
      <Badge variant="outline">{batch.status === 'collecting' ? t('collecting') : batch.status === 'queued' && batch.runStatus === 'pending' ? t('queued') : run(batch.runStatus)}</Badge>
      {batch.status === 'collecting' && automation.status === 'active' && <div className="flex flex-wrap gap-2">
        <Button size="xs" variant="outline" disabled={busy} onClick={() => { void close(batch.id, flushAutomationBatch) }}>{t('flush')}</Button>
        <Button size="xs" variant="ghost" disabled={busy} onClick={() => setConfirm(batch.id)}>{t('cancel')}</Button>
      </div>}
    </div>)}
    {pages.error && <div className="p-4"><InlineLoadError message={all('loadError')} retryLabel={common('retry')} onRetry={() => { void pages.mutate() }} /></div>}
    {pages.data?.at(-1)?.nextCursor && !pages.error && <div className="px-5 pb-3">
      <Button variant="ghost" size="sm" disabled={pages.isValidating} onClick={() => { void pages.setSize(size => size + 1) }}>{t('more')}</Button>
    </div>}
    <AlertDialog open={confirm !== null} onOpenChange={open => { if (!open && !busy) setConfirm(null) }}>
      <AlertDialogContent>
        <AlertDialogHeader><AlertDialogTitle>{t('confirmTitle')}</AlertDialogTitle><AlertDialogDescription>{t('confirmBody')}</AlertDialogDescription></AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>{t('keep')}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={busy} onClick={() => { if (confirm) void close(confirm, cancelAutomationBatch) }}>{t('cancel')}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </SettingsSection>
}
