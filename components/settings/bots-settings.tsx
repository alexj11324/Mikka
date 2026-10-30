'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import useSWR from 'swr'
import { useLocale, useTranslations } from 'next-intl'
import { ChevronRight } from 'lucide-react'
import { toast } from 'sonner'
import { getWorkspaceModelPolicy, listBotThreads, listWorkspaceBots, updateWorkspaceModelPolicy } from '@/app/actions/bots'
import { Link } from '@/i18n/navigation'
import { BotAvatar } from '@/components/nav/bot-avatar'
import { SettingRow, SettingsLoading, SettingsSaveError, SettingsSection } from '@/components/settings/primitives'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Empty, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from '@/components/ui/item'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import type { WorkspaceBotModel } from '@/lib/db/schema'
import { relativeTime } from '@/lib/relative-time'
import { useActionError } from '@/lib/use-action-error'
import { cn } from '@/lib/utils'
import { resolveBotModel } from '@/lib/workspace-admin/bot-model-policy'
import type { BotThreadPage, ModelPolicy, WorkspaceBotView } from '@/lib/workspace-admin/bots'

type Policy = ModelPolicy
type BotsT = ReturnType<typeof useTranslations<'Settings.botSettings'>>

/**
 * 设置 › 工作区 › Bot (docs/design/bot-settings.md). Admins govern 可用模型 and the
 * starting model; every member sees 全部 Bot, read-only. A bot's own model and
 * repository are changed by its owner in the bot's 详情, never here.
 */
export function BotsSettings({ admin, workspaceId }: { admin: boolean; workspaceId: string }) {
  const t = useTranslations('Settings.botSettings')
  const commonT = useTranslations('Common')
  const actionError = useActionError()
  const policy = useSWR(['workspace-model-policy', workspaceId], async () => {
    const result = await getWorkspaceModelPolicy()
    if (result.error) throw new Error(result.error)
    return result
  }, { revalidateOnFocus: false })
  const bots = useSWR(['workspace-bots', workspaceId], async () => {
    const result = await listWorkspaceBots()
    if (result.error) throw new Error(result.error)
    return result.bots
  }, { revalidateOnFocus: false })

  if (policy.error || bots.error) return <SettingsSaveError message={actionError(null)} retryLabel={commonT('retry')} onRetry={() => { void policy.mutate(); void bots.mutate() }} />
  if (!policy.data || !bots.data) return <div className="flex flex-col gap-6">{admin && <SettingsLoading label={t('modelsTitle')} rows={4} />}<SettingsLoading label={t('allBotsTitle')} rows={3} /></div>

  return <div className="flex flex-col gap-6">
    {admin && <ModelPolicySection policy={policy.data} onChange={next => void policy.mutate(next, { revalidate: false })} />}
    <SettingsSection id="bot-list-heading" title={t('allBotsTitle')}>
      {bots.data.length === 0
        ? <Empty><EmptyHeader><EmptyTitle>{t('noBots')}</EmptyTitle></EmptyHeader></Empty>
        : bots.data.map(bot => <BotRow key={bot.id} bot={bot} policy={policy.data!} />)}
    </SettingsSection>
  </div>
}

/**
 * 可用模型: one switch per model family, at least one stays on, plus the model a
 * new bot starts with. Saves are serialised (one in flight); the last save wins.
 */
function ModelPolicySection({ policy, onChange }: { policy: Policy; onChange: (policy: Policy) => void }) {
  const t = useTranslations()
  const actionError = useActionError()
  const [saving, setSaving] = useState(false)
  const label = (model: WorkspaceBotModel) => t(policy.modelGroups.find(group => group.id === model)!.labelKey)

  async function save(allowedModels: WorkspaceBotModel[], startingModel: WorkspaceBotModel | null) {
    if (saving) return
    setSaving(true)
    const previous = policy
    onChange({ ...policy, allowedModels, startingModel })
    try {
      const result = await updateWorkspaceModelPolicy({ allowedModels, startingModel })
      if (!result.error) { onChange(result); return }
      onChange(previous)
      toast.error(actionError(result.error))
    } catch {
      onChange(previous)
      toast.error(actionError(null))
    } finally {
      setSaving(false)
    }
  }

  function toggle(model: WorkspaceBotModel, on: boolean) {
    const allowedModels = policy.modelGroups.map(group => group.id).filter(id => id === model ? on : policy.allowedModels.includes(id))
    if (!allowedModels.length) return
    void save(allowedModels, policy.startingModel && allowedModels.includes(policy.startingModel) ? policy.startingModel : null)
  }

  const starting = policy.startingModel ?? policy.allowedModels[0]
  const items = policy.allowedModels.map(model => ({ value: model, label: label(model) }))
  return <SettingsSection id="bot-models-heading" title={t('Settings.botSettings.modelsTitle')}>
    {policy.modelGroups.map(group => {
      const on = policy.allowedModels.includes(group.id)
      return <SettingRow key={group.id} title={t(group.labelKey)}>
        <Switch aria-label={t(group.labelKey)} checked={on} disabled={saving || (on && policy.allowedModels.length === 1)} onCheckedChange={checked => toggle(group.id, checked)} />
      </SettingRow>
    })}
    <SettingRow title={t('Settings.botSettings.startingModel')}>
      <Select items={items} value={starting} disabled={saving} onValueChange={value => { if (value && value !== starting) void save(policy.allowedModels, value as WorkspaceBotModel) }}>
        <SelectTrigger size="sm" className="w-32" aria-label={t('Settings.botSettings.startingModel')}><SelectValue /></SelectTrigger>
        <SelectContent align="end"><SelectGroup>{items.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup></SelectContent>
      </Select>
    </SettingRow>
  </SettingsSection>
}

function botStatus(t: BotsT, bot: WorkspaceBotView) {
  return bot.status === 'running' ? t('running', { count: bot.runningThreads }) : t('idle')
}

/** One bot in 全部 Bot. Its sheet shows the owner's model and repository read-only, then its threads. */
function BotRow({ bot, policy }: { bot: WorkspaceBotView; policy: Policy }) {
  const t = useTranslations('Settings.botSettings')
  const allT = useTranslations()
  const model = resolveBotModel({ model: bot.model, allowedModels: policy.allowedModels, startingModel: policy.startingModel })
  const modelLabel = (id: WorkspaceBotModel | null) => {
    const group = policy.modelGroups.find(item => item.id === id)
    return group ? allT(group.labelKey) : null
  }
  return <Sheet>
    <SheetTrigger nativeButton={false} render={<Item />}>
      <ItemMedia><BotAvatar color={bot.color} shape={bot.shape} size="pill" still /></ItemMedia>
      <ItemContent>
        <ItemTitle>{bot.name}</ItemTitle>
        <ItemDescription>{t('ownerStatus', { owner: bot.ownerName ?? '—', status: botStatus(t, bot) })}</ItemDescription>
      </ItemContent>
      <ItemActions>
        <span aria-hidden="true" className={cn('inline-block size-1.5 rounded-full', bot.status === 'running' ? 'bg-success' : 'bg-muted-foreground')} />
        <ChevronRight aria-hidden="true" className="text-muted-foreground" />
      </ItemActions>
    </SheetTrigger>
    <SheetContent side="right">
      <SheetHeader>
        <SheetTitle>{bot.name}</SheetTitle>
        <SheetDescription className="sr-only">{t('ownerStatus', { owner: bot.ownerName ?? '—', status: botStatus(t, bot) })}</SheetDescription>
      </SheetHeader>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 px-4 text-sm" data-testid="bot-config">
        <dt className="text-muted-foreground">{t('model')}</dt>
        <dd className="flex min-w-0 items-center gap-2">{modelLabel(model.model)}{model.unavailable && <Badge variant="outline">{t('modelUnavailable', { model: modelLabel(bot.model) ?? '' })}</Badge>}</dd>
        <dt className="text-muted-foreground">{t('repository')}</dt>
        <dd className="truncate">{bot.repository ?? t('noRepository')}</dd>
      </dl>
      <ThreadList bot={bot} />
    </SheetContent>
  </Sheet>
}

/** WS-07 线程列表 (from PR #442): newest first, 私有线程 for what the viewer may not see, paged. */
function ThreadList({ bot }: { bot: WorkspaceBotView }) {
  const t = useTranslations('Settings.botSettings')
  const commonT = useTranslations('Common')
  const actionError = useActionError()
  const locale = useLocale()
  const [page, setPage] = useState<BotThreadPage | null>(null)
  const [failed, setFailed] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const request = useRef(0)
  const moreInFlight = useRef(false)

  const load = useCallback(async (cursor: string | null) => {
    const id = ++request.current
    setFailed(false)
    const result = await listBotThreads({ botId: bot.id, cursor })
    if (id !== request.current) return
    if (result.error) { setFailed(true); return }
    setPage(current => cursor && current ? { ...result, threads: [...current.threads, ...result.threads] } : result)
  }, [bot.id])
  useEffect(() => { void load(null) }, [load])

  async function loadMore(cursor: string) {
    if (moreInFlight.current) return
    moreInFlight.current = true
    setLoadingMore(true)
    try { await load(cursor) } finally { moreInFlight.current = false; setLoadingMore(false) }
  }

  return <section aria-label={t('threadsTitle')} className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pb-4">
    <h3 className="text-xs text-muted-foreground">{t('threadsTitle')}</h3>
    {!page && !failed && <div role="status" aria-label={commonT('loading')} className="flex flex-col gap-3">{Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-13 w-full" />)}</div>}
    {page && page.threads.length === 0 && <Empty><EmptyHeader><EmptyTitle>{t('noThreads')}</EmptyTitle></EmptyHeader></Empty>}
    {page?.threads.map(thread => {
      const time = relativeTime(thread.lastActivityAt, locale)
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
    {failed && <SettingsSaveError message={actionError(null)} retryLabel={commonT('retry')} onRetry={() => void (page?.nextCursor ? loadMore(page.nextCursor) : load(null))} />}
    {page?.nextCursor && !failed && <Button variant="outline" size="sm" disabled={loadingMore} onClick={() => void loadMore(page.nextCursor!)}>{t('loadMore')}</Button>}
  </section>
}
