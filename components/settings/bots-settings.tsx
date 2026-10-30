'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { ChevronRight } from 'lucide-react'
import { toast } from 'sonner'
import { Link, useRouter } from '@/i18n/navigation'
import { BotAvatar } from '@/components/nav/bot-avatar'
import { SettingRow, SettingsLoading, SettingsSaveError, SettingsSection } from '@/components/settings/primitives'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Empty, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Item, ItemContent, ItemDescription, ItemTitle } from '@/components/ui/item'
import { Select, SelectContent, SelectGroup, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { relativeTime } from '@/lib/relative-time'
import { settingsHref } from '@/lib/settings-sections'
import { effectiveModel, type BotDefaultsView, type BotModelId, type BotThreadPage, type BotsSettingsApi, type WorkspaceBotRow } from '@/lib/settings/bots-api'

const CONNECT_REPOSITORY = '__connect-repository__'

/** 设置 › 工作区 › Bot (V13, WS-05, WS-06, WS-07). Data comes through `api` so the page does not care whether it is mocked. */
export function BotsSettings({ api, workspaceId }: { api: BotsSettingsApi; workspaceId?: string }) {
  const t = useTranslations('Settings.botSettings')
  const commonT = useTranslations('Common')
  const errorsT = useTranslations('Errors')
  const [defaults, setDefaults] = useState<BotDefaultsView | null>(null)
  const [bots, setBots] = useState<WorkspaceBotRow[] | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [saveFailed, setSaveFailed] = useState<null | { defaultModel?: BotModelId | null; defaultRepository?: string | null }>(null)

  const load = useCallback(async () => {
    setLoadFailed(false)
    const [nextDefaults, nextBots] = await Promise.all([api.getDefaults(), api.listBots()])
    if (nextDefaults.error || nextBots.error) { setLoadFailed(true); return }
    setDefaults(nextDefaults)
    setBots(nextBots.bots)
  }, [api])
  useEffect(() => { void load() }, [load])

  async function save(change: { defaultModel?: BotModelId | null; defaultRepository?: string | null }) {
    if (!defaults) return
    const previous = defaults
    setSaveFailed(null)
    setDefaults({ ...defaults, ...change })
    const result = await api.updateDefaults(change)
    if (result.error) { setDefaults(previous); setSaveFailed(change); return }
    setDefaults(current => current && { ...current, ...result })
    toast(t('saved'))
  }

  if (loadFailed) return <SettingsSaveError message={errorsT('generic')} retryLabel={commonT('retry')} onRetry={() => void load()} />
  if (!defaults || !bots) return <div className="flex flex-col gap-6"><SettingsLoading label={t('defaultsTitle')} rows={2} /><SettingsLoading label={t('allBotsTitle')} rows={3} /></div>

  return <div className="flex flex-col gap-6">
    {saveFailed && <SettingsSaveError message={errorsT('generic')} retryLabel={commonT('retry')} onRetry={() => void save(saveFailed)} />}
    <SettingsSection id="bot-defaults-heading" title={t('defaultsTitle')}>
      <SettingRow title={t('model')}>
        <ModelSelect defaults={defaults} disabled={!api.isAdmin} onChange={model => void save({ defaultModel: model })} />
      </SettingRow>
      <SettingRow title={t('repository')} description={t('repositorySource')}>
        <RepositorySelect defaults={defaults} disabled={!api.isAdmin} workspaceId={workspaceId} onChange={repository => void save({ defaultRepository: repository })} />
      </SettingRow>
    </SettingsSection>
    <SettingsSection id="bot-list-heading" title={t('allBotsTitle')}>
      {bots.length === 0
        ? <Empty><EmptyHeader><EmptyTitle>{t('noBots')}</EmptyTitle></EmptyHeader></Empty>
        : bots.map(bot => <BotRow key={bot.id} bot={bot} api={api} />)}
    </SettingsSection>
  </div>
}

function ModelSelect({ defaults, disabled, onChange }: { defaults: BotDefaultsView; disabled: boolean; onChange: (model: BotModelId) => void }) {
  const t = useTranslations()
  const items = defaults.modelGroups.map(group => ({ value: group.id, label: t(group.labelKey) }))
  return <Select items={items} value={effectiveModel(defaults)} disabled={disabled} onValueChange={value => { if (value) onChange(value as BotModelId) }}>
    <SelectTrigger size="sm" aria-label={t('Settings.botSettings.model')}><SelectValue /></SelectTrigger>
    <SelectContent align="end"><SelectGroup>{items.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup></SelectContent>
  </Select>
}

function RepositorySelect({ defaults, disabled, workspaceId, onChange }: { defaults: BotDefaultsView; disabled: boolean; workspaceId?: string; onChange: (repository: string) => void }) {
  const t = useTranslations('Settings.botSettings')
  const router = useRouter()
  const items = [...defaults.repositories.map(value => ({ value, label: value })), { value: CONNECT_REPOSITORY, label: t('connectRepository') }]
  return <Select items={items} value={defaults.defaultRepository} disabled={disabled} onValueChange={value => {
    if (value === CONNECT_REPOSITORY) { router.push(settingsHref('connections', workspaceId)); return }
    if (typeof value === 'string') onChange(value)
  }}>
    <SelectTrigger size="sm" aria-label={t('repository')}><SelectValue placeholder={t('noRepository')} /></SelectTrigger>
    <SelectContent align="end">
      <SelectGroup>{defaults.repositories.map(repository => <SelectItem key={repository} value={repository}>{repository}</SelectItem>)}</SelectGroup>
      <SelectSeparator />
      <SelectGroup><SelectItem value={CONNECT_REPOSITORY}>{t('connectRepository')}</SelectItem></SelectGroup>
    </SelectContent>
  </Select>
}

function botStatus(t: ReturnType<typeof useTranslations<'Settings.botSettings'>>, bot: WorkspaceBotRow) {
  return bot.status === 'running' ? t('running', { count: bot.runningThreads }) : t('idle')
}

function BotRow({ bot, api }: { bot: WorkspaceBotRow; api: BotsSettingsApi }) {
  const t = useTranslations('Settings.botSettings')
  const commonT = useTranslations('Common')
  return <Sheet>
    <SheetTrigger className="flex w-full items-center gap-3 px-3.5 py-3 text-left text-sm outline-none hover:bg-muted/50 focus-visible:bg-muted/50">
      <BotAvatar color={bot.color} shape={bot.shape} size="pill" still />
      <span className="min-w-0 flex-1 truncate">{bot.name}</span>
      <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
        <span aria-hidden="true" className={cn('size-1.5 rounded-full', bot.status === 'running' ? 'bg-success' : 'bg-muted-foreground')} />
        {botStatus(t, bot)}
      </span>
      <ChevronRight aria-hidden="true" className="text-muted-foreground" />
    </SheetTrigger>
    <SheetContent side="right" showCloseButton={false}>
      <SheetHeader className="border-b">
        <SheetTitle>{t('threadsTitle')}</SheetTitle>
        <SheetDescription>{t('threadsSubtitle', { name: bot.name, status: botStatus(t, bot) })}</SheetDescription>
      </SheetHeader>
      <ThreadList bot={bot} api={api} />
      <SheetFooter className="items-start">
        <SheetClose render={<Button variant="outline" size="sm" />}>{commonT('close')}</SheetClose>
      </SheetFooter>
    </SheetContent>
  </Sheet>
}

function ThreadList({ bot, api }: { bot: WorkspaceBotRow; api: BotsSettingsApi }) {
  const t = useTranslations('Settings.botSettings')
  const commonT = useTranslations('Common')
  const errorsT = useTranslations('Errors')
  const locale = useLocale()
  const [page, setPage] = useState<BotThreadPage | null>(null)
  const [failed, setFailed] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const request = useRef(0)

  const load = useCallback(async (cursor: string | null) => {
    const id = ++request.current
    setFailed(false)
    const result = await api.listThreads({ botId: bot.id, cursor })
    if (id !== request.current) return
    if (result.error) { setFailed(true); return }
    setPage(current => cursor && current ? { ...result, threads: [...current.threads, ...result.threads] } : result)
  }, [api, bot.id])
  useEffect(() => { void load(null) }, [load])

  return <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4">
      {failed && <SettingsSaveError message={errorsT('generic')} retryLabel={commonT('retry')} onRetry={() => void load(page?.nextCursor ?? null)} />}
      {!page && !failed && <div role="status" aria-label={commonT('loading')} className="flex flex-col gap-3">{Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-13 w-full rounded-lg" />)}</div>}
      {page && page.threads.length === 0 && <Empty><EmptyHeader><EmptyTitle>{t('noThreads')}</EmptyTitle></EmptyHeader></Empty>}
      {page?.threads.map(thread => {
        const meta = <ItemDescription className="flex items-center gap-1.5">
          <Avatar size="xs" aria-hidden="true">{thread.initiator.avatarUrl && <AvatarImage src={thread.initiator.avatarUrl} alt="" />}<AvatarFallback>{(thread.initiator.name ?? '?').slice(0, 1).toUpperCase()}</AvatarFallback></Avatar>
          <span>{thread.title === null ? relativeTime(thread.lastActivityAt, locale) : t('threadMeta', { status: thread.status === 'running' ? t('threadRunning') : t('threadDone'), time: relativeTime(thread.lastActivityAt, locale) })}</span>
        </ItemDescription>
        const title = <ItemTitle className={cn(thread.title === null && 'text-muted-foreground')}>{thread.title ?? t('privateThread')}</ItemTitle>
        return thread.canOpen && thread.href
          ? <Item key={thread.threadId} variant="muted" render={<Link href={thread.href} />}><ItemContent>{title}{meta}</ItemContent></Item>
          : <Item key={thread.threadId} variant="muted" data-thread-locked=""><ItemContent>{title}{meta}</ItemContent></Item>
      })}
      {page?.nextCursor && <Button variant="outline" size="sm" disabled={loadingMore} onClick={() => { setLoadingMore(true); void load(page.nextCursor).finally(() => setLoadingMore(false)) }}>{t('loadMore')}</Button>}
    </div>
}
