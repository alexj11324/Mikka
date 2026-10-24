'use client'

import { type ComponentProps, type Ref } from 'react'
import { ScrollArea as ScrollAreaPrimitive } from '@base-ui/react/scroll-area'
import { useTranslations } from 'next-intl'
import { Circle, Flag, Plus } from 'lucide-react'
import { IssueMetadataControls, type MetadataSavedIssue } from '@/components/workspace/issue-metadata-controls'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/reui/badge'
import { Kanban, KanbanBoard as KanbanBoardPrimitive, KanbanColumn, KanbanColumnContent, KanbanItem, KanbanItemHandle, KanbanOverlay } from '@/components/reui/kanban'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardTitle, CardHeader, CardContent, CardFooter } from '@/components/ui/card'
import { CardControlBoundary, CardCreatedAt } from '@/components/workspace/issue-card-controls'
import { IssuePropertyMenu } from '@/components/workspace/issue-property-menu'
import { ISSUE_PRIORITIES, ISSUE_STATUSES, issueIdentifier, type IssueStatus } from '@/components/workspace/issue-properties'
import { BOARD_COLUMNS, type BoardColumns, type BoardTask } from './data'

function BoardScrollArea({ children, viewportRef, ...props }: ComponentProps<typeof ScrollAreaPrimitive.Viewport> & { viewportRef: Ref<HTMLDivElement> }) {
  return <ScrollAreaPrimitive.Root data-slot="scroll-area" className="relative min-h-0 w-full min-w-0 flex-1 pb-3">
    <ScrollAreaPrimitive.Viewport {...props} ref={viewportRef} data-slot="scroll-area-viewport" className="h-full w-full overscroll-x-contain rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset">
      <ScrollAreaPrimitive.Content data-slot="scroll-area-content" className="h-full w-max min-w-full">{children}</ScrollAreaPrimitive.Content>
    </ScrollAreaPrimitive.Viewport>
    <ScrollAreaPrimitive.Scrollbar orientation="horizontal" className="flex h-2.5 touch-none flex-col p-px select-none"><ScrollAreaPrimitive.Thumb className="relative flex-1 rounded-full bg-foreground/15" /></ScrollAreaPrimitive.Scrollbar>
    <ScrollAreaPrimitive.Corner />
  </ScrollAreaPrimitive.Root>
}

function TaskCard({ task, status, disabled, isOverlay = false, onOpen, onStatusChange, onPriorityChange, onMetadataSaved, onMetadataBusy }: {
  task: BoardTask
  status: IssueStatus
  disabled: boolean
  isOverlay?: boolean
  onOpen: (id: string) => void
  onStatusChange: (task: BoardTask, status: IssueStatus) => void
  onPriorityChange: (task: BoardTask, priority: string) => void
  onMetadataSaved: (issue: MetadataSavedIssue) => void
  onMetadataBusy: (busy: boolean) => void
}) {
  const t = useTranslations('Board')
  const tIssue = useTranslations('Issue')
  const statusLabel = (value: string) => tIssue.has(`status.${value}` as never) ? tIssue(`status.${value}` as never) : value
  const priorityLabel = (value: string) => tIssue.has(`priority.${value}` as never) ? tIssue(`priority.${value}` as never) : value
  const statusOptions = ISSUE_STATUSES.map(item => ({ ...item, label: statusLabel(item.value) }))
  const priorityOptions = ISSUE_PRIORITIES.map(item => ({ ...item, label: priorityLabel(item.value) }))
  const optimistic = 'optimistic' in task && task.optimistic === true
  const controlsDisabled = disabled || isOverlay || optimistic
  const card = <Card size="sm" className={cn('select-none gap-2 shadow-xs transition-shadow hover:ring-foreground/20 hover:shadow-sm', isOverlay && 'pointer-events-none shadow-lg')}>
    <CardHeader className="flex min-w-0 items-center justify-between gap-2">
      <CardDescription className="truncate tabular-nums">{issueIdentifier(task, tIssue('unassignedNumber'))}</CardDescription>
      <div className="flex shrink-0 items-center gap-1">
        <CardControlBoundary><IssuePropertyMenu label={tIssue('priorityLabel')} value={task.priority} options={priorityOptions} icon={Flag} iconOnly compact pill disabled={controlsDisabled} onChange={value => onPriorityChange(task, value)} /></CardControlBoundary>
        <CardControlBoundary><IssueMetadataControls task={task} section="assignee" compact disabled={controlsDisabled} onSaved={onMetadataSaved} onBusyChange={onMetadataBusy} /></CardControlBoundary>
      </div>
    </CardHeader>
    <CardContent className="flex min-w-0 items-start gap-1">
      <CardControlBoundary><IssuePropertyMenu label={tIssue('statusLabel')} value={status} options={statusOptions} icon={Circle} iconOnly compact disabled={controlsDisabled} onChange={value => onStatusChange(task, value as IssueStatus)} /></CardControlBoundary>
      <CardTitle className="min-w-0 flex-1 pt-0.5"><h3 data-slot="kanban-task-title" className="line-clamp-3 break-words">{task.title}</h3></CardTitle>
    </CardContent>
    <CardContent className="flex flex-wrap items-center gap-1.5 pt-1">
      <CardControlBoundary><IssueMetadataControls task={task} section="properties" compact disabled={controlsDisabled} onSaved={onMetadataSaved} onBusyChange={onMetadataBusy} /></CardControlBoundary>
    </CardContent>
    <CardFooter className="border-0 bg-transparent pt-0"><CardCreatedAt createdAt={task.createdAt} /></CardFooter>
  </Card>

  return <KanbanItem value={task.id} disabled={disabled || optimistic} data-optimistic={optimistic ? '' : undefined} aria-busy={optimistic || undefined} className={cn('shrink-0', optimistic && 'max-h-64 overflow-hidden opacity-100 transition-[max-height,opacity] duration-200 ease-out starting:max-h-0 starting:opacity-0 motion-reduce:transition-none')} role="group" tabIndex={-1} aria-label={task.title}>
    {isOverlay ? card : <KanbanItemHandle cursor={false} role="group" tabIndex={disabled ? -1 : 0} className="block cursor-pointer touch-pan-y rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring data-[dragging=true]:cursor-grabbing" aria-label={t('openTask', { title: task.title })} aria-roledescription={t('openableDraggableTask')} aria-keyshortcuts="Enter Space" onClick={event => {
      if (disabled || event.defaultPrevented || (event.target as HTMLElement).closest('[data-card-control]')) return
      onOpen(task.id)
    }} onKeyDownCapture={event => {
      if (event.target !== event.currentTarget || event.nativeEvent.isComposing || event.keyCode === 229 || event.currentTarget.dataset.dragging === 'true') return
      if (event.key.toLowerCase() === 'a' && !disabled && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault(); event.stopPropagation()
        event.currentTarget.querySelector<HTMLButtonElement>('[data-assignee-trigger]')?.click()
      }
      if (event.key === 'Enter' && !disabled) {
        event.preventDefault()
        event.stopPropagation()
        onOpen(task.id)
      }
    }}>{card}</KanbanItemHandle>}
  </KanbanItem>
}

type KanbanBoardProps = Omit<ComponentProps<typeof Kanban<BoardTask>>, 'children' | 'getItemValue'> & {
  value: BoardColumns
  pending?: boolean
  viewportRef: Ref<HTMLDivElement>
  viewportId: string
  instructionsId: string
  onViewportKeyDown: ComponentProps<'div'>['onKeyDown']
  onOpen: (id: string) => void
  onCreate: (status: IssueStatus) => void
  onStatusChange: (task: BoardTask, status: IssueStatus) => void
  onPriorityChange: (task: BoardTask, priority: string) => void
  onMetadataSaved: (issue: MetadataSavedIssue) => void
  onMetadataBusy: (busy: boolean) => void
}

export function KanbanBoard({ pending = false, viewportRef, viewportId, instructionsId, onViewportKeyDown, onOpen, onCreate, onStatusChange, onPriorityChange, onMetadataSaved, onMetadataBusy, ...props }: KanbanBoardProps) {
  const t = useTranslations('Board')
  const tIssue = useTranslations('Issue')
  const statusLabel = (value: string) => tIssue.has(`status.${value}` as never) ? tIssue(`status.${value}` as never) : value
  return <Kanban {...props} getItemValue={item => item.id} className="flex min-h-0 w-full min-w-0 flex-1 flex-col">
    <BoardScrollArea viewportRef={viewportRef} id={viewportId} role="region" aria-label={t('horizontalScroll')} aria-describedby={instructionsId} tabIndex={0} onKeyDown={onViewportKeyDown}>
      <KanbanBoardPrimitive className="grid h-full min-h-0 w-max min-w-full auto-cols-[17.5rem] grid-flow-col grid-cols-none items-stretch gap-3 px-1 pb-2">
        {BOARD_COLUMNS.map(column => <KanbanColumn key={column.value} value={column.value} className="min-h-0 w-70 min-w-70">
          <section className={cn('flex min-h-0 flex-1 flex-col gap-2 rounded-lg border p-2.5 transition-colors', column.surfaceClassName, column.borderClassName)} aria-label={t('columnLabel', { status: statusLabel(column.value) })}>
            <div className="flex h-8 shrink-0 items-center gap-2 px-0.5">
              <column.icon className={cn('size-4 shrink-0', column.indicatorClassName)} aria-hidden="true" />
              <h2 className="truncate text-sm font-semibold">{statusLabel(column.value)}</h2>
              <Badge variant="outline">{props.value[column.value]?.length ?? 0}</Badge>
              <Button type="button" variant="ghost" size="icon-xs" className="ml-auto" aria-label={t('newTaskIn', { status: statusLabel(column.value) })} disabled={pending} onClick={() => onCreate(column.value)}><Plus /></Button>
            </div>
            <KanbanColumnContent value={column.value} className="min-h-0 flex-1 gap-2 overflow-y-auto overscroll-y-contain p-1" aria-label={t('columnContent', { status: statusLabel(column.value) })}>
              {(props.value[column.value] ?? []).map(task => <TaskCard key={task.id} task={task} status={column.value} disabled={pending} onOpen={onOpen} onStatusChange={onStatusChange} onPriorityChange={onPriorityChange} onMetadataSaved={onMetadataSaved} onMetadataBusy={onMetadataBusy} />)}
              {!props.value[column.value]?.length && <p className="rounded-lg border border-dashed border-border/70 bg-background/55 px-3 py-6 text-center text-xs text-muted-foreground">{t('dropHere')}</p>}
            </KanbanColumnContent>
          </section>
        </KanbanColumn>)}
      </KanbanBoardPrimitive>
    </BoardScrollArea>
    <KanbanOverlay>{({ value }) => {
      const entry = Object.entries(props.value).find(([, tasks]) => tasks.some(task => task.id === value))
      const task = entry?.[1].find(item => item.id === value)
      return task ? <TaskCard task={task} status={entry![0] as IssueStatus} disabled isOverlay onOpen={onOpen} onStatusChange={onStatusChange} onPriorityChange={onPriorityChange} onMetadataSaved={onMetadataSaved} onMetadataBusy={onMetadataBusy} /> : null
    }}</KanbanOverlay>
  </Kanban>
}
