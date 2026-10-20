'use client'

import { type ComponentProps, type Ref } from 'react'
import { ScrollArea as ScrollAreaPrimitive } from '@base-ui/react/scroll-area'
import { ArrowRight, CalendarDays, GripVertical, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/reui/badge'
import { Kanban, KanbanBoard as KanbanBoardPrimitive, KanbanColumn, KanbanColumnContent, KanbanItem, KanbanItemHandle, KanbanOverlay } from '@/components/reui/kanban'
import { Button } from '@/components/ui/button'
import { Card, CardHeader, CardTitle, CardFooter } from '@/components/ui/card'
import { IssuePropertyMenu } from '@/components/workspace/issue-property-menu'
import { ISSUE_PRIORITIES, issueIdentifier, type IssueStatus } from '@/components/workspace/issue-properties'
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
  return <button type="button" disabled={disabled} onClick={onOpen} className="group/task-title inline-flex w-full min-w-0 items-start gap-1 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
    <span className={cn('line-clamp-2 flex-1 py-0.5', isDone && 'text-muted-foreground line-through')}>{title}</span>
    <ArrowRight aria-hidden="true" className="mt-1 size-3 shrink-0 -translate-x-1 opacity-0 transition-all group-hover/task-title:translate-x-0 group-hover/task-title:opacity-100 motion-reduce:transition-none" />
  </button>
}

function TaskCard({ task, status, disabled, isOverlay = false, onOpen, onStatus }: {
  task: BoardTask
  status: IssueStatus
  disabled: boolean
  isOverlay?: boolean
  onOpen: (id: string) => void
  onStatus: (task: BoardTask, status: string) => void
}) {
  const state = BOARD_COLUMNS.find(column => column.value === status)!
  const priority = ISSUE_PRIORITIES.find(item => item.value === task.priority)
  return <KanbanItem value={task.id} disabled={disabled} role="group" tabIndex={-1} aria-label={task.title}>
    <Card size="sm" className={cn('min-h-40 shadow-xs transition-shadow hover:shadow-sm', isOverlay && 'pointer-events-none shadow-lg')}>
      <CardHeader>
        <div className="flex min-w-0 items-center justify-between gap-2">
          <span className="truncate font-mono text-xs text-muted-foreground">{issueIdentifier(task.id)}</span>
          <KanbanItemHandle className="touch-none" render={({ className, ...handleProps }) => <button {...handleProps} type="button" disabled={disabled || isOverlay} aria-label={`拖动任务：${task.title}`} aria-roledescription="可拖动任务" className={cn('flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring', className)}><GripVertical className="size-4" aria-hidden="true" /></button>} />
        </div>
        <CardTitle><TaskTitleAffordance title={task.title} isDone={status === 'done' || status === 'canceled'} onOpen={() => onOpen(task.id)} disabled={disabled || isOverlay} /></CardTitle>
      </CardHeader>
      <CardFooter className="mt-auto flex-wrap justify-between gap-2">
        <IssuePropertyMenu label="移动到" value={status} options={BOARD_COLUMNS} icon={state.icon} disabled={disabled || isOverlay} onChange={value => onStatus(task, value)} />
        <div className="flex items-center gap-2">
          <Badge variant="outline" size="xs">{priority?.label}</Badge>
          <time title="最后更新" className="inline-flex items-center gap-1 text-xs tabular-nums text-muted-foreground" dateTime={new Date(task.updatedAt).toISOString()}><CalendarDays className="size-3" aria-hidden="true" />{new Date(task.updatedAt).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric', timeZone: 'UTC' })}</time>
        </div>
      </CardFooter>
    </Card>
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
  onStatus: (task: BoardTask, status: string) => void
}

export function KanbanBoard({ pending = false, viewportRef, viewportId, instructionsId, onViewportKeyDown, onOpen, onCreate, onStatus, ...props }: KanbanBoardProps) {
  return <Kanban {...props} getItemValue={item => item.id} className="w-full min-w-0">
    <BoardScrollArea viewportRef={viewportRef} id={viewportId} role="region" aria-label="横向滚动任务看板" aria-describedby={instructionsId} tabIndex={0} onKeyDown={onViewportKeyDown}>
      <KanbanBoardPrimitive className="grid w-max min-w-full auto-cols-[17.5rem] grid-flow-col grid-cols-none items-start gap-3 px-1 pb-2">
        {BOARD_COLUMNS.map(column => <KanbanColumn key={column.value} value={column.value} className="w-70 min-w-70">
          <section className={cn('flex min-h-80 flex-col gap-2 rounded-lg border p-2.5', column.surfaceClassName, column.borderClassName)} aria-label={`${column.label}任务列`}>
            <div className="flex h-8 items-center gap-2 px-0.5">
              <column.icon className={cn('size-4 shrink-0', column.indicatorClassName)} aria-hidden="true" />
              <h2 className="truncate text-sm font-semibold">{column.label}</h2>
              <Badge variant="outline">{props.value[column.value]?.length ?? 0}</Badge>
              <Button type="button" variant="ghost" size="icon-xs" className="ml-auto" aria-label={`新建${column.label}任务`} disabled={pending} onClick={() => onCreate(column.value)}><Plus /></Button>
            </div>
            <KanbanColumnContent value={column.value} className="min-h-60 gap-2" aria-label={`${column.label}列`}>
              {(props.value[column.value] ?? []).map(task => <TaskCard key={task.id} task={task} status={column.value} disabled={pending} onOpen={onOpen} onStatus={onStatus} />)}
              {!props.value[column.value]?.length && <p className="rounded-lg border border-dashed border-border/70 bg-background/55 px-3 py-6 text-center text-xs text-muted-foreground">拖动任务到这里</p>}
            </KanbanColumnContent>
          </section>
        </KanbanColumn>)}
      </KanbanBoardPrimitive>
    </BoardScrollArea>
    <KanbanOverlay>{({ value }) => {
      const entry = Object.entries(props.value).find(([, tasks]) => tasks.some(task => task.id === value))
      const task = entry?.[1].find(item => item.id === value)
      return task ? <TaskCard task={task} status={entry![0] as IssueStatus} disabled isOverlay onOpen={onOpen} onStatus={onStatus} /> : null
    }}</KanbanOverlay>
  </Kanban>
}
