'use client'

// The default all-threads slot (docs/ui-overlay.md): 全部线程's button and its column.
import { MessagesSquare, Search, X } from 'lucide-react'
import { useViewScroll, useViewState } from '@/lib/hooks/view-state'
import { useTranslations } from 'next-intl'
import { Badge } from '@/components/reui/badge'
import { Button } from '@/components/ui/button'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { SearchInput } from '@/components/ui/search-input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { RightColumn } from '@/components/workspace/thread-column'
import { navigate, openThread, toggleAllThreads } from '@/components/workspace/workspace-navigation'
import { threadBots } from '@/components/nav/all-threads-data'
import type { AllThreadsColumnProps, AllThreadsToggleProps } from '@/components/slots/all-threads-contract'
import { cn } from '@/lib/utils'
import { threadName } from '@/components/nav/thread-list'
import { matches, ThreadResults } from '@/components/nav/context-panel'

/**
 * 全部线程's button, beside the globe in the window bar and in the phone's
 * header: the threads every bot dispatched, from any page, not only from a
 * bot's panel (R-82). While threads wait on you it carries their count after
 * 等待你's hand (Figma 802:56), 99+ past 99; with none, the icon alone.
 */
export function AllThreadsToggle({ open, onToggle, waiting = 0 }: AllThreadsToggleProps) {
  const t = useTranslations('Shell.panel')
  const label = waiting ? t('allThreadsWaiting', { count: waiting }) : t('allThreads')
  return <Tooltip><TooltipTrigger render={<Button variant="ghost" size={waiting ? 'sm' : 'icon-sm'} aria-label={label} aria-pressed={open} onClick={onToggle}
    className={cn('text-muted-foreground', waiting && 'relative gap-1 px-1.5 pointer-coarse:after:absolute pointer-coarse:after:-inset-1.5', open && 'bg-muted text-foreground')} />}>
    <MessagesSquare data-icon="inline-start" />
    {waiting > 0 && <Badge data-slot="threads-waiting" variant="warning-light" className="gap-1 px-1.5 tabular-nums"><span aria-hidden="true" className="size-1.5 rounded-full bg-warning" />{waiting > 99 ? '99+' : waiting}</Badge>}
  </TooltipTrigger><TooltipContent side="bottom">{label}</TooltipContent></Tooltip>
}

/**
 * 全部线程 in the right column (?threads=all, or ?threads=<bot> filtered to the
 * threads one bot dispatched): the threads every bot dispatched, in R-52's
 * groups; each row's second line opens with the mark of the Agent running it
 * (R-78) and 「<Bot> 派出」 (glossary: a bot dispatches a thread, an Agent runs it). A thread opens in this column; ← comes back here.
 */
export function AllThreadsColumn({ view, threads, issues, loading = false }: AllThreadsColumnProps) {
  const t = useTranslations('Shell.panel')
  const bots = threadBots(threads)
  const bot = view === 'all' ? null : view
  const dispatched = bot ? threads.filter(thread => thread.botId === bot) : threads
  // The header's search filters this column in place (R-50); null while it is closed.
  const [query, setQuery] = useViewState<string | null>(`all-threads:${view}:query`, null)
  const scroll = useViewScroll<HTMLDivElement>(`all-threads:${view}:${query ?? ''}`, !loading)
  const shown = query ? dispatched.filter(thread => matches(query, threadName(thread, issues, ''), thread.lastReply)) : dispatched
  return <RightColumn slot="all-threads">
    <section aria-labelledby="all-threads-title" className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 px-4 pr-2">
        <h2 id="all-threads-title" className="min-w-0 flex-1 truncate text-sm font-semibold">{t('allThreads')}</h2>
        {/* A filter refines the same place: it replaces the address (R-82). */}
        {bots.length > 1 && <NativeSelect size="sm" aria-label={t('filterBot')} className="w-36" value={bot ?? 'all'} onChange={event => navigate({ threads: event.target.value }, 'replace')}>
          <NativeSelectOption value="all">{t('allBots')}</NativeSelectOption>
          {bots.map(item => <NativeSelectOption key={item.id} value={item.id}>{item.name}</NativeSelectOption>)}
        </NativeSelect>}
        <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label={t('search')} aria-pressed={query !== null} onClick={() => setQuery(query === null ? '' : null)} />}><Search data-icon="inline-start" /></TooltipTrigger><TooltipContent side="bottom">{t('search')}</TooltipContent></Tooltip>
        <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label={t('closeAllThreads')} onClick={() => toggleAllThreads(false)} />}><X data-icon="inline-start" /></TooltipTrigger><TooltipContent side="bottom">{t('closeAllThreads')}</TooltipContent></Tooltip>
      </header>
      {query !== null && <div className="shrink-0 px-3 pb-2">
        <SearchInput autoFocus aria-label={t('search')} placeholder={t('search')} value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); setQuery(null) } }} />
      </div>}
      <div ref={scroll} className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <ThreadResults stateKey={`all-threads:${view}`} threads={dispatched} shown={shown} issues={issues} all loading={loading} onOpenThread={thread => openThread(thread.runId)} />
      </div>
    </section>
  </RightColumn>
}
