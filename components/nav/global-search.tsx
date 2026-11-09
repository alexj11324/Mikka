'use client'

import { useState } from 'react'
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
import { statusTone, type StatusTone } from '@/lib/status-appearance'
import { ShortcutKeys } from '@/components/shortcut-keys'
import type { SavedAgentSession } from '@/lib/agent-history'
import { matchesQuery, mergeById, type SiteSearchItem } from '@/lib/site-search'
import { useSiteSearch, type ListedSource } from '@/hooks/use-site-search'
import type { ChatTarget } from './bot-list'
import { LetterAvatar } from './letter-avatar'
import { BotAvatar, CoordinatorAvatar } from './bot-avatar'
import { FieldError } from '@/components/ui/field'
import { localTaskState, type TaskState } from '@/hooks/use-bot-tasks'

type Issue = Awaited<ReturnType<typeof listIssues>>[number]
type Project = Awaited<ReturnType<typeof listProjects>>[number]
type TaskHit = Extract<SiteSearchItem, { type: 'task' }>
type GroupHit = Extract<SiteSearchItem, { type: 'group' }>
type HistoryHit = Extract<SiteSearchItem, { type: 'history' }>

/** A task state's badge tone: waiting is the person's turn, blocked and failed need help, the rest are calm. */
const TASK_STATE_TONE = { waiting: 'warning', blocked: 'destructive', failed: 'destructive', running: 'info', queued: 'neutral', todo: 'neutral', idle: 'neutral', done: 'success', canceled: 'neutral', duplicate: 'neutral' } as const satisfies Record<TaskState, StatusTone>

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

/**
 * ⌘K over everything (MIK-36): conversations, group chats, tasks, threads and projects.
 * Built on reUI's command palette (c-command-5 / c-command-8), centered in the
 * window with a fixed-height list so the dialog doesn't jump while filtering.
 *
 * With an empty query it lists what the page already loaded. Once there is a
 * query, the loaded rows that match show at once and GET /api/search (#310) adds
 * history, group and task hits beyond them, one source and cursor each. Rows
 * stay authorized by the server; opening one goes through the destination's own
 * access check.
 */
export function GlobalSearch({ open, onOpenChange, onOpenChangeComplete, bots, sessions, coordinatorLine, issues, projects, threads = [], workspaceId, onChat, onNewBot, onIssue, onProject, onThread, onCreateIssue, reviewTaskId = null, onReview }: {
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
}) {
  const t = useTranslations('Shell')
  const tNav = useTranslations('Nav')
  const tIssue = useTranslations('Issue')
  const tCopy = useTranslations('FeatureCopy')
  const tCommon = useTranslations('Common')
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
    issues.filter(issue => shown(`${issue.identifier ?? ''} ${issue.title}`)),
    search.state.tasks.items.filter((item): item is TaskHit => item.type === 'task'),
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

  /** Label of a source's "load more" row; the row sits inside that source's group. */
  function moreLabel(source: ListedSource) {
    const loading = search.state[source].loadingMore
    return <>{loading ? <Spinner role="presentation" aria-hidden="true" /> : <Plus />}{loading ? t('search.loadingMore') : t('search.more')}</>
  }

  const quickActions = (actions.length > 0 || reviewRows.length > 0) && <CommandGroup heading={t('groups.actions')}>
    {reviewRows.map(row => <CommandItem key={row.value} value={row.value} onSelect={() => pick(() => onReview?.(row.id))}><FileDiff />{row.label}</CommandItem>)}
    {actions.map(action => <CommandItem key={action.value} value={action.value} onSelect={() => pick(action.run)}><action.icon />{action.label}</CommandItem>)}
  </CommandGroup>

  return <CommandDialog open={open} onOpenChange={onOpenChange} onOpenChangeComplete={onOpenChangeComplete} title={t('searchLabel')} description={t('searchDescription')} className="top-[max(1rem,calc(50svh-15rem))] translate-y-0 max-md:top-[max(1rem,env(safe-area-inset-top))] sm:max-w-xl">
    {/* Filtering is ours: server hits must not be dropped by cmdk's client-side match. */}
    {/* The active row is a step of the text colour, so it reads on white and on the dark popover alike (bg-muted equals the dark popover). */}
    <Command shouldFilter={false} className="**:data-[selected=true]:bg-foreground/[0.08]">
      <CommandInput className="text-base text-ellipsis md:text-sm" aria-label={t('searchLabel')} placeholder={t('searchPlaceholder')} value={query} onValueChange={setQuery} maxLength={400} />
      <p role="status" aria-live="polite" className="sr-only">{text ? announce : ''}</p>
      {/* The dialog's top edge stays put and its height follows the results (Linear, Raycast): no blank block under one empty line. */}
      <CommandList aria-busy={search.searching} className="max-h-[min(26rem,60svh)] scroll-fade-y">
        {text && quickActions}
        {(coordinatorShown || botRows.length > 0) && <CommandGroup heading={t('groups.bots')}>
          {coordinatorShown && <CommandItem value={coordinatorValue} onSelect={() => pick(() => onChat({ kind: 'coordinator' }))} className="gap-3 py-2">
            <CoordinatorAvatar size="search" />
            <span className="flex min-w-0 flex-col"><span className="truncate font-medium">{tNav('coordinator')}</span>{coordinatorLine && <span className="truncate text-xs text-muted-foreground">{coordinatorLine}</span>}</span>
          </CommandItem>}
          {botRows.map(bot => <CommandItem key={bot.id} value={`bot ${bot.id}`} onSelect={() => pick(() => onChat({ kind: 'bot', botId: bot.id }))} className="gap-3 py-2">
            <BotAvatar id={bot.id} color={bot.color} shape={bot.shape} size="search" />
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
                <span className="truncate font-medium">{row.identifier && <><span className="text-muted-foreground tabular-nums">{row.identifier}</span> </>}{row.title}</span>
                {assignee && <span className="truncate text-xs text-muted-foreground">{assignee}</span>}
              </span>
              <CommandShortcut className="tracking-normal">{(() => {
                // The task's one state, as its card, panel row and board read it (localTaskState), not the bare board
                // status: a done run whose PR waits says Needs review here too (UI audit work-04). A server hit without
                // its metadata keeps the board status.
                const task = 'metadata' in row ? localTaskState(row, threads.find(thread => thread.issueId === row.id)) : null
                return task
                  ? <Badge variant={STATUS_BADGES[TASK_STATE_TONE[task.state]]} size="sm">{task.reason ? t(`panel.task.reason.${task.reason}`) : t(`panel.task.state.${task.state}`)}</Badge>
                  : <Badge variant={STATUS_BADGES[statusTone(row.status)]} size="sm">{statusLabel(row.status)}</Badge>
              })()}</CommandShortcut>
            </CommandItem>
          })}
          {search.state.tasks.nextCursor && <CommandItem value="more tasks" disabled={search.state.tasks.loadingMore} onSelect={() => search.more('tasks')} className="text-muted-foreground">{moreLabel('tasks')}</CommandItem>}
        </CommandGroup>}
        {threadRows.length > 0 && onThread && <CommandGroup heading={t('groups.threads')}>
          {threadRows.map(({ thread, name }) => <CommandItem key={`thread:${thread.id}`} value={`thread ${thread.id}`} onSelect={() => pick(() => onThread(thread.id))} className="gap-3 py-2">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted"><ThreadMark size="row" /></span>
            <span className="flex min-w-0 flex-col"><span className="truncate font-medium">{name}</span><span className="truncate text-xs text-muted-foreground">{thread.lastReply ?? thread.agentName}</span></span>
          </CommandItem>)}
        </CommandGroup>}
        {projectRows.length > 0 && <CommandGroup heading={t('groups.projects')}>
          {projectRows.map(project => <CommandItem key={project.id} value={`project ${project.id}`} onSelect={() => pick(() => onProject(project.id))} className="gap-3 py-2">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"><FolderClosed /></span>
            <span className="flex min-w-0 flex-col"><span className="truncate font-medium">{project.name}</span>{project.summary && <span className="truncate text-xs text-muted-foreground">{project.summary}</span>}</span>
          </CommandItem>)}
        </CommandGroup>}
        {!text && quickActions}
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
      {/* The list ends on this bar, not mid-row; the keys are the ones issue-search names. */}
      <div aria-hidden="true" className="flex items-center gap-4 bg-muted/30 px-4 py-2.5 text-xs text-muted-foreground max-md:hidden"><span className="flex items-center gap-1.5"><KbdGroup><Kbd>↑</Kbd><Kbd>↓</Kbd></KbdGroup>{tCopy('c_70b20820')}</span><span className="flex items-center gap-1.5"><Kbd>Enter</Kbd>{tCopy('c_65fc81e1')}</span><span className="ml-auto flex items-center gap-1.5"><Kbd>Esc</Kbd>{tCommon('close')}</span></div>
    </Command>
  </CommandDialog>
}
