'use client'

import { useState, type ComponentProps, type Ref } from 'react'
import { ScrollArea as ScrollAreaPrimitive } from '@base-ui/react/scroll-area'
import { useTranslations } from 'next-intl'
import { Box, CalendarDays, ChevronsLeftRight, Circle, CircleUserRound, Ellipsis, EyeOff, Flag, Link2, ListChecks, Lock, MessageSquare, Tag, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/reui/badge'
import { Kanban, KanbanBoard as KanbanBoardPrimitive, KanbanColumn, KanbanColumnContent, KanbanItem, KanbanItemHandle, KanbanOverlay } from '@/components/reui/kanban'
import { Button } from '@/components/ui/button'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuRadioGroup, ContextMenuRadioItem, ContextMenuSeparator, ContextMenuShortcut, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger, ContextMenuTrigger } from '@/components/ui/context-menu'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { LabelDot, IssueMetadataControls, type MetadataRequest, type MetadataSavedIssue } from '@/components/workspace/issue-metadata-controls'
import { IssuePropertyMenu } from '@/components/workspace/issue-property-menu'
import { PullRequestIcon } from '@/components/workspace/pull-request-icon'
import { CardControlBoundary, CardCreatedAt } from '@/components/workspace/issue-card-controls'
import { ISSUE_PRIORITIES, ISSUE_STATUSES, issueIdentifier, type IssueStatus } from '@/components/workspace/issue-properties'
import { BOARD_COLUMNS, type AgentState, type BoardColumns, type BoardTask, type CardProperty } from './data'

function BoardScrollArea({ children, viewportRef, ...props }: ComponentProps<typeof ScrollAreaPrimitive.Viewport> & { viewportRef: Ref<HTMLDivElement> }) {
  return <ScrollAreaPrimitive.Root data-slot="scroll-area" className="relative min-h-0 w-full min-w-0 flex-1 pb-3">
    <ScrollAreaPrimitive.Viewport {...props} ref={viewportRef} data-slot="scroll-area-viewport" className="h-full w-full overscroll-x-contain rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset">
      <ScrollAreaPrimitive.Content data-slot="scroll-area-content" className="h-full w-max min-w-full">{children}</ScrollAreaPrimitive.Content>
    </ScrollAreaPrimitive.Viewport>
    <ScrollAreaPrimitive.Scrollbar orientation="horizontal" className="flex h-2.5 touch-none flex-col p-px select-none"><ScrollAreaPrimitive.Thumb className="relative flex-1 rounded-full bg-foreground/15" /></ScrollAreaPrimitive.Scrollbar>
    <ScrollAreaPrimitive.Corner />
  </ScrollAreaPrimitive.Root>
}

const AGENT_STATE_BADGES = { running: 'success-light', waiting: 'warning-light', failed: 'destructive-light' } as const satisfies Record<AgentState, string>
const AGENT_STATE_DOTS = { running: 'bg-success', waiting: 'bg-warning', failed: 'bg-destructive' } as const satisfies Record<AgentState, string>

export type CardHandlers = {
  onOpen: (id: string) => void
  onStatusChange: (task: BoardTask, status: IssueStatus) => void
  onPriorityChange: (task: BoardTask, priority: string) => void
  onMetadataSaved: (issue: MetadataSavedIssue) => void
  onMetadataBusy: (busy: boolean) => void
  onDelete: (task: BoardTask) => void
  onDiscuss: (task: BoardTask) => void
}

/** What the board knows about a card beyond the task row itself. */
export type CardContext = {
  properties: ReadonlySet<CardProperty>
  agentStates: ReadonlyMap<string, AgentState>
  subtasks: ReadonlyMap<string, { done: number; total: number }>
}

function TaskCard({ task, disabled, isOverlay = false, context, onOpen, onStatusChange, onPriorityChange, onMetadataSaved, onMetadataBusy, onDelete, onDiscuss }: CardHandlers & {
  task: BoardTask
  disabled: boolean
  isOverlay?: boolean
  context: CardContext
}) {
  const t = useTranslations('Board')
  const tCard = useTranslations('Shell.board.card')
  const tIssue = useTranslations('Issue')
  const statusLabel = (value: string) => tIssue.has(`status.${value}` as never) ? tIssue(`status.${value}` as never) : value
  const priorityLabel = (value: string) => tIssue.has(`priority.${value}` as never) ? tIssue(`priority.${value}` as never) : value
  const statusOptions = ISSUE_STATUSES.map(item => ({ ...item, label: statusLabel(item.value) }))
  const priorityOptions = ISSUE_PRIORITIES.map(item => ({ ...item, label: priorityLabel(item.value) }))
  const controlsDisabled = disabled || isOverlay
  const [request, setRequest] = useState<MetadataRequest | null>(null)
  const ask = (target: MetadataRequest['target']) => setRequest(current => ({ target, sequence: (current?.sequence ?? 0) + 1 }))
  const show = (property: CardProperty) => context.properties.has(property)
  const agentState = context.agentStates.get(task.id)
  const subtasks = context.subtasks.get(task.id)
  const metadata = task.metadata
  const chips = [
    show('priority') && <CardControlBoundary key="priority"><IssuePropertyMenu label={tIssue('priorityLabel')} value={task.priority} options={priorityOptions} icon={Flag} iconOnly compact disabled={controlsDisabled} onChange={value => onPriorityChange(task, value)} /></CardControlBoundary>,
    ...(show('labels') ? metadata.labels.map(label => <Badge key={`label-${label.name}`} variant="outline" size="lg" className="border-transparent px-1 max-w-36"><LabelDot color={label.color} /><span className="truncate">{label.name}</span></Badge>) : []),
    show('project') && metadata.project && <Badge key="project" variant="outline" size="lg" className="border-transparent px-1 max-w-36"><Box /><span className="truncate">{metadata.project}</span></Badge>,
    ...(show('pullRequests') ? metadata.pullRequests.map(pr => {
      return <CardControlBoundary key={pr.url}><Badge variant="outline" size="lg" className="border-transparent px-1 tabular-nums" render={<a href={pr.url} draggable={false} target="_blank" rel="noopener noreferrer" />}><PullRequestIcon state={pr.state} />#{pr.url.split('/').at(-1)}</Badge></CardControlBoundary>
    }) : []),
    show('subtasks') && subtasks && subtasks.total > 0 && <Badge key="subtasks" variant="outline" size="lg" className="border-transparent px-1 tabular-nums" title={tCard('subtasks')}><ListChecks />{subtasks.done}/{subtasks.total}</Badge>,
    show('agentState') && agentState && <Badge key="agent" variant={AGENT_STATE_BADGES[agentState]} size="lg"><span aria-hidden="true" className={cn('size-1.5 rounded-full', AGENT_STATE_DOTS[agentState])} />{tCard(`agent.${agentState}`)}</Badge>,
    show('dueDate') && metadata.dueDate && <Badge key="due" variant="outline" size="lg" className="border-transparent px-1 tabular-nums"><CalendarDays />{metadata.dueDate.slice(5)}</Badge>,
  ].filter(Boolean)

  const card = <div className={cn('flex flex-col gap-1.5 rounded-lg border bg-card px-3 pt-2.5 pb-3 text-card-foreground shadow-xs transition-shadow hover:border-foreground/20', isOverlay && 'pointer-events-none rotate-1 shadow-lg')}>
    <div className="flex h-5 min-w-0 items-center gap-1.5">
      {show('identifier') && <span className="truncate text-xs text-muted-foreground tabular-nums">{issueIdentifier(task, tIssue('unassignedNumber'))}</span>}
      {task.scope === 'personal' && <Lock aria-label={tCard('personal')} className="size-3 shrink-0 text-muted-foreground" />}
      {show('assignee') && <div className="ml-auto flex shrink-0 items-center"><CardControlBoundary><IssueMetadataControls task={task} section="assignee" compact disabled={controlsDisabled} request={request?.target === 'assignee' ? request : null} onSaved={onMetadataSaved} onBusyChange={onMetadataBusy} /></CardControlBoundary></div>}
    </div>
    <div className="flex min-w-0 items-start gap-1">
      <CardControlBoundary><IssuePropertyMenu label={tIssue('statusLabel')} value={task.status} options={statusOptions} icon={Circle} iconOnly compact disabled={controlsDisabled} onChange={value => onStatusChange(task, value as IssueStatus)} /></CardControlBoundary>
      <h3 data-slot="kanban-task-title" className="line-clamp-3 min-w-0 flex-1 pt-0.5 text-sm font-medium break-words">{task.title}</h3>
    </div>
    {chips.length > 0 && <div className="flex flex-wrap items-center gap-1 pl-7">{chips}</div>}
    {show('createdAt') && <div className="pl-7"><CardCreatedAt createdAt={task.createdAt} /></div>}
    {/* Opened from the context menu: labels, project and PR editors, rendered off-card. */}
    {!isOverlay && <div hidden><IssueMetadataControls task={task} section="all" disabled={controlsDisabled} request={request && request.target !== 'assignee' ? request : null} onSaved={onMetadataSaved} onBusyChange={onMetadataBusy} /></div>}
  </div>

  if (isOverlay) return <KanbanItem value={task.id} disabled className="shrink-0">{card}</KanbanItem>
  return <KanbanItem value={task.id} disabled={disabled} className="shrink-0" role="group" tabIndex={-1} aria-label={task.title}>
    <ContextMenu>
      <ContextMenuTrigger render={<KanbanItemHandle cursor={false} role="group" tabIndex={disabled ? -1 : 0} className="block cursor-pointer touch-pan-y rounded-lg outline-none select-none focus-visible:ring-2 focus-visible:ring-ring data-[dragging=true]:cursor-grabbing" aria-label={t('openTask', { title: task.title })} aria-roledescription={t('openableDraggableTask')} aria-keyshortcuts="Enter Space" onClick={event => {
        if (disabled || event.defaultPrevented || (event.target as HTMLElement).closest('[data-card-control]')) return
        onOpen(task.id)
      }} onKeyDownCapture={event => {
        if (event.target !== event.currentTarget || event.nativeEvent.isComposing || event.keyCode === 229 || event.currentTarget.dataset.dragging === 'true') return
        if (event.key.toLowerCase() === 'a' && !disabled && !event.ctrlKey && !event.metaKey && !event.altKey) {
          event.preventDefault(); event.stopPropagation()
          ask('assignee')
        }
        if (event.key === 'Enter' && !disabled) {
          event.preventDefault()
          event.stopPropagation()
          onOpen(task.id)
        }
      }} />}>{card}</ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        <ContextMenuSub>
          <ContextMenuSubTrigger disabled={disabled}><Circle />{tCard('status')}<ContextMenuShortcut>S</ContextMenuShortcut></ContextMenuSubTrigger>
          <ContextMenuSubContent><ContextMenuRadioGroup value={task.status} onValueChange={value => onStatusChange(task, value as IssueStatus)}>
            {statusOptions.map(option => <ContextMenuRadioItem key={option.value} value={option.value}><option.icon className={option.indicatorClassName} />{option.label}</ContextMenuRadioItem>)}
          </ContextMenuRadioGroup></ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSub>
          <ContextMenuSubTrigger disabled={disabled}><Flag />{tCard('priority')}<ContextMenuShortcut>P</ContextMenuShortcut></ContextMenuSubTrigger>
          <ContextMenuSubContent><ContextMenuRadioGroup value={task.priority} onValueChange={value => onPriorityChange(task, String(value))}>
            {priorityOptions.map(option => <ContextMenuRadioItem key={option.value} value={option.value}><option.icon {...option.iconProps} />{option.label}</ContextMenuRadioItem>)}
          </ContextMenuRadioGroup></ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuItem disabled={disabled} onClick={() => ask('assignee')}><CircleUserRound />{tCard('assignee')}<ContextMenuShortcut>A</ContextMenuShortcut></ContextMenuItem>
        <ContextMenuItem disabled={disabled} onClick={() => ask('labels')}><Tag />{tCard('labels')}</ContextMenuItem>
        <ContextMenuItem disabled={disabled} onClick={() => ask('project')}><Box />{tCard('project')}</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem disabled={disabled} onClick={() => ask('pullRequests')}><Link2 />{tCard('linkPr')}</ContextMenuItem>
        <ContextMenuItem onClick={() => onDiscuss(task)}><MessageSquare />{tCard('discuss')}</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" disabled={disabled} onClick={() => onDelete(task)}><Trash2 />{tCard('delete')}</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  </KanbanItem>
}

type KanbanBoardProps = Omit<ComponentProps<typeof Kanban<BoardTask>>, 'children' | 'getItemValue'> & {
  value: BoardColumns
  columns: IssueStatus[]
  hiddenColumns: { status: IssueStatus; count: number }[]
  context: CardContext
  pending?: boolean
  viewportRef: Ref<HTMLDivElement>
  viewportId: string
  instructionsId: string
  onViewportKeyDown: ComponentProps<'div'>['onKeyDown']
  onHideColumn: (status: IssueStatus) => void
  onShowColumn: (status: IssueStatus) => void
  /** Columns folded to a 40px strip (已完成 while the Coordinator sidebar is open), until clicked. */
  narrowColumns?: IssueStatus[]
} & CardHandlers

export function KanbanBoard({ columns, hiddenColumns: hidden, narrowColumns = [], context, pending = false, viewportRef, viewportId, instructionsId, onViewportKeyDown, onHideColumn, onShowColumn, onOpen, onStatusChange, onPriorityChange, onMetadataSaved, onMetadataBusy, onDelete, onDiscuss, ...props }: KanbanBoardProps) {
  const handlers = { onOpen, onStatusChange, onPriorityChange, onMetadataSaved, onMetadataBusy, onDelete, onDiscuss }
  const t = useTranslations('Board')
  const tBoard = useTranslations('Shell.board')
  const tIssue = useTranslations('Issue')
  const statusLabel = (value: string) => tIssue.has(`status.${value}` as never) ? tIssue(`status.${value}` as never) : value
  const shown = BOARD_COLUMNS.filter(column => columns.includes(column.value))
  const [opened, setOpened] = useState<IssueStatus[]>([])
  const narrow = (status: IssueStatus) => narrowColumns.includes(status) && !opened.includes(status)
  // Beside the Coordinator sidebar the columns share the width instead of scrolling (R-25); hidden columns stay reachable from 显示.
  const fit = narrowColumns.length > 0
  return <Kanban {...props} getItemValue={item => item.id} className="flex min-h-0 w-full min-w-0 flex-1 flex-col">
    <BoardScrollArea viewportRef={viewportRef} id={viewportId} role="region" aria-label={t('horizontalScroll')} aria-describedby={instructionsId} tabIndex={0} onKeyDown={onViewportKeyDown}>
      <KanbanBoardPrimitive className={cn('flex h-full min-h-0 min-w-full items-stretch gap-3 pb-2', fit ? 'w-full' : 'w-max')}>
        {shown.map(column => {
          const tasks = props.value[column.value] ?? []
          if (narrow(column.value)) return <KanbanColumn key={column.value} value={column.value} className="min-h-0 w-10 min-w-10 shrink-0">
            <Button variant="ghost" className="h-full w-10 flex-col items-center justify-start gap-2 rounded-xl bg-muted/60 px-0 py-2.5 font-medium whitespace-normal hover:bg-muted" aria-label={tBoard('expandColumn', { status: statusLabel(column.value) })} onClick={() => setOpened(current => [...current, column.value])}>
              <column.icon className={cn('size-3.5 shrink-0', column.indicatorClassName)} aria-hidden="true" />
              <span className="w-[1em] shrink-0 text-center text-sm leading-tight break-all">{statusLabel(column.value)}</span>
              <span className="shrink-0 text-sm text-muted-foreground tabular-nums">{tasks.length}</span>
            </Button>
          </KanbanColumn>
          return <KanbanColumn key={column.value} value={column.value} className={cn('min-h-0', fit ? 'max-w-72 min-w-44 flex-1 basis-0' : 'w-60 min-w-60 shrink-0')}>
            <section className="group/column flex min-h-0 flex-1 flex-col gap-1 rounded-xl bg-muted/60 p-1.5" aria-label={t('columnLabel', { status: statusLabel(column.value) })}>
              <div className="flex h-8 shrink-0 items-center gap-2 pr-0.5 pl-1.5">
                <column.icon className={cn('size-3.5 shrink-0', column.indicatorClassName)} aria-hidden="true" />
                <h2 className="truncate text-sm font-medium">{statusLabel(column.value)}</h2>
                <span className="text-sm text-muted-foreground tabular-nums">{tasks.length}</span>
                <DropdownMenu>
                  <DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" className="ml-auto text-muted-foreground" aria-label={tBoard('columnMenu', { status: statusLabel(column.value) })} />}><Ellipsis /></DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-40">
                    <DropdownMenuItem onClick={() => onHideColumn(column.value)}><EyeOff />{tBoard('hideColumn')}</DropdownMenuItem>
                    {narrowColumns.includes(column.value) && <DropdownMenuItem onClick={() => setOpened(current => current.filter(item => item !== column.value))}><ChevronsLeftRight />{tBoard('foldColumn')}</DropdownMenuItem>}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              <KanbanColumnContent value={column.value} className="min-h-0 flex-1 gap-1.5 overflow-y-auto overscroll-y-contain p-0.5" aria-label={t('columnContent', { status: statusLabel(column.value) })}>
                {tasks.map(task => <TaskCard key={task.id} task={task} disabled={pending} context={context} {...handlers} />)}
              </KanbanColumnContent>
            </section>
          </KanbanColumn>
        })}
        {hidden.length > 0 && !fit && <section aria-label={tBoard('hiddenLane')} className="flex w-52 shrink-0 flex-col gap-1 rounded-xl bg-muted/60 p-1.5">
          <h2 className="flex h-8 items-center px-1.5 text-sm font-medium text-muted-foreground">{tBoard('hiddenLane')}</h2>
          {hidden.map(({ status, count }) => {
            const column = BOARD_COLUMNS.find(item => item.value === status)!
            return <Button key={status} variant="ghost" className="h-9 justify-start gap-2 rounded-lg px-1.5 font-normal" title={tBoard('showColumn', { status: statusLabel(status) })} onClick={() => onShowColumn(status)}>
              <column.icon data-icon="inline-start" className={column.indicatorClassName} />{statusLabel(status)}<span className="ml-auto text-muted-foreground tabular-nums">{count}</span>
            </Button>
          })}
        </section>}
      </KanbanBoardPrimitive>
    </BoardScrollArea>
    <KanbanOverlay>{({ value }) => {
      const entry = Object.entries(props.value).find(([, tasks]) => tasks.some(task => task.id === value))
      const task = entry?.[1].find(item => item.id === value)
      return task && entry ? <TaskCard task={task} disabled isOverlay context={context} {...handlers} /> : null
    }}</KanbanOverlay>
  </Kanban>
}
