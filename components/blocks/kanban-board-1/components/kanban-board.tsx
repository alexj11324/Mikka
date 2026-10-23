'use client'

import { type ComponentProps, type Ref } from 'react'
import { ScrollArea as ScrollAreaPrimitive } from '@base-ui/react/scroll-area'
import { useTranslations } from 'next-intl'
import { cn } from '@/lib/utils'
import { LetterAvatar } from '@/components/nav/letter-avatar'
import { Kanban, KanbanBoard as KanbanBoardPrimitive, KanbanColumn, KanbanColumnContent, KanbanItem, KanbanItemHandle, KanbanOverlay } from '@/components/reui/kanban'
import { issueIdentifier } from '@/components/workspace/issue-properties'
import { BOARD_COLUMNS, type BoardColumns, type BoardTask } from './data'

function BoardScrollArea({ children, viewportRef, ...props }: ComponentProps<typeof ScrollAreaPrimitive.Viewport> & { viewportRef: Ref<HTMLDivElement> }) {
  return <ScrollAreaPrimitive.Root data-slot="scroll-area" className="relative min-h-0 w-full min-w-0 flex-1 pb-3">
    <ScrollAreaPrimitive.Viewport {...props} ref={viewportRef} data-slot="scroll-area-viewport" className="h-full w-full overscroll-x-contain rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset">
      <ScrollAreaPrimitive.Content data-slot="scroll-area-content" className="h-full w-full min-w-max">{children}</ScrollAreaPrimitive.Content>
    </ScrollAreaPrimitive.Viewport>
    <ScrollAreaPrimitive.Scrollbar orientation="horizontal" className="flex h-2.5 touch-none flex-col p-px select-none"><ScrollAreaPrimitive.Thumb className="relative flex-1 rounded-full bg-foreground/15" /></ScrollAreaPrimitive.Scrollbar>
    <ScrollAreaPrimitive.Corner />
  </ScrollAreaPrimitive.Root>
}

function TaskCard({ task, disabled, isOverlay = false, onOpen }: {
  task: BoardTask
  disabled: boolean
  isOverlay?: boolean
  onOpen: (id: string) => void
}) {
  const t = useTranslations('Board')
  const tIssue = useTranslations('Issue')
  const tShell = useTranslations('Shell.board')
  const assignee = task.metadata.assignee
  // Only the title and who has it (Figma 57:2); everything else lives on the issue page.
  const card = <div className={cn('flex flex-col gap-2.5 rounded-xl bg-shell-raised px-3 py-3 shadow-xs ring-1 ring-foreground/5 transition-shadow hover:ring-foreground/15', isOverlay && 'pointer-events-none shadow-lg')}>
    <h3 data-slot="kanban-task-title" className="line-clamp-3 text-sm font-semibold break-words"><span className="tabular-nums">{issueIdentifier(task, tIssue('unassignedNumber'))}</span> {task.title}</h3>
    <p className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">{assignee ? <><LetterAvatar name={assignee.name} size="row" /><span className="truncate">{assignee.name}</span></> : <span>{tShell('unassigned')}</span>}</p>
  </div>

  return <KanbanItem value={task.id} disabled={disabled} className="shrink-0" role="group" tabIndex={-1} aria-label={task.title}>
    {isOverlay ? card : <KanbanItemHandle cursor={false} role="group" tabIndex={disabled ? -1 : 0} className="block cursor-pointer touch-pan-y rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring data-[dragging=true]:cursor-grabbing" aria-label={t('openTask', { title: task.title })} aria-roledescription={t('openableDraggableTask')} aria-keyshortcuts="Enter Space" onClick={event => {
      if (disabled || event.defaultPrevented) return
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
}

export function KanbanBoard({ pending = false, viewportRef, viewportId, instructionsId, onViewportKeyDown, onOpen, ...props }: KanbanBoardProps) {
  const t = useTranslations('Board')
  const tIssue = useTranslations('Issue')
  const statusLabel = (value: string) => tIssue.has(`status.${value}` as never) ? tIssue(`status.${value}` as never) : value
  return <Kanban {...props} getItemValue={item => item.id} className="flex min-h-0 w-full min-w-0 flex-1 flex-col">
    <BoardScrollArea viewportRef={viewportRef} id={viewportId} role="region" aria-label={t('horizontalScroll')} aria-describedby={instructionsId} tabIndex={0} onKeyDown={onViewportKeyDown}>
      <KanbanBoardPrimitive className="grid h-full min-h-0 w-full min-w-max grid-cols-[repeat(4,minmax(13rem,1fr))] items-stretch gap-3 pb-2 sm:grid-cols-[repeat(4,minmax(13rem,1fr))]">
        {BOARD_COLUMNS.map(column => <KanbanColumn key={column.value} value={column.value} className="min-h-0 min-w-0">
          <section className="flex min-h-0 flex-1 flex-col gap-1 rounded-xl bg-muted/50 p-2.5" aria-label={t('columnLabel', { status: statusLabel(column.value) })}>
            <h2 className="flex h-7 shrink-0 items-center gap-2 px-1 text-sm font-semibold">{statusLabel(column.value)}<span className="tabular-nums">{props.value[column.value]?.length ?? 0}</span></h2>
            <KanbanColumnContent value={column.value} className="min-h-0 flex-1 gap-2.5 overflow-y-auto overscroll-y-contain p-0.5" aria-label={t('columnContent', { status: statusLabel(column.value) })}>
              {(props.value[column.value] ?? []).map(task => <TaskCard key={task.id} task={task} disabled={pending} onOpen={onOpen} />)}
            </KanbanColumnContent>
          </section>
        </KanbanColumn>)}
      </KanbanBoardPrimitive>
    </BoardScrollArea>
    <KanbanOverlay>{({ value }) => {
      const entry = Object.entries(props.value).find(([, tasks]) => tasks.some(task => task.id === value))
      const task = entry?.[1].find(item => item.id === value)
      return task && entry ? <TaskCard task={task} disabled isOverlay onOpen={onOpen} /> : null
    }}</KanbanOverlay>
  </Kanban>
}
