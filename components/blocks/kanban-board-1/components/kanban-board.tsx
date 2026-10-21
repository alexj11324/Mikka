'use client'

import { type ComponentProps, type Ref } from 'react'
import { ScrollArea as ScrollAreaPrimitive } from '@base-ui/react/scroll-area'
import { ArrowRight, CalendarDays, Plus } from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/reui/badge'
import { Kanban, KanbanBoard as KanbanBoardPrimitive, KanbanColumn, KanbanColumnContent, KanbanItem, KanbanItemHandle, KanbanOverlay } from '@/components/reui/kanban'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { issueIdentifier, type IssueStatus } from '@/components/workspace/issue-properties'
import { BOARD_COLUMNS, type BoardColumns, type BoardTask } from './data'

function BoardScrollArea({ children, viewportRef, ...props }: ComponentProps<typeof ScrollAreaPrimitive.Viewport> & { viewportRef: Ref<HTMLDivElement> }) {
  return <ScrollAreaPrimitive.Root data-slot="scroll-area" className="relative w-full min-w-0 pb-3">
    <ScrollAreaPrimitive.Viewport {...props} ref={viewportRef} data-slot="scroll-area-viewport" className="w-full overscroll-x-contain rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset">
      <ScrollAreaPrimitive.Content data-slot="scroll-area-content" className="w-max min-w-full">{children}</ScrollAreaPrimitive.Content>
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
  const statusT = useTranslations('Issue.status')
  return <Badge variant="outline" className="gap-1.5">
    <span className={cn('size-1.5 shrink-0 rounded-full', signalDotClass[status])} aria-hidden="true" />
    {statusT.has(status as never) ? statusT(status as never) : status}
  </Badge>
}

function DueBadge({ updatedAt }: { updatedAt: BoardTask['updatedAt'] }) {
  const t = useTranslations('Board')
  const format = useFormatter()
  return <Badge variant="outline" className="bg-background gap-1.5 font-normal" title={t('lastUpdated')}>
    <CalendarDays className="size-3.5 text-muted-foreground" aria-hidden="true" />
    <time className="tabular-nums" dateTime={new Date(updatedAt).toISOString()}>{format.dateTime(new Date(updatedAt), { month: 'numeric', day: 'numeric', timeZone: 'UTC' })}</time>
  </Badge>
}

function CompletionRing() {
  const t = useTranslations('Board')
  return <span className="flex items-center gap-1.5 text-xs tabular-nums text-muted-foreground" aria-label={t('noCompletion')} title={t('noCompletion')}>
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
  const t = useTranslations('Board')
  const priorityT = useTranslations('Issue.priority')
  const isDone = status === 'done' || status === 'canceled' || status === 'duplicate'
  const owner = task.ownerName || t('unknownMember')
  const initials = Array.from(owner).slice(0, 2).join('').toUpperCase()
  const card = <Card size="sm" className={cn('bg-card p-0 shadow-xs transition-[border-color,box-shadow] hover:border-foreground/20 hover:shadow-sm', isOverlay && 'pointer-events-none shadow-lg', isDone && 'bg-muted/40')}>
    <CardContent className="flex min-h-[8.75rem] flex-col p-3">
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <Badge variant="secondary">{t('task')}</Badge>
          <span className="truncate text-xs tabular-nums text-muted-foreground">{issueIdentifier(task.id)}</span>
          <span className="text-xs tabular-nums text-muted-foreground" title={priorityT.has(task.priority as never) ? priorityT(task.priority as never) : task.priority}>{priorityCodes[task.priority]}</span>
        </div>
        <SignalBadge status={status} />
      </div>
      <h3 className="mt-3 min-h-10 text-sm leading-5 font-medium">
        <TaskTitleAffordance title={task.title} isDone={isDone} onOpen={() => onOpen(task.id)} disabled={disabled || isOverlay} />
      </h3>
      <div className="mt-auto flex items-center justify-between gap-2 pt-4">
        <div className="flex min-w-0 items-center gap-2" title={t('creator', { name: owner })}>
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

  return <KanbanItem value={task.id} disabled={disabled} role="group" tabIndex={-1} aria-label={task.title}>
    {isOverlay ? card : <KanbanItemHandle className="block touch-pan-y rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={t('dragTask', { title: task.title })} aria-roledescription={t('draggableTask')}>{card}</KanbanItemHandle>}
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
  const t = useTranslations('Board')
  const statusT = useTranslations('Issue.status')
  const statusLabel = (value: string) => statusT.has(value as never) ? statusT(value as never) : value
  return <Kanban {...props} getItemValue={item => item.id} className="w-full min-w-0">
    <BoardScrollArea viewportRef={viewportRef} id={viewportId} role="region" aria-label={t('horizontalScroll')} aria-describedby={instructionsId} tabIndex={0} onKeyDown={onViewportKeyDown}>
      <KanbanBoardPrimitive className="grid w-max min-w-full auto-cols-[17.5rem] grid-flow-col grid-cols-none items-start gap-3 px-1 pb-2">
        {BOARD_COLUMNS.map(column => <KanbanColumn key={column.value} value={column.value} className="w-70 min-w-70">
          <section className={cn('flex min-h-64 flex-col gap-2 rounded-lg border p-2.5 transition-colors', column.surfaceClassName, column.borderClassName)} aria-label={t('columnLabel', { status: statusLabel(column.value) })}>
            <div className="flex h-8 items-center gap-2 px-0.5">
              <column.icon className={cn('size-4 shrink-0', column.indicatorClassName)} aria-hidden="true" />
              <h2 className="truncate text-sm font-semibold">{statusLabel(column.value)}</h2>
              <Badge variant="outline">{props.value[column.value]?.length ?? 0}</Badge>
              <Button type="button" variant="ghost" size="icon-xs" className="ml-auto" aria-label={t('newTaskIn', { status: statusLabel(column.value) })} disabled={pending} onClick={() => onCreate(column.value)}><Plus /></Button>
            </div>
            <KanbanColumnContent value={column.value} className="min-h-28 gap-2" aria-label={t('columnContent', { status: statusLabel(column.value) })}>
              {(props.value[column.value] ?? []).map(task => <TaskCard key={task.id} task={task} status={column.value} disabled={pending} onOpen={onOpen} />)}
              {!props.value[column.value]?.length && <p className="rounded-lg border border-dashed border-border/70 bg-background/55 px-3 py-6 text-center text-xs text-muted-foreground">{t('dropHere')}</p>}
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
