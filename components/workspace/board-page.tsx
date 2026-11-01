'use client'

import { PersonAvatar } from '@/components/person-avatar'
import { useEffect, useId, useMemo, useState } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { Box, Check, CircleUserRound, Columns3, Flag, List, ListFilter, PanelRightClose, PanelRightOpen, Plus, RefreshCw, Settings2, SquareKanban, Tag, X } from 'lucide-react'
import type { listIssues } from '@/app/actions/issues'
import { listAgents } from '@/app/actions/agents'
import { listTaskRuns } from '@/app/actions/task-runs'
import { getLinearBoardSync } from '@/app/actions/linear-sync'
import { CoordinatorChat } from '@/components/coordinator/coordinator-chat'
import { NewTaskDialog } from '@/components/coordinator/new-task-dialog'
import { ConversationPill } from '@/components/nav/conversation-pill'
import { CoordinatorAvatar } from '@/components/nav/bot-avatar'
import { AGENT_STATES, CARD_PROPERTIES, DEFAULT_CARD_PROPERTIES, DEFAULT_HIDDEN_COLUMNS, agentStateOf, type AgentState, type CardProperty } from '@/components/blocks/kanban-board-1/components/data'
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
import { IssueBoard } from './issue-board'
import { IssueList } from './issue-list'
import { AgentSphere } from './issue-assignee-menu'
import { LabelDot } from './issue-metadata-controls'
import { ISSUE_PRIORITIES, ISSUE_STATUSES, type IssueStatus } from './issue-properties'

type Issue = Awaited<ReturnType<typeof listIssues>>[number]
type Scope = 'all' | 'workspace' | 'personal'
type FilterField = 'status' | 'priority' | 'assignee' | 'labels' | 'project' | 'agentState'
type Filters = Partial<Record<FilterField, string[]>>
type Sort = 'priority' | 'updated' | 'created'
type Completed = 'all' | 'week' | 'month'
type Display = { sort: Sort; completed: Completed; showEmpty: boolean; properties: CardProperty[]; hidden: IssueStatus[] }

const SETTINGS_KEY = 'mikka:board-v2'
const SIDEBAR_KEY = 'mikka:board-coordinator-open'
const WIDE = '(min-width: 80rem)'
const ME = 'me'
const NONE = 'none'
const DEFAULT_DISPLAY: Display = { sort: 'priority', completed: 'week', showEmpty: true, properties: DEFAULT_CARD_PROPERTIES, hidden: DEFAULT_HIDDEN_COLUMNS }
const DEFAULT_SETTINGS = { scope: 'all' as Scope, view: 'board' as 'board' | 'list', filters: { assignee: [ME] } as Filters, display: DEFAULT_DISPLAY }
/** A 显示 chip: checked and tinted when on, plain grey when off. */
const DISPLAY_CHIP = 'h-7 rounded-md px-2 text-xs font-normal text-muted-foreground aria-pressed:bg-sidebar-primary/10 aria-pressed:text-sidebar-primary'
const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 }
const COMPLETED_DAYS: Record<Completed, number> = { all: Infinity, week: 7, month: 30 }
const FILTER_FIELDS: { field: FilterField; icon: typeof Flag }[] = [
  { field: 'status', icon: ISSUE_STATUSES[1].icon }, { field: 'priority', icon: Flag }, { field: 'assignee', icon: CircleUserRound },
  { field: 'labels', icon: Tag }, { field: 'project', icon: Box }, { field: 'agentState', icon: SquareKanban },
]

/** Board settings kept per browser: scope, view, filters and the 显示 options. */
function useBoardSettings() {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS)
  useEffect(() => {
    try {
      const stored = JSON.parse(window.localStorage.getItem(SETTINGS_KEY) ?? 'null')
      if (stored) setSettings(current => ({ ...current, ...stored, display: { ...current.display, ...stored.display } }))
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
 * Coordinator) over five status columns, with the
 * Coordinator conversation in a sidebar that folds into a pill (MIK-45).
 */
export function BoardPage({ issues, userId, onOpen, onUpdated, onBusyChange }: {
  issues: Issue[]
  userId: string
  onOpen: (id: string) => boolean | void
  onUpdated: () => Promise<unknown>
  onBusyChange: (busy: boolean) => void
}) {
  const t = useTranslations('Shell.board')
  const tNav = useTranslations('Nav')
  const tIssue = useTranslations('Issue')
  const titleId = useId()
  const statusLabel = (value: string) => tIssue.has(`status.${value}` as never) ? tIssue(`status.${value}` as never) : value
  const priorityLabel = (value: string) => tIssue.has(`priority.${value}` as never) ? tIssue(`priority.${value}` as never) : value
  const [settings, update] = useBoardSettings()
  const { scope, view, filters, display } = settings
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
  const [prefill, setPrefill] = useState<{ text: string; nonce: number }>()
  const [newTask, setNewTask] = useState(false)
  const { data: agents } = useSWR('agents', () => listAgents())
  const { data: linear } = useSWR('linear-board-sync', () => getLinearBoardSync(), { revalidateOnFocus: false })
  // Without a connected Linear team, the button only reloads the board.
  const linearSynced = !!linear && !linear.error && linear.synced
  const { data: runs } = useSWR('task-runs', () => listTaskRuns(), { refreshInterval: 15000 })
  const myAgents = useMemo(() => new Set((agents ?? []).map(agent => agent.id)), [agents])
  const owners = useMemo(() => new Map((runs ?? []).map(run => [run.issueId, { bot: run.bot, harnesses: run.harnesses }] as const)), [runs])
  const agentStates = useMemo(() => new Map((runs ?? []).flatMap(run => { const state = agentStateOf(run.status); return state ? [[run.issueId, state] as const] : [] })), [runs])
  const subtasks = useMemo(() => {
    const result = new Map<string, { done: number; total: number }>()
    for (const issue of issues) {
      const parent = issue.metadata.parentId
      if (parent) { const entry = result.get(parent) ?? { done: 0, total: 0 }; entry.total++; if (issue.status === 'done') entry.done++; result.set(parent, entry) }
    }
    for (const issue of issues) if (!result.has(issue.id) && issue.checklist.total) result.set(issue.id, { done: issue.checklist.checked, total: issue.checklist.total })
    return result
  }, [issues])

  // Mine: assigned to me, created by me, or held by one of my agents.
  const isMine = (issue: Issue) => issue.ownerId === userId || issue.metadata.assignee?.id === userId || (issue.metadata.assignee?.kind === 'agent' && myAgents.has(issue.metadata.assignee.id))
  const valuesOf = (issue: Issue, field: FilterField): string[] => {
    switch (field) {
      case 'status': return [issue.status]
      case 'priority': return [issue.priority]
      case 'assignee': return [...(isMine(issue) ? [ME] : []), issue.metadata.assignee?.id ?? NONE]
      case 'labels': return issue.metadata.labels.map(label => label.name)
      case 'project': return [issue.metadata.project ?? NONE]
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
  const count = (status: IssueStatus) => shown.filter(issue => issue.status === status).length
  const columns = ISSUE_STATUSES.map(status => status.value).filter(status => !display.hidden.includes(status) && (display.showEmpty || count(status) > 0))
  const hidden = display.hidden.map(status => ({ status, count: count(status) }))

  // Every value a filter can take, from the tasks on the board.
  const assignees = [...new Map(issues.flatMap(issue => issue.metadata.assignee ? [[issue.metadata.assignee.id, issue.metadata.assignee] as const] : [])).values()]
  const labels = [...new Map(issues.flatMap(issue => issue.metadata.labels.map(label => [label.name, label] as const))).values()]
  const projects = [...new Set(issues.flatMap(issue => issue.metadata.project ? [issue.metadata.project] : []))]
  const options: Record<FilterField, { value: string; label: string; mark?: React.ReactNode }[]> = {
    status: ISSUE_STATUSES.map(status => ({ value: status.value, label: statusLabel(status.value), mark: <status.icon className={cn(statusIconTints[status.tone])} /> })),
    priority: ISSUE_PRIORITIES.map(priority => ({ value: priority.value, label: priorityLabel(priority.value), mark: <priority.icon {...priority.iconProps} /> })),
    assignee: [{ value: ME, label: t('me') }, ...assignees.filter(assignee => assignee.id !== userId).map(assignee => ({ value: assignee.id, label: assignee.name, mark: assignee.kind === 'agent' ? <AgentSphere name={assignee.name} compact /> : <PersonAvatar name={assignee.name} image={assignee.image} size="row" /> })), { value: NONE, label: t('unassigned'), mark: <CircleUserRound /> }],
    labels: labels.map(label => ({ value: label.name, label: label.name, mark: <LabelDot color={label.color} /> })),
    project: [...projects.map(project => ({ value: project, label: project, mark: <Box /> })), { value: NONE, label: t('noProject') }],
    agentState: [...AGENT_STATES.map(state => ({ value: state, label: t(`card.agent.${state}` as `card.agent.${AgentState}`) })), { value: NONE, label: t('noRun') }],
  }
  function toggleFilter(field: FilterField, value: string) {
    const current = filters[field] ?? []
    const next = current.includes(value) ? current.filter(item => item !== value) : [...current, value]
    update({ filters: { ...filters, [field]: next } })
  }
  const setDisplay = (patch: Partial<Display>) => update({ display: { ...display, ...patch } })
  const activeFilters = (Object.entries(filters) as [FilterField, string[]][]).filter(([, values]) => values?.length)

  return <div className="flex min-h-0 flex-1">
    <section aria-labelledby={titleId} className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <h1 id={titleId} className="sr-only">{t('title')}</h1>
      <div role="toolbar" aria-label={t('toolbar')} className="flex min-h-14 shrink-0 flex-wrap items-center gap-2 px-5 py-3">
        <ToggleGroup aria-label={t('scopeLabel')} variant="segment" size="sm" spacing={0.5} value={[scope]} onValueChange={values => { const next = values[0] as Scope | undefined; if (next) update({ scope: next }) }}>
          {(['all', 'workspace', 'personal'] as const).map(value => <ToggleGroupItem key={value} value={value}>{t(`scope.${value}`)}</ToggleGroupItem>)}
        </ToggleGroup>
        <Separator orientation="vertical" className="mx-1 h-5" />
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="outline" size="sm" />}><ListFilter data-icon="inline-start" />{t('filter')}</DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-52"><DropdownMenuGroup>
            {FILTER_FIELDS.map(({ field, icon: Icon }) => <DropdownMenuSub key={field}>
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
          <span className="max-w-48 truncate font-medium">{values.map(value => options[field].find(option => option.value === value)?.label ?? value).join(', ')}</span>
          <Button variant="ghost" size="icon-xs" className="rounded-sm text-muted-foreground hover:bg-control-hover" aria-label={t('removeFilter', { field: t(`filterField.${field}`) })} onClick={() => update({ filters: { ...filters, [field]: [] } })}><X data-icon="inline-start" /></Button>
        </div>)}
        <div className="ml-auto flex items-center gap-1">
          <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label={linearSynced ? t('synced') : t('refresh')} className={cn(linearSynced && 'text-success-foreground')} onClick={() => { void onUpdated() }} />}><RefreshCw /></TooltipTrigger><TooltipContent side="bottom">{linearSynced ? t('synced') : t('refresh')}</TooltipContent></Tooltip>
          <ToggleGroup aria-label={t('viewLabel')} variant="segment" size="sm" spacing={0.5} value={[view]} onValueChange={values => { const next = values[0]; if (next === 'board' || next === 'list') update({ view: next }) }}>
            <ToggleGroupItem value="board" aria-label={t('viewBoard')}><Columns3 /></ToggleGroupItem>
            <ToggleGroupItem value="list" aria-label={t('viewList')}><List /></ToggleGroupItem>
          </ToggleGroup>
          <Popover>
            <PopoverTrigger render={<Button variant="outline" size="sm" />}><Settings2 data-icon="inline-start" />{t('display')}</PopoverTrigger>
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
                {ISSUE_STATUSES.map(status => { const isShown = !display.hidden.includes(status.value); return <Toggle key={status.value} size="sm" variant="outline" pressed={isShown} className={DISPLAY_CHIP} onPressedChange={pressed => setDisplay({ hidden: pressed ? display.hidden.filter(item => item !== status.value) : [...display.hidden, status.value] })}>{isShown && <Check data-icon="inline-start" />}{statusLabel(status.value)}</Toggle> })}
              </div>
            </PopoverContent>
          </Popover>
          <Button size="sm" className="ml-1 bg-sidebar-primary text-sidebar-primary-foreground hover:bg-sidebar-primary/90" onClick={() => setNewTask(true)}><Plus data-icon="inline-start" />{t('newTask')}</Button>
          <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" className={cn('text-muted-foreground', sidebar && 'xl:hidden')} aria-expanded={sheet} aria-label={t('expand')} onClick={openPanel} />}><PanelRightOpen data-icon="inline-start" /></TooltipTrigger><TooltipContent>{t('expand')}</TooltipContent></Tooltip>
        </div>
      </div>
      {view === 'board'
        ? <div className="flex min-h-0 flex-1 flex-col px-5"><IssueBoard issues={shown} columns={columns} hidden={hidden} narrow={sidebarShown ? ['done'] : undefined} context={{ properties: new Set(display.properties), agentStates, subtasks, owners }} onOpen={id => { onOpen(id) }} onDiscuss={issue => { openPanel(); setPrefill({ text: t('discussPrefill', { id: issue.identifier ?? '', title: issue.title }), nonce: Date.now() }) }} onHideColumn={status => setDisplay({ hidden: [...display.hidden, status] })} onShowColumn={status => setDisplay({ hidden: display.hidden.filter(item => item !== status) })} onUpdated={onUpdated} onBusyChange={onBusyChange} /></div>
        : <div className="min-h-0 flex-1 overflow-y-auto"><IssueList issues={shown} properties={new Set(display.properties)} owners={owners} searching={activeFilters.length > 0 || scope !== 'all'} onOpen={id => { onOpen(id) }} onCreate={() => setNewTask(true)} /></div>}
    </section>
    {sidebar && <aside aria-label={tNav('coordinator')} className="relative hidden w-90 shrink-0 flex-col border-l xl:flex">
      {/* Same centered pill as the Coordinator page, so the two read as one conversation. */}
      <ConversationPill name={tNav('coordinator')} avatar={<CoordinatorAvatar size="pill" />} />
      <div className="absolute top-3.5 right-3 z-20"><Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label={t('collapse')} aria-expanded onClick={() => setSidebar(false)} />}><PanelRightClose data-icon="inline-start" /></TooltipTrigger><TooltipContent side="left">{t('collapse')}</TooltipContent></Tooltip></div>
      <div aria-hidden="true" className="h-14 shrink-0" />
      <CoordinatorChat compact prefill={prefill} onOpenIssue={id => { onOpen(id) }} />
    </aside>}
    <Sheet open={sheet} onOpenChange={setSheet}>
      <SheetContent side="right" className="w-full gap-0 p-0 sm:max-w-sm">
        <SheetHeader className="sr-only"><SheetTitle>{tNav('coordinator')}</SheetTitle></SheetHeader>
        <ConversationPill name={tNav('coordinator')} avatar={<CoordinatorAvatar size="pill" />} />
        <div aria-hidden="true" className="h-14 shrink-0" />
        <CoordinatorChat compact prefill={prefill} onOpenIssue={id => { setSheet(false); onOpen(id) }} />
      </SheetContent>
    </Sheet>
    <NewTaskDialog open={newTask} onOpenChange={setNewTask} onSent={openPanel} />
  </div>
}
