'use client'

import { ListTodo, Plus } from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'
import { cn } from '@/lib/utils'
import type { listIssues } from '@/app/actions/issues'
import { Button } from '@/components/ui/button'
import { Empty, EmptyContent, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import type { CardProperty } from '@/components/blocks/kanban-board-1/components/data'
import { AssigneeAvatar } from './issue-assignee-menu'
import { ISSUE_STATUSES } from './issue-properties'
import { PriorityIcon } from './priority-icon'

const LIST_COLUMNS: ReadonlySet<CardProperty> = new Set(['identifier', 'priority', 'assignee'])

/** The board's list view: one row per task, its columns the same 显示 properties as the cards. */
export function IssueList({ issues, properties = LIST_COLUMNS, searching, onOpen, onCreate }: {
  issues: Awaited<ReturnType<typeof listIssues>>
  properties?: ReadonlySet<CardProperty>
  searching: boolean
  onOpen: (id: string) => void
  onCreate: () => void
}) {
  const t = useTranslations('Issue.list')
  const tIssue = useTranslations('Issue')
  const format = useFormatter()
  const statusLabel = (value: string) => tIssue.has(`status.${value}` as never) ? tIssue(`status.${value}` as never) : value
  const priorityLabel = (value: string) => tIssue.has(`priority.${value}` as never) ? tIssue(`priority.${value}` as never) : value
  // Without Linear sync no task has a number; the column is left out rather than filled with a placeholder (R-40).
  const showIdentifier = properties.has('identifier') && issues.some(issue => issue.identifier)
  if (!issues.length) return <Empty className="min-h-80">
    <EmptyHeader>
      <EmptyMedia variant="icon"><ListTodo /></EmptyMedia>
      <EmptyTitle>{searching ? t('noResults') : t('emptyTitle')}</EmptyTitle>
    </EmptyHeader>
    {!searching && <EmptyContent><Button size="sm" onClick={onCreate}><Plus data-icon="inline-start" />{t('newTask')}</Button></EmptyContent>}
  </Empty>

  return <div aria-label={t('label')} className="flex flex-col">
    {ISSUE_STATUSES.map(status => {
      const group = issues.filter(issue => issue.status === status.value)
      if (!group.length) return null
      // R-34: the same colours as ISSUE_STATUSES (board, ⌘K): review is info, done is success.
      const indicatorClassName = status.value === 'doing' ? 'text-warning-foreground' : status.value === 'review' ? 'text-info-foreground' : status.value === 'done' ? 'text-success-foreground' : 'text-muted-foreground'
      return <section key={status.value} aria-label={statusLabel(status.value)}>
        <header className="flex h-10 items-center gap-2 bg-muted/40 px-4 text-xs sm:px-6">
          <status.icon className={cn('size-3.5', indicatorClassName)} />
          <h2 className="font-medium">{statusLabel(status.value)}</h2>
          <span className="text-muted-foreground tabular-nums">{group.length}</span>
        </header>
        <ul>
          {group.map(issue => <li key={issue.id}>
            <Button type="button" variant="ghost" onClick={() => onOpen(issue.id)} className="h-auto min-h-13 w-full justify-start p-0">
              <span className="flex w-full items-center gap-3 px-4 py-3 text-left sm:px-6">
                {/* Linear's row order: priority, number, status, title. */}
                {properties.has('priority') && <PriorityIcon priority={issue.priority} label={priorityLabel(issue.priority)} />}
                <status.icon className={cn('size-3.5 shrink-0', indicatorClassName)} />
                {showIdentifier && <span className="hidden w-20 shrink-0 text-xs text-muted-foreground tabular-nums sm:block">{issue.identifier}</span>}
                <span className="min-w-0 flex-1 truncate font-medium">{issue.title}</span>
                {properties.has('assignee') && <span className="flex size-4 shrink-0 items-center justify-center" title={issue.metadata.assignee?.name}>{issue.metadata.assignee && <><AssigneeAvatar assignee={issue.metadata.assignee} compact /><span className="sr-only">{issue.metadata.assignee.name}</span></>}</span>}
                <time suppressHydrationWarning dateTime={new Date(issue.updatedAt).toISOString()} className="hidden w-16 shrink-0 text-right text-xs text-muted-foreground md:block">{format.dateTime(new Date(issue.updatedAt), { month: 'numeric', day: 'numeric' })}</time>
              </span>
            </Button>
          </li>)}
        </ul>
      </section>
    })}
  </div>
}
