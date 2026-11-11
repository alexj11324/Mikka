'use client'

import { PersonAvatar } from '@/components/person-avatar'
import { useViewScroll, useViewState } from '@/lib/hooks/view-state'
import { useContext, useEffect, useId, useMemo, useRef, useState } from 'react'
import { ShortcutKeys } from '@/components/shortcut-keys'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { Box, Check, CircleUserRound, UserRoundPen, Columns3, Flag, List, ListFilter, PanelRightClose, PanelRightOpen, Plus, RefreshCw, Settings2, SquareKanban, Tag, X } from 'lucide-react'
import type { listIssues } from '@/app/actions/issues'
import { listAgents } from '@/app/actions/agents'
import { useLiveTaskRunList } from '@/hooks/use-live-lists'
import type { TaskBlock } from '@/lib/task-blocked'
import { TaskPresentationsContext } from '@/hooks/use-task-collection'
import { useListExpiry } from '@/hooks/use-list-expiry'
import { getLinearBoardSync } from '@/app/actions/linear-sync'
import { CoordinatorChat } from '@/components/coordinator/coordinator-chat'
import { NewTaskDialog } from '@/components/coordinator/new-task-dialog'
import { ConversationPill } from '@/components/nav/conversation-pill'
import { CoordinatorAvatar } from '@/components/nav/bot-avatar'
import { AGENT_STATES, BLOCKED_COLUMN, BOARD_COLUMNS, CARD_PROPERTIES, DEFAULT_CARD_PROPERTIES, DEFAULT_HIDDEN_COLUMNS, cardStateKind, type AgentState, type BoardColumn, type CardProperty } from '@/components/blocks/kanban-board-1/components/data'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuGroup, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { Toggle } from '@/components/ui/toggle'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { statusIconTints } from '@/lib/status-appearance'
import { boardProjectFilters, personFilters } from '@/lib/board-filters'
import { IssueBoard } from './issue-board'
import { BoardScreen, BoardScreenView } from './board-screen'
import type { BoardMenuItem } from '@/components/slots/board-contract'
import { IssueList } from './issue-list'
import { AgentSphere } from './issue-assignee-menu'
import { LabelDot } from './issue-metadata-controls'
import { ISSUE_PRIORITIES, ISSUE_STATUSES } from './issue-properties'
import { ResizablePane } from '@/components/ui/resizable-pane'

type Issue = Awaited<ReturnType<typeof listIssues>>[number]
type Scope = 'all' | 'workspace' | 'personal'
type FilterField = 'status' | 'priority' | 'assignee' | 'creator' | 'labels' | 'project' | 'agentState'
type Filters = Partial<Record<FilterField, string[]>>
type Sort = 'priority' | 'updated' | 'created'
type Completed = 'all' | 'week' | 'month'
type Display = { sort: Sort; completed: Completed; showEmpty: boolean; properties: CardProperty[]; hidden: BoardColumn[] }

const SETTINGS_KEY = 'mikka:board-v2'
const SIDEBAR_KEY = 'mikka:board-coordinator-open'
const WIDE = '(min-width: 80rem)'
const ME = 'me'
const NONE = 'none'
const DEFAULT_DISPLAY: Display = { sort: 'priority', completed: 'week', showEmpty: true, properties: DEFAULT_CARD_PROPERTIES, hidden: DEFAULT_HIDDEN_COLUMNS }
const DEFAULT_FILTERS: Filters = { assignee: [ME] }
const DEFAULT_SETTINGS = { scope: 'all' as Scope, view: 'board' as 'board' | 'list', display: DEFAULT_DISPLAY }
/** A 显示 chip: checked and tinted when on, plain grey when off. */
const DISPLAY_CHIP = 'h-7 rounded-md px-2 text-xs font-normal text-muted-foreground aria-pressed:bg-sidebar-primary/10 aria-pressed:text-sidebar-primary'
const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 }
const COMPLETED_DAYS: Record<Completed, number> = { all: Infinity, week: 7, month: 30 }
const FILTER_FIELDS: { field: FilterField; icon: typeof Flag }[] = [
  { field: 'status', icon: ISSUE_STATUSES[1].icon }, { field: 'priority', icon: Flag }, { field: 'assignee', icon: CircleUserRound }, { field: 'creator', icon: UserRoundPen },
  { field: 'labels', icon: Tag }, { field: 'project', icon: Box }, { field: 'agentState', icon: SquareKanban },
]

/** Browser preferences remain durable; named filters belong to the authenticated view scope. */
function useBoardSettings() {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS)
  useEffect(() => {
    try {
      const stored = JSON.parse(window.localStorage.getItem(SETTINGS_KEY) ?? 'null')
      if (stored) {
        const { filters: legacyFilters, ...preferences } = stored
        setSettings(current => ({ ...current, ...preferences, display: { ...current.display, ...preferences.display } }))
        // The old entry has no owner/workspace proof, so its names cannot migrate.
        if (legacyFilters !== undefined) window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(preferences))
      }
    } catch { /* storage unavailable */ }
  }, [])
  function update(patch: Partial<typeof DEFAULT_SETTINGS>) {
    setSettings(current => {
      const next = { ...current, ...patch }
      try { window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(next)) } catch { /* storage unavailable */ }
      return next
    })
  }
  return [settings, update] as const
}

function useStoredFlag(key: string, fallback: boolean) {
  const [value, setValue] = useState(fallback)
  useEffect(() => {
    try { const stored = window.localStorage.getItem(key); if (stored !== null) setValue(stored === '1') } catch { /* storage unavailable */ }
  }, [key])
  function update(next: boolean) {
    setValue(next)
    try { window.localStorage.setItem(key, next ? '1' : '0') } catch { /* storage unavailable */ }
  }
  return [value, update] as const
}

/**
 * The board page, v2 (Figma 77:2): scope segment, filters, Linear sync, board
 * or list, 显示 options and 新建任务 (described in a sentence, created by the
 * Coordinator) over the status columns and 受阻 (lib/task-blocked.ts), with the
 * Coordinator conversation in a sidebar that folds into a pill (MIK-45).
 */
export function BoardPage({ issues, userId, workspaceId, teamId, personalWorkspace = false, onOpen, onUpdated, onBusyChange, stateKey = 'board' }: { stateKey?: string; workspaceId?: string; teamId?: string;
  /** In a personal workspace every task is the person's: no 全部 / 工作区 / 个人 segment and no lock on cards (glossary, Known naming debt). */
  personalWorkspace?: boolean
  issues: Issue[]
  userId: string
  onOpen: (id: string) => boolean | void
  onUpdated: () => Promise<unknown>
  onBusyChange: (busy: boolean) => void
}) {
  const t = useTranslations('Shell.board')
  const tNav = useTranslations('Nav')
  const tIssue = useTranslations('Issue')
  const tCommon = useTranslations('Common')
  const titleId = useId()
  const statusLabel = (value: string) => tIssue.has(`status.${value}` as never) ? tIssue(`status.${value}` as never) : value
  const priorityLabel = (value: string) => tIssue.has(`priority.${value}` as never) ? tIssue(`priority.${value}` as never) : value
  const [settings, update] = useBoardSettings()
  const { view, display } = settings
  const scope: Scope = personalWorkspace ? 'all' : settings.scope
  const [savedFilters, setFilters] = useViewState<Filters>('board:filters', DEFAULT_FILTERS)
  const projects = useMemo(() => new Map(issues.flatMap(issue => issue.projectId && issue.metadata.project
    ? [[issue.projectId, issue.metadata.project] as const] : [])), [issues])
  const filters = useMemo(() => {
    const project = boardProjectFilters(savedFilters.project, projects)
    return project?.some((id, index) => id !== savedFilters.project?.[index]) || project?.length !== savedFilters.project?.length
      ? { ...savedFilters, project } : savedFilters
  }, [savedFilters, projects])
  useEffect(() => {
    if (filters !== savedFilters) setFilters(filters)
  }, [filters, savedFilters, setFilters])
  useListExpiry(display.completed === 'all' ? [] : issues.filter(issue => issue.status === 'done')
    .map(issue => new Date(issue.updatedAt).getTime() + COMPLETED_DAYS[display.completed] * 86_400_000))
  const listScroll = useViewScroll<HTMLDivElement>(`${stateKey}:list`, view === 'list')
  const [sidebar, setSidebar] = useStoredFlag(SIDEBAR_KEY, true)
  // Below xl (1280) a 360px panel leaves the board too little room: it starts folded and opens as a sheet over the board, as Linear's side panel does on narrow windows (R-65).
  const [sheet, setSheet] = useState(false)
  const [wide, setWide] = useState(true)
  useEffect(() => {
    const query = window.matchMedia(WIDE)
    const sync = () => { setWide(query.matches); if (query.matches) setSheet(false) }
    sync()
    query.addEventListener('change', sync)
    return () => query.removeEventListener('change', sync)
  }, [])
  const openPanel = () => { setSidebar(true); if (!window.matchMedia(WIDE).matches) setSheet(true) }
  const sidebarShown = sidebar && wide
  // The sheet opens on its composer, not on the first tabbable (the message list).
  const sheetRef = useRef<HTMLDivElement>(null)
  // R-65: ⌘J / Ctrl+J opens and closes the AI sidebar, the sheet below xl.
  useEffect(() => {
    function toggle(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.isComposing || event.key.toLowerCase() !== 'j') return
      event.preventDefault()
      if (window.matchMedia(WIDE).matches) setSidebar(!sidebar)
      else { setSheet(!sheet); if (!sheet) setSidebar(true) }
    }
    window.addEventListener('keydown', toggle)
    return () => window.removeEventListener('keydown', toggle)
  }, [sidebar, sheet, setSidebar])
  const [prefill, setPrefill] = useState<{ text: string; nonce: number }>()
  const [newTask, setNewTask] = useState(false)
  const { data: linear } = useSWR('linear-board-sync', () => getLinearBoardSync(), { revalidateOnFocus: false })
  // Without a connected Linear team, the button only reloads the board.
  const linearSynced = !!linear && !linear.error && linear.synced
  const { data: agents } = useSWR('agents', () => listAgents())
  const { data: runList } = useLiveTaskRunList(userId)
  const runs = runList?.items
  const myAgents = useMemo(() => new Set((agents ?? []).map(agent => agent.id)), [agents])
  const owners = useMemo(() => new Map((runs ?? []).map(run => [run.issueId, { bot: run.bot, harnesses: run.harnesses }] as const)), [runs])
  const presentation = useContext(TaskPresentationsContext)
  const taskStates = useMemo(() => new Map(Object.entries(presentation)), [presentation])
  const agentStates = useMemo(() => {
    const result = new Map<string, AgentState>()
    for (const [id, task] of taskStates) {
      const state = cardStateKind(task.state)
      if (state && state !== 'done') result.set(id, state)
    }
    return result
  }, [taskStates])
  const blocks = useMemo(() => {
    const result = new Map<string, TaskBlock>()
    for (const [id, task] of taskStates) {
      const reason = task.blockedReason
      if (reason) result.set(id, { reason: reason === 'factory' ? 'run' : reason, blockerIdentifier: task.blockedBy })
    }
    return result
  }, [taskStates])
  const newestRuns = useMemo(() => new Map((runs ?? []).map(run => [run.issueId, run.runId] as const)), [runs])
  const subtasks = useMemo(() => {
    const result = new Map<string, { done: number; total: number }>()
    for (const issue of issues) {
      const parent = issue.metadata.parentId
      if (parent) { const entry = result.get(parent) ?? { done: 0, total: 0 }; entry.total++; if (issue.status === 'done') entry.done++; result.set(parent, entry) }
    }
    for (const issue of issues) if (!result.has(issue.id) && issue.checklist.total) result.set(issue.id, { done: issue.checklist.checked, total: issue.checklist.total })
    return result
  }, [issues])

  const valuesOf = (issue: Issue, field: FilterField): string[] => {
    switch (field) {
      case 'status': return [issue.status, ...(blocks.has(issue.id) ? [BLOCKED_COLUMN] : [])]
      case 'priority': return [issue.priority]
      // listTaskRuns names a run's bot only when it is the person's own.
      case 'assignee': return [...(personFilters(issue, userId, { agents: myAgents, heldByMyBot: !!owners.get(issue.id)?.bot }).assignee ? [ME] : []), issue.metadata.assignee?.id ?? NONE]
      case 'creator': return personFilters(issue, userId, { agents: myAgents, heldByMyBot: false }).creator ? [ME] : []
      case 'labels': return issue.metadata.labels.map(label => label.name)
      case 'project': return [issue.projectId ?? NONE]
      case 'agentState': return [agentStates.get(issue.id) ?? NONE]
    }
  }
  const now = Date.now()
  const shown = issues
    .filter(issue => scope === 'all' || issue.scope === scope)
    .filter(issue => Object.entries(filters).every(([field, values]) => !values?.length || valuesOf(issue, field as FilterField).some(value => values.includes(value))))
    .filter(issue => issue.status !== 'done' || now - new Date(issue.updatedAt).getTime() <= COMPLETED_DAYS[display.completed] * 86400000)
    .toSorted((a, b) => display.sort === 'priority' ? (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9) || +new Date(b.updatedAt) - +new Date(a.updatedAt)
      : +new Date(display.sort === 'created' ? b.createdAt : b.updatedAt) - +new Date(display.sort === 'created' ? a.createdAt : a.updatedAt))
  const count = (column: BoardColumn) => shown.filter(issue => column === BLOCKED_COLUMN ? blocks.has(issue.id) : issue.status === column && !blocks.has(issue.id)).length
  const columns = BOARD_COLUMNS.map(column => column.value).filter(column => !display.hidden.includes(column) && (display.showEmpty || count(column) > 0))
  const hidden = display.hidden.map(status => ({ status, count: count(status) }))

  // Every value a filter can take, from the tasks on the board.
  const assignees = [...new Map(issues.flatMap(issue => issue.metadata.assignee ? [[issue.metadata.assignee.id, issue.metadata.assignee] as const] : [])).values()]
  const labels = [...new Map(issues.flatMap(issue => issue.metadata.labels.map(label => [label.name, label] as const))).values()]
  const options: Record<FilterField, { value: string; label: string; mark?: React.ReactNode }[]> = {
    status: BOARD_COLUMNS.map(column => { const status = ISSUE_STATUSES.find(item => item.value === column.value); return { value: column.value, label: statusLabel(column.value), mark: <column.icon className={cn(status ? statusIconTints[status.tone] : 'text-destructive-foreground')} /> } }),
    priority: ISSUE_PRIORITIES.map(priority => ({ value: priority.value, label: priorityLabel(priority.value), mark: <priority.icon {...priority.iconProps} /> })),
    assignee: [{ value: ME, label: t('me') }, ...assignees.filter(assignee => assignee.id !== userId).map(assignee => ({ value: assignee.id, label: assignee.name, mark: assignee.kind === 'agent' ? <AgentSphere name={assignee.name} compact /> : <PersonAvatar name={assignee.name} image={assignee.image} size="row" /> })), { value: NONE, label: t('unassigned'), mark: <CircleUserRound /> }],
    creator: [{ value: ME, label: t('me') }],
    labels: labels.map(label => ({ value: label.name, label: label.name, mark: <LabelDot color={label.color} /> })),
    project: [...[...projects].map(([id, name]) => ({ value: id, label: name, mark: <Box /> })), { value: NONE, label: t('noProject') }],
    agentState: [...AGENT_STATES.map(state => ({ value: state, label: t(`card.agent.${state}` as `card.agent.${AgentState}`) })), { value: NONE, label: t('noRun') }],
  }
  function toggleFilter(field: FilterField, value: string) {
    const current = filters[field] ?? []
    const next = current.includes(value) ? current.filter(item => item !== value) : [...current, value]
    setFilters({ ...filters, [field]: next })
  }
  const setDisplay = (patch: Partial<Display>) => update({ display: { ...display, ...patch } })
  const activeFilters = (Object.entries(filters) as [FilterField, string[]][]).filter(([, values]) => values?.length)

  const discuss = (issue: Issue) => { openPanel(); setPrefill({ text: t('discussPrefill', { id: issue.identifier ?? '', title: issue.title }), nonce: Date.now() }) }
  const refreshButton = <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label={linearSynced ? t('synced') : t('refresh')} className={cn(linearSynced && 'text-success-foreground')} onClick={() => { void onUpdated() }} />}><RefreshCw /></TooltipTrigger><TooltipContent side="bottom">{linearSynced ? t('synced') : t('refresh')}</TooltipContent></Tooltip>
  const panelButton = <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" className={cn('text-muted-foreground', sidebar && 'xl:hidden')} aria-expanded={sheet} aria-label={t('expand')} aria-keyshortcuts="Control+j Meta+j" onClick={openPanel} />}><PanelRightOpen data-icon="inline-start" /></TooltipTrigger><TooltipContent>{t('expand')}<ShortcutKeys keys={['mod', 'J']} /></TooltipContent></Tooltip>
  // The template's own menus (the `board` slot's BoardScreen) carry the filters and the 显示 options.
  const scoped = (value: Scope) => issues
    .filter(issue => value === 'all' || issue.scope === value)
    .filter(issue => Object.entries(filters).every(([field, values]) => !values?.length || valuesOf(issue, field as FilterField).some(item => values.includes(item))))
    .filter(issue => issue.status !== 'done' || now - new Date(issue.updatedAt).getTime() <= COMPLETED_DAYS[display.completed] * 86400000).length
  const scopes = (personalWorkspace ? ['all'] as const : ['all', 'workspace', 'personal'] as const).map(value => ({ id: value, label: t(`scope.${value}`), count: scoped(value) }))
  const filterItems: BoardMenuItem[] = [
    ...FILTER_FIELDS.map(({ field }): BoardMenuItem => field === 'creator'
      ? { label: t(`filterField.${field}`), checked: filters.creator?.includes(ME) ?? false, onSelect: () => toggleFilter(field, ME) }
      : { label: t(`filterField.${field}`), submenu: options[field].map(option => ({ label: option.label, checked: filters[field]?.includes(option.value) ?? false, onSelect: () => toggleFilter(field, option.value) })) }),
    { label: t('columns'), divider: true, submenu: BOARD_COLUMNS.map(column => ({ label: statusLabel(column.value), checked: !display.hidden.includes(column.value), onSelect: () => setDisplay({ hidden: display.hidden.includes(column.value) ? display.hidden.filter(item => item !== column.value) : [...display.hidden, column.value] }) })) },
    { label: t('showEmpty'), checked: display.showEmpty, onSelect: () => setDisplay({ showEmpty: !display.showEmpty }) },
  ]
  const sortItems: BoardMenuItem[] = [
    ...(['priority', 'updated', 'created'] as const).map(value => ({ label: t(`sortBy.${value}`), checked: display.sort === value, onSelect: () => setDisplay({ sort: value }) })),
    { label: t('completed'), divider: true, submenu: (['week', 'month', 'all'] as const).map(value => ({ label: t(`completedRange.${value}`), checked: display.completed === value, onSelect: () => setDisplay({ completed: value }) })) },
    { label: t('cardProperties'), submenu: CARD_PROPERTIES.map(property => ({ label: t(`property.${property}`), checked: display.properties.includes(property), onSelect: () => setDisplay({ properties: display.properties.includes(property) ? display.properties.filter(item => item !== property) : [...display.properties, property] }) })) },
  ]

  return <div className="flex min-h-0 flex-1">
    <section aria-labelledby={titleId} className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <h1 id={titleId} className="sr-only">{t('title')}</h1>
      {BoardScreen ? <BoardScreenView issues={shown} columns={columns} hidden={display.hidden} blocks={blocks} newestRuns={newestRuns} context={{ properties: new Set(display.properties), agentStates, taskStates, subtasks, owners, blocks, personalWorkspace }}
        view={view} onView={next => update({ view: next })} scopes={scopes} scope={scope} onScope={next => update({ scope: next as Scope })}
        filterItems={filterItems} filterCount={activeFilters.length} sortItems={sortItems} tools={<span className="flex items-center gap-1 max-md:hidden">{refreshButton}{panelButton}</span>}
        onNew={() => setNewTask(true)} onOpen={id => { onOpen(id) }} onDiscuss={discuss} onUpdated={onUpdated} onBusyChange={onBusyChange} />
      : <>
        <div role="toolbar" aria-label={t('toolbar')} className="flex min-h-14 shrink-0 flex-wrap items-center gap-2 px-5 py-3">
          {!personalWorkspace && <ToggleGroup aria-label={t('scopeLabel')} variant="segment" size="sm" spacing={0.5} value={[scope]} onValueChange={values => { const next = values[0] as Scope | undefined; if (next) update({ scope: next }) }}>
            {(['all', 'workspace', 'personal'] as const).map(value => <ToggleGroupItem key={value} value={value}>{t(`scope.${value}`)}</ToggleGroupItem>)}
          </ToggleGroup>}
          {!personalWorkspace && <Separator orientation="vertical" className="mx-1 h-5" />}
          <DropdownMenu>
            {/* On a phone Filter and Display show their icons only, so the toolbar keeps one row (UI audit gap-02, work-12). */}
            <DropdownMenuTrigger render={<Button variant="outline" size="sm" aria-label={t('filter')} />}><ListFilter data-icon="inline-start" /><span className="max-md:hidden">{t('filter')}</span></DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-52"><DropdownMenuGroup>
              {FILTER_FIELDS.map(({ field, icon: Icon }) => field === 'creator'
                ? <DropdownMenuCheckboxItem key={field} checked={filters.creator?.includes(ME) ?? false} closeOnClick={false} onCheckedChange={() => toggleFilter(field, ME)}><Icon />{t(`filterField.${field}`)}</DropdownMenuCheckboxItem>
                : <DropdownMenuSub key={field}>
                <DropdownMenuSubTrigger><Icon />{t(`filterField.${field}`)}</DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="max-h-80 w-52 overflow-y-auto">
                  {options[field].map(option => <DropdownMenuCheckboxItem key={option.value} checked={filters[field]?.includes(option.value) ?? false} closeOnClick={false} onCheckedChange={() => toggleFilter(field, option.value)}>{option.mark}<span className="truncate">{option.label}</span></DropdownMenuCheckboxItem>)}
                </DropdownMenuSubContent>
              </DropdownMenuSub>)}
            </DropdownMenuGroup></DropdownMenuContent>
          </DropdownMenu>
          {/* One chip per filter (Linear): field, value and remove in a single control-grey container. */}
          {activeFilters.map(([field, values]) => <div key={field} role="group" aria-label={t(`filterField.${field}`)} className="flex h-7 min-w-0 items-center gap-1.5 rounded-md bg-control pr-0.5 pl-2.5 text-xs">
            <span className="text-muted-foreground">{t(`filterField.${field}`)}</span>
            {field !== 'creator' && <span className="max-w-48 truncate font-medium">{values.map(value => options[field].find(option => option.value === value)?.label ?? value).join(', ')}</span>}
            <Button variant="ghost" size="icon-xs" className="rounded-sm text-muted-foreground hover:bg-control-hover" aria-label={t('removeFilter', { field: t(`filterField.${field}`) })} onClick={() => setFilters({ ...filters, [field]: [] })}><X data-icon="inline-start" /></Button>
          </div>)}
          <div className="ml-auto flex items-center gap-1">
            {refreshButton}
            <ToggleGroup aria-label={t('viewLabel')} variant="segment" size="sm" spacing={0.5} value={[view]} onValueChange={values => { const next = values[0]; if (next === 'board' || next === 'list') update({ view: next }) }}>
              <ToggleGroupItem value="board" aria-label={t('viewBoard')}><Columns3 /></ToggleGroupItem>
              <ToggleGroupItem value="list" aria-label={t('viewList')}><List /></ToggleGroupItem>
            </ToggleGroup>
            <Popover>
              <PopoverTrigger render={<Button variant="outline" size="sm" aria-label={t('display')} />}><Settings2 data-icon="inline-start" /><span className="max-md:hidden">{t('display')}</span></PopoverTrigger>
              <PopoverContent align="end" className="w-80 gap-3">
                <div className="flex items-center justify-between gap-3"><Label>{t('sort')}</Label>
                  <Select value={display.sort} onValueChange={value => setDisplay({ sort: value as Sort })} items={(['priority', 'updated', 'created'] as const).map(value => ({ value, label: t(`sortBy.${value}`) }))}>
                    <SelectTrigger size="sm" className="w-28" aria-label={t('sort')}><SelectValue /></SelectTrigger>
                    <SelectContent><SelectGroup>{(['priority', 'updated', 'created'] as const).map(value => <SelectItem key={value} value={value}>{t(`sortBy.${value}`)}</SelectItem>)}</SelectGroup></SelectContent>
                  </Select>
                </div>
                <div className="flex items-center justify-between gap-3"><Label>{t('completed')}</Label>
                  <Select value={display.completed} onValueChange={value => setDisplay({ completed: value as Completed })} items={(['week', 'month', 'all'] as const).map(value => ({ value, label: t(`completedRange.${value}`) }))}>
                    <SelectTrigger size="sm" className="w-28" aria-label={t('completed')}><SelectValue /></SelectTrigger>
                    <SelectContent><SelectGroup>{(['week', 'month', 'all'] as const).map(value => <SelectItem key={value} value={value}>{t(`completedRange.${value}`)}</SelectItem>)}</SelectGroup></SelectContent>
                  </Select>
                </div>
                <div className="flex items-center justify-between gap-3"><Label htmlFor={`${titleId}-empty`}>{t('showEmpty')}</Label><Switch id={`${titleId}-empty`} checked={display.showEmpty} onCheckedChange={showEmpty => setDisplay({ showEmpty })} /></div>
                <p className="pt-2 text-xs text-muted-foreground">{t('cardProperties')}</p>
                <div className="flex flex-wrap gap-1.5">
                  {CARD_PROPERTIES.map(property => <Toggle key={property} size="sm" variant="outline" pressed={display.properties.includes(property)} className={DISPLAY_CHIP} onPressedChange={pressed => setDisplay({ properties: pressed ? [...display.properties, property] : display.properties.filter(item => item !== property) })}>{display.properties.includes(property) && <Check data-icon="inline-start" />}{t(`property.${property}`)}</Toggle>)}
                </div>
                {/* Both groups read the same way: checked and tinted means shown (R-30). */}
                <p className="pt-2 text-xs text-muted-foreground">{t('columns')}</p>
                <div className="flex flex-wrap gap-1.5">
                  {BOARD_COLUMNS.map(column => { const isShown = !display.hidden.includes(column.value); return <Toggle key={column.value} size="sm" variant="outline" pressed={isShown} className={DISPLAY_CHIP} onPressedChange={pressed => setDisplay({ hidden: pressed ? display.hidden.filter(item => item !== column.value) : [...display.hidden, column.value] })}>{isShown && <Check data-icon="inline-start" />}{statusLabel(column.value)}</Toggle> })}
                </div>
              </PopoverContent>
            </Popover>
            <Button size="sm" className="ml-1 bg-sidebar-primary text-sidebar-primary-foreground hover:bg-sidebar-primary/90" onClick={() => setNewTask(true)}><Plus data-icon="inline-start" />{t('newTask')}</Button>
            {panelButton}
          </div>
        </div>
        {/* A board with nothing to show is one empty state, not five blank columns (UI audit states-06): the list's. */}
        {view === 'board' && shown.length > 0
          ? <div className="flex min-h-0 flex-1 flex-col px-5"><IssueBoard stateKey={stateKey} issues={shown} columns={columns} hidden={hidden} sidebarOpen={sidebarShown} blocks={blocks} newestRuns={newestRuns} context={{ properties: new Set(display.properties), agentStates, subtasks, owners, blocks, personalWorkspace }} onOpen={id => { onOpen(id) }} onDiscuss={discuss} onHideColumn={status => setDisplay({ hidden: [...display.hidden, status] })} onShowColumn={status => setDisplay({ hidden: display.hidden.filter(item => item !== status) })} onUpdated={onUpdated} onBusyChange={onBusyChange} /></div>
          : <div ref={listScroll} className="min-h-0 flex-1 overflow-y-auto"><IssueList issues={shown} blocks={blocks} properties={new Set(display.properties)} owners={owners} searching={activeFilters.length > 0 || scope !== 'all'} onOpen={id => { onOpen(id) }} onCreate={() => setNewTask(true)} onClearFilters={activeFilters.length > 0 ? () => setFilters({}) : undefined} /></div>}
      </>}
    </section>
    {sidebar && <ResizablePane render="aside" aria-label={tNav('coordinator')} storageKey="mikka:board-sidebar-width" defaultWidth={360} min={280} max={560} edge="start" from="xl" label={tCommon('resize.boardSidebar')} className="hidden shrink-0 flex-col border-l xl:flex">
      {/* Same centered pill as the Coordinator page, so the two read as one conversation. */}
      <ConversationPill name={tNav('coordinator')} avatar={<CoordinatorAvatar size="pill" />} />
      <div className="absolute top-3.5 right-3 z-20"><Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label={t('collapse')} aria-expanded aria-keyshortcuts="Control+j Meta+j" onClick={() => setSidebar(false)} />}><PanelRightClose data-icon="inline-start" /></TooltipTrigger><TooltipContent side="left">{t('collapse')}<ShortcutKeys keys={['mod', 'J']} /></TooltipContent></Tooltip></div>
      <div aria-hidden="true" className="h-14 shrink-0" />
      <CoordinatorChat compact prefill={prefill} onOpenIssue={id => { onOpen(id) }} />
    </ResizablePane>}
    <Sheet open={sheet} onOpenChange={setSheet}>
      <SheetContent ref={sheetRef} initialFocus={() => sheetRef.current?.querySelector<HTMLElement>('textarea:not(:disabled)') ?? true} side="right" className="w-full gap-0 p-0 sm:max-w-sm">
        <SheetHeader className="sr-only"><SheetTitle>{tNav('coordinator')}</SheetTitle></SheetHeader>
        <ConversationPill name={tNav('coordinator')} avatar={<CoordinatorAvatar size="pill" />} />
        <div aria-hidden="true" className="h-14 shrink-0" />
        <CoordinatorChat compact prefill={prefill} onOpenIssue={id => { setSheet(false); onOpen(id) }} />
      </SheetContent>
    </Sheet>
    <NewTaskDialog workspaceId={workspaceId} open={newTask} onOpenChange={setNewTask} onSent={openPanel} initialIntent="create_only" onCreated={teamId ? undefined : id => { void onUpdated(); onOpen(id) }} />
  </div>
}
