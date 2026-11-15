'use client'

import { Fragment, useState, type MouseEvent } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { ChevronDown, Plus } from 'lucide-react'
import { listWorkspaceBots } from '@/app/actions/bots'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Empty, EmptyContent, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemSeparator, ItemTitle } from '@/components/ui/item'
import { SearchInput } from '@/components/ui/search-input'
import { Skeleton } from '@/components/ui/skeleton'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { InlineLoadError } from '@/components/load-error'
import { BotAvatar, CoordinatorAvatar } from '@/components/nav/bot-avatar'
import { useLiveKey } from '@/hooks/use-live-key'
import { useAutomations } from '@/hooks/use-automations'
import type { AutomationView } from '@/lib/schedules/automation-view'
import { useNextRunLabel, useTimingSummary } from './automation-summary'

type Filter = 'all' | 'active' | 'paused'
export type WorkspaceBotRow = { id: string; name: string; color: string; shape: string }

/** The workspace's Bots by ID, for 交给 (any member may read them; the list follows `bot_list`). */
export function useWorkspaceBotNames(workspaceId: string | null) {
  const key = workspaceId ? ['automations-workspace-bots', workspaceId] as const : null
  const read = useSWR(key, async () => {
    const result = await listWorkspaceBots()
    if ('error' in result && result.error) throw new Error(result.error)
    return (result as { bots: WorkspaceBotRow[] }).bots
  }, { revalidateOnFocus: false, shouldRetryOnError: false })
  useLiveKey('bot_list', workspaceId, key ? [JSON.stringify(key)] : [], workspaceId)
  return new Map((read.data ?? []).map(bot => [bot.id, bot]))
}

/** 交给: the Bot an automation hands its request to, with its avatar; the Coordinator when none is named. */
export function AutomationBot({ automation, bots }: { automation: AutomationView; bots: Map<string, WorkspaceBotRow> }) {
  const t = useTranslations('Automations')
  const task = automation.definition.task
  if (task.kind !== 'dispatch_task') return <span className="text-muted-foreground">{t(`kind.${task.kind}`)}</span>
  const bot = task.botId ? bots.get(task.botId) : null
  if (task.botId && !bot) return null
  return <span className="flex min-w-0 items-center gap-1.5">
    {bot ? <BotAvatar id={bot.id} color={bot.color} shape={bot.shape} size="row" /> : <CoordinatorAvatar size="row" />}
    <span className="truncate">{bot?.name ?? t('coordinator')}</span>
  </span>
}

const statusVariant = { active: 'secondary', paused: 'outline', completed: 'outline', cancelled: 'outline' } as const

/**
 * 自动化 (Capy's Automations list, layout and interaction only): each row names the automation, says when it runs and
 * next runs, who it hands work to and whether it is on. Search and the 全部 / 运行中 / 已暂停 filter work on the rows read.
 */
export function AutomationsPage({ workspaceId, href, onOpen, onAskBot }: { workspaceId: string | null; href: (id: string) => string; onOpen: (id: string | 'new') => void; onAskBot: (text: string) => void }) {
  const t = useTranslations('Automations')
  const tCommon = useTranslations('Common')
  const summary = useTimingSummary()
  const nextRun = useNextRunLabel()
  const { automations, error, data, mutate, setSize, size, more, isValidating } = useAutomations(workspaceId)
  const bots = useWorkspaceBotNames(workspaceId)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const visible = automations.filter(row => row.status !== 'cancelled')
    .filter(row => filter === 'all' || (filter === 'active' ? row.status === 'active' : row.status === 'paused'))
    .filter(row => !query.trim() || row.definition.title.toLowerCase().includes(query.trim().toLowerCase()))
  // A plain click opens the automation in place; a modified click keeps the browser's own new-tab behaviour.
  const follow = (event: MouseEvent, id: string) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    onOpen(id)
  }
  const create = <DropdownMenu>
    <DropdownMenuTrigger render={<Button size="sm" />}><Plus data-icon="inline-start" />{t('new')}<ChevronDown data-icon="inline-end" /></DropdownMenuTrigger>
    <DropdownMenuContent align="end">
      <DropdownMenuGroup>
        <DropdownMenuItem onClick={() => onAskBot(t('askBotPrompt'))}>{t('askBot')}</DropdownMenuItem>
        <DropdownMenuItem onClick={() => onOpen('new')}>{t('fromScratch')}</DropdownMenuItem>
      </DropdownMenuGroup>
    </DropdownMenuContent>
  </DropdownMenu>

  return <section aria-labelledby="automations-title" className="flex min-h-0 flex-1 flex-col overflow-auto">
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6">
      <header className="flex items-center justify-between gap-3">
        <h1 id="automations-title" className="text-lg font-semibold">{t('title')}</h1>
        {create}
      </header>
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput className="min-w-0 flex-1 sm:max-w-64" type="search" value={query} maxLength={120} aria-label={t('search')} placeholder={t('search')} onChange={event => setQuery(event.target.value)} />
        <ToggleGroup aria-label={t('filter.all')} size="sm" variant="segment" spacing={0.5} value={[filter]} onValueChange={values => { const next = values[0]; if (next === 'all' || next === 'active' || next === 'paused') setFilter(next) }}>
          {(['all', 'active', 'paused'] as const).map(value => <ToggleGroupItem key={value} value={value}>{t(`filter.${value}`)}</ToggleGroupItem>)}
        </ToggleGroup>
      </div>
      {error && !data ? <InlineLoadError message={t('loadError')} retryLabel={tCommon('retry')} onRetry={() => { void mutate() }} />
        : !data ? <div role="status" aria-label={t('loading')} className="flex flex-col gap-2">{[0, 1, 2].map(index => <Skeleton key={index} className="h-16 w-full rounded-xl" />)}</div>
          : !visible.length ? <Empty className="border">
            <EmptyHeader><EmptyTitle>{automations.length ? t('emptyFiltered') : t('empty')}</EmptyTitle></EmptyHeader>
            {!automations.length && <EmptyContent>{create}</EmptyContent>}
          </Empty>
            : <ItemGroup role="list" className="gap-0! overflow-hidden rounded-2xl border bg-card">
              {visible.map((row, index) => <Fragment key={row.id}>{index > 0 && <ItemSeparator className="my-0" />}<Item role="listitem" className="rounded-none hover:bg-accent/50" render={<a href={href(row.id)} />} onClick={(event: MouseEvent) => follow(event, row.id)}>
                <ItemContent className="min-w-0">
                  <ItemTitle className="w-full truncate">{row.definition.title}</ItemTitle>
                  <ItemDescription className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span>{summary(row.definition)}</span>
                    {row.status === 'active' && row.next_at && <time dateTime={new Date(row.next_at).toISOString()}>{t('nextRun', { time: nextRun(row.next_at, row.definition.timezone) })}</time>}
                  </ItemDescription>
                </ItemContent>
                <ItemMedia className="hidden max-w-40 text-sm sm:flex"><AutomationBot automation={row} bots={bots} /></ItemMedia>
                <ItemActions><Badge variant={statusVariant[row.status]}>{row.status === 'paused' && row.disabled_reason ? t('status.autoPaused') : t(`status.${row.status}`)}</Badge></ItemActions>
              </Item></Fragment>)}
            </ItemGroup>}
      {more && <Button variant="outline" disabled={isValidating} onClick={() => void setSize(size + 1)}>{t('more')}</Button>}
    </div>
  </section>
}
