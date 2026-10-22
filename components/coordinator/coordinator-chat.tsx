'use client'

import { useState, type FormEvent, type KeyboardEvent } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { ArrowUp, Send } from 'lucide-react'
import { getCoordinatorChat, sendCoordinatorMessage, type CoordinatorChat as Chat } from '@/app/actions/coordinator'
import { useActionError } from '@/lib/use-action-error'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Bubble, BubbleContent } from '@/components/ui/bubble'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from '@/components/ui/input-group'
import { Message, MessageContent, MessageFooter } from '@/components/ui/message'
import { MessageScroller, MessageScrollerButton, MessageScrollerContent, MessageScrollerItem, MessageScrollerProvider, MessageScrollerViewport } from '@/components/ui/message-scroller'
import { Spinner } from '@/components/ui/spinner'

/** The person's conversation with their Coordinator, which dispatches agents to issues. */
export function CoordinatorChat() {
  const t = useTranslations('Coordinator')
  const actionError = useActionError()
  const { data, mutate, error: loadError } = useSWR<Chat>('coordinator-chat', () => getCoordinatorChat(), {
    refreshInterval: latest => latest?.working ? 2000 : 10000,
  })
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const items = data?.items ?? []

  async function send(event?: FormEvent) {
    event?.preventDefault()
    const text = draft.trim()
    if (!text || sending) return
    setSending(true)
    setSendError(null)
    try {
      const result = await sendCoordinatorMessage(text)
      if (result.error) { setSendError(actionError(result.error)); return }
      setDraft('')
      await mutate()
    } catch { setSendError(actionError()) } finally { setSending(false) }
  }
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    void send()
  }

  return <section aria-label={t('label')} className="flex min-h-0 flex-1 flex-col">
    <MessageScrollerProvider defaultScrollPosition="end">
      <MessageScroller className="min-h-0 flex-1">
        <MessageScrollerViewport aria-label={t('conversation')}>
          <MessageScrollerContent className="mx-auto w-full max-w-3xl px-4 py-6">
            {data && !items.length && <Empty className="flex-1"><EmptyHeader><EmptyMedia variant="icon"><Send /></EmptyMedia><EmptyTitle>{t('emptyTitle')}</EmptyTitle><EmptyDescription>{t('emptyDescription')}</EmptyDescription></EmptyHeader></Empty>}
            {items.map(item => <MessageScrollerItem key={item.position} messageId={String(item.position)} scrollAnchor={item.from === 'person'}>
              {item.from === 'event'
                ? <p className="text-center text-xs text-muted-foreground">{item.text.replace(/^\[Event\]\s*/, '')}</p>
                : <Message align={item.from === 'person' ? 'end' : 'start'}><MessageContent>
                    {item.text && <Bubble variant={item.from === 'person' ? 'secondary' : 'ghost'} align={item.from === 'person' ? 'end' : 'start'}><BubbleContent className="whitespace-pre-wrap">{item.text}</BubbleContent></Bubble>}
                    {item.tools.length > 0 && <MessageFooter>{t('usedTools', { tools: [...new Set(item.tools)].join(', ') })}</MessageFooter>}
                  </MessageContent></Message>}
            </MessageScrollerItem>)}
            {data?.working && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner />{t('working')}</p>}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton />
      </MessageScroller>
    </MessageScrollerProvider>
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-4 pb-4">
      {loadError && <p role="alert" className="text-xs text-destructive">{t('loadError')}</p>}
      {data && !data.enabled && <Alert><AlertTitle>{t('disabledTitle')}</AlertTitle><AlertDescription>{t('disabledDescription')}</AlertDescription></Alert>}
      {data?.error && !data.working && <Alert variant="destructive"><AlertTitle>{t('failedTitle')}</AlertTitle><AlertDescription>{data.error}</AlertDescription></Alert>}
      {sendError && <p role="alert" className="text-xs text-destructive">{sendError}</p>}
      <form onSubmit={send}>
        <InputGroup>
          <InputGroupTextarea aria-label={t('input')} placeholder={t('placeholder')} value={draft} maxLength={10_000} rows={2} disabled={sending} onChange={event => setDraft(event.target.value)} onKeyDown={onKeyDown} />
          <InputGroupAddon align="block-end">
            <InputGroupButton type="submit" variant="default" size="icon-sm" className="ml-auto" aria-label={t('send')} disabled={sending || !draft.trim()}>{sending ? <Spinner /> : <ArrowUp />}</InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
      </form>
    </div>
  </section>
}
