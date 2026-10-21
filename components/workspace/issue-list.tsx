'use client'

import { ListTodo, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { listIssues } from '@/app/actions/issues'
import { Button } from '@/components/ui/button'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { ISSUE_PRIORITIES, ISSUE_STATUSES, issueIdentifier } from './issue-properties'

export function IssueList({ issues, searching, onOpen, onCreate }: {
  issues: Awaited<ReturnType<typeof listIssues>>
  searching: boolean
  onOpen: (id: string) => void
  onCreate: () => void
}) {
  if (!issues.length) return <Empty className="min-h-80">
    <EmptyHeader>
      <EmptyMedia variant="icon"><ListTodo /></EmptyMedia>
      <EmptyTitle>{searching ? '没有找到匹配的任务' : '这里还没有任务'}</EmptyTitle>
      <EmptyDescription>{searching ? '试试其他关键词或切换状态筛选。' : '把想法变成一项清晰、可执行的任务。'}</EmptyDescription>
    </EmptyHeader>
    {!searching && <EmptyContent><Button size="sm" onClick={onCreate}><Plus data-icon="inline-start" />新建任务</Button></EmptyContent>}
  </Empty>

  return <div aria-label="任务列表" className="flex flex-col">
    {ISSUE_STATUSES.map(status => {
      const group = issues.filter(issue => issue.status === status.value)
      if (!group.length) return null
      const indicatorClassName = status.value === 'doing' ? 'text-warning-foreground' : status.value === 'review' ? 'text-success-foreground' : status.value === 'done' ? 'text-info-foreground' : 'text-muted-foreground'
      return <section key={status.value} aria-label={status.label}>
        <header className="flex h-10 items-center gap-2 border-y bg-muted/40 px-4 text-xs sm:px-6">
          <status.icon className={cn('size-3.5', indicatorClassName)} />
          <h2 className="font-medium">{status.label}</h2>
          <span className="text-muted-foreground">{group.length}</span>
        </header>
        <ul>
          {group.map(issue => <li key={issue.id} className="border-b last:border-b-0">
            <Button type="button" variant="ghost" onClick={() => onOpen(issue.id)} className="h-auto min-h-13 w-full justify-start p-0">
              <span className="flex w-full items-center gap-3 px-4 py-3 text-left sm:px-6">
                <status.icon className={cn('size-3.5 shrink-0', indicatorClassName)} />
                <span className="hidden w-24 shrink-0 font-mono text-xs text-muted-foreground sm:block">{issueIdentifier(issue.metadata.number)}</span>
                <span className="min-w-0 flex-1 truncate font-medium">{issue.title}</span>
                <span className="hidden w-24 shrink-0 text-xs text-muted-foreground sm:block">{ISSUE_PRIORITIES.find(priority => priority.value === issue.priority)?.label}</span>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">v{issue.revision}</span>
                <time dateTime={new Date(issue.updatedAt).toISOString()} className="hidden w-16 shrink-0 text-right text-xs text-muted-foreground md:block">{new Date(issue.updatedAt).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric', timeZone: 'UTC' })}</time>
              </span>
            </Button>
          </li>)}
        </ul>
      </section>
    })}
  </div>
}
