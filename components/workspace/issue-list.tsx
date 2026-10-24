'use client'

import { ListTodo, Plus } from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'
import { cn } from '@/lib/utils'
import type { listIssues } from '@/app/actions/issues'
import { Button } from '@/components/ui/button'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { ISSUE_STATUSES, issueIdentifier } from './issue-properties'

export function IssueList({ issues, searching, onOpen, onCreate }: {
  issues: Awaited<ReturnType<typeof listIssues>>
  searching: boolean
  onOpen: (id: string) => void
  onCreate: () => void
}) {
  const t = useTranslations('Issue.list')
  const tIssue = useTranslations('Issue')
  const format = useFormatter()
  const statusLabel = (value: string) => tIssue.has(`status.${value}` as never) ? tIssue(`status.${value}` as never) : value
  const priorityLabel = (value: string) => tIssue.has(`priority.${value}` as never) ? tIssue(`priority.${value}` as never) : value
  if (!issues.length) return <Empty className="min-h-80">
    <EmptyHeader>
      <EmptyMedia variant="icon"><ListTodo /></EmptyMedia>
      <EmptyTitle>{searching ? t('noResults') : t('emptyTitle')}</EmptyTitle>
      <EmptyDescription>{searching ? t('noResultsHint') : t('emptyHint')}</EmptyDescription>
    </EmptyHeader>
    {!searching && <EmptyContent><Button size="sm" onClick={onCreate}><Plus data-icon="inline-start" />{t('newTask')}</Button></EmptyContent>}
  </Empty>

  return <div aria-label={t('label')} className="flex flex-col">
    {ISSUE_STATUSES.map(status => {
      const group = issues.filter(issue => issue.status === status.value)
      if (!group.length) return null
      const indicatorClassName = status.value === 'doing' ? 'text-warning-foreground' : status.value === 'review' ? 'text-success-foreground' : status.value === 'done' ? 'text-info-foreground' : 'text-muted-foreground'
      return <section key={status.value} aria-label={statusLabel(status.value)}>
        <header className="flex h-10 items-center gap-2 bg-muted/40 px-4 text-xs sm:px-6">
          <status.icon className={cn('size-3.5', indicatorClassName)} />
          <h2 className="font-medium">{statusLabel(status.value)}</h2>
          <span className="text-muted-foreground">{group.length}</span>
        </header>
        <ul>
          {group.map(issue => { const optimistic = 'optimistic' in issue && issue.optimistic === true; return <li key={issue.id} data-optimistic={optimistic ? '' : undefined} aria-busy={optimistic || undefined} className={cn(optimistic && 'max-h-64 overflow-hidden opacity-100 transition-[max-height,opacity] duration-200 ease-out starting:max-h-0 starting:opacity-0 motion-reduce:transition-none')}>
            <Button type="button" variant="ghost" onClick={() => onOpen(issue.id)} className="h-auto min-h-13 w-full justify-start p-0">
              <span className="flex w-full items-center gap-3 px-4 py-3 text-left sm:px-6">
                <status.icon className={cn('size-3.5 shrink-0', indicatorClassName)} />
                <span className="hidden w-24 shrink-0 font-mono text-xs text-muted-foreground sm:block">{issueIdentifier(issue, tIssue('unassignedNumber'))}</span>
                <span className="min-w-0 flex-1 truncate font-medium">{issue.title}</span>
                <span className="hidden w-24 shrink-0 text-xs text-muted-foreground sm:block">{priorityLabel(issue.priority)}</span>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">v{issue.revision}</span>
                <time dateTime={new Date(issue.updatedAt).toISOString()} className="hidden w-16 shrink-0 text-right text-xs text-muted-foreground md:block">{format.dateTime(new Date(issue.updatedAt), { month: 'numeric', day: 'numeric', timeZone: 'UTC' })}</time>
              </span>
            </Button>
          </li> })}
        </ul>
      </section>
    })}
  </div>
}
