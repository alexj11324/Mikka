'use client'

import { useState } from 'react'
import dynamic from 'next/dynamic'
import useSWR, { useSWRConfig } from 'swr'
import { useLocale, useTranslations } from 'next-intl'
import { RotateCw } from 'lucide-react'
import { toast } from 'sonner'
import { sendSuggestion } from '@/app/actions/coordinator'
import { coordinatorChatKey } from '@/components/coordinator/coordinator-chat'
import { ConversationPill } from '@/components/nav/conversation-pill'
import { CoordinatorAvatar } from '@/components/nav/bot-avatar'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader } from '@/components/ui/empty'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { WorkspaceContentLoading } from '@/components/workspace/workspace-loading'
import { withBasePath } from '@/lib/base-path'
import type { SuggestionCard } from '@/lib/suggestions/card'
import { useActionError } from '@/lib/use-action-error'
import { cn } from '@/lib/utils'
import { CARD_FRAME, SuggestionCardBody } from './mobile-card'

const CoordinatorChat = dynamic(() => import('@/components/coordinator/coordinator-chat').then(module => module.CoordinatorChat), { loading: WorkspaceContentLoading })

type SuggestionItem = SuggestionCard & { id: string }
type SuggestionsView = { groups: { items: SuggestionItem[] }[] }

/** Composio's connected apps for the person; only whether any is active matters here. */
type Connections = { accounts: { status: string }[] }

const fetchJson = async <T,>(url: string): Promise<T> => {
  const response = await fetch(url, { credentials: 'same-origin' })
  if (!response.ok) throw new Error(String(response.status))
  return response.json()
}


/**
 * 建议 (rail, Figma F8 `420:5831`): the cards on the left, the Coordinator's
 * chat on the right, half and half. Tapping a card sends it to the
 * Coordinator at once (R-21); it shows there as the same card, then the full
 * instruction, and leaves this list. `onSent` lets a phone, which has no
 * room for the chat here, show it.
 */
export function SuggestionFeed({ onOpenIssue, onConnect, onSent }: { onOpenIssue: (id: string) => void; onConnect: () => void; onSent?: () => void }) {
  const t = useTranslations('SuggestionsPage')
  const tNav = useTranslations('Nav')
  const actionError = useActionError()
  const locale = useLocale()
  const timeZone = typeof Intl === 'undefined' ? 'UTC' : Intl.DateTimeFormat().resolvedOptions().timeZone
  const { mutate: mutateAll } = useSWRConfig()
  const { data, error, isValidating, mutate } = useSWR(withBasePath(`/api/suggestions?tz=${encodeURIComponent(timeZone)}&locale=${encodeURIComponent(locale)}`), fetchJson<SuggestionsView>, { revalidateOnFocus: false })
  const empty = !!data && !data.groups.some(group => group.items.length)
  // 「连接应用」 only for someone with no app connected yet; an unknown answer shows nothing.
  const { data: connections } = useSWR(empty ? withBasePath('/api/integrations/composio') : null, fetchJson<Connections>, { revalidateOnFocus: false, shouldRetryOnError: false })
  const noConnection = !!connections && !connections.accounts.some(account => account.status === 'ACTIVE')
  const [sending, setSending] = useState<string | null>(null)
  const [sendError, setSendError] = useState<string | null>(null)
  // One list, newest first (R-21); the API still groups by app.
  const items = data?.groups.flatMap(group => group.items) ?? []

  async function pick(item: SuggestionItem) {
    if (sending) return
    setSending(item.id)
    setSendError(null)
    try {
      const result = await sendSuggestion(item.id)
      if (result.error && result.error !== 'suggestionNotFound') { setSendError(actionError(result.error)); return }
      await Promise.all([mutate(), mutateAll(coordinatorChatKey()), mutateAll('threads')])
      onSent?.()
    } catch { setSendError(actionError()) } finally { setSending(null) }
  }

  return <div className="flex min-h-0 flex-1 flex-col md:flex-row">
    <section aria-labelledby="suggestions-title" className="flex min-h-0 flex-1 flex-col md:basis-1/2">
      <header className="flex items-center justify-between gap-3 px-6 pt-6 pb-4">
        <h1 id="suggestions-title" className="text-2xl font-semibold">{t('title')}</h1>
        <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label={t('refresh')} disabled={isValidating} onClick={() => { void mutate().then(() => toast.success(t('refreshed')), () => toast.error(t('refreshFailed'))) }} />}><RotateCw data-icon="inline-start" className={cn(isValidating && 'animate-spin')} /></TooltipTrigger><TooltipContent>{t('refresh')}</TooltipContent></Tooltip>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-6 pb-6">
        {error && <div role="alert" className="flex items-center gap-2 text-xs"><span className="text-destructive">{t('loadError')}</span><Button variant="ghost" size="xs" onClick={() => { void mutate() }}>{t('retry')}</Button></div>}
        {sendError && <p role="alert" className="text-xs text-destructive">{sendError}</p>}
        {!data && !error && <div role="status" aria-label={t('loading')} className="flex flex-col gap-2.5">{[0, 1, 2].map(index => <Skeleton key={index} className="h-14 w-full rounded-[16px]" />)}</div>}
        {items.map(item => <Button key={item.id} variant="ghost" data-slot="suggestion-card" disabled={sending !== null} aria-busy={sending === item.id || undefined} onClick={() => { void pick(item) }}
          className={cn(CARD_FRAME, 'h-auto w-full justify-start hover:bg-muted/40', sending === item.id && 'opacity-60')}>
          <SuggestionCardBody card={item} />
        </Button>)}
        {data && !items.length && <Empty className="flex-1"><EmptyHeader><EmptyDescription>{t('empty')}</EmptyDescription></EmptyHeader>{noConnection && <Button variant="secondary" className="rounded-full" onClick={onConnect}>{t('connect')}</Button>}</Empty>}
      </div>
    </section>
    <div className="relative hidden min-h-0 flex-1 flex-col border-l border-rule md:flex md:basis-1/2 has-data-[slot=thread-view]:[&_[data-slot=conversation-pill]]:hidden">
      <ConversationPill name={tNav('coordinator')} avatar={<CoordinatorAvatar size="pill" />} />
      <CoordinatorChat onOpenIssue={onOpenIssue} />
    </div>
  </div>
}
