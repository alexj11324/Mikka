'use client'

import useSWR from 'swr'
import { useLocale, useTranslations } from 'next-intl'
import { RotateCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Empty, EmptyHeader, EmptyDescription } from '@/components/ui/empty'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { withBasePath } from '@/lib/base-path'
import { displayTitle } from '@/lib/suggestions/action-title'
import type { SuggestionAction, SuggestionSource } from '@/lib/db/schema'
import { cn } from '@/lib/utils'

export type SuggestionItem = { id: string; source: SuggestionSource; action: SuggestionAction; title: string; actionTitle: string | null; url: string | null }
export type SuggestionsView = {
  groups: { source: SuggestionSource; items: SuggestionItem[] }[]
}

export const fetchSuggestions = async (url: string): Promise<SuggestionsView> => {
  const response = await fetch(url, { credentials: 'same-origin' })
  if (!response.ok) throw new Error(String(response.status))
  return response.json()
}

export function SourceMark({ source }: { source: SuggestionSource }) {
  return <span aria-hidden="true" className={cn('size-2.5 shrink-0 rounded-xs',
    source === 'gmail' && 'bg-destructive', source === 'github' && 'bg-muted-foreground', source === 'linear' && 'bg-label-violet',
    source === 'notion' && 'bg-foreground', source === 'slack' && 'bg-avatar-2')} />
}

/** An inline source chip: the app's mark and the item as an action (R-45), or its own title before one is written (MIK-28). A click puts it in the Coordinator's composer. */
export function SourceChip({ item, onPick }: { item: SuggestionItem; onPick: (item: SuggestionItem) => void }) {
  return <Button type="button" variant="secondary" size="xs" className="h-auto max-w-full min-w-0 gap-1.5 rounded-md px-1.5 py-0.5 align-middle font-normal" onClick={() => onPick(item)}>
    <SourceMark source={item.source} /><span className="truncate">{displayTitle(item)}</span>
  </Button>
}

export function greetingKey(now: Date) {
  const hour = now.getHours()
  return hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening'
}

/**
 * 建议: routine items by source app; the daily briefing goes to chat (R-21). GET
 * /api/suggestions (MIK-28). Clicking one fills the Coordinator's composer;
 * once sent, the Coordinator dispatches a thread and the item leaves 建议 for
 * 我的任务.
 */
export function Suggestions({ name, onArrange, onConnect }: { name: string; onArrange: (prompt: string, suggestionId: string) => void; onConnect: () => void }) {
  const t = useTranslations('Shell.suggestions')
  const pick = (item: SuggestionItem) => onArrange([item.actionTitle?.trim() || `${t(`action.${item.action}`)}：${item.title}`, item.url].filter(Boolean).join('\n'), item.id)
  const timeZone = typeof Intl === 'undefined' ? 'UTC' : Intl.DateTimeFormat().resolvedOptions().timeZone
  const locale = useLocale()
  const { data, error, isValidating, mutate } = useSWR(withBasePath(`/api/suggestions?tz=${encodeURIComponent(timeZone)}&locale=${encodeURIComponent(locale)}`), fetchSuggestions, { revalidateOnFocus: false })
  const empty = data && !data.groups.length
  return <section aria-label={t('title')} className="flex flex-col gap-2">
    <div className="flex items-center justify-between">
      <h2 className="text-xs font-medium text-muted-foreground">{t('title')}</h2>
      <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-xs" aria-label={t('refresh')} disabled={isValidating} onClick={() => { void mutate() }} />}><RotateCw data-icon="inline-start" /></TooltipTrigger><TooltipContent>{t('refresh')}</TooltipContent></Tooltip>
    </div>
    <p className="text-lg font-semibold">{t(greetingKey(new Date()), { name })}</p>
    {error && <p role="alert" className="text-xs text-destructive">{t('loadError')}</p>}
    {data && !!data.groups.length && <>
      <h3 className="pt-2 text-xs font-medium text-muted-foreground">{t('routine')}</h3>
      {data.groups.map(group => <div key={group.source} className="flex flex-col gap-2 rounded-xl bg-muted/50 p-3">
        <p className="flex items-center gap-2 text-xs text-muted-foreground"><SourceMark source={group.source} />{t(`source.${group.source}`)}</p>
        {group.items.map(item => <p key={item.id} className="flex min-w-0 items-center gap-2 text-sm">{!item.actionTitle && <span className="shrink-0">{t(`action.${item.action}`)}</span>}<SourceChip item={item} onPick={pick} /></p>)}
      </div>)}
    </>}
    {empty && <Empty className="py-10"><EmptyHeader><EmptyDescription>{t('empty')}</EmptyDescription></EmptyHeader><Button variant="secondary" className="rounded-full" onClick={onConnect}>{t('connect')}</Button></Empty>}
  </section>
}
