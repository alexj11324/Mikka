'use client'

import { useViewScroll } from '@/lib/hooks/view-state'
import { displayTaskTitle } from '@/lib/short-title'
import { isValidElement, useState, type ComponentProps, type ReactNode, type Ref } from 'react'
import { ScrollArea as ScrollAreaPrimitive } from '@base-ui/react/scroll-area'
import { useFormatter, useNow, useTranslations } from 'next-intl'
import { Box, CalendarDays, Circle, CircleStop, CircleUserRound, Ellipsis, EyeOff, Flag, Link2, ListChecks, Lock, MessageSquare, Tag, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/reui/badge'
import { Kanban, KanbanBoard as KanbanBoardPrimitive, KanbanColumn, KanbanColumnContent, KanbanItem, KanbanItemHandle, KanbanOverlay } from '@/components/reui/kanban'
import { AvatarGroup, AvatarGroupCount } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { BotAvatar } from '@/components/nav/bot-avatar'
import { LetterAvatar } from '@/components/nav/letter-avatar'
import { HarnessMark } from '@/components/labels/entity-labels'
import { AgentSphere } from '@/components/workspace/issue-assignee-menu'
import type { IssueMetadata } from '@/lib/issue-metadata'
import { formatDateOnly } from '@/lib/date-only'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuRadioGroup, ContextMenuRadioItem, ContextMenuSeparator, ContextMenuShortcut, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger, ContextMenuTrigger } from '@/components/ui/context-menu'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { LabelDot, IssueMetadataControls, type MetadataRequest, type MetadataSavedIssue } from '@/components/workspace/issue-metadata-controls'
import { IssuePropertyMenu } from '@/components/workspace/issue-property-menu'
import { IssuePullRequestLink } from '@/components/workspace/issue-pull-request-link'
import { CardControlBoundary, CardCreatedAt } from '@/components/workspace/issue-card-controls'
import { ISSUE_PRIORITIES, ISSUE_STATUSES, type IssueStatus } from '@/components/workspace/issue-properties'
import { PriorityIcon } from '@/components/workspace/priority-icon'
import { BOARD_COLUMNS, type AgentState, type BoardColumn, type BoardColumns, type BoardTask, type CardProperty, type RunOwner } from './data'
import type { TaskBlock } from '@/lib/task-blocked'
import type { TaskReason, TaskState } from '@/hooks/use-bot-tasks'
import { blockLabel } from '@/components/workspace/block-label'
import { BoardCard, BoardColumnFrame, BoardHiddenLane } from '@ui-slot/board'

function BoardScrollArea({ children, viewportRef, ...props }: ComponentProps<typeof ScrollAreaPrimitive.Viewport> & { viewportRef: Ref<HTMLDivElement> }) {
  return <ScrollAreaPrimitive.Root data-slot="scroll-area" className="relative min-h-0 w-full min-w-0 flex-1 pb-3">
    <ScrollAreaPrimitive.Viewport {...props} ref={viewportRef} data-slot="scroll-area-viewport" className="h-full w-full overscroll-x-contain scroll-fade-x rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset">
      <ScrollAreaPrimitive.Content data-slot="scroll-area-content" className="h-full w-max min-w-full">{children}</ScrollAreaPrimitive.Content>
    </ScrollAreaPrimitive.Viewport>
    <ScrollAreaPrimitive.Scrollbar orientation="horizontal" className="flex h-2.5 touch-none flex-col p-px select-none"><ScrollAreaPrimitive.Thumb className="relative flex-1 rounded-full bg-foreground/15" /></ScrollAreaPrimitive.Scrollbar>
    <ScrollAreaPrimitive.Corner />
  </ScrollAreaPrimitive.Root>
}

/** Each avatar in the card's group (Figma 看板/负责人组): an 18px circle ringed 2px in the card colour. */
const GROUP_AVATAR = 'relative flex size-[18px] shrink-0 items-center justify-center overflow-hidden rounded-full bg-card ring-2 ring-card'

/**
 * The assignee slot (Figma 看板/负责人组, R-25): the owning Bot in its own bloub on top, the assigned
 * person as a letter avatar, then the coding agents of the task's threads (at most two, then +N),
 * each tucked behind the one before it. Null when nobody owns the task. The board's list view
 * shows the same group, so a task has one face on both (R-25, R-36, R-60).
 */
export function assigneeGroupOf({ assignee, owner }: { assignee: IssueMetadata['assignee']; owner: RunOwner | undefined }) {
  const avatars: ReactNode[] = []
  if (owner?.bot) avatars.push(<span key="bot" data-avatar="bot" className={GROUP_AVATAR}><BotAvatar color={owner.bot.color} shape={owner.bot.shape} size="row" /></span>)
  if (assignee?.kind === 'member') avatars.push(<span key="member" data-avatar="member" className={cn(GROUP_AVATAR, '[&>[data-slot=avatar]]:size-full')}><LetterAvatar name={assignee.name} size="row" /></span>)
  else if (assignee?.kind === 'agent' && !owner?.bot) avatars.push(<span key="agent" data-avatar="bot" className={GROUP_AVATAR}><AgentSphere name={assignee.name} compact /></span>)
  if (avatars.length === 0) return null
  const harnesses = owner?.harnesses ?? []
  for (const harness of harnesses.slice(0, 2)) avatars.push(<span key={harness} data-avatar="agent" className={GROUP_AVATAR}><HarnessMark harness={harness} /></span>)
  return <AvatarGroup className="isolate -space-x-1">
    {avatars.map((avatar, index) => <span key={index} className="flex" style={{ zIndex: avatars.length - index + 1 }}>{avatar}</span>)}
    {harnesses.length > 2 && <AvatarGroupCount className="z-0 size-[18px] text-[9px] font-medium ring-card">+{harnesses.length - 2}</AvatarGroupCount>}
  </AvatarGroup>
}

const AGENT_STATE_BADGES = { running: 'success-light', waiting: 'warning-light', blocked: 'destructive-light' } as const satisfies Record<AgentState, string>
const AGENT_STATE_DOTS = { running: 'bg-muted-foreground motion-safe:animate-pulse', waiting: 'bg-warning', blocked: 'bg-destructive' } as const satisfies Record<AgentState, string>

export type CardHandlers = {
  onOpen: (id: string) => void
  onStatusChange: (task: BoardTask, status: IssueStatus) => void
  onPriorityChange: (task: BoardTask, priority: string) => void
  onMetadataSaved: (issue: MetadataSavedIssue) => void
  onMetadataBusy: (busy: boolean) => void
  onDelete: (task: BoardTask) => void
  onDiscuss: (task: BoardTask) => void
  /** Into 受阻 by hand, or out of it (lib/task-blocked.ts). */
  onBlockChange?: (task: BoardTask, blocked: boolean) => void
}

/** What the board knows about a card beyond the task row itself. */
export type CardContext = {
  properties: ReadonlySet<CardProperty>
  agentStates: ReadonlyMap<string, AgentState>
  /** Each task's own state (localTaskState on its newest run), for a card's status line (decision #1864 point 6). */
  taskStates?: ReadonlyMap<string, { state: TaskState; reason: TaskReason | null }>
  subtasks: ReadonlyMap<string, { done: number; total: number }>
  /** The Bot and coding agents working each task, from its threads. */
  owners?: ReadonlyMap<string, RunOwner>
  /** Why each 受阻 task is blocked; its card names the reason. */
  blocks?: ReadonlyMap<string, TaskBlock>
  /** Cards the person just moved with the status menu (enter) or deleted (leave); others' changes are absent and snap (R-37). */
  motion?: ReadonlyMap<string, 'enter' | 'leave'>
  /** A personal workspace: every task is the person's, so no card shows the private lock. */
  personalWorkspace?: boolean
}

function TaskCard({ task, disabled, isOverlay = false, context, onOpen, onStatusChange, onPriorityChange, onMetadataSaved, onMetadataBusy, onDelete, onDiscuss, onBlockChange }: CardHandlers & {
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
  const block = context.blocks?.get(task.id)
  // A blocked card names why; the thread's own 受阻 badge would say less of the same.
  const agentState = block && block.reason !== 'flagged' && block.reason !== 'dependency' ? undefined : context.agentStates.get(task.id)
  const subtasks = context.subtasks.get(task.id)
  const metadata = task.metadata
  const format = useFormatter()
  const now = useNow({ updateInterval: 60_000 })
  const done = ['done', 'canceled', 'duplicate'].includes(task.status)
  const overdue = !done && Boolean(metadata.dueDate) && metadata.dueDate! < `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const labels = show('labels') ? metadata.labels : []
  const assigneeGroup = assigneeGroupOf({ assignee: metadata.assignee, owner: context.owners?.get(task.id) })
  // The newest PR, then a count of the rest (Figma 看板/任务卡片).
  const pullRequest = show('pullRequests') ? metadata.pullRequests.at(-1) : undefined
  const meta = 'flex items-center gap-1 text-xs text-muted-foreground tabular-nums [&_svg]:size-3.5 [&_svg]:shrink-0'
  // Row 3 shows only what the task has; it wraps when it does not fit.
  const chips = [
    show('priority') && <CardControlBoundary key="priority"><div className="-mx-[3px] flex"><IssuePropertyMenu label={tIssue('priorityLabel')} value={task.priority} options={priorityOptions} icon={Flag} iconOnly compact disabled={controlsDisabled} renderIcon={value => <PriorityIcon priority={value} />} onChange={value => onPriorityChange(task, value)} /></div></CardControlBoundary>,
    labels.length > 0 && <div key="labels" className="flex min-w-0 items-center gap-2">
      {labels.slice(0, 2).map(label => <span key={label.name} className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground"><LabelDot color={label.color} small /><span className="max-w-20 truncate">{label.name}</span></span>)}
      {labels.length > 2 && <span className="text-xs text-muted-foreground/70 tabular-nums">+{labels.length - 2}</span>}
    </div>,
    show('project') && metadata.project && <span key="project" className={cn(meta, 'min-w-0')}><Box /><span className="max-w-28 truncate">{metadata.project}</span></span>,
    pullRequest && <span key="pr" className="flex items-center gap-1"><CardControlBoundary><IssuePullRequestLink issueId={task.id} pr={pullRequest} compact /></CardControlBoundary>{metadata.pullRequests.length > 1 && <span className="text-xs text-muted-foreground/70 tabular-nums">+{metadata.pullRequests.length - 1}</span>}</span>,
    show('subtasks') && subtasks && subtasks.total > 0 && <span key="subtasks" className={meta} title={tCard('subtasks')}><ListChecks />{subtasks.done}/{subtasks.total}</span>,
    block && <Badge key="block" variant="destructive-light" size="lg"><CircleStop aria-hidden="true" className="size-3" />{blockLabel(tCard, block)}</Badge>,
    show('agentState') && agentState && <Badge key="agent" variant={AGENT_STATE_BADGES[agentState]} size="lg">{/* The thread's state is a dot, the same colours as on its bubble (R-52). */}<span aria-hidden="true" className={cn('size-1.5 rounded-full', AGENT_STATE_DOTS[agentState])} />{tCard(`agent.${agentState}`)}</Badge>,
    show('dueDate') && metadata.dueDate && <span key="due" className={cn(meta, overdue && 'text-destructive-foreground')}><CalendarDays />{formatDateOnly(format, metadata.dueDate, { month: 'short', day: 'numeric' })}</span>,
  ].filter(Boolean)

  const card = <BoardCard id={task.id} title={displayTaskTitle(task)} fullTitle={task.title} identifier={show('identifier') && task.identifier ? task.identifier : null} done={done} overlay={isOverlay}
    personal={task.scope === 'personal' && !context.personalWorkspace ? <Tooltip><TooltipTrigger render={<span className="flex shrink-0" />}><Lock aria-label={tCard('personal')} className="size-3.5 text-muted-foreground" /></TooltipTrigger><TooltipContent>{tCard('personalHint')}</TooltipContent></Tooltip> : null}
    hasAssignee={Boolean(assigneeGroup)}
    assignee={show('assignee') ? <CardControlBoundary><IssueMetadataControls task={task} section="assignee" compact disabled={controlsDisabled} assigneeAvatar={assigneeGroup} request={request?.target === 'assignee' ? request : null} onSaved={onMetadataSaved} onBusyChange={onMetadataBusy} /></CardControlBoundary> : null}
    status={<CardControlBoundary><div className="-ml-[3px] flex"><IssuePropertyMenu label={tIssue('statusLabel')} value={task.status} options={statusOptions} icon={Circle} iconOnly compact disabled={controlsDisabled} onChange={value => onStatusChange(task, value as IssueStatus)} /></div></CardControlBoundary>}
    chips={chips} runState={show('agentState') && agentState ? agentState : null} block={block ? { reason: block.reason, label: blockLabel(tCard, block) } : null} createdAt={show('createdAt') ? <CardCreatedAt createdAt={task.createdAt} /> : null}
    // Opened from the context menu: labels, project and PR editors, rendered off-card.
    editors={isOverlay ? null : <div hidden><IssueMetadataControls task={task} section="all" compact disabled={controlsDisabled} request={request && request.target !== 'assignee' ? request : null} onSaved={onMetadataSaved} onBusyChange={onMetadataBusy} /></div>} />

  if (isOverlay) return <KanbanItem value={task.id} disabled className="shrink-0">{card}</KanbanItem>
  const cardMotion = context.motion?.get(task.id)
  return <KanbanItem value={task.id} disabled={disabled} className={cn('shrink-0', cardMotion === 'enter' && 'animate-in fade-in-0 duration-150 motion-reduce:animate-none', cardMotion === 'leave' && 'pointer-events-none opacity-0 transition-opacity duration-150 motion-reduce:transition-none')} role="group" tabIndex={-1} aria-label={task.title}>
    <ContextMenu>
      <ContextMenuTrigger render={<KanbanItemHandle cursor={false} role="group" tabIndex={disabled ? -1 : 0} className="block cursor-pointer touch-pan-y rounded-md outline-none select-none focus-visible:ring-2 focus-visible:ring-ring data-[dragging=true]:cursor-grabbing" aria-label={t('openTask', { title: task.title })} aria-roledescription={t('openableDraggableTask')} aria-keyshortcuts="Enter Space" data-focus-id={task.id} onClick={event => {
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
      <ContextMenuContent className="w-56"><TaskMenuItems task={task} disabled={disabled} block={!!block} ask={ask} onStatusChange={onStatusChange} onPriorityChange={onPriorityChange} onDelete={onDelete} onDiscuss={onDiscuss} onBlockChange={onBlockChange} /></ContextMenuContent>
    </ContextMenu>
  </KanbanItem>
}

/** A card's context menu: status, priority, the metadata editors, 受阻, discuss and delete. */
function TaskMenuItems({ task, disabled, block, ask, onStatusChange, onPriorityChange, onDelete, onDiscuss, onBlockChange }: Pick<CardHandlers, 'onStatusChange' | 'onPriorityChange' | 'onDelete' | 'onDiscuss' | 'onBlockChange'> & {
  task: BoardTask
  disabled: boolean
  block: boolean
  ask: (target: MetadataRequest['target']) => void
}) {
  const tCard = useTranslations('Shell.board.card')
  const tIssue = useTranslations('Issue')
  const statusLabel = (value: string) => tIssue.has(`status.${value}` as never) ? tIssue(`status.${value}` as never) : value
  const priorityLabel = (value: string) => tIssue.has(`priority.${value}` as never) ? tIssue(`priority.${value}` as never) : value
  const statusOptions = ISSUE_STATUSES.map(item => ({ ...item, label: statusLabel(item.value) }))
  const priorityOptions = ISSUE_PRIORITIES.map(item => ({ ...item, label: priorityLabel(item.value) }))
  return <>
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
    {onBlockChange && <ContextMenuItem disabled={disabled} onClick={() => onBlockChange(task, !block)}><CircleStop />{block ? tCard('unblock') : tCard('markBlocked')}</ContextMenuItem>}
    <ContextMenuItem onClick={() => onDiscuss(task)}><MessageSquare />{tCard('discuss')}</ContextMenuItem>
    <ContextMenuSeparator />
    <ContextMenuItem variant="destructive" disabled={disabled} onClick={() => onDelete(task)}><Trash2 />{tCard('delete')}</ContextMenuItem>
  </>
}

/**
 * The same context menu around a UI layer's own card (the `board` slot's BoardScreen), with the editors it opens kept
 * off the card. The card stays as the layer draws it: the trigger adds no box of its own.
 */
export function TaskContextMenu({ task, disabled, block, children, onStatusChange, onPriorityChange, onMetadataSaved, onMetadataBusy, onDelete, onDiscuss, onBlockChange }: Omit<CardHandlers, 'onOpen'> & {
  task: BoardTask
  disabled: boolean
  block: boolean
  children: ReactNode
}) {
  const [request, setRequest] = useState<MetadataRequest | null>(null)
  const ask = (target: MetadataRequest['target']) => setRequest(current => ({ target, sequence: (current?.sequence ?? 0) + 1 }))
  return <>
    <ContextMenu>
      {isValidElement(children) && typeof children.type === 'string'
        ? <ContextMenuTrigger render={children} data-focus-id={task.id} />
        : <ContextMenuTrigger render={<div className="contents" />}>{children}</ContextMenuTrigger>}
      <ContextMenuContent className="w-56"><TaskMenuItems task={task} disabled={disabled} block={block} ask={ask} onStatusChange={onStatusChange} onPriorityChange={onPriorityChange} onDelete={onDelete} onDiscuss={onDiscuss} onBlockChange={onBlockChange} /></ContextMenuContent>
    </ContextMenu>
    <div hidden><IssueMetadataControls task={task} section="all" compact disabled={disabled} request={request} onSaved={onMetadataSaved} onBusyChange={onMetadataBusy} /></div>
  </>
}

function RememberedColumn({ stateKey, ...props }: ComponentProps<typeof KanbanColumnContent> & { stateKey: string }) {
  const scroll = useViewScroll<HTMLDivElement>(stateKey)
  return <KanbanColumnContent ref={scroll} {...props} />
}

type KanbanBoardProps = Omit<ComponentProps<typeof Kanban<BoardTask>>, 'children' | 'getItemValue'> & {
  stateKey?: string;
  value: BoardColumns
  columns: BoardColumn[]
  hiddenColumns: { status: BoardColumn; count: number }[]
  context: CardContext
  pending?: boolean
  viewportRef: Ref<HTMLDivElement>
  viewportId: string
  instructionsId: string
  onViewportKeyDown: ComponentProps<'div'>['onKeyDown']
  onHideColumn: (status: BoardColumn) => void
  onShowColumn: (status: BoardColumn) => void
  /** The Coordinator sidebar is beside the board: the hidden lane is left out. Columns keep their width either way. */
  sidebarOpen?: boolean
} & CardHandlers

export function KanbanBoard({ stateKey = 'board', columns, hiddenColumns: hidden, sidebarOpen = false, context, pending = false, viewportRef, viewportId, instructionsId, onViewportKeyDown, onHideColumn, onShowColumn, onOpen, onStatusChange, onPriorityChange, onMetadataSaved, onMetadataBusy, onDelete, onDiscuss, onBlockChange, ...props }: KanbanBoardProps) {
  const handlers = { onOpen, onStatusChange, onPriorityChange, onMetadataSaved, onMetadataBusy, onDelete, onDiscuss, onBlockChange }
  const t = useTranslations('Board')
  const tBoard = useTranslations('Shell.board')
  const tIssue = useTranslations('Issue')
  const statusLabel = (value: string) => tIssue.has(`status.${value}` as never) ? tIssue(`status.${value}` as never) : value
  const shown = BOARD_COLUMNS.filter(column => columns.includes(column.value))
  // R-25: every column is a fixed 300px, as Linear, sidebar open or not; when they do not fit, the board scrolls
  // and spare width stays empty; its edges fade where more columns wait (UI audit work-03). Beside the Coordinator sidebar the hidden lane is left out; hidden columns stay reachable from 显示.
  return <Kanban {...props} getItemValue={item => item.id} className="flex min-h-0 w-full min-w-0 flex-1 flex-col">
    <BoardScrollArea viewportRef={viewportRef} id={viewportId} role="region" aria-label={t('horizontalScroll')} aria-describedby={instructionsId} tabIndex={0} onKeyDown={onViewportKeyDown}>
      <KanbanBoardPrimitive className="flex h-full min-h-0 w-max min-w-full items-stretch gap-3 pb-2">
        {shown.map(column => {
          const tasks = props.value[column.value] ?? []
          return <KanbanColumn key={column.value} value={column.value} className="min-h-0 w-75 min-w-75 shrink-0">
            <BoardColumnFrame status={column.value} label={statusLabel(column.value)} count={tasks.length}
              icon={<column.icon className={cn('size-3.5 shrink-0', column.indicatorClassName)} aria-hidden="true" />}
              menu={<DropdownMenu>
                <DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" className="ml-auto text-muted-foreground" aria-label={tBoard('columnMenu', { status: statusLabel(column.value) })} />}><Ellipsis /></DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-40">
                  <DropdownMenuItem onClick={() => onHideColumn(column.value)}><EyeOff />{tBoard('hideColumn')}</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>}>
              <RememberedColumn stateKey={`${stateKey}:column:${column.value}`} value={column.value} className="min-h-0 flex-1 gap-1.5 overflow-y-auto overscroll-y-contain p-0.5" aria-label={t('columnContent', { status: statusLabel(column.value) })}>
                {tasks.map(task => <TaskCard key={task.id} task={task} disabled={pending} context={context} {...handlers} />)}
              </RememberedColumn>
            </BoardColumnFrame>
          </KanbanColumn>
        })}
        {hidden.length > 0 && !sidebarOpen && <BoardHiddenLane label={tBoard('hiddenLane')} columns={hidden.map(({ status, count }) => {
          const column = BOARD_COLUMNS.find(item => item.value === status)!
          return { status, label: statusLabel(status), icon: column.icon, iconClassName: column.indicatorClassName, count, title: tBoard('showColumn', { status: statusLabel(status) }), onShow: () => onShowColumn(status) }
        })} />}
      </KanbanBoardPrimitive>
    </BoardScrollArea>
    <KanbanOverlay>{({ value }) => {
      const entry = Object.entries(props.value).find(([, tasks]) => tasks.some(task => task.id === value))
      const task = entry?.[1].find(item => item.id === value)
      return task && entry ? <TaskCard task={task} disabled isOverlay context={context} {...handlers} /> : null
    }}</KanbanOverlay>
  </Kanban>
}
