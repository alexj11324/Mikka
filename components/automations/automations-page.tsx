'use client'

import { useState } from 'react'
import useSWR, { useSWRConfig } from 'swr'
import { useTranslations } from '@/lib/intl/i18n-client'
import { toast } from 'sonner'
import { organizeAutomation, pinAutomation, restoreAutomation } from '@/app/actions/automations'
import { listWorkspaceBots } from '@/app/actions/bots'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useActionError } from '@/lib/use-action-error'
import { BotAvatar, CoordinatorAvatar } from '@/components/nav/bot-avatar'
import { useLiveKey } from '@/hooks/use-live-key'
import { invalidateAutomationList, useAutomations } from '@/hooks/use-automations'
import type { AutomationView } from '@/lib/schedules/automation-view'
import { useNextRunLabel, useTimingSummary } from './automation-summary'
import { AUTOMATION_TEMPLATES, TEMPLATE_TRIGGERS } from './automation-templates'
import { AutomationsPageView } from '@ui-slot/automations'
import type { AutomationGroup, AutomationRow, AutomationsPageProps, AutomationsTab, AutomationTriggerKind } from '@/components/slots/automations-contract'
import { navigate } from '@/components/workspace/workspace-navigation'
import { useViewState } from '@/lib/hooks/view-state'

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

/** What starts an automation, for its row's icon: its first event trigger, else its webhook, else its timing. */
export function triggerKind(definition: AutomationView['definition']): AutomationTriggerKind {
  const first = definition.events?.[0]
  if (first) return first.source
  if (definition.webhook) return 'webhook'
  return definition.timing.kind === 'manual' ? 'manual' : 'schedule'
}

type Filters = AutomationsPageProps['filters']
type Display = AutomationsPageProps['display']
const TAB_FILTERS: Record<AutomationsTab, Pick<Filters, 'creatorIsMe' | 'scheduledOnly'>> = {
  mine: { creatorIsMe: true, scheduledOnly: false },
  all: { creatorIsMe: false, scheduledOnly: false },
  scheduled: { creatorIsMe: false, scheduledOnly: true },
}

/**
 * 自动化 (Capy's Automations list): the 我的 / 全部 / 定时 tabs are presets of the 创建者是我 and 定时 filters, which the
 * server applies (the list arrives a page at a time); 状态, search and tag narrow the rows read. Rows group by state
 * (运行中 N, 已暂停 N with the server's counts) or by folder. The page is drawn by the automations slot.
 */
export function AutomationsPage({ workspaceId, userId, href, onOpen, onAskBot }: { workspaceId: string | null; userId: string; href: (id: string) => string; onOpen: (id: string) => void; onAskBot: (text: string) => void }) {
  const t = useTranslations('Automations')
  const summary = useTimingSummary()
  const nextRun = useNextRunLabel()
  const [filters, setFilters] = useViewState<Filters>('automations:filters', { creatorIsMe: true, scheduledOnly: false, status: 'all' })
  const [display, setDisplay] = useViewState<Display>('automations:display', { grouping: 'status', showTemplates: true })
  const [restoring, setRestoring] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const deleted = filters.status === 'deleted'
  const { automations, counts, error, data, mutate, setSize, size, more, isValidating } = useAutomations(workspaceId, { deleted, ...(filters.creatorIsMe ? { owner: 'me' as const } : {}), ...(filters.scheduledOnly ? { trigger: 'schedule' as const } : {}) })
  const { mutate: mutateCache } = useSWRConfig()
  const bots = useWorkspaceBotNames(workspaceId)
  const [query, setQuery] = useState('')
  const [tag, setTag] = useState<string | null>(null)
  const [organizing, setOrganizing] = useState<AutomationView | null>(null)
  const actionError = useActionError()
  const visible = automations.filter(row => deleted ? row.deleted : row.status !== 'cancelled' && (filters.status === 'all' || row.status === filters.status))
    .filter(row => !query.trim() || row.definition.title.toLowerCase().includes(query.trim().toLowerCase()))
    .filter(row => !tag || (row.tags ?? []).includes(tag))
  const byId = new Map(visible.map(row => [row.id, row]))
  const toRow = (row: AutomationView): AutomationRow => ({
    id: row.id, title: row.definition.title, href: href(row.id), trigger: triggerKind(row.definition),
    // 含时区: a timed automation names the zone its clock reads.
    schedule: row.definition.timing.kind === 'manual' ? summary(row.definition) : `${summary(row.definition)} (${row.definition.timezone})`,
    nextRun: row.status === 'active' && row.next_at ? { at: new Date(row.next_at).toISOString(), label: nextRun(row.next_at, row.definition.timezone) } : null,
    status: row.status, statusLabel: row.status === 'paused' && row.disabled_reason ? t('status.autoPaused') : t(`status.${row.status}`),
    creator: row.owner_name ? { name: row.owner_name, image: row.owner_image ?? null } : null,
    handler: <AutomationBot automation={row} bots={bots} />,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    pinned: Boolean(row.pinned), tags: row.tags ?? [], deleted: Boolean(row.deleted),
    canRestore: Boolean(row.deleted) && (row.owner_id === userId || Boolean(row.can_take_over)),
    canOrganize: row.owner_id === userId || Boolean(row.can_take_over),
  })
  // The server's counts cover the whole filtered list; a search or tag narrows to the rows read, so it counts those.
  const narrowed = Boolean(query.trim() || tag)
  const groups: AutomationGroup[] = deleted ? [{ key: 'deleted', label: t('groups.deleted'), count: visible.length, rows: visible.map(toRow) }]
    : display.grouping === 'status' ? (['active', 'paused', 'ended'] as const).map(state => {
      // 置顶 first within each state, then the list's own order (newest first).
      const rows = visible.filter(row => state === 'ended' ? row.status === 'completed' : row.status === state).sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)))
      const count = state === 'ended' || narrowed || !counts ? rows.length : counts[state]
      return { key: state, label: t(`groups.${state}`), count, rows: rows.map(toRow) }
    }).filter(group => group.rows.length)
      : (() => {
        // 已置顶 first, then each 文件夹 by name, then those in none.
        const folders = [...new Set(visible.filter(row => !row.pinned && row.folder).map(row => row.folder!))].sort((a, b) => a.localeCompare(b))
        return [
          { key: 'pinned', label: t('pinned'), rows: visible.filter(row => row.pinned) },
          ...folders.map(folder => ({ key: `folder:${folder}`, label: folder, rows: visible.filter(row => !row.pinned && row.folder === folder) })),
          { key: 'rest', label: t('noFolder'), rows: visible.filter(row => !row.pinned && !row.folder) },
        ].filter(group => group.rows.length).map(group => ({ ...group, count: group.rows.length, rows: group.rows.map(toRow) }))
      })()
  async function restore(row: AutomationRow) {
    const automation = byId.get(row.id)
    if (restoring || !workspaceId || !automation) return
    setRestoring(row.id)
    try {
      const result = await restoreAutomation({ scheduleId: automation.id, version: automation.version }, workspaceId)
      if ('error' in result && result.error) { toast.error(actionError(result.error)); return }
      await invalidateAutomationList(mutateCache, workspaceId, false)
      await mutate()
    } catch { toast.error(actionError('generic')) }
    finally { setRestoring(null) }
  }
  async function pin(row: AutomationRow) {
    const result = await pinAutomation({ scheduleId: row.id, pinned: !row.pinned }, workspaceId ?? undefined)
    if ('error' in result && result.error) { toast.error(actionError(result.error)); return }
    await mutate()
  }
  const tab = (Object.keys(TAB_FILTERS) as AutomationsTab[]).find(key => TAB_FILTERS[key].creatorIsMe === filters.creatorIsMe && TAB_FILTERS[key].scheduledOnly === filters.scheduledOnly) ?? null
  const clearFilters = () => { setFilters({ creatorIsMe: false, scheduledOnly: false, status: 'all' }); setQuery(''); setTag(null) }
  const templates = AUTOMATION_TEMPLATES.map(id => {
    const trigger = TEMPLATE_TRIGGERS[id]
    return { id, title: t(`templates.${id}.title`), description: t(`templateDescriptions.${id}`), trigger, triggerLabel: t(`trigger.${trigger}`) }
  })
  return <AutomationsPageView
    tab={tab} onTab={next => setFilters(current => ({ ...current, ...TAB_FILTERS[next] }))}
    filters={filters} onFilters={change => setFilters(current => ({ ...current, ...change }))}
    display={display} onDisplay={change => setDisplay(current => ({ ...current, ...change }))}
    query={query} onQuery={setQuery} tag={tag} onTag={setTag}
    loading={!data && !error} error={Boolean(error && !data)} onRetry={() => { void mutate() }}
    groups={groups}
    empty={!data || groups.length ? null : deleted ? 'deleted' : automations.length || narrowed || filters.creatorIsMe || filters.scheduledOnly || filters.status !== 'all' ? 'filtered' : 'none'}
    onClearFilters={clearFilters}
    more={more} loadingMore={isValidating} onMore={() => { void setSize(size + 1) }}
    // A plain click opens the automation in place; a modified click keeps the browser's own new-tab behaviour.
    onOpen={(id, event) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      event.preventDefault()
      onOpen(id)
    }}
    onPin={row => { void pin(row) }}
    onOrganize={row => { const automation = byId.get(row.id); if (automation) setOrganizing(automation) }}
    onRestore={row => { void restore(row) }}
    onViewRuns={row => navigate({ section: 'conversations', directoryAutomation: row.id })}
    restoring={restoring}
    templates={templates}
    onTemplate={id => { setCreating(false); onOpen(`new:${id}`) }}
    create={{ open: creating, onOpenChange: setCreating, onScratch: () => { setCreating(false); onOpen('new') }, onAskBot: () => { setCreating(false); onAskBot(t('askBotPrompt')) } }}
    dialogs={organizing && <OrganizeDialog automation={organizing} folders={[...new Set(automations.flatMap(row => row.folder ? [row.folder] : []))]} onClose={() => setOrganizing(null)} onSaved={() => { setOrganizing(null); void mutate() }} />}
  />
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
