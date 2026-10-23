'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { getRun, sendRunMessage } from '@/app/actions/agents'
import { runIsActive, runOutput } from '@/lib/issue-run-conversation'
import { Button } from '@/components/ui/button'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { AgentMarkdown } from './agent-markdown'

export function IssueRunSession({ runId, issueId, onClose }: { runId: string; issueId: string; onClose: () => void }) {
  const t = useTranslations('IssueRuns')
  const statusLabel = useTranslations('Coordinator.citation.runStatus')
  const { data, error, mutate } = useSWR(['issue-run', issueId, runId], async () => {
    const detail = await getRun(runId)
    // A stale response or a link to another issue must never fill this sidebar.
    return detail?.run.issueId === issueId ? detail : null
  }, { refreshInterval: detail => detail && runIsActive(detail.run.status) ? 2000 : 0, revalidateOnFocus: true })
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState(false)
  const output = runOutput(data?.chunks ?? [])
  const active = !!data && runIsActive(data.run.status)
  async function send() {
    if (!active || !message.trim() || sending) return
    const text = message.trim()
    setSending(true); setSendError(false)
    try { await sendRunMessage({ runId, text }); setMessage(current => current.trim() === text ? '' : current); void mutate().catch(() => {}) }
    catch { setSendError(true) }
    finally { setSending(false) }
  }
  return <Sheet open onOpenChange={open => { if (!open) onClose() }}>
    <SheetContent side="right">
      <SheetHeader><SheetTitle>{t('sessionTitle', { agent: data?.run.agentName ?? t('agent') })}</SheetTitle><SheetDescription>{t('sessionDescription')}</SheetDescription></SheetHeader>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pb-4">
        {error ? <div role="alert"><p>{t('loadFailed')}</p><Button variant="outline" onClick={() => { void mutate() }}>{t('retry')}</Button></div> : data === undefined ? <div role="status" aria-label={t('loading')}><Skeleton className="h-20 w-full" /></div> : !data ? <p role="status">{t('unavailable')}</p> : <>
          <div role="status" aria-live="polite"><Badge variant="outline">{statusLabel.has(data.run.status) ? statusLabel(data.run.status) : data.run.status}</Badge></div>
          {data.run.error && <p role="alert">{data.run.error}</p>}
          <div role="log" aria-label={t('output')} className="flex flex-col gap-4">
            {output.map(block => <div key={block.id}><p className="text-xs text-muted-foreground">{t(block.kind)}</p>{block.kind === 'text' ? <AgentMarkdown text={block.text} isStreaming={active} /> : <p className="whitespace-pre-wrap break-words text-sm">{block.text}</p>}</div>)}
            {!output.length && <p>{t('noOutput')}</p>}
          </div>
          {data.run.report && <section aria-label={t('report')}><h3>{t('report')}</h3><pre className="overflow-x-auto whitespace-pre-wrap break-words text-sm">{JSON.stringify(data.run.report, null, 2)}</pre></section>}
          <section aria-label={t('messages')} className="flex flex-col gap-2"><h3>{t('messages')}</h3>{data.messages.map(entry => <p key={entry.id} className="whitespace-pre-wrap break-words text-sm">{entry.text}</p>)}</section>
          {active ? <form className="flex flex-col gap-2" onSubmit={event => { event.preventDefault(); void send() }}><FieldGroup><Field><FieldLabel htmlFor={`run-message-${runId}`}>{t('messageLabel')}</FieldLabel><Textarea id={`run-message-${runId}`} value={message} onChange={event => setMessage(event.target.value)} maxLength={10000} disabled={sending} /></Field></FieldGroup>{sendError && <p role="alert">{t('sendFailed')}</p>}<Button type="submit" disabled={sending || !message.trim()}>{sending ? t('sending') : t('send')}</Button></form> : <p>{t('ended')}</p>}
        </>}
      </div>
    </SheetContent>
  </Sheet>
}
