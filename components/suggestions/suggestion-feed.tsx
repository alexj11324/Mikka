'use client'

import { useState } from 'react'
import { useViewScroll } from '@/lib/hooks/view-state'
import dynamic from 'next/dynamic'
import useSWR, { useSWRConfig } from 'swr'
import { useLocale, useTranslations } from 'next-intl'
import { Lightbulb, RotateCw } from 'lucide-react'
import { toast } from 'sonner'
import { sendSuggestion } from '@/app/actions/coordinator'
import { coordinatorChatKey } from '@/components/coordinator/coordinator-chat'
import { ConversationPill } from '@/components/nav/conversation-pill'
import { CoordinatorAvatar } from '@/components/nav/bot-avatar'
import { Button } from '@/components/ui/button'
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { WorkspaceContentLoading } from '@/components/workspace/workspace-loading'
import { withBasePath } from '@/lib/base-path'
import type { SuggestionCard } from '@/lib/suggestions/card'
import { useActionError } from '@/lib/use-action-error'
import { cn } from '@/lib/utils'
import { CARD_FRAME, SuggestionCardBody } from './mobile-card'
import { InlineLoadError } from '@/components/load-error'
import { FieldError } from '@/components/ui/field'
import { ResizablePane } from '@/components/ui/resizable-pane'

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


/** The suggestions list's SWR key: the person's time zone and language decide the cards' wording. */
function useSuggestionsKey() {
  const locale = useLocale()
  const timeZone = typeof Intl === 'undefined' ? 'UTC' : Intl.DateTimeFormat().resolvedOptions().timeZone
  return withBasePath(`/api/suggestions?tz=${encodeURIComponent(timeZone)}&locale=${encodeURIComponent(locale)}`)
}

/**
 * The 建议 list and 交给 Coordinator (R-21), shared with a UI layer's inbox (docs/ui-overlay.md).
 * `send` resolves to the error to show, or null once the Coordinator has it.
 */
export function useSuggestions() {
  const actionError = useActionError()
  const { mutate: mutateAll } = useSWRConfig()
  const { data, error, mutate } = useSWR(useSuggestionsKey(), fetchJson<SuggestionsView>)
  // One list, newest first (R-21); the API still groups by app.
  const items = data?.groups.flatMap(group => group.items) ?? []
  async function send(id: string): Promise<string | null> {
    try {
      const result = await sendSuggestion(id)
      if (result.error && result.error !== 'suggestionNotFound') return actionError(result.error)
      await Promise.all([mutate(), mutateAll(SUGGESTION_COUNT_KEY), mutateAll(coordinatorChatKey()), mutateAll(key => key === 'threads' || Array.isArray(key) && key[0] === 'threads')])
      return null
    } catch { return actionError() }
  }
  return { data, items, error, mutate, send }
}

const SUGGESTION_COUNT_KEY = withBasePath('/api/suggestions?count=1')

/**
 * How many cards the suggestions list shows, for the count on 收件箱. A read-only count (`count=1`): unlike the list's
 * read, it writes no briefing and wakes nothing, so a count on every page changes nothing. `enabled` false reads nothing.
 */
export function useSuggestionCount(enabled: boolean) {
  const { data } = useSWR(enabled ? SUGGESTION_COUNT_KEY : null, fetchJson<{ count: number }>)
  return data?.count ?? 0
}

/** Re-reads the suggestions: beside the title on wide screens, among the phone header's actions otherwise. */
export function SuggestionsRefresh({ phoneHidden = false }: { phoneHidden?: boolean }) {
  const t = useTranslations('SuggestionsPage')
  const { isValidating, mutate } = useSWR(useSuggestionsKey(), fetchJson<SuggestionsView>)
  const { mutate: mutateAll } = useSWRConfig()
  return <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" className={cn(phoneHidden && 'max-md:hidden')} aria-label={t('refresh')} disabled={isValidating} onClick={() => { void mutateAll(SUGGESTION_COUNT_KEY); void mutate().then(() => toast.success(t('refreshed')), () => toast.error(t('refreshFailed'))) }} />}><RotateCw data-icon="inline-start" className={cn(isValidating && 'animate-spin')} /></TooltipTrigger><TooltipContent>{t('refresh')}</TooltipContent></Tooltip>
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
  const tCommon = useTranslations('Common')
  const { data, items, error, mutate, send } = useSuggestions()
  const empty = !!data && !data.groups.some(group => group.items.length)
  // 「连接应用」 only for someone with no app connected yet; an unknown answer shows nothing.
  const { data: connections } = useSWR(empty ? withBasePath('/api/integrations/composio') : null, fetchJson<Connections>, { revalidateOnFocus: false, shouldRetryOnError: false })
  const noConnection = !!connections && !connections.accounts.some(account => account.status === 'ACTIVE')
  const [sending, setSending] = useState<string | null>(null)
  const [sendError, setSendError] = useState<string | null>(null)
  const scroll = useViewScroll<HTMLDivElement>('suggestions', !!data)

  async function pick(item: SuggestionItem) {
    if (sending) return
    setSending(item.id)
    setSendError(null)
    try {
      const failed = await send(item.id)
      if (failed) { setSendError(failed); return }
      onSent?.()
    } finally { setSending(null) }
  }

  // min-w-0 on both halves: one long unbroken line in a card must not widen its half and push the chat off screen.
  return <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-clip md:flex-row">
    <section aria-labelledby="suggestions-title" className="flex min-h-0 min-w-0 flex-1 flex-col md:basis-1/2">
      {/* Phones name the page in the header bar above, and its refresh sits among that bar's actions (SuggestionsRefresh), so nothing here sits on top of them. */}
      <header className="flex items-center justify-between gap-3 px-6 pt-6 pb-4 max-md:p-0">
        <h1 id="suggestions-title" className="text-2xl font-semibold max-md:sr-only">{t('title')}</h1>
        <SuggestionsRefresh phoneHidden />
      </header>
      <div ref={scroll} className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-6 pb-6 max-md:pt-2">
        {error && <InlineLoadError message={t('loadError')} retryLabel={t('retry')} onRetry={() => { void mutate() }} />}
        {sendError && <FieldError className="text-xs">{sendError}</FieldError>}
        {!data && !error && <div role="status" aria-label={t('loading')} className="flex flex-col gap-2.5">{[0, 1, 2].map(index => <Skeleton key={index} className="h-14 w-full rounded-[16px]" />)}</div>}
        {items.map(item => <Button key={item.id} variant="ghost" data-slot="suggestion-card" disabled={sending !== null} aria-busy={sending === item.id || undefined} onClick={() => { void pick(item) }}
          className={cn(CARD_FRAME, 'h-auto w-full justify-start hover:bg-muted/40', sending === item.id && 'opacity-60')}>
          <SuggestionCardBody card={item} />
        </Button>)}
        {/* Empty: the rail's own icon and the state as a title, in the upper third, with the one way on (R-40: no explainer). */}
        {data && !items.length && <Empty className="flex-1 justify-start pt-[12vh]"><EmptyHeader><EmptyMedia variant="icon"><Lightbulb /></EmptyMedia><EmptyTitle>{t('empty')}</EmptyTitle></EmptyHeader>{noConnection && <Button onClick={onConnect}>{t('connect')}</Button>}</Empty>}
      </div>
    </section>
    {/* Half and half until the line between them is dragged (decision 2026-11-01-1310). */}
    <ResizablePane data-slot="suggestions-coordinator" storageKey="mikka:suggestions-chat-width" min={320} max="70%" edge="start" from="md" label={tCommon('resize.suggestionsChat')}
      className="hidden min-h-0 min-w-0 flex-1 flex-col border-l border-rule md:flex md:basis-1/2">
      <ConversationPill name={tNav('coordinator')} avatar={<CoordinatorAvatar size="pill" />} />
      <CoordinatorChat onOpenIssue={onOpenIssue} />
    </ResizablePane>
  </div>
}
