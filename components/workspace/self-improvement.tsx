'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { withBasePath } from '@/lib/base-path'

async function request(path: string, body?: unknown) {
  const response = await fetch(withBasePath(path), body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error ?? 'request failed') }
  return response.json()
}

export function ThreadFeedback({ runId }: { runId: string }) {
  const t = useTranslations('SelfImprovement')
  const { data, error } = useSWR(`/api/self-improvement?runId=${encodeURIComponent(runId)}`, request, { shouldRetryOnError: false })
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<'saved' | 'error' | null>(null)
  if (error && ['notFound', 'runUnavailable'].includes(error.message)) return null
  if (error) return <p role="alert" className="text-xs">{t('error')}</p>
  if (!data) return null
  async function submit(verdict: 'positive' | 'negative') {
    setBusy(true); setResult(null)
    try { await request('/api/self-improvement', { action: 'feedback', eventId: crypto.randomUUID(), runId, verdict, note }); setResult('saved') }
    catch { setResult('error') }
    finally { setBusy(false) }
  }
  return <div className="flex flex-col gap-2"><p className="text-sm font-medium">{t('feedback')}</p><Textarea aria-label={t('feedbackNote')} placeholder={t('feedbackNote')} maxLength={2000} value={note} onChange={event => setNote(event.target.value)} /><div className="flex gap-2"><Button size="sm" variant="outline" disabled={busy || result === 'saved'} onClick={() => { void submit('positive') }}>{t('positive')}</Button><Button size="sm" variant="outline" disabled={busy || result === 'saved'} onClick={() => { void submit('negative') }}>{t('negative')}</Button></div>{result && <p role={result === 'error' ? 'alert' : 'status'} className="text-xs">{t(result)}</p>}</div>
}

