'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { useTranslations } from '@/lib/intl/i18n-client'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Check } from '@/components/icons'
import { withBasePath } from '@/lib/base-path'

async function request(path: string, body?: unknown) {
  const response = await fetch(withBasePath(path), body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error ?? 'request failed') }
  return response.json()
}

/**
 * A finished run's one feedback line, at the end of its thread: was this any good, and why.
 *
 * It is a card, not a form dropped into the transcript: the words, the two answers, and the note behind a
 * second step, so the common case (one click) does not put an empty textarea in the middle of a conversation.
 * Once recorded it says so and offers nothing more — a greyed-out form still asks a question that is answered.
 */
export function ThreadFeedback({ runId }: { runId: string }) {
  const t = useTranslations('SelfImprovement')
  const { data, error } = useSWR(`/api/self-improvement?runId=${encodeURIComponent(runId)}`, request, { shouldRetryOnError: false })
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<'saved' | 'error' | null>(null)
  if (error && ['notFound', 'runUnavailable'].includes(error.message)) return null
  if (error) return <p role="alert" className="text-xs text-destructive-foreground">{t('error')}</p>
  if (!data) return null
  async function submit(verdict: 'positive' | 'negative') {
    setBusy(true); setResult(null)
    try { await request('/api/self-improvement', { action: 'feedback', eventId: crypto.randomUUID(), runId, verdict, note }); setResult('saved') }
    catch { setResult('error') }
    finally { setBusy(false) }
  }
  if (result === 'saved') return <p role="status" className="flex items-center gap-1.5 text-xs text-muted-foreground"><Check data-icon aria-hidden />{t('saved')}</p>
  return <section aria-label={t('feedback')} className="flex flex-col gap-3 rounded-xl border border-rule px-3 py-3">
    <p className="text-xs font-medium text-foreground">{t('feedback')}</p>
    <Textarea aria-label={t('feedbackNote')} placeholder={t('feedbackNote')} maxLength={2000} rows={2} value={note} onChange={event => setNote(event.target.value)} />
    <div className="flex items-center gap-2">
      <Button size="sm" variant="outline" disabled={busy} onClick={() => { void submit('positive') }}>{t('positive')}</Button>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => { void submit('negative') }}>{t('negative')}</Button>
      {result === 'error' && <p role="alert" className="text-xs text-destructive-foreground">{t('error')}</p>}
    </div>
  </section>
}
