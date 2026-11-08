'use client'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { BoardCardProps, BoardColumnFrameProps, BoardHiddenLaneProps } from '@/components/slots/board-contract'
import { useTranslations } from 'next-intl'

/** A board column's frame (R-25): the header with the status, its count and the ⋯ menu, then the droppable list. */
export function BoardColumnView({ label, icon, count, menu, children }: BoardColumnFrameProps) {
  const t = useTranslations('Board')
  return <section className="group/column flex min-h-0 flex-1 flex-col gap-1 rounded-xl bg-muted/60 dark:bg-muted/30 p-1.5" aria-label={t('columnLabel', { status: label })}>
    <div className="flex h-8 shrink-0 items-center gap-2 pr-0.5 pl-1.5">
      {icon}
      <h2 className="truncate text-sm font-medium">{label}</h2>
      <span className="text-sm text-muted-foreground tabular-nums">{count}</span>
      {menu}
    </div>
    {children}
  </section>
}

/** 已隐藏: the hidden columns, each with its count, one click to show it again. */
export function BoardHiddenLaneView({ label, columns }: BoardHiddenLaneProps) {
  return <section aria-label={label} className="flex w-52 shrink-0 flex-col gap-1 rounded-xl bg-muted/60 dark:bg-muted/30 p-1.5">
    <h2 className="flex h-8 items-center px-1.5 text-sm font-medium text-muted-foreground">{label}</h2>
    {columns.map(column => <Button key={column.status} variant="ghost" className="h-9 justify-start gap-2 rounded-lg px-1.5 font-normal" title={column.title} onClick={column.onShow}>
      <column.icon data-icon="inline-start" className={column.iconClassName} />{column.label}<span className="ml-auto text-muted-foreground tabular-nums">{column.count}</span>
    </Button>)}
  </section>
}

/** Figma 看板/任务卡片: filled, no stroke (R-31); radius 8, padding 12, rows 8 apart. */
export function BoardCardView({ title, fullTitle, identifier, done, personal, status, assignee, hasAssignee, chips, createdAt, overlay, editors }: Omit<BoardCardProps, 'runState' | 'block'> & Partial<Pick<BoardCardProps, 'runState' | 'block'>>) {
  return <div className={cn('group/card flex flex-col gap-2 rounded-md bg-card p-3 text-card-foreground shadow-xs transition-colors hover:bg-muted/50', overlay && 'pointer-events-none rotate-2 shadow-lg')}>
    <div className="flex h-5 min-w-0 items-center gap-1.5">
      {/* No placeholder while the task has no number (Linear sync off): the row starts with what is there (R-25, R-40). */}
      {identifier && <span className="truncate text-xs text-muted-foreground tabular-nums">{identifier}</span>}
      {personal}
      {/* No placeholder circle when nobody owns the task; the control appears on hover and focus. */}
      {assignee && <div className={cn('ml-auto flex shrink-0 items-center', !hasAssignee && 'opacity-0 group-hover/card:opacity-100 focus-within:opacity-100')}>{assignee}</div>}
    </div>
    <div className="flex min-w-0 items-start gap-[3px]">
      {status}
      <h3 data-slot="kanban-task-title" className={cn('line-clamp-2 min-w-0 flex-1 text-[13px] leading-5 font-medium break-words', done && 'text-muted-foreground')} title={fullTitle}>{title}</h3>
    </div>
    {chips.length > 0 && <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 pl-5">{chips}</div>}
    {createdAt && <div className="pl-5">{createdAt}</div>}
    {editors}
  </div>
}
