'use client'

import { PersonAvatar } from '@/components/person-avatar'
import { useState, type FormEvent, type KeyboardEvent } from 'react'
import useSWR from 'swr'
import { useFormatter, useTranslations } from 'next-intl'
import { ArrowUp, ChevronLeft, ChevronRight, X } from 'lucide-react'
import { getIssueThread, sendIssueThreadMessage } from '@/app/actions/agents'
import { runIsActive, threadItems } from '@/lib/issue-run-conversation'
import { LetterAvatar } from '@/components/nav/letter-avatar'
import { Button } from '@/components/ui/button'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from '@/components/ui/input-group'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { AgentMarkdown } from './agent-markdown'
import { ThreadStatus, harnessLabel } from './issue-threads'
import { cn } from '@/lib/utils'
import { ThreadFeedback } from './self-improvement'

const BUBBLE = 'max-w-[85%] rounded-2xl bg-muted px-3.5 py-2 text-sm whitespace-pre-wrap break-words'

/**
 * An open thread: a conversation between people and the agent running it (R-62, R-10).
 * On the issue page it sits on the right with a close button; opened from a chat's thread
 * card it fills the centre column and `back` names the chat it returns to (R-66).
 */
export function IssueThreadPanel({ issueId, runId, onClose, back }: { issueId: string; runId: string; onClose: () => void; back?: string }) {
  const t = useTranslations('IssueThreads')
  const format = useFormatter()
  const { data, error, mutate } = useSWR(['issue-thread', issueId, runId], () => getIssueThread(issueId, runId), {
    refreshInterval: detail => detail && runIsActive(detail.thread.status) ? 2000 : 0, revalidateOnFocus: true,
  })
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [sendFailed, setSendFailed] = useState(false)
  const detail = data?.thread.detail
  const active = !!data && runIsActive(data.thread.status)
  const items = data ? threadItems(data.chunks, data.messages) : []
  async function send(event?: FormEvent) {
    event?.preventDefault()
    const text = draft.trim()
    if (!text || sending) return
    setSending(true); setSendFailed(false)
    try { await sendIssueThreadMessage({ issueId, runId, text }); setDraft(current => current.trim() === text ? '' : current); void mutate() }
    catch { setSendFailed(true) }
    finally { setSending(false) }
  }
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send() }
  }
  return <section aria-label={detail?.name ?? t('title')} className="flex h-full min-h-0 flex-col">
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-rule px-4">
      {back && <>
        <Button variant="ghost" size="sm" className="shrink-0" aria-label={t('back', { name: back })} onClick={onClose}><ChevronLeft data-icon="inline-start" />{back}</Button>
        <span aria-hidden="true" className="text-muted-foreground">/</span>
      </>}
      {detail && <LetterAvatar name={detail.agentName} size="pill" />}
      <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{detail?.name ?? t('title')}</h2>
      {!back && <Button variant="ghost" size="icon-sm" aria-label={t('close')} onClick={onClose}><X data-icon="inline-start" /></Button>}
    </header>
    <div className={cn('flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4', back && 'mx-auto w-full max-w-3xl')}>
      {error ? <div role="alert" className="flex items-center gap-2 text-xs"><span className="text-destructive">{t('loadFailed')}</span><Button variant="ghost" size="xs" onClick={() => { void mutate() }}>{t('retry')}</Button></div>
        : !data ? <div role="status" aria-label={t('loading')} className="flex flex-col gap-3"><Skeleton className="h-5 w-40" /><Skeleton className="ml-auto h-12 w-3/4" /><Skeleton className="h-12 w-2/3" /></div>
        : <>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <ThreadStatus status={data.thread.status} />
            <span>{t('started', { time: format.dateTime(new Date(data.thread.createdAt), { hour: '2-digit', minute: '2-digit' }) })}</span>
          </div>
          {data.thread.prompt.trim() && <p className={cn(BUBBLE, data.thread.ownedByCurrentUser ? 'self-end bg-sidebar-primary text-sidebar-primary-foreground' : 'self-start')}>{data.thread.prompt.trim()}</p>}
          <ol aria-label={t('conversation')} className="flex flex-col gap-3">
            {items.map(item => <li key={item.id} className="flex flex-col gap-1">
              {item.kind === 'agent' && <div className={cn(BUBBLE, 'self-start whitespace-normal')}><AgentMarkdown text={item.text} isStreaming={active} /></div>}
              {item.kind === 'steps' && <span className="flex items-center gap-1 text-xs text-muted-foreground"><ChevronRight className="size-3.5" aria-hidden="true" />{t('steps', { harness: harnessLabel(detail?.harness ?? ''), count: item.count })}</span>}
              {item.kind === 'error' && <p role="alert" className="text-xs text-destructive">{item.text}</p>}
              {item.kind === 'person' && (item.mine
                // R-14: your own words are the blue bubble on the right.
                ? <p className={cn(BUBBLE, 'self-end bg-sidebar-primary text-sidebar-primary-foreground')}>{item.text}</p>
                // A teammate speaks from the left under their name, as in a group chat (R-13).
                : <>
                  <span className="flex items-center gap-1.5 text-xs"><PersonAvatar name={item.author} image={item.image} /><span className="font-medium">{item.author}</span><span className="text-muted-foreground">{format.dateTime(new Date(item.at), { hour: '2-digit', minute: '2-digit' })}</span></span>
                  <p className={cn(BUBBLE, 'self-start')}>{item.text}</p>
                </>)}
            </li>)}
          </ol>
          {data.thread.feedbackEligible && <ThreadFeedback runId={runId} />}
        </>}
    </div>
    {active && detail && <form className={cn('flex shrink-0 flex-col gap-1 p-3', back && 'mx-auto w-full max-w-3xl px-4 pb-4')} onSubmit={event => { void send(event) }}>
      <InputGroup className="min-h-12 rounded-3xl bg-background shadow-xs">
        <InputGroupTextarea aria-label={t('composer', { agent: detail.agentName })} placeholder={t('composer', { agent: detail.agentName })} className="max-h-40 min-h-12 py-3.5" value={draft} maxLength={10_000} rows={1} disabled={sending} onChange={event => setDraft(event.target.value)} onKeyDown={onKeyDown} />
        <InputGroupAddon align="inline-end" className="self-end pb-2">
          <InputGroupButton type="submit" variant="default" size="icon-sm" className="rounded-full" aria-label={t('send')} disabled={sending || !draft.trim()}>{sending ? <Spinner /> : <ArrowUp />}</InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
      {sendFailed && <p role="alert" className="px-3 text-xs text-destructive">{t('sendFailed')}</p>}
    </form>}
  </section>
}
