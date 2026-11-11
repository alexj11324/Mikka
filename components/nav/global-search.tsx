'use client'

import { useContext, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Bot, FileDiff, FolderClosed, ListTodo, Plus, RotateCw, Search, SquarePen, Users } from 'lucide-react'
import type { listIssues } from '@/app/actions/issues'
import type { listProjects } from '@/app/actions/projects'
import type { Thread } from '@/app/actions/task-runs'
import { threadSearchHits } from '@/lib/thread-search'
import { threadName, ThreadMark } from './thread-list'
import type { BotView } from '@/app/actions/bots'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/reui/badge'
import { Command, CommandDialog, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from '@/components/ui/command'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { Spinner } from '@/components/ui/spinner'
import type { StatusTone } from '@/lib/status-appearance'
import { ShortcutKeys } from '@/components/shortcut-keys'
import type { SavedAgentSession } from '@/lib/agent-history'
import { matchesQuery, mergeById, type SiteSearchItem } from '@/lib/site-search'
import { useSiteSearch, type ListedSource } from '@/hooks/use-site-search'
import type { ChatTarget } from './bot-list'
import * as searchSlot from '@ui-slot/search'
import type { SearchLead, SearchPaletteProps, SearchRow, SearchSection } from '@/components/slots/search-contract'
import { cn } from '@/lib/utils'
import { LetterAvatar } from './letter-avatar'
import { BotAvatar, CoordinatorAvatar } from './bot-avatar'
import { FieldError } from '@/components/ui/field'
import type { TaskState } from '@/lib/task-state'
import { TaskPresentationsContext, useWorkspaceTaskPresentations } from '@/hooks/use-task-collection'
import { useLiveScope } from '@/hooks/use-live-key'

type Issue = Awaited<ReturnType<typeof listIssues>>[number]
type Project = Awaited<ReturnType<typeof listProjects>>[number]
type TaskHit = Extract<SiteSearchItem, { type: 'task' }>
type GroupHit = Extract<SiteSearchItem, { type: 'group' }>
type HistoryHit = Extract<SiteSearchItem, { type: 'history' }>

/** A task state's badge tone: waiting is the person's turn, blocked and failed need help, the rest are calm. */
const TASK_STATE_TONE = { waiting: 'warning', blocked: 'destructive', failed: 'destructive', running: 'info', queued: 'neutral', todo: 'neutral', done: 'success', canceled: 'neutral', duplicate: 'neutral' } as const satisfies Record<TaskState, StatusTone>

const STATUS_BADGES = { neutral: 'outline', warning: 'warning-light', info: 'info-light', success: 'success-light', destructive: 'destructive-light', focus: 'focus-light' } as const satisfies Record<StatusTone, string>

/** The search pill centered in the window bar (Comma's shell); it opens the results below it. */
export function SearchPill({ onSearch }: { onSearch: () => void }) {
  const t = useTranslations('Shell')
  return <Button variant="outline" size="sm" aria-label={t('searchLabel')} aria-keyshortcuts="Control+k Meta+k" onClick={onSearch} className="h-7 w-full min-w-0 justify-center gap-2 rounded-full px-3 text-xs font-normal text-muted-foreground hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring">
    <Search data-icon="inline-start" />
    <span className="truncate">{t('searchPlaceholder')}</span>
    {/* Keycaps a step off the pill, so Ctrl and K read as keys in light mode too (chat-12, work-15). */}
    <ShortcutKeys keys={['mod', 'K']} className="*:data-[slot=kbd]:bg-muted" />
  </Button>
}

type GlobalSearchProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onOpenChangeComplete?: (open: boolean) => void
  bots: BotView[]
  sessions: SavedAgentSession[]
  coordinatorLine?: string
  issues: Issue[]
  projects: Project[]
  /** The right column's threads, already loaded by the shell: searched by name, request and last reply (D4/M10). */
  threads?: Thread[]
  /** Selects the sharing context for group and task search; history needs none. */
  workspaceId: string | null
  onChat: (target: ChatTarget) => void
  onNewBot: () => void
  onIssue: (id: string) => boolean
  onProject: (id: string) => void
  onThread?: (runId: string) => void
  onCreateIssue: () => void
  /** The task in front of the person: its 「审阅 #N」 is listed with an empty query too. */
  reviewTaskId?: string | null
  /** Opens a task's review page; only given when the UI layer has one (review-summary's REVIEW_ENABLED). */
  onReview?: (issueId: string) => void
}

const QUERY_MAX_LENGTH = 400

/**
 * ⌘K over everything (MIK-36): conversations, group chats, tasks, threads and projects.
 * Built on reUI's command palette (c-command-5 / c-command-8), centered in the
 * window with a fixed-height list so the dialog doesn't jump while filtering;
 * a UI layer draws its own from the same sections (the `search` slot).
 *
 * With an empty query it lists what the page already loaded. Once there is a
 * query, the loaded rows that match show at once and GET /api/search (#310) adds
 * history, group and task hits beyond them, one source and cursor each. Rows
 * stay authorized by the server; opening one goes through the destination's own
 * access check.
 */
export function GlobalSearch(props: GlobalSearchProps) {
  const palette = useSearchPalette(props)
  const Layer = searchSlot.SearchPalette ?? null
  if (Layer) return <Layer {...palette} />
  return <SearchDialog {...palette} />
}

/** The palette as data: what is listed for the query, in order, and what picking each row does. */
function useSearchPalette({ open, onOpenChange, onOpenChangeComplete, bots, sessions, coordinatorLine, issues, projects, threads = [], workspaceId, onChat, onNewBot, onIssue, onProject, onThread, onCreateIssue, reviewTaskId = null, onReview }: GlobalSearchProps): SearchPaletteProps {
  const t = useTranslations('Shell')
  const tNav = useTranslations('Nav')
  const [query, setQuery] = useState('')
  const search = useSiteSearch(query, workspaceId)
  const text = query.trim()
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
  const presentations = useContext(TaskPresentationsContext)
  const scope = useLiveScope()
  const remoteTasks = useMemo(() => search.state.tasks.items.filter((item): item is TaskHit => item.type === 'task'), [search.state.tasks.items])
  // The workspace already reads its loaded issues. Only hits outside that collection need another batch.
  const extraTasks = useMemo(() => {
    const loaded = new Set(issues.map(issue => issue.id))
    return remoteTasks.filter(hit => !loaded.has(hit.id)).map(hit => ({ id: hit.id, workspaceId }))
  }, [issues, remoteTasks, workspaceId])
  const extra = useWorkspaceTaskPresentations(scope?.ownerId ?? '', workspaceId ?? undefined, null, extraTasks, open && !!scope?.ownerId && scope.workspaceId === workspaceId)
  const taskRows: (Issue | TaskHit)[] = mergeById(
    issues.filter(issue => shown(`${issue.identifier ?? ''} ${issue.title}`)),
    remoteTasks,
  )
  const threadRows = onThread ? threadSearchHits(threads, text, thread => threadName(thread, issues, tNav('untitledConversation')), new Set(taskRows.map(row => row.id))) : []
  const projectRows = projects.filter(project => shown(`${project.name} ${project.summary}`))
  const actions = [
    // i18n-ignore: bilingual search keywords, not rendered
    { value: '新建任务 create issue new task', icon: Plus, label: t('newTask'), run: onCreateIssue },
    // i18n-ignore: search keywords, not rendered
    { value: 'Bot coordinator chat', icon: SquarePen, label: tNav('openBotChat'), run: () => onChat({ kind: 'coordinator' }) },
    // i18n-ignore: bilingual search keywords, not rendered
    { value: '新建 bot create new bot', icon: Bot, label: t('newBot.title'), run: onNewBot },
  ].filter(action => shown(`${action.value} ${action.label}`))
  // 「审阅 #N」 (#1732): the current task's, and with a query any matching task that has a pull request.
  const reviewRows = onReview ? issues.filter(issue => issue.id === reviewTaskId || (text && issue.metadata.pullRequests?.length))
    .map(issue => ({ id: issue.id, label: t('reviewTask', { identifier: issue.identifier ?? issue.title }), value: `review ${issue.id} ${issue.identifier ?? ''} ${issue.title}` }))
    .filter(row => shown(`${row.value} ${row.label}`)) : []
  const coordinatorShown = shown(coordinatorValue)

  const failed = search.sources.filter(source => search.state[source].status === 'error' || search.state[source].error)
  const authLost = failed.some(source => search.state[source].error === 'authRequired')
  const resultCount = (coordinatorShown ? 1 : 0) + botRows.length + historyRows.length + groupRows.length + taskRows.length + threadRows.length + projectRows.length + actions.length + reviewRows.length
  const announce = search.searching ? t('search.searching')
    : search.query.kind === 'tooLong' ? t('search.tooLong')
      : resultCount === 0 ? t('searchEmpty') : t('search.count', { count: resultCount })

  /** A source's "load more" row; it sits inside that source's group. */
  function moreRow(source: ListedSource): SearchRow[] {
    const page = search.state[source]
    if (!page.nextCursor) return []
    return [{ key: `more ${source}`, label: page.loadingMore ? t('search.loadingMore') : t('search.more'), lead: { kind: 'glyph', icon: Plus }, busy: page.loadingMore, disabled: page.loadingMore, select: () => search.more(source) }]
  }

  const quickActions: SearchSection = { id: 'actions', heading: t('groups.actions'), rows: [
    ...reviewRows.map(row => ({ key: row.value, label: row.label, lead: { kind: 'glyph', icon: FileDiff }, select: () => pick(() => onReview?.(row.id)) } satisfies SearchRow)),
    ...actions.map(action => ({ key: action.value, label: action.label, lead: { kind: 'glyph', icon: action.icon }, select: () => pick(action.run) } satisfies SearchRow)),
  ] }
  const listed: SearchSection[] = [
    ...(text ? [quickActions] : []),
    { id: 'bots', heading: t('groups.bots'), rows: [
      ...(coordinatorShown ? [{ key: coordinatorValue, label: tNav('coordinator'), detail: coordinatorLine, lead: { kind: 'coordinator' }, select: () => pick(() => onChat({ kind: 'coordinator' })) } satisfies SearchRow] : []),
      ...botRows.map(bot => ({ key: `bot ${bot.id}`, label: bot.name, lead: { kind: 'bot', id: bot.id, color: bot.color, shape: bot.shape }, select: () => pick(() => onChat({ kind: 'bot', botId: bot.id })) } satisfies SearchRow)),
    ] },
    { id: 'conversations', heading: t('groups.conversations'), rows: historyRows.length ? [
      ...historyRows.map(row => {
        const name = sessionName(row.title)
        const preview = 'preview' in row ? row.preview : null
        return { key: `session ${row.id}`, label: name, detail: preview && preview !== name ? preview : undefined, lead: { kind: 'letter', name }, select: () => pick(() => onChat({ kind: 'agent', sessionId: row.id })) } satisfies SearchRow
      }),
      ...moreRow('history'),
    ] : [] },
    { id: 'groupChats', heading: t('groups.groupChats'), rows: groupRows.length ? [
      ...groupRows.map(row => ({ key: `group ${row.id}`, label: row.title || tNav('untitledConversation'), lead: { kind: 'icon', icon: Users }, select: () => pick(() => onChat({ kind: 'group', id: row.id, title: row.title, workspaceId: row.workspaceId })) } satisfies SearchRow)),
      ...moreRow('groups'),
    ] : [] },
    { id: 'tasks', heading: t('groups.tasks'), rows: taskRows.length ? [
      ...taskRows.map(row => {
        const assignee = 'metadata' in row ? row.metadata.assignee?.name : null
        const task = presentations[row.id] ?? extra.items[row.id]
        const status = task && { label: task.reason ? t(`panel.task.reason.${task.reason}`) : t(`panel.task.state.${task.state}`), tone: TASK_STATE_TONE[task.state] }
        return { key: `issue ${row.id}`, label: row.title, identifier: row.identifier ?? undefined, detail: assignee ?? undefined, status, lead: { kind: 'icon', icon: ListTodo }, select: () => { if (onIssue(row.id)) onOpenChange(false) } } satisfies SearchRow
      }),
      ...moreRow('tasks'),
    ] : [] },
    { id: 'threads', heading: t('groups.threads'), rows: onThread ? threadRows.map(({ thread, name }) => ({ key: `thread ${thread.id}`, label: name, detail: thread.lastReply ?? thread.agentName, lead: { kind: 'thread' }, select: () => pick(() => onThread(thread.id)) } satisfies SearchRow)) : [] },
    { id: 'projects', heading: t('groups.projects'), rows: projectRows.map(project => ({ key: `project ${project.id}`, label: project.name, detail: project.summary || undefined, lead: { kind: 'icon', icon: FolderClosed }, select: () => pick(() => onProject(project.id)) } satisfies SearchRow)) },
    ...(text ? [] : [quickActions]),
    ...(failed.length > 0 && !authLost ? [{ id: 'retry', rows: [{
      key: 'retry search', label: t('search.failed', { sources: failed.map(source => t(`search.source.${source}`)).join(t('search.sourceSeparator')) }), trailing: t('search.retry'), lead: { kind: 'glyph', icon: RotateCw },
      select: () => { for (const source of failed) search.retry(source) },
    }] } satisfies SearchSection] : []),
  ]
  const sections = listed.filter(section => section.rows.length > 0)

  return {
    open, onOpenChange, onOpenChangeComplete, query, onQueryChange: setQuery, maxLength: QUERY_MAX_LENGTH, sections,
    searching: search.searching, announce: text ? announce : '',
    empty: !search.searching && resultCount === 0 ? (search.query.kind === 'tooLong' ? t('search.tooLong') : t('searchEmpty')) : null,
    authError: authLost ? t('search.authRequired') : null,
  }
}

function RowLead({ lead }: { lead: SearchLead }) {
  switch (lead.kind) {
    case 'coordinator': return <CoordinatorAvatar size="search" />
    case 'bot': return <BotAvatar id={lead.id} color={lead.color} shape={lead.shape} size="search" />
    case 'letter': return <LetterAvatar name={lead.name} size="search" />
    case 'thread': return <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted"><ThreadMark size="row" /></span>
    case 'icon': return <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"><lead.icon /></span>
    case 'glyph': return <lead.icon />
  }
}

/** The open-source palette: reUI's command dialog over the sections. */
function SearchDialog({ open, onOpenChange, onOpenChangeComplete, query, onQueryChange, maxLength, sections, searching, announce, empty, authError }: SearchPaletteProps) {
  const t = useTranslations('Shell')
  const tCopy = useTranslations('FeatureCopy')
  const tCommon = useTranslations('Common')


  // Rows sit in their group's JSX (lint-ui composition/group).
  const group = (section: SearchSection) => <CommandGroup key={section.id} heading={section.heading}>{section.rows.map(item => item.lead.kind === 'glyph'
    ? <CommandItem key={item.key} value={item.key} disabled={item.disabled} onSelect={item.select} className={cn((item.busy !== undefined || item.trailing) && 'text-muted-foreground')}>
      {item.busy ? <Spinner role="presentation" aria-hidden="true" /> : <RowLead lead={item.lead} />}{item.label}
      {item.trailing && <CommandShortcut className="tracking-normal">{item.trailing}</CommandShortcut>}
    </CommandItem>
    : <CommandItem key={item.key} value={item.key} disabled={item.disabled} onSelect={item.select} className="gap-3 py-2">
      <RowLead lead={item.lead} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium">{item.identifier && <><span className="text-muted-foreground tabular-nums">{item.identifier}</span> </>}{item.label}</span>
        {item.detail && <span className="truncate text-xs text-muted-foreground">{item.detail}</span>}
      </span>
      {item.status && <CommandShortcut className="tracking-normal"><Badge variant={STATUS_BADGES[item.status.tone]} size="sm">{item.status.label}</Badge></CommandShortcut>}
    </CommandItem>)}</CommandGroup>

  return <CommandDialog open={open} onOpenChange={onOpenChange} onOpenChangeComplete={onOpenChangeComplete} title={t('searchLabel')} description={t('searchDescription')} className="top-[max(1rem,calc(50svh-15rem))] translate-y-0 max-md:top-[max(1rem,env(safe-area-inset-top))] sm:max-w-xl">
    {/* Filtering is ours: server hits must not be dropped by cmdk's client-side match. */}
    {/* The active row is a step of the text colour, so it reads on white and on the dark popover alike (bg-muted equals the dark popover). */}
    <Command shouldFilter={false} className="**:data-[selected=true]:bg-foreground/[0.08]">
      <CommandInput className="text-base text-ellipsis md:text-sm" aria-label={t('searchLabel')} placeholder={t('searchPlaceholder')} value={query} onValueChange={onQueryChange} maxLength={maxLength} />
      <p role="status" aria-live="polite" className="sr-only">{announce}</p>
      {/* The dialog's top edge stays put and its height follows the results (Linear, Raycast): no blank block under one empty line. */}
      <CommandList aria-busy={searching} className="max-h-[min(26rem,60svh)] scroll-fade-y">
        {sections.filter(section => section.id !== 'retry').map(group)}
        {/* Both lines are announced by the status region above, so the listbox stays options only for screen readers. */}
        {searching && <div aria-hidden="true" className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground"><Spinner role="presentation" aria-hidden="true" className="size-3.5" />{t('search.searching')}</div>}
        {empty && <p aria-hidden="true" className="py-6 text-center text-sm">{empty}</p>}
        {authError ? <FieldError className="px-3 py-2 text-xs">{authError}</FieldError> : sections.filter(section => section.id === 'retry').map(group)}
      </CommandList>
      {/* The list ends on this bar, not mid-row; the keys are the ones issue-search names. */}
      <div aria-hidden="true" className="flex items-center gap-4 bg-muted/30 px-4 py-2.5 text-xs text-muted-foreground max-md:hidden"><span className="flex items-center gap-1.5"><KbdGroup><Kbd>↑</Kbd><Kbd>↓</Kbd></KbdGroup>{tCopy('c_70b20820')}</span><span className="flex items-center gap-1.5"><Kbd>Enter</Kbd>{tCopy('c_65fc81e1')}</span><span className="ml-auto flex items-center gap-1.5"><Kbd>Esc</Kbd>{tCommon('close')}</span></div>
    </Command>
  </CommandDialog>
}
