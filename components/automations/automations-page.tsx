'use client'

import { Fragment, useState, type MouseEvent } from 'react'
import useSWR, { useSWRConfig } from 'swr'
import { useTranslations } from 'next-intl'
import { ChevronDown, Ellipsis, Pin, Plus, X } from '@/components/icons'
import { toast } from 'sonner'
import { organizeAutomation, pinAutomation, restoreAutomation } from '@/app/actions/automations'
import { listWorkspaceBots } from '@/app/actions/bots'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useActionError } from '@/lib/use-action-error'
import { Empty, EmptyContent, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemSeparator, ItemTitle } from '@/components/ui/item'
import { SearchInput } from '@/components/ui/search-input'
import { Skeleton } from '@/components/ui/skeleton'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { InlineLoadError } from '@/components/load-error'
import { BotAvatar, CoordinatorAvatar } from '@/components/nav/bot-avatar'
import { useLiveKey } from '@/hooks/use-live-key'
import { invalidateAutomationList, useAutomations } from '@/hooks/use-automations'
import type { AutomationView } from '@/lib/schedules/automation-view'
import { useNextRunLabel, useTimingSummary } from './automation-summary'
import { AUTOMATION_TEMPLATES } from './automation-templates'

type Filter = 'all' | 'active' | 'paused' | 'deleted'
export type WorkspaceBotRow = { id: string; name: string; color: string; shape: string }

/** The workspace's Bots by ID, for 交给 (any member may read them; the list follows `bot_list`). */
export function useWorkspaceBotNames(workspaceId: string | null) {
  const key = workspaceId ? ['automations-workspace-bots', workspaceId] as const : null
  const read = useSWR(key, async ([, shown]) => {
    const result = await listWorkspaceBots(shown)
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
export function AutomationsPage({ workspaceId, userId, href, onOpen, onAskBot }: { workspaceId: string | null; userId: string; href: (id: string) => string; onOpen: (id: string) => void; onAskBot: (text: string) => void }) {
  const t = useTranslations('Automations')
  const tCommon = useTranslations('Common')
  const summary = useTimingSummary()
  const nextRun = useNextRunLabel()
  const [filter, setFilter] = useState<Filter>('all')
  const [restoring, setRestoring] = useState<string | null>(null)
  const { automations, error, data, mutate, setSize, size, more, isValidating } = useAutomations(workspaceId, filter === 'deleted')
  const { mutate: mutateCache } = useSWRConfig()
  const bots = useWorkspaceBotNames(workspaceId)
  const [query, setQuery] = useState('')
  const [tag, setTag] = useState<string | null>(null)
  const [organizing, setOrganizing] = useState<AutomationView | null>(null)
  const actionError = useActionError()
  const visible = automations.filter(row => filter === 'deleted' ? row.deleted : row.status !== 'cancelled' && (filter === 'all' || row.status === filter))
    .filter(row => !query.trim() || row.definition.title.toLowerCase().includes(query.trim().toLowerCase()))
    .filter(row => !tag || (row.tags ?? []).includes(tag))
  // 已置顶 first, then each 文件夹 by name, then those in none; within each, the list's own order (newest first).
  const folders = [...new Set(visible.filter(row => !row.pinned && row.folder).map(row => row.folder!))].sort((a, b) => a.localeCompare(b))
  const groups: { key: string; label: string | null; rows: AutomationView[] }[] = [
    { key: 'pinned', label: t('pinned'), rows: visible.filter(row => row.pinned) },
    ...folders.map(folder => ({ key: `folder:${folder}`, label: folder, rows: visible.filter(row => !row.pinned && row.folder === folder) })),
    { key: 'rest', label: folders.length ? t('noFolder') : null, rows: visible.filter(row => !row.pinned && !row.folder) },
  ].filter(group => group.rows.length)
  async function restore(row: AutomationView) {
    if (restoring || !workspaceId) return
    setRestoring(row.id)
    try {
      const result = await restoreAutomation({ scheduleId: row.id, version: row.version }, workspaceId)
      if ('error' in result && result.error) { toast.error(actionError(result.error)); return }
      await invalidateAutomationList(mutateCache, workspaceId, false)
      await mutate()
    } catch { toast.error(actionError('generic')) }
    finally { setRestoring(null) }
  }
  async function pin(row: AutomationView) {
    const result = await pinAutomation({ scheduleId: row.id, pinned: !row.pinned }, workspaceId ?? undefined)
    if ('error' in result && result.error) { toast.error(actionError(result.error)); return }
    await mutate()
  }
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
      <DropdownMenuSeparator />
      <DropdownMenuGroup>
        <DropdownMenuLabel>{t('fromTemplate')}</DropdownMenuLabel>
        {AUTOMATION_TEMPLATES.map(template => <DropdownMenuItem key={template} onClick={() => onOpen(`new:${template}`)}>{t(`templates.${template}.title`)}</DropdownMenuItem>)}
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
        <ToggleGroup aria-label={t('filter.all')} size="sm" variant="segment" spacing={0.5} value={[filter]} onValueChange={values => { const next = values[0]; if (next === 'all' || next === 'active' || next === 'paused' || next === 'deleted') setFilter(next) }}>
          {(['all', 'active', 'paused', 'deleted'] as const).map(value => <ToggleGroupItem key={value} value={value}>{t(`filter.${value}`)}</ToggleGroupItem>)}
        </ToggleGroup>
        {tag && <Badge variant="secondary" className="gap-1">{t('tagFilter', { tag })}<Button size="icon-xs" variant="ghost" aria-label={t('clearTag')} onClick={() => setTag(null)}><X /></Button></Badge>}
      </div>
      {error && !data ? <InlineLoadError message={t('loadError')} retryLabel={tCommon('retry')} onRetry={() => { void mutate() }} />
        : !data ? <div role="status" aria-label={t('loading')} className="flex flex-col gap-2">{[0, 1, 2].map(index => <Skeleton key={index} className="h-16 w-full rounded-xl" />)}</div>
          : !visible.length ? <Empty className="border">
            <EmptyHeader><EmptyTitle>{filter === 'deleted' ? t('emptyDeleted') : automations.length ? t('emptyFiltered') : t('empty')}</EmptyTitle></EmptyHeader>
            {filter !== 'deleted' && !automations.length && <EmptyContent>{create}</EmptyContent>}
          </Empty>
            : <div className="flex flex-col gap-4">{groups.map(group => <section key={group.key} aria-label={group.label ?? undefined} className="flex flex-col gap-2">
              {group.label && <h2 className="flex items-center gap-1.5 px-1 text-sm font-medium text-muted-foreground">{group.key === 'pinned' && <Pin className="size-3.5" />}{group.label}</h2>}
              <ItemGroup role="list" className="gap-0! overflow-hidden rounded-2xl border bg-card">
              {group.rows.map((row, index) => <Fragment key={row.id}>{index > 0 && <ItemSeparator className="my-0" />}<Item role="listitem" className="rounded-none hover:bg-accent/50" render={row.deleted ? undefined : <a href={href(row.id)} />} onClick={row.deleted ? undefined : (event: MouseEvent) => follow(event, row.id)}>
                <ItemContent className="min-w-0">
                  <ItemTitle className="w-full truncate">{row.definition.title}</ItemTitle>
                  <ItemDescription className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span>{summary(row.definition)}</span>
                    {row.status === 'active' && row.next_at && <time dateTime={new Date(row.next_at).toISOString()}>{t('nextRun', { time: nextRun(row.next_at, row.definition.timezone) })}</time>}
                    {(row.tags ?? []).map(name => <Button key={name} size="xs" variant="secondary" className="rounded-full"
                      onClick={event => { event.preventDefault(); event.stopPropagation(); setTag(name) }}>#{name}</Button>)}
                  </ItemDescription>
                </ItemContent>
                <ItemMedia className="hidden max-w-40 text-sm sm:flex"><AutomationBot automation={row} bots={bots} /></ItemMedia>
                <ItemActions>
                  <Badge variant={statusVariant[row.status]}>{row.status === 'paused' && row.disabled_reason ? t('status.autoPaused') : t(`status.${row.status}`)}</Badge>
                  {row.deleted ? (row.owner_id === userId || row.can_take_over) && <Button size="sm" variant="outline" disabled={restoring !== null} aria-busy={restoring === row.id} onClick={() => { void restore(row) }}>{t('restore')}</Button> : <DropdownMenu>
                    <DropdownMenuTrigger render={<Button size="icon-sm" variant="ghost" aria-label={t('rowMenu')} onClick={event => { event.preventDefault(); event.stopPropagation() }} />}><Ellipsis /></DropdownMenuTrigger>
                    <DropdownMenuContent align="end" onClick={event => event.stopPropagation()}>
                      <DropdownMenuGroup>
                        <DropdownMenuItem onClick={() => { void pin(row) }}>{row.pinned ? t('unpin') : t('pin')}</DropdownMenuItem>
                        {(row.owner_id === userId || row.can_take_over) && <DropdownMenuItem onClick={() => setOrganizing(row)}>{t('organize')}</DropdownMenuItem>}
                      </DropdownMenuGroup>
                    </DropdownMenuContent>
                  </DropdownMenu>}
                </ItemActions>
              </Item></Fragment>)}
              </ItemGroup>
            </section>)}</div>}
      {more && <Button variant="outline" disabled={isValidating} onClick={() => void setSize(size + 1)}>{t('more')}</Button>}
    </div>
    {organizing && <OrganizeDialog automation={organizing} folders={[...new Set(automations.flatMap(row => row.folder ? [row.folder] : []))]} onClose={() => setOrganizing(null)} onSaved={() => { setOrganizing(null); void mutate() }} />}
  </section>
}

/** 文件夹和标签 (decision 2026-11-15-2100): the workspace's folder and tags for one automation. */
function OrganizeDialog({ automation, folders, onClose, onSaved }: { automation: AutomationView; folders: string[]; onClose: () => void; onSaved: () => void }) {
  const t = useTranslations('Automations')
  const actionError = useActionError()
  const [folder, setFolder] = useState(automation.folder ?? '')
  const [tags, setTags] = useState((automation.tags ?? []).join(', '))
  const [busy, setBusy] = useState(false)
  async function save() {
    setBusy(true)
    try {
      const list = [...new Set(tags.split(/[,，]/).map(item => item.trim()).filter(Boolean))].slice(0, 10)
      const result = await organizeAutomation({ scheduleId: automation.id, folder: folder.trim() || null, tags: list }, automation.workspace_id ?? undefined)
      if ('error' in result && result.error) { toast.error(actionError(result.error)); return }
      toast.success(t('saved'))
      onSaved()
    } finally { setBusy(false) }
  }
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose() }}>
    <DialogContent>
      <DialogHeader><DialogTitle>{t('organizeTitle')}</DialogTitle></DialogHeader>
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="automation-folder">{t('folder')}</Label>
          <Input id="automation-folder" list="automation-folders" value={folder} maxLength={60} placeholder={t('folderPlaceholder')} onChange={event => setFolder(event.target.value)} />
          <datalist id="automation-folders">{folders.map(name => <option key={name} value={name} />)}</datalist>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="automation-tags">{t('tags')}</Label>
          <Input id="automation-tags" value={tags} maxLength={340} placeholder={t('tagsPlaceholder')} onChange={event => setTags(event.target.value)} />
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" disabled={busy} onClick={onClose}>{t('cancel')}</Button>
        <Button disabled={busy} onClick={() => { void save() }}>{t('save')}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
}
