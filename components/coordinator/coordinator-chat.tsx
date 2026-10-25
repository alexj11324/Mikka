'use client'

import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { ArrowUp, Plus, Send } from 'lucide-react'
import { toast } from 'sonner'
import { getCoordinatorChat, sendCoordinatorMessage, type CoordinatorChat as Chat } from '@/app/actions/coordinator'
import { listTaskRuns } from '@/app/actions/task-runs'
import { LetterAvatar } from '@/components/nav/letter-avatar'
import { cn } from '@/lib/utils'
import { TEXT_ATTACHMENT_ACCEPT, textAttachment } from '@/lib/text-attachment'
import { Input } from '@/components/ui/input'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { useActionError } from '@/lib/use-action-error'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Bubble, BubbleContent } from '@/components/ui/bubble'
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from '@/components/ui/input-group'
import { Message, MessageContent, MessageFooter } from '@/components/ui/message'
import { MessageScroller, MessageScrollerButton, MessageScrollerContent, MessageScrollerItem, MessageScrollerProvider, MessageScrollerViewport } from '@/components/ui/message-scroller'
import { Spinner } from '@/components/ui/spinner'
import { useLinkPreviews, type AgentCitations } from '@/components/workspace/agent-citations'
import { AgentInteractionContext } from '@/components/workspace/agent-interaction'
import { AgentThemeProvider } from '@/components/workspace/agent-theme'
import { IssueThreadPanel } from '@/components/workspace/issue-thread-panel'
import { CoordinatorReply } from './coordinator-reply'
import { ThreadCard } from './thread-card'
import { PendingActions } from './pending-actions'

/** The tools a reply used, less a dispatch that already shows as its thread card. */
function footerTools(item: Chat['items'][number]) {
  return [...new Set(item.tools.filter(tool => !(tool === 'dispatch_run' && item.threads.length)))]
}

/** The person's conversation with their Coordinator, which dispatches agents to issues. */
export function CoordinatorChat({ onOpenIssue, prefill, placeholder, compact = false }: { onOpenIssue: (id: string) => void; prefill?: { text: string; nonce: number }; placeholder?: string; compact?: boolean }) {
  const t = useTranslations('Coordinator')
  const tShell = useTranslations('Shell')
  const { data: runs } = useSWR('task-runs', () => listTaskRuns(), { refreshInterval: 15000, revalidateOnFocus: false })
  const working = [...new Map((runs ?? []).filter(run => ['preparing', 'running', 'finishing'].includes(run.status)).map(run => [run.agentId, run.agentName])).values()]
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const fileId = useId()
  const actionError = useActionError()
  const { data, mutate, error: loadError } = useSWR<Chat>('coordinator-chat', () => getCoordinatorChat(), {
    refreshInterval: latest => latest?.working ? 2000 : 10000,
  })
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  // A thread card opens its conversation in place of the chat; back returns here (R-66).
  const [openThread, setOpenThread] = useState<{ issueId: string; runId: string } | null>(null)
  // 「让 Agent 安排」 puts its sentence here for the person to finish (MIK-39).
  useEffect(() => {
    if (!prefill) return
    setDraft(prefill.text)
    const input = inputRef.current
    if (input) { input.focus(); input.setSelectionRange(prefill.text.length, prefill.text.length) }
  }, [prefill])
  const items = data?.items ?? []
  const previews = useLinkPreviews(items.filter(item => item.from === 'coordinator').map(item => item.text))
  const sources = data?.sources
  const citations = useMemo<AgentCitations>(() => ({ sources: sources ?? {}, previews, onOpenIssue }), [sources, previews, onOpenIssue])

  /** Sends `text` to the Coordinator; false if it did not go. */
  async function post(text: string) {
    if (!text || sending) return false
    setSending(true)
    setSendError(null)
    try {
      const result = await sendCoordinatorMessage(text)
      if (result.error) { setSendError(actionError(result.error)); return false }
      await mutate()
      return true
    } catch { setSendError(actionError()); return false } finally { setSending(false) }
  }
  async function attach(files: File[]) {
    let next = draft
    for (const file of files) {
      const block = await textAttachment(file, 10_000 - next.length - 2)
      if (!block) { toast.error(tShell('attachUnsupported', { max: 10_000 })); continue }
      next = next.trim() ? `${next.trimEnd()}\n\n${block}` : block
    }
    setDraft(next)
    inputRef.current?.focus()
  }

  async function send(event?: FormEvent) {
    event?.preventDefault()
    const text = draft.trim()
    if (await post(text)) setDraft(current => current.trim() === text ? '' : current)
  }
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    void send()
  }

  if (openThread) return <section aria-label={t('label')} data-slot="thread-view" className="flex min-h-0 flex-1 flex-col">
    <IssueThreadPanel issueId={openThread.issueId} runId={openThread.runId} back={t('label')} onClose={() => setOpenThread(null)} />
  </section>

  return <AgentThemeProvider><AgentInteractionContext value={{ busy: sending || Boolean(data?.working), continueFromAnswer: prompt => post(prompt.trim()) }}>
  <section aria-label={t('label')} className="mikka-agent flex min-h-0 flex-1 flex-col">
    <MessageScrollerProvider defaultScrollPosition="end">
      <MessageScroller className="min-h-0 flex-1">
        <MessageScrollerViewport aria-label={t('conversation')}>
          <MessageScrollerContent className={cn('mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 pb-6', compact ? 'pt-4' : 'pt-18')}>
            {data && !items.length && <Empty className="flex-1"><EmptyHeader><EmptyMedia variant="icon"><Send /></EmptyMedia><EmptyTitle>{t('emptyTitle')}</EmptyTitle></EmptyHeader></Empty>}
            {items.map(item => <MessageScrollerItem key={item.position} messageId={String(item.position)} scrollAnchor={item.from === 'person'}>
              {item.from === 'event'
                ? <p className="text-center text-xs text-muted-foreground">{item.text.replace(/^\[Event\]\s*/, '')}</p>
                : <Message align={item.from === 'person' ? 'end' : 'start'}><MessageContent>
                    {item.text && (item.from === 'coordinator'
                      ? <Bubble variant="muted" align="start" className={cn('min-w-0', compact ? 'max-w-full' : 'max-w-[min(35rem,85%)]')}><BubbleContent className="flex w-full min-w-0 flex-col gap-1 rounded-2xl bg-muted/60 px-4 py-3"><span className="text-xs font-medium text-muted-foreground">{t('label')}</span><CoordinatorReply text={item.text} citations={citations} /></BubbleContent></Bubble>
                      : <Bubble variant="secondary" align="end" className={cn(compact ? 'max-w-[90%]' : 'max-w-[min(26rem,80%)]')}><BubbleContent className="rounded-2xl px-4 py-3 whitespace-pre-wrap">{item.text}</BubbleContent></Bubble>)}
                    {item.threads.map(id => {
                      const run = sources?.[id]
                      return run?.kind === 'run' ? <ThreadCard key={id} run={run} onOpen={setOpenThread} /> : null
                    })}
                    {footerTools(item).length > 0 && <MessageFooter>{t('usedTools', { tools: footerTools(item).join(', ') })}</MessageFooter>}
                  </MessageContent></Message>}
            </MessageScrollerItem>)}
            {data?.working && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner />{t('working')}</p>}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton />
      </MessageScroller>
    </MessageScrollerProvider>
    <div className={cn('mx-auto flex w-full max-w-3xl flex-col gap-2', compact ? 'px-3 pb-3' : 'px-4 pb-4')}>
      {!compact && working.length > 0 && <p className="flex items-center gap-3 px-2 text-xs text-muted-foreground"><span>{tShell('whoIsWorking')}</span><span className="flex [&>*+*]:-ml-1.5">{working.slice(0, 5).map(name => <LetterAvatar key={name} name={name} size="stack" />)}</span><span>{tShell('agentsWorking', { count: working.length })}</span></p>}
      {loadError && <p role="alert" className="text-xs text-destructive">{t('loadError')}</p>}
      {data?.error && !data.working && <Alert variant="destructive"><AlertTitle>{t('failedTitle')}</AlertTitle><AlertDescription>{data.error}</AlertDescription></Alert>}
      {sendError && <p role="alert" className="text-xs text-destructive">{sendError}</p>}
      <PendingActions />
      {/* Grok-style composer: one rounded bar, attach on the left, send on the right. */}
      <form onSubmit={send}>
        <FieldGroup className="sr-only"><Field><FieldLabel htmlFor={fileId}>{tShell('attach')}</FieldLabel><Input ref={fileRef} id={fileId} type="file" accept={TEXT_ATTACHMENT_ACCEPT} multiple className="sr-only" tabIndex={-1} onChange={event => { void attach(Array.from(event.target.files ?? [])); event.target.value = '' }} /></Field></FieldGroup>
        <InputGroup className="min-h-12 rounded-3xl bg-background shadow-xs">
          <InputGroupAddon align="inline-start" className="self-end pb-2">
            <InputGroupButton type="button" variant="secondary" size="icon-sm" className="rounded-full" aria-label={tShell('attach')} disabled={sending} onClick={() => fileRef.current?.click()}><Plus /></InputGroupButton>
          </InputGroupAddon>
          <InputGroupTextarea ref={inputRef} aria-label={t('input')} placeholder={placeholder ?? t('input')} className="max-h-48 min-h-12 py-3.5" value={draft} maxLength={10_000} rows={1} disabled={sending} onChange={event => setDraft(event.target.value)} onKeyDown={onKeyDown} />
          <InputGroupAddon align="inline-end" className="self-end pb-2">
            <InputGroupButton type="submit" variant="default" size="icon-sm" className="rounded-full" aria-label={t('send')} disabled={sending || !draft.trim()}>{sending ? <Spinner /> : <ArrowUp />}</InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
      </form>
    </div>
  </section>
  </AgentInteractionContext></AgentThemeProvider>
}
