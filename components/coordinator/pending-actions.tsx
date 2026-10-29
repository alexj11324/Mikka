'use client'

import { useState, type ReactNode } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { CalendarClock, Mail } from 'lucide-react'
import { toast } from 'sonner'
import { decidePendingAction } from '@/app/actions/pending-actions'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { withBasePath } from '@/lib/base-path'
import type { PendingActionView } from '@/lib/pending-action-view'
import { useActionError } from '@/lib/use-action-error'

/** "2026-10-27T10:00:00-07:00" → "2026-10-27 10:00 -07:00": exactly what will be sent, only easier to read. */
function shownTime(value: unknown, timezone?: unknown) {
  if (typeof value !== 'string') return null
  const text = value.replace('T', ' ').replace(/(\d{2}:\d{2}):00(?=$|Z|[+-])/, '$1').replace(/(Z|[+-]\d{2}:\d{2})$/, ' $1')
  return typeof timezone === 'string' ? `${text} (${timezone})` : text
}

function list(value: unknown) {
  return Array.isArray(value) && value.length ? value.join(', ') : null
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  if (children === null || children === undefined || children === '') return null
  return <div className="flex gap-3 text-xs"><dt className="w-14 shrink-0 text-muted-foreground">{label}</dt><dd className="min-w-0 break-words">{children}</dd></div>
}

async function fetchPendingActions(): Promise<PendingActionView[]> {
  const response = await fetch(withBasePath('/api/pending-actions'), { cache: 'no-store' })
  if (!response.ok) throw new Error(String(response.status))
  return response.json() as Promise<PendingActionView[]>
}

/**
 * What the person's agents want to do in their mail and calendar, one card
 * each, above the composer. Nothing runs until the person approves.
 */
export function PendingActions() {
  const t = useTranslations('Coordinator.pendingActions')
  const actionError = useActionError()
  const { data, mutate } = useSWR('pending-actions', fetchPendingActions, { refreshInterval: 10000 })
  const [busy, setBusy] = useState<string | null>(null)
  if (!data?.length) return null

  async function decide(item: PendingActionView, approve: boolean) {
    setBusy(item.id)
    try {
      const result = await decidePendingAction(item.id, approve)
      if (result.error) toast.error(actionError(result.error))
      else if (result.status === 'failed') toast.error(t('failed', { error: result.reason ?? '' }))
      else if (result.status === 'done') toast.success(t(item.action === 'send_email' ? 'sent' : 'saved'))
      await mutate()
    } catch { toast.error(actionError()) } finally { setBusy(null) }
  }

  return <ul aria-label={t('label')} className="flex max-h-[50vh] flex-col gap-2 overflow-y-auto">
    {data.map(item => {
      const input = item.input
      const email = item.action === 'send_email'
      const browser = item.action === 'browser_operation' || item.action === 'credential_operation'
      const title = item.action === 'browser_operation' || item.action === 'credential_operation' ? String(input.summary ?? '') : t(item.action)
      return <li key={item.id} className="flex flex-col gap-3 rounded-[14px] bg-muted/60 px-4 py-3">
        <p className="flex items-center gap-2 text-sm font-medium">{email ? <Mail className="size-4" /> : <CalendarClock className="size-4" />}{title}</p>
        <dl className="flex flex-col gap-1">
          {browser ? <Row label={t('site')}>{String(input.origin ?? '')}</Row> : email ? <>
            <Row label={t('to')}>{list(input.to)}</Row>
            <Row label={t('cc')}>{list(input.cc)}</Row>
            <Row label={t('bcc')}>{list(input.bcc)}</Row>
            <Row label={t('subject')}>{String(input.subject ?? '')}</Row>
          </> : <>
            {item.context && <Row label={t('current')}>{[item.context.summary, [shownTime(item.context.start), shownTime(item.context.end)].filter(Boolean).join(' – ')].filter(Boolean).join(' · ')}</Row>}
            <Row label={t('eventTitle')}>{typeof input.summary === 'string' ? input.summary : null}</Row>
            <Row label={t('time')}>{input.start || input.end ? [shownTime(input.start, input.timezone), shownTime(input.end)].filter(Boolean).join(' – ') : null}</Row>
            <Row label={t('location')}>{typeof input.location === 'string' ? input.location : null}</Row>
            <Row label={t('attendees')}>{list(input.attendees)}</Row>
            {list(input.attendees) && <Row label={t('notify')}>{input.notify_attendees === false ? t('notifyNo') : t('notifyYes')}</Row>}
          </>}
        </dl>
        {typeof (email ? input.body : input.description) === 'string' && <p className="max-h-48 overflow-y-auto rounded-lg bg-background/70 px-3 py-2 text-sm whitespace-pre-wrap">{String(email ? input.body : input.description)}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" disabled={busy !== null} onClick={() => void decide(item, false)}>{item.action === 'credential_operation' && input.operation === 'submit' ? t('approveClear') : t('decline')}</Button>
          <Button type="button" size="sm" disabled={busy !== null} onClick={() => void decide(item, true)}>{busy === item.id ? <Spinner /> : null}{browser ? t(input.operation === 'clear' ? 'approveClear' : input.operation === 'submit' ? 'approveSubmit' : 'approveBrowser') : email ? t('approveSend') : t('approveSave')}</Button>
        </div>
      </li>
    })}
  </ul>
}
