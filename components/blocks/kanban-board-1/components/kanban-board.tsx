'use client'

import { type ComponentProps, type Ref } from 'react'
import { ScrollArea as ScrollAreaPrimitive } from '@base-ui/react/scroll-area'
import { ArrowRight, CalendarDays, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/reui/badge'
import { Kanban, KanbanBoard as KanbanBoardPrimitive, KanbanColumn, KanbanColumnContent, KanbanItem, KanbanItemHandle, KanbanOverlay } from '@/components/reui/kanban'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { ISSUE_PRIORITIES, issueIdentifier, type IssueStatus } from '@/components/workspace/issue-properties'
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

function TaskTitleAffordance({ title, isDone, onOpen, disabled }: { title: string; isDone: boolean; onOpen: () => void; disabled: boolean }) {
  return <button type="button" disabled={disabled} onClick={onOpen} onPointerDown={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()} className="group/task-title inline-flex max-w-full min-w-0 items-start gap-1 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
    <span data-slot="kanban-task-title" className={cn('line-clamp-2 cursor-pointer py-0.25 transition-colors hover:text-primary', isDone && 'text-muted-foreground line-through')}>{title}</span>
    <ArrowRight aria-hidden="true" className="mt-1 size-3 shrink-0 -translate-x-1 opacity-0 transition-all group-hover/task-title:translate-x-0 group-hover/task-title:opacity-100 motion-reduce:transition-none" />
  </button>
}

const signalDotClass: Record<IssueStatus, string> = {
  backlog: 'bg-muted-foreground',
  todo: 'bg-muted-foreground',
  doing: 'bg-warning',
  review: 'bg-success',
  done: 'bg-info',
  canceled: 'bg-muted-foreground',
  duplicate: 'bg-muted-foreground',
}

const priorityCodes: Record<string, string> = { urgent: 'P0', high: 'P1', normal: 'P2', low: 'P3' }

function SignalBadge({ status }: { status: IssueStatus }) {
  return <Badge variant="outline" className="gap-1.5">
    <span className={cn('size-1.5 shrink-0 rounded-full', signalDotClass[status])} aria-hidden="true" />
    {BOARD_COLUMNS.find(column => column.value === status)?.label}
  </Badge>
}

function DueBadge({ updatedAt }: { updatedAt: BoardTask['updatedAt'] }) {
  return <Badge variant="outline" className="bg-background gap-1.5 font-normal" title="最后更新日期（非截止日期）">
    <CalendarDays className="size-3.5 text-muted-foreground" aria-hidden="true" />
    <time className="tabular-nums" dateTime={new Date(updatedAt).toISOString()}>{new Date(updatedAt).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric', timeZone: 'UTC' })}</time>
  </Badge>
}

function CompletionRing() {
  return <span className="flex items-center gap-1.5 text-xs tabular-nums text-muted-foreground" aria-label="尚未设置完成百分比" title="尚未设置完成百分比">
    <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-border">-</span>
  </span>
}

function TaskCard({ task, status, disabled, isOverlay = false, onOpen }: {
  task: BoardTask
  status: IssueStatus
  disabled: boolean
  isOverlay?: boolean
  onOpen: (id: string) => void
}) {
  const isDone = status === 'done' || status === 'canceled' || status === 'duplicate'
  const owner = task.ownerName || '未知成员'
  const initials = Array.from(owner).slice(0, 2).join('').toUpperCase()
  const card = <Card size="sm" className={cn('bg-card p-0 shadow-xs transition-[border-color,box-shadow] hover:border-foreground/20 hover:shadow-sm', isOverlay && 'pointer-events-none shadow-lg', isDone && 'bg-muted/40')}>
    <CardContent className="flex min-h-[8.75rem] flex-col p-3">
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <Badge variant="secondary">任务</Badge>
          <span className="truncate text-xs tabular-nums text-muted-foreground">{issueIdentifier(task.id)}</span>
          <span className="text-xs tabular-nums text-muted-foreground" title={ISSUE_PRIORITIES.find(item => item.value === task.priority)?.label}>{priorityCodes[task.priority]}</span>
        </div>
        <SignalBadge status={status} />
      </div>
      <h3 className="mt-3 min-h-10 text-sm leading-5 font-medium">
        <TaskTitleAffordance title={task.title} isDone={isDone} onOpen={() => onOpen(task.id)} disabled={disabled || isOverlay} />
      </h3>
      <div className="mt-auto flex items-center justify-between gap-2 pt-4">
        <div className="flex min-w-0 items-center gap-2" title={`创建者：${owner}`}>
          <Avatar size="sm">
            {task.ownerImage && <AvatarImage src={task.ownerImage} alt={owner} />}
            <AvatarFallback>{initials}</AvatarFallback>
          </Avatar>
          <span className="truncate text-xs font-medium text-muted-foreground">{owner}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <DueBadge updatedAt={task.updatedAt} />
          <CompletionRing />
        </div>
      </div>
    </CardContent>
  </Card>

  return <KanbanItem value={task.id} disabled={disabled} className="shrink-0" role="group" tabIndex={-1} aria-label={task.title}>
    {isOverlay ? card : <KanbanItemHandle className="block touch-pan-y rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={`拖动任务：${task.title}`} aria-roledescription="可拖动任务">{card}</KanbanItemHandle>}
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
}

export function KanbanBoard({ pending = false, viewportRef, viewportId, instructionsId, onViewportKeyDown, onOpen, onCreate, ...props }: KanbanBoardProps) {
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
              {(props.value[column.value] ?? []).map(task => <TaskCard key={task.id} task={task} status={column.value} disabled={pending} onOpen={onOpen} />)}
              {!props.value[column.value]?.length && <p className="rounded-lg border border-dashed border-border/70 bg-background/55 px-3 py-6 text-center text-xs text-muted-foreground">拖动任务到这里</p>}
            </KanbanColumnContent>
          </section>
        </KanbanColumn>)}
      </KanbanBoardPrimitive>
    </BoardScrollArea>
    <KanbanOverlay>{({ value }) => {
      const entry = Object.entries(props.value).find(([, tasks]) => tasks.some(task => task.id === value))
      const task = entry?.[1].find(item => item.id === value)
      return task ? <TaskCard task={task} status={entry![0] as IssueStatus} disabled isOverlay onOpen={onOpen} /> : null
    }}</KanbanOverlay>
  </Kanban>
}
