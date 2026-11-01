'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Bot, FolderClosed, ListTodo, Plus, RotateCw, Search, SquarePen, Users } from 'lucide-react'
import type { listIssues } from '@/app/actions/issues'
import type { listProjects } from '@/app/actions/projects'
import type { BotView } from '@/app/actions/bots'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/reui/badge'
import { Command, CommandDialog, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from '@/components/ui/command'
import { Spinner } from '@/components/ui/spinner'
import { statusTone, type StatusTone } from '@/lib/status-appearance'
import { ShortcutKeys } from '@/components/shortcut-keys'
import { issueIdentifier } from '@/components/workspace/issue-properties'
import type { SavedAgentSession } from '@/lib/agent-history'
import { matchesQuery, mergeById, type SiteSearchItem } from '@/lib/site-search'
import { useSiteSearch, type ListedSource } from '@/hooks/use-site-search'
import type { ChatTarget } from './bot-list'
import { LetterAvatar } from './letter-avatar'
import { BotAvatar, CoordinatorAvatar } from './bot-avatar'
import { FieldError } from '@/components/ui/field'

type Issue = Awaited<ReturnType<typeof listIssues>>[number]
type Project = Awaited<ReturnType<typeof listProjects>>[number]
type TaskHit = Extract<SiteSearchItem, { type: 'task' }>
type GroupHit = Extract<SiteSearchItem, { type: 'group' }>
type HistoryHit = Extract<SiteSearchItem, { type: 'history' }>

const STATUS_BADGES = { neutral: 'outline', warning: 'warning-light', info: 'info-light', success: 'success-light', destructive: 'destructive-light', focus: 'focus-light' } as const satisfies Record<StatusTone, string>

/** The search pill centered in the window bar (Comma's shell); it opens the results below it. */
export function SearchPill({ onSearch }: { onSearch: () => void }) {
  const t = useTranslations('Shell')
  return <Button variant="outline" size="sm" aria-label={t('searchLabel')} aria-keyshortcuts="Control+k Meta+k" onClick={onSearch} className="h-7 w-full min-w-0 justify-center gap-2 rounded-full px-3 text-xs font-normal text-muted-foreground hover:text-foreground">
    <Search data-icon="inline-start" />
    <span className="truncate">{t('searchPlaceholder')}</span>
    <ShortcutKeys keys={['mod', 'K']} />
  </Button>
}

/**
 * ⌘K over everything (MIK-36): conversations, group chats, tasks and projects.
 * Built on reUI's command palette (c-command-5 / c-command-8), centered in the
 * window with a fixed-height list so the dialog doesn't jump while filtering.
 *
 * With an empty query it lists what the page already loaded. Once there is a
 * query, the loaded rows that match show at once and GET /api/search (#310) adds
 * history, group and task hits beyond them, one source and cursor each. Rows
 * stay authorized by the server; opening one goes through the destination's own
 * access check.
 */
export function GlobalSearch({ open, onOpenChange, onOpenChangeComplete, bots, sessions, coordinatorLine, issues, projects, workspaceId, onChat, onNewBot, onIssue, onProject, onCreateIssue }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onOpenChangeComplete?: (open: boolean) => void
  bots: BotView[]
  sessions: SavedAgentSession[]
  coordinatorLine?: string
  issues: Issue[]
  projects: Project[]
  /** Selects the sharing context for group and task search; history needs none. */
  workspaceId: string | null
  onChat: (target: ChatTarget) => void
  onNewBot: () => void
  onIssue: (id: string) => boolean
  onProject: (id: string) => void
  onCreateIssue: () => void
}) {
  const t = useTranslations('Shell')
  const tNav = useTranslations('Nav')
  const tIssue = useTranslations('Issue')
  const [query, setQuery] = useState('')
  const search = useSiteSearch(query, workspaceId)
  const text = query.trim()
  const statusLabel = (value: string) => tIssue.has(`status.${value}` as never) ? tIssue(`status.${value}` as never) : value
  const sessionName = (title: string) => tNav('archivedConversation', { title: title || tNav('untitledConversation') })
  function pick(action: () => void) { onOpenChange(false); action() }
  const shown = (value: string) => !text || matchesQuery(value, text)

  const coordinatorValue = `coordinator ${tNav('coordinator')} ${coordinatorLine ?? ''}`
  // The Coordinator has its own entry above; its bot row is not listed again.
  const botRows = bots.filter(bot => !bot.coordinator && shown(bot.name))
  const historyRows = mergeById(
    sessions.filter(session => shown(`${sessionName(session.title)} ${session.preview ?? ''}`)),
    search.state.history.items.filter((item): item is HistoryHit => item.type === 'history'),
  )
  const groupRows = search.state.groups.items.filter((item): item is GroupHit => item.type === 'group')
  const taskRows: (Issue | TaskHit)[] = mergeById(
    issues.filter(issue => shown(`${issueIdentifier(issue)} ${issue.title}`)),
    search.state.tasks.items.filter((item): item is TaskHit => item.type === 'task'),
  )
  const projectRows = projects.filter(project => shown(`${project.name} ${project.summary}`))
  const actions = [
    // i18n-ignore: bilingual search keywords, not rendered
    { value: '新建任务 create issue new task', icon: Plus, label: t('newTask'), run: onCreateIssue },
    // i18n-ignore: search keywords, not rendered
    { value: 'Bot coordinator chat', icon: SquarePen, label: tNav('openBotChat'), run: () => onChat({ kind: 'coordinator' }) },
    // i18n-ignore: bilingual search keywords, not rendered
    { value: '新建 bot create new bot', icon: Bot, label: t('newBot.title'), run: onNewBot },
  ].filter(action => shown(`${action.value} ${action.label}`))
  const coordinatorShown = shown(coordinatorValue)

  const failed = search.sources.filter(source => search.state[source].status === 'error' || search.state[source].error)
  const authLost = failed.some(source => search.state[source].error === 'authRequired')
  const resultCount = (coordinatorShown ? 1 : 0) + botRows.length + historyRows.length + groupRows.length + taskRows.length + projectRows.length + actions.length
  const announce = search.searching ? t('search.searching')
    : search.query.kind === 'tooLong' ? t('search.tooLong')
      : resultCount === 0 ? t('searchEmpty') : t('search.count', { count: resultCount })

  /** Label of a source's "load more" row; the row sits inside that source's group. */
  function moreLabel(source: ListedSource) {
    const loading = search.state[source].loadingMore
    return <>{loading ? <Spinner role="presentation" aria-hidden="true" /> : <Plus />}{loading ? t('search.loadingMore') : t('search.more')}</>
  }

  return <CommandDialog open={open} onOpenChange={onOpenChange} onOpenChangeComplete={onOpenChangeComplete} title={t('searchLabel')} description={t('searchDescription')} className="top-1/2 -translate-y-1/2 sm:max-w-xl">
    {/* Filtering is ours: server hits must not be dropped by cmdk's client-side match. */}
    <Command shouldFilter={false} className="**:data-[selected=true]:bg-muted">
      <CommandInput aria-label={t('searchLabel')} placeholder={t('searchPlaceholder')} value={query} onValueChange={setQuery} maxLength={400} />
      <p role="status" aria-live="polite" className="sr-only">{text ? announce : ''}</p>
      <CommandList aria-busy={search.searching} className="h-[min(26rem,60svh)] max-h-none">
        {(coordinatorShown || botRows.length > 0) && <CommandGroup heading={t('groups.bots')}>
          {coordinatorShown && <CommandItem value={coordinatorValue} onSelect={() => pick(() => onChat({ kind: 'coordinator' }))} className="gap-3 py-2">
            <CoordinatorAvatar size="search" />
            <span className="flex min-w-0 flex-col"><span className="truncate font-medium">{tNav('coordinator')}</span>{coordinatorLine && <span className="truncate text-xs text-muted-foreground">{coordinatorLine}</span>}</span>
          </CommandItem>}
          {botRows.map(bot => <CommandItem key={bot.id} value={`bot ${bot.id}`} onSelect={() => pick(() => onChat({ kind: 'bot', botId: bot.id }))} className="gap-3 py-2">
            <BotAvatar color={bot.color} shape={bot.shape} size="search" />
            <span className="truncate font-medium">{bot.name}</span>
          </CommandItem>)}
        </CommandGroup>}
        {historyRows.length > 0 && <CommandGroup heading={t('groups.conversations')}>
          {historyRows.map(row => {
            const name = sessionName(row.title)
            const preview = 'preview' in row ? row.preview : null
            return <CommandItem key={`history:${row.id}`} value={`session ${row.id}`} onSelect={() => pick(() => onChat({ kind: 'agent', sessionId: row.id }))} className="gap-3 py-2">
              <LetterAvatar name={name} size="search" />
              <span className="flex min-w-0 flex-col"><span className="truncate font-medium">{name}</span>{preview && preview !== name && <span className="truncate text-xs text-muted-foreground">{preview}</span>}</span>
            </CommandItem>
          })}
          {search.state.history.nextCursor && <CommandItem value="more history" disabled={search.state.history.loadingMore} onSelect={() => search.more('history')} className="text-muted-foreground">{moreLabel('history')}</CommandItem>}
        </CommandGroup>}
        {groupRows.length > 0 && <CommandGroup heading={t('groups.groupChats')}>
          {groupRows.map(row => <CommandItem key={`group:${row.id}`} value={`group ${row.id}`} onSelect={() => pick(() => onChat({ kind: 'group', id: row.id, title: row.title, workspaceId: row.workspaceId }))} className="gap-3 py-2">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"><Users /></span>
            <span className="min-w-0 flex-1 truncate font-medium">{row.title || tNav('untitledConversation')}</span>
          </CommandItem>)}
          {search.state.groups.nextCursor && <CommandItem value="more groups" disabled={search.state.groups.loadingMore} onSelect={() => search.more('groups')} className="text-muted-foreground">{moreLabel('groups')}</CommandItem>}
        </CommandGroup>}
        {taskRows.length > 0 && <CommandGroup heading={t('groups.tasks')}>
          {taskRows.map(row => {
            const assignee = 'metadata' in row ? row.metadata.assignee?.name : null
            return <CommandItem key={`task:${row.id}`} value={`issue ${row.id}`} onSelect={() => { if (onIssue(row.id)) onOpenChange(false) }} className="gap-3 py-2">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"><ListTodo /></span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-medium"><span className="text-muted-foreground tabular-nums">{issueIdentifier(row, tIssue('unassignedNumber'))}</span> {row.title}</span>
                {assignee && <span className="truncate text-xs text-muted-foreground">{assignee}</span>}
              </span>
              <CommandShortcut className="tracking-normal"><Badge variant={STATUS_BADGES[statusTone(row.status)]} size="sm">{statusLabel(row.status)}</Badge></CommandShortcut>
            </CommandItem>
          })}
          {search.state.tasks.nextCursor && <CommandItem value="more tasks" disabled={search.state.tasks.loadingMore} onSelect={() => search.more('tasks')} className="text-muted-foreground">{moreLabel('tasks')}</CommandItem>}
        </CommandGroup>}
        {projectRows.length > 0 && <CommandGroup heading={t('groups.projects')}>
          {projectRows.map(project => <CommandItem key={project.id} value={`project ${project.id}`} onSelect={() => pick(() => onProject(project.id))} className="gap-3 py-2">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"><FolderClosed /></span>
            <span className="flex min-w-0 flex-col"><span className="truncate font-medium">{project.name}</span>{project.summary && <span className="truncate text-xs text-muted-foreground">{project.summary}</span>}</span>
          </CommandItem>)}
        </CommandGroup>}
        {actions.length > 0 && <CommandGroup heading={t('groups.actions')}>
          {actions.map(action => <CommandItem key={action.value} value={action.value} onSelect={() => pick(action.run)}><action.icon />{action.label}</CommandItem>)}
        </CommandGroup>}
        {/* Both lines are announced by the status region above, so the listbox stays options only for screen readers. */}
        {search.searching && <div aria-hidden="true" className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground"><Spinner role="presentation" aria-hidden="true" className="size-3.5" />{t('search.searching')}</div>}
        {!search.searching && resultCount === 0 && <p aria-hidden="true" className="py-6 text-center text-sm">{search.query.kind === 'tooLong' ? t('search.tooLong') : t('searchEmpty')}</p>}
        {failed.length > 0 && (authLost
          ? <FieldError className="px-3 py-2 text-xs">{t('search.authRequired')}</FieldError>
          : <CommandGroup>
            <CommandItem value="retry search" onSelect={() => { for (const source of failed) search.retry(source) }} className="text-muted-foreground">
              <RotateCw />{t('search.failed', { sources: failed.map(source => t(`search.source.${source}`)).join(t('search.sourceSeparator')) })}
              <CommandShortcut className="tracking-normal">{t('search.retry')}</CommandShortcut>
            </CommandItem>
          </CommandGroup>)}
      </CommandList>
    </Command>
  </CommandDialog>
}
