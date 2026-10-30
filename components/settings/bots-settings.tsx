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
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from '@/components/ui/item'
import { Select, SelectContent, SelectGroup, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { relativeTime } from '@/lib/relative-time'
import { settingsHref } from '@/lib/settings-sections'
import { createBotDefaultsSaver, type BotDefaultsChange } from '@/lib/settings/bot-defaults-saver'
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
  const [saveFailed, setSaveFailed] = useState<null | BotDefaultsChange>(null)

  // Cleared on unmount so a late load or save answer sets no state on a gone page.
  const alive = useRef(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  const load = useCallback(async () => {
    setLoadFailed(false)
    const [nextDefaults, nextBots] = await Promise.all([api.getDefaults(), api.listBots()])
    if (!alive.current) return
    if (nextDefaults.error || nextBots.error) { setLoadFailed(true); return }
    saver.current?.confirm({ defaultModel: nextDefaults.defaultModel, defaultRepository: nextDefaults.defaultRepository })
    setDefaults(nextDefaults)
    setBots(nextBots.bots)
  }, [api])
  useEffect(() => { void load() }, [load])

  const saver = useRef<ReturnType<typeof createBotDefaultsSaver> | null>(null)
  saver.current ??= createBotDefaultsSaver({
    update: change => api.updateDefaults(change),
    apply: patch => setDefaults(current => current && { ...current, ...patch }),
    onSaved: () => toast(t('saved')),
    onFailed: change => setSaveFailed(change),
    isActive: () => alive.current,
  })
  function save(change: BotDefaultsChange) {
    setSaveFailed(null)
    return saver.current?.save(change)
  }

  if (loadFailed) return <SettingsSaveError message={errorsT('generic')} retryLabel={commonT('retry')} onRetry={() => void load()} />
  if (!defaults || !bots) return <div className="flex flex-col gap-6"><SettingsLoading label={t('defaultsTitle')} rows={2} /><SettingsLoading label={t('allBotsTitle')} rows={3} /></div>

  return <div className="flex flex-col gap-6">
    <SettingsSection id="bot-defaults-heading" title={t('defaultsTitle')}>
      <SettingRow title={t('model')}>
        {api.isAdmin ? <ModelSelect defaults={defaults} onChange={model => void save({ defaultModel: model })} /> : <ModelLabel defaults={defaults} />}
      </SettingRow>
      <SettingRow title={t('repository')} description={t('repositorySource')}>
        {api.isAdmin ? <RepositorySelect defaults={defaults} workspaceId={workspaceId} onChange={repository => void save({ defaultRepository: repository })} /> : (defaults.defaultRepository ?? t('noRepository'))}
      </SettingRow>
    </SettingsSection>
    <SettingsSection id="bot-list-heading" title={t('allBotsTitle')}>
      {bots.length === 0
        ? <Empty><EmptyHeader><EmptyTitle>{t('noBots')}</EmptyTitle></EmptyHeader></Empty>
        : bots.map(bot => <BotRow key={bot.id} bot={bot} api={api} />)}
    </SettingsSection>
    {/* Floats over the panel's bottom edge so a failed save never shifts the rows (Design Lead: no content push). */}
    {saveFailed && <div className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center px-4 animate-in fade-in duration-200" data-testid="bots-save-error">
      <div className="pointer-events-auto w-full max-w-md"><SettingsSaveError message={errorsT('generic')} retryLabel={commonT('retry')} onRetry={() => void save(saveFailed)} /></div>
    </div>}
  </div>
}

/** Members cannot change defaults, so they see the value instead of a control. */
function ModelLabel({ defaults }: { defaults: BotDefaultsView }) {
  const t = useTranslations()
  const group = defaults.modelGroups.find(item => item.id === effectiveModel(defaults))
  return group ? t(group.labelKey) : null
}

function ModelSelect({ defaults, onChange }: { defaults: BotDefaultsView; onChange: (model: BotModelId) => void }) {
  const t = useTranslations()
  const items = defaults.modelGroups.map(group => ({ value: group.id, label: t(group.labelKey) }))
  return <Select items={items} value={effectiveModel(defaults)} onValueChange={value => { if (value) onChange(value as BotModelId) }}>
    <SelectTrigger size="sm" className="w-32" aria-label={t('Settings.botSettings.model')}><SelectValue /></SelectTrigger>
    <SelectContent align="end"><SelectGroup>{items.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup></SelectContent>
  </Select>
}

function RepositorySelect({ defaults, workspaceId, onChange }: { defaults: BotDefaultsView; workspaceId?: string; onChange: (repository: string) => void }) {
  const t = useTranslations('Settings.botSettings')
  const router = useRouter()
  const items = [...defaults.repositories.map(value => ({ value, label: value })), { value: CONNECT_REPOSITORY, label: t('connectRepository') }]
  return <Select items={items} value={defaults.defaultRepository} onValueChange={value => {
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
    <SheetTrigger nativeButton={false} render={<Item />}>
      <ItemMedia><BotAvatar color={bot.color} shape={bot.shape} size="pill" still /></ItemMedia>
      <ItemContent><ItemTitle>{bot.name}</ItemTitle></ItemContent>
      <ItemActions>
        <ItemDescription><span aria-hidden="true" className={cn('mr-1.5 inline-block size-1.5 rounded-full align-middle', bot.status === 'running' ? 'bg-success' : 'bg-muted-foreground')} />{botStatus(t, bot)}</ItemDescription>
        <ChevronRight aria-hidden="true" className="text-muted-foreground" />
      </ItemActions>
    </SheetTrigger>
    <SheetContent side="right" showCloseButton={false}>
      <SheetHeader>
        <SheetTitle>{t('threadsTitle')}</SheetTitle>
        <SheetDescription>{t('threadsSubtitle', { name: bot.name, status: botStatus(t, bot) })}</SheetDescription>
      </SheetHeader>
      <ThreadList bot={bot} api={api} />
      <SheetFooter>
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
  const moreInFlight = useRef(false)

  const load = useCallback(async (cursor: string | null) => {
    const id = ++request.current
    setFailed(false)
    const result = await api.listThreads({ botId: bot.id, cursor })
    if (id !== request.current) return
    if (result.error) { setFailed(true); return }
    setPage(current => cursor && current ? { ...result, threads: [...current.threads, ...result.threads] } : result)
  }, [api, bot.id])
  useEffect(() => { void load(null) }, [load])

  async function loadMore(cursor: string) {
    if (moreInFlight.current) return
    moreInFlight.current = true
    setLoadingMore(true)
    try { await load(cursor) } finally { moreInFlight.current = false; setLoadingMore(false) }
  }

  return <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4">
      {!page && !failed && <div role="status" aria-label={commonT('loading')} className="flex flex-col gap-3">{Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-13 w-full" />)}</div>}
      {page && page.threads.length === 0 && <Empty><EmptyHeader><EmptyTitle>{t('noThreads')}</EmptyTitle></EmptyHeader></Empty>}
      {page?.threads.map(thread => {
        const time = relativeTime(thread.lastActivityAt, locale)
        // 私有线程 uses ItemDescription, the component's own muted text, instead of restyling ItemTitle.
        const body = <>
          <ItemMedia><Avatar size="xs" aria-hidden="true">{thread.initiator.avatarUrl && <AvatarImage src={thread.initiator.avatarUrl} alt="" />}<AvatarFallback>{(thread.initiator.name ?? '?').slice(0, 1).toUpperCase()}</AvatarFallback></Avatar></ItemMedia>
          <ItemContent>
            {thread.title === null ? <ItemDescription>{t('privateThread')}</ItemDescription> : <ItemTitle>{thread.title}</ItemTitle>}
            <ItemDescription>{thread.title === null ? time : t('threadMeta', { status: thread.status === 'running' ? t('threadRunning') : t('threadDone'), time })}</ItemDescription>
          </ItemContent>
        </>
        return thread.canOpen && thread.href
          ? <Item key={thread.threadId} variant="muted" render={<Link href={thread.href} />}>{body}</Item>
          : <Item key={thread.threadId} variant="muted" data-thread-locked="">{body}</Item>
      })}
      {failed && <SettingsSaveError message={errorsT('generic')} retryLabel={commonT('retry')} onRetry={() => void (page?.nextCursor ? loadMore(page.nextCursor) : load(null))} />}
      {page?.nextCursor && !failed && <Button variant="outline" size="sm" disabled={loadingMore} onClick={() => void loadMore(page.nextCursor!)}>{t('loadMore')}</Button>}
    </div>
}
