'use client'

import { type ComponentProps, type Ref } from 'react'
import { ScrollArea as ScrollAreaPrimitive } from '@base-ui/react/scroll-area'
import { Circle, Flag, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/reui/badge'
import { Kanban, KanbanBoard as KanbanBoardPrimitive, KanbanColumn, KanbanColumnContent, KanbanItem, KanbanItemHandle, KanbanOverlay } from '@/components/reui/kanban'
import { Button } from '@/components/ui/button'
import { Card, CardHeader, CardContent, CardFooter } from '@/components/ui/card'
import { CardControlBoundary, CardMembers, CardHistory, CardCompletion } from '@/components/workspace/issue-card-controls'
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

const priorityCodes: Record<string, string> = { urgent: 'P0', high: 'P1', normal: 'P2', low: 'P3' }

function TaskCard({ task, status, disabled, isOverlay = false, onOpen, onStatusChange, onPriorityChange }: {
  task: BoardTask
  status: IssueStatus
  disabled: boolean
  isOverlay?: boolean
  onOpen: (id: string) => void
  onStatusChange: (task: BoardTask, status: IssueStatus) => void
  onPriorityChange: (task: BoardTask, priority: string) => void
}) {
  const isDone = status === 'done' || status === 'canceled' || status === 'duplicate'
  const controlsDisabled = disabled || isOverlay
  const card = <Card size="sm" className={cn('min-h-36 gap-0 bg-card p-0 shadow-xs transition-shadow hover:ring-foreground/20 hover:shadow-sm', isOverlay && 'pointer-events-none shadow-lg', isDone && 'bg-muted/40')}>
    <CardHeader className="flex min-w-0 items-start justify-between gap-1 p-3 pb-0">
      <div className="flex min-w-0 flex-wrap items-center gap-1 text-xs text-muted-foreground">
        <CardControlBoundary><Button type="button" variant="secondary" size="xs" disabled={controlsDisabled} onClick={() => onOpen(task.id)}>任务</Button></CardControlBoundary>
        <span className="truncate tabular-nums">{issueIdentifier(task.id)}</span>
        <CardControlBoundary><IssuePropertyMenu label="优先级" value={task.priority} options={ISSUE_PRIORITIES} icon={Flag} compact displayValue={priorityCodes[task.priority]} disabled={controlsDisabled} onChange={value => onPriorityChange(task, value)} /></CardControlBoundary>
      </div>
      <CardControlBoundary><IssuePropertyMenu label="任务状态" value={status} options={ISSUE_STATUSES} icon={Circle} compact pill disabled={controlsDisabled} onChange={value => onStatusChange(task, value as IssueStatus)} /></CardControlBoundary>
    </CardHeader>
    <CardContent className="px-3 pt-3 pb-4">
      <h3 data-slot="kanban-task-title" className={cn('line-clamp-2 min-h-10 text-sm leading-5 font-medium', isDone && 'text-muted-foreground line-through')}>{task.title}</h3>
    </CardContent>
    <CardFooter className="mt-auto justify-between gap-2 border-0 bg-transparent p-3 pt-0">
      <CardMembers task={task} disabled={controlsDisabled} />
      <div className="flex shrink-0 items-center gap-1"><CardHistory task={task} disabled={controlsDisabled} onOpen={onOpen} /><CardCompletion task={task} status={status} disabled={controlsDisabled} onOpen={onOpen} onStatusChange={onStatusChange} /></div>
    </CardFooter>
  </Card>

  return <KanbanItem value={task.id} disabled={disabled} className="shrink-0" role="group" tabIndex={-1} aria-label={task.title}>
    {isOverlay ? card : <KanbanItemHandle cursor={false} role="group" tabIndex={disabled ? -1 : 0} className="block cursor-pointer touch-pan-y rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring data-[dragging=true]:cursor-grabbing" aria-label={`打开任务：${task.title}`} aria-roledescription="可打开、可拖动任务" aria-keyshortcuts="Enter Space" onClick={event => {
      if (disabled || event.defaultPrevented || (event.target as HTMLElement).closest('[data-card-control]') || window.getSelection()?.toString()) return
      onOpen(task.id)
    }} onKeyDownCapture={event => {
      if (event.target !== event.currentTarget || event.nativeEvent.isComposing || event.keyCode === 229 || event.currentTarget.dataset.dragging === 'true') return
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
}

export function KanbanBoard({ pending = false, viewportRef, viewportId, instructionsId, onViewportKeyDown, onOpen, onCreate, onStatusChange, onPriorityChange, ...props }: KanbanBoardProps) {
  return <Kanban {...props} getItemValue={item => item.id} className="flex min-h-0 w-full min-w-0 flex-1 flex-col">
    <BoardScrollArea viewportRef={viewportRef} id={viewportId} role="region" aria-label="横向滚动任务看板" aria-describedby={instructionsId} tabIndex={0} onKeyDown={onViewportKeyDown}>
      <KanbanBoardPrimitive className="grid h-full min-h-0 w-max min-w-full auto-cols-[17.5rem] grid-flow-col grid-cols-none items-stretch gap-3 px-1 pb-2">
        {BOARD_COLUMNS.map(column => <KanbanColumn key={column.value} value={column.value} className="min-h-0 w-70 min-w-70">
          <section className={cn('flex min-h-0 flex-1 flex-col gap-2 rounded-lg border p-2.5 transition-colors', column.surfaceClassName, column.borderClassName)} aria-label={`${column.label}任务列`}>
            <div className="flex h-8 shrink-0 items-center gap-2 px-0.5">
              <column.icon className={cn('size-4 shrink-0', column.indicatorClassName)} aria-hidden="true" />
              <h2 className="truncate text-sm font-semibold">{column.label}</h2>
              <Badge variant="outline">{props.value[column.value]?.length ?? 0}</Badge>
              <Button type="button" variant="ghost" size="icon-xs" className="ml-auto" aria-label={`新建${column.label}任务`} disabled={pending} onClick={() => onCreate(column.value)}><Plus /></Button>
            </div>
            <KanbanColumnContent value={column.value} className="min-h-0 flex-1 gap-2 overflow-y-auto overscroll-y-contain" aria-label={`${column.label}列`}>
              {(props.value[column.value] ?? []).map(task => <TaskCard key={task.id} task={task} status={column.value} disabled={pending} onOpen={onOpen} onStatusChange={onStatusChange} onPriorityChange={onPriorityChange} />)}
              {!props.value[column.value]?.length && <p className="rounded-lg border border-dashed border-border/70 bg-background/55 px-3 py-6 text-center text-xs text-muted-foreground">拖动任务到这里</p>}
            </KanbanColumnContent>
          </section>
        </KanbanColumn>)}
      </KanbanBoardPrimitive>
    </BoardScrollArea>
    <KanbanOverlay>{({ value }) => {
      const entry = Object.entries(props.value).find(([, tasks]) => tasks.some(task => task.id === value))
      const task = entry?.[1].find(item => item.id === value)
      return task ? <TaskCard task={task} status={entry![0] as IssueStatus} disabled isOverlay onOpen={onOpen} onStatusChange={onStatusChange} onPriorityChange={onPriorityChange} /> : null
    }}</KanbanOverlay>
  </Kanban>
}
