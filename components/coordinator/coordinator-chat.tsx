'use client'

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import useSWR, { useSWRConfig } from 'swr'
import { withBasePath } from '@/lib/base-path'
import { useTranslations } from 'next-intl'
import { getCoordinatorChat, sendCoordinatorMessage, welcomeCoordinator, type CoordinatorChat as Chat } from '@/app/actions/coordinator'
import { CoordinatorAvatar } from '@/components/nav/bot-avatar'
import { cn } from '@/lib/utils'
import { useActionError } from '@/lib/use-action-error'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Bubble, BubbleContent } from '@/components/ui/bubble'
import { Message, MessageContent, MessageFooter } from '@/components/ui/message'
import { MessageScroller, MessageScrollerButton, MessageScrollerContent, MessageScrollerItem, MessageScrollerProvider, MessageScrollerViewport } from '@/components/ui/message-scroller'
import { Spinner } from '@/components/ui/spinner'
import { useLinkPreviews, type AgentCitations } from '@/components/workspace/agent-citations'
import { AgentInteractionContext } from '@/components/workspace/agent-interaction'
import { AgentThemeProvider } from '@/components/workspace/agent-theme'
import { CoordinatorReply } from './coordinator-reply'
import { ChatComposer } from './chat-composer'

/** Text put into the composer from elsewhere; `suggestionId` when it came from a 建议 item. */
export type CoordinatorPrefill = { text: string; nonce: number; suggestionId?: string }

/** The person's conversation with their Coordinator, which dispatches agents to issues. */
export function CoordinatorChat({ onOpenIssue, prefill, placeholder, compact = false }: { onOpenIssue: (id: string) => void; prefill?: CoordinatorPrefill; placeholder?: string; compact?: boolean }) {
  const t = useTranslations('Coordinator')
  const tNav = useTranslations('Nav')
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const actionError = useActionError()
  const { data, mutate, error: loadError } = useSWR<Chat>('coordinator-chat', () => getCoordinatorChat(), {
    refreshInterval: latest => latest?.working ? 2000 : 10000,
  })
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const { mutate: mutateAll } = useSWRConfig()
  // The 建议 item whose text is in the composer: once sent, the Coordinator dispatches a thread for it and it leaves 建议.
  const suggestion = useRef<string | null>(null)
  // 「让 Agent 安排」 and 建议 items put their sentence here for the person to finish (MIK-39).
  useEffect(() => {
    if (!prefill) return
    suggestion.current = prefill.suggestionId ?? null
    setDraft(prefill.text)
    const input = inputRef.current
    if (input) { input.focus(); input.setSelectionRange(prefill.text.length, prefill.text.length) }
  }, [prefill])
  const items = data?.items ?? []
  const welcomed = useRef(false)
  useEffect(() => {
    if (!data?.enabled || items.length || data.working || welcomed.current) return
    welcomed.current = true
    void welcomeCoordinator().then(() => mutate())
  })
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
  async function send(event?: FormEvent) {
    event?.preventDefault()
    const text = draft.trim()
    if (!await post(text)) return
    setDraft(current => current.trim() === text ? '' : current)
    const id = suggestion.current
    suggestion.current = null
    if (id) {
      await fetch(withBasePath(`/api/suggestions/${id}`), { method: 'DELETE', credentials: 'same-origin' }).catch(() => undefined)
      void mutateAll(key => typeof key === 'string' && key.includes('/api/suggestions'))
      void mutateAll('threads')
    }
  }
  return <AgentThemeProvider><AgentInteractionContext value={{ busy: sending || Boolean(data?.working), continueFromAnswer: prompt => post(prompt.trim()) }}>
  <section aria-label={t('label')} className="orvilo-agent flex min-h-0 flex-1 flex-col">
    <MessageScrollerProvider defaultScrollPosition="end">
      <MessageScroller className="min-h-0 flex-1">
        <MessageScrollerViewport aria-label={t('conversation')}>
          <MessageScrollerContent className={cn('mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 pb-6', compact ? 'pt-4' : 'pt-18')}>
            {/* Like every bot, the Coordinator has no empty chat: it writes its welcome first. */}
            {data && !items.length && (data.enabled
              ? <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><CoordinatorAvatar size="pill" mood="thinking" />{tNav('writingWelcome')}</p>
              : <div className="flex flex-1 flex-col items-center justify-center gap-3"><CoordinatorAvatar size="profile" /><p className="text-sm font-medium">{t('label')}</p></div>)}
            {items.map(item => <MessageScrollerItem key={item.position} messageId={String(item.position)} scrollAnchor={item.from === 'person'}>
              {item.from === 'event'
                ? <p className="text-center text-xs text-muted-foreground">{item.text.replace(/^\[Event\]\s*/, '')}</p>
                : <Message align={item.from === 'person' ? 'end' : 'start'}><MessageContent>
                    {item.text && (item.from === 'coordinator'
                      ? <CoordinatorReply text={item.text} citations={citations} />
                      : <Bubble variant="secondary" align="end" className={cn(compact ? 'max-w-[90%]' : 'max-w-[min(26rem,80%)]')}><BubbleContent className="rounded-2xl px-4 py-3 whitespace-pre-wrap">{item.text}</BubbleContent></Bubble>)}
                    {item.tools.length > 0 && <MessageFooter>{t('usedTools', { tools: [...new Set(item.tools)].join(', ') })}</MessageFooter>}
                  </MessageContent></Message>}
            </MessageScrollerItem>)}
            {data?.working && items.length > 0 && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner />{t('working')}</p>}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton />
      </MessageScroller>
    </MessageScrollerProvider>
    <div className={cn('mx-auto flex w-full max-w-3xl flex-col gap-2', compact ? 'px-3 pb-3' : 'px-4 pb-4')}>
      {loadError && <p role="alert" className="text-xs text-destructive">{t('loadError')}</p>}
      {data?.error && !data.working && <Alert variant="destructive"><AlertTitle>{t('failedTitle')}</AlertTitle><AlertDescription>{data.error}</AlertDescription></Alert>}
      {sendError && <p role="alert" className="text-xs text-destructive">{sendError}</p>}
      <ChatComposer ref={inputRef} label={t('input')} placeholder={placeholder} value={draft} onChange={setDraft} sending={sending} onSubmit={() => { void send() }} />
    </div>
  </section>
  </AgentInteractionContext></AgentThemeProvider>
}
