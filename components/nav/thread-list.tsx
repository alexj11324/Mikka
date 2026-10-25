'use client'

import { Hash } from 'lucide-react'
import { useTranslations } from 'next-intl'
import type { listIssues } from '@/app/actions/issues'
import type { Thread } from '@/app/actions/task-runs'
import { Button } from '@/components/ui/button'
import { issueIdentifier } from '@/components/workspace/issue-properties'
import { cn } from '@/lib/utils'
import { StatusDot } from './status-dot'

type Issue = Awaited<ReturnType<typeof listIssues>>[number]

/**
 * A thread's own name, about its work (docs/design/glossary.md): its task,
 * as "#71 Infisical 连接超时排查", else the first line of what it was asked.
 * Never the bot's name.
 */
export function threadName(thread: Thread, issues: Issue[], fallback: string) {
  const issue = thread.issueId ? issues.find(item => item.id === thread.issueId) : undefined
  if (issue) return `${issueIdentifier(issue)} ${issue.title}`
  return thread.prompt.split('\n').find(line => line.trim())?.trim().slice(0, 80) || fallback
}

function dotStatus(thread: Thread) {
  if (thread.status === 'waiting_input') return 'waiting'
  if (['queued', 'preparing', 'running', 'finishing'].includes(thread.status)) return 'running'
  if (thread.status === 'failed') return 'failed'
  return thread.status === 'succeeded' ? 'done' : 'idle'
}

/** A thread's mark: an orange disc with # (Figma 188:3192), 72px on its 详情. */
export function ThreadMark({ size = 'profile' }: { size?: 'profile' | 'row' }) {
  return <span aria-hidden="true" className={cn('flex shrink-0 items-center justify-center rounded-full bg-avatar-5 text-avatar-foreground', size === 'profile' && 'size-18', size === 'row' && 'size-4')}>
    <Hash className={cn(size === 'profile' && 'size-8', size === 'row' && 'size-2.5')} strokeWidth={2.5} />
  </span>
}

/**
 * The right column's thread list: one bot's threads, newest first, each with
 * its status dot and its own name. Picking one shows it, with the bot's
 * computer, in 详情.
 */
export function ThreadList({ threads, issues, current, onPick }: { threads: Thread[]; issues: Issue[]; current: string | null; onPick: (id: string) => void }) {
  const t = useTranslations('Shell.threads')
  if (!threads.length) return <p className="text-xs text-muted-foreground">{t('empty')}</p>
  return <ul aria-label={t('title')} className="flex flex-col">
    {threads.map(thread => {
      const waiting = thread.status === 'waiting_input'
      return <li key={thread.id}>
        <Button variant="ghost" aria-current={thread.id === current ? 'true' : undefined} className={cn('h-8 w-full justify-start gap-3 rounded-lg px-2 font-normal', thread.id === current && 'bg-muted')} onClick={() => onPick(thread.id)}>
          <StatusDot status={dotStatus(thread)} />
          <span className="min-w-0 flex-1 truncate text-left">{threadName(thread, issues, t('untitled'))}</span>
          {(waiting || thread.status === 'failed') && <span className={cn('shrink-0 text-xs', waiting ? 'text-muted-foreground' : 'text-destructive')}>{t(waiting ? 'waiting' : 'failed')}</span>}
        </Button>
      </li>
    })}
  </ul>
}
